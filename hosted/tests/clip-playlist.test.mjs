import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const dataDir = await mkdtemp(join(tmpdir(), 'touchline-clips-'));
process.env.TOUCHLINE_DATA_DIR = dataDir;
const { createAppServer } = await import('../server/index.mjs');
let server, root;
before(async () => {
  server = createAppServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  root = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise(r => server.close(r));
  await rm(dataDir, { recursive: true, force: true });
});
const req = async (path, method = 'GET', data) => {
  const response = await fetch(root + path, { method, headers: data ? {'Content-Type':'application/json'} : {}, body: data ? JSON.stringify(data) : undefined });
  return { status: response.status, data: await response.json() };
};
const now = '2026-11-07T11:00:00.000Z';
const clip = (title, start, end) => ({ id: randomUUID(), title, start, end, category:'Pressing', notes:'Strong pressure from the 9', createdAt:now, updatedAt:now });
const playlist = (title, ids) => ({ id: randomUUID(), title, clipIds:ids, createdAt:now, updatedAt:now });
const createWithFootage = async () => {
  const p = (await req('/api/projects','POST',{title:'Match'})).data;
  const result = await fetch(`${root}/api/projects/${p.id}/video`, {method:'PUT',headers:{'X-File-Name':'test.mp4'},body:Buffer.from('synthetic video bytes')});
  assert.equal(result.status,201);
  return p.id;
};

test('clip and playlist are persisted as timestamp references with no copied video', async () => {
  const id = await createWithFootage();
  const a = clip('Pressing trigger',12.5,20.25);
  const b = clip('Counter attack',48,58);
  const list = playlist('High pressing',[b.id,a.id]);
  const saved = await req(`/api/projects/${id}`,'PATCH',{duration:120,clips:[a,b],playlists:[list]});
  assert.equal(saved.status,200);
  const reloaded = await req(`/api/projects/${id}`);
  assert.deepEqual(reloaded.data.clips,[a,b]);
  assert.deepEqual(reloaded.data.playlists,[list]);
  assert.equal(reloaded.data.video.size,21);
  assert.equal((await readdir(join(dataDir,'videos'))).length,1);
  const stored = JSON.parse(await readFile(join(dataDir,'projects',`${id}.json`),'utf8'));
  assert.equal(stored.playlists[0].clipIds[0],b.id);
  assert.equal(stored.clips[0].start,12.5);
  const title = await req(`/api/projects/${id}`,'PATCH',{title:'Renamed match'});
  assert.equal(title.status,200);
  assert.deepEqual(title.data.playlists,[list]);
  const reordered = await req(`/api/projects/${id}`,'PATCH',{clips:[a,b],playlists:[{...list,clipIds:[a.id,b.id,a.id]}]});
  assert.equal(reordered.status,200,'Playlists may intentionally repeat clips');
  assert.deepEqual((await req(`/api/projects/${id}`)).data.playlists[0].clipIds,[a.id,b.id,a.id]);
});

test('invalid clips and cross-match or missing playlist references are rejected atomically', async () => {
  const id = await createWithFootage();
  const a = clip('Valid',10,16);
  assert.equal((await req(`/api/projects/${id}`,'PATCH',{duration:60,clips:[a]})).status,200);
  const badPatches = [
    {clips:[{...a,end:10}]},
    {clips:[{...a,end:61}]},
    {clips:[{...a,start:-1}]},
    {clips:[a,a]},
    {clips:[{...a, category:''}]},
    {playlists:[playlist('Missing clip',[randomUUID()])]},
    {clips:[],playlists:[playlist('Broken',[a.id])]},
    {playlists:[playlist('Bad IDs',['__proto__'])]},
  ];
  for (const patch of badPatches) {
    const response = await req(`/api/projects/${id}`,'PATCH',patch);
    assert.equal(response.status,400,JSON.stringify(patch));
    const reload = (await req(`/api/projects/${id}`)).data;
    assert.deepEqual(reload.clips,[a], 'Failed patch must not mutate existing project');
    assert.deepEqual(reload.playlists,[]);
  }
  const another = await createWithFootage();
  assert.equal((await req(`/api/projects/${another}`,'PATCH',{clips:[a],duration:60,playlists:[playlist('Other match',[a.id])]})).status,200);
  // Referencing a clip from another project must fail unless it is also part of this one.
  assert.equal((await req(`/api/projects/${id}`,'PATCH',{playlists:[playlist('Cross project',[randomUUID()])]})).status,400);
});

test('legacy v0.4 saved projects open and can receive clips without migration', async () => {
  const id = await createWithFootage();
  const path = join(dataDir,'projects',`${id}.json`);
  const original = JSON.parse(await readFile(path,'utf8'));
  delete original.clips; delete original.playlists;
  await writeFile(path,JSON.stringify(original));
  assert.equal((await req(`/api/projects/${id}`)).data.clips,undefined);
  const a = clip('Legacy source clip',3,7);
  assert.equal((await req(`/api/projects/${id}`,'PATCH',{duration:30,clips:[a],playlists:[playlist('Migrated',[a.id])]})).status,200);
  assert.equal((await req(`/api/projects/${id}`)).data.clips[0].title,'Legacy source clip');
});

test('replacing video source clears incompatible clips and leaves original match safe', async () => {
  const id = await createWithFootage();
  const a = clip('Opening',1,2);
  assert.equal((await req(`/api/projects/${id}`,'PATCH',{duration:15,clips:[a],playlists:[playlist('Opening',[a.id])]})).status,200);
  const savedVideoName = (await req(`/api/projects/${id}`)).data.video.storageName;
  const replaced = await req(`/api/projects/${id}/video-url`,'PUT',{url:'https://example.com/test.mp4'});
  assert.equal(replaced.status,200);
  assert.deepEqual(replaced.data.clips,[]);
  assert.deepEqual(replaced.data.playlists,[]);
  assert.equal(replaced.data.videoUrl,'https://example.com/test.mp4');
  assert.equal((await readdir(join(dataDir,'videos'))).some(f => f === savedVideoName),false);
});

test('a project with no footage cannot claim timestamped clips', async () => {
  const p = (await req('/api/projects','POST',{title:'Empty'})).data;
  const saved = await req(`/api/projects/${p.id}`,'PATCH',{clips:[clip('No footage',0,3)]});
  assert.equal(saved.status,400);
  const reloaded = await req(`/api/projects/${p.id}`);
  assert.deepEqual(reloaded.data.clips,[]);
});
