import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const directory = await mkdtemp(join(tmpdir(), 'touchline-test-'));
process.env.TOUCHLINE_DATA_DIR = directory;
const { createAppServer } = await import('../server/index.mjs');
let server, root;
before(async () => {
  server = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  root = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
});
const j = async (path, method = 'GET', body) => {
  const response = await fetch(root + path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body && JSON.stringify(body) });
  return { response, data: await response.json() };
};
const sample = () => ({ id: randomUUID(), type: 'rect', x1: .1, y1: .3, x2: .4, y2: .6, points: [], text: '', color: '#ffffff', width: 5, start: 0, end: 4 });

test('project create, update, reopen, list, and missing project response', async () => {
  const { response, data } = await j('/api/projects', 'POST', { title: 'First half' });
  assert.equal(response.status, 201);
  assert.equal(data.title, 'First half');
  assert.equal(data.video, null);
  const annotation = sample();
  const updated = await j(`/api/projects/${data.id}`, 'PATCH', { annotations: [annotation], duration: 90 });
  assert.equal(updated.response.status, 200);
  const retrieved = await j(`/api/projects/${data.id}`);
  assert.deepEqual(retrieved.data.annotations, [annotation]);
  assert.equal(retrieved.data.duration, 90);
  const listed = await j('/api/projects');
  assert.equal(listed.data.length, 1);
  assert.equal((await j(`/api/projects/${randomUUID()}`)).response.status, 404);
  const invalid = await j(`/api/projects/${data.id}`, 'PATCH', { annotations: [{ nonsense: true }] });
  assert.equal(invalid.response.status, 400);
});
test('streamed upload supports partial byte-range playback and deletion', async () => {
  const created = (await j('/api/projects', 'POST', { title: 'Range test' })).data;
  const bytes = Buffer.from('Video byte stream fixture 0123456789');
  const uploadedResponse = await fetch(`${root}/api/projects/${created.id}/video`, { method: 'PUT', headers: { 'X-File-Name': encodeURIComponent('test footage.mp4') }, body: bytes });
  assert.equal(uploadedResponse.status, 201);
  const video = await uploadedResponse.json();
  assert.equal(video.originalName, 'test footage.mp4');
  assert.equal(video.size, bytes.length);
  const full = await fetch(`${root}/api/videos/${video.id}`);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const part = await fetch(`${root}/api/videos/${video.id}`, { headers: { Range: 'bytes=6-9' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 6-9/${bytes.length}`);
  assert.equal(await part.text(), 'byte');
  const suffix = await fetch(`${root}/api/videos/${video.id}`, { headers: { Range: 'bytes=-4' } });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), '6789');
  const outOfBounds = await fetch(`${root}/api/videos/${video.id}`, { headers: { Range: 'bytes=999-' } });
  assert.equal(outOfBounds.status, 416);
  const current = (await j(`/api/projects/${created.id}`)).data;
  assert.equal(current.annotations.length, 0);
  assert.equal(current.video.id, video.id);
  assert.equal((await j(`/api/projects/${created.id}`, 'DELETE')).response.status, 200);
  assert.equal((await fetch(`${root}/api/videos/${video.id}`)).status, 404);
  await assert.rejects(stat(join(directory, 'videos', video.storageName)), { code: 'ENOENT' });
});
test('static assets are served and unknown API routes are not HTML', async () => {
  const page = await fetch(root + '/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Touchline Studio/);
  const script = await fetch(root + '/assets/app.js');
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type'), /javascript/);
  const missing = await j('/api/not-a-route');
  assert.equal(missing.response.status, 404);
});

test('Veo watch link is saved as a reference, not mistaken for a playable video', async () => {
  const project = (await j('/api/projects', 'POST', { title: 'Veo reference' })).data;
  const link = 'https://app.veo.co/matches/example-share-123?start=80';
  const updated = await j(`/api/projects/${project.id}`, 'PATCH', { sourceLink: link });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.sourceLink, link);
  assert.equal(updated.data.video, null);
  assert.equal(updated.data.videoUrl, null);
  assert.equal((await j(`/api/projects/${project.id}`)).data.sourceLink, link);
  const invalid = [
    'https://evil-veo.co/matches/hijack',
    'http://app.veo.co/matches/test',
    'javascript:alert(1)',
    'https://test:pass@app.veo.co/recording/123',
    'https://app.veo.co.evil.example/watch'
  ];
  for (const url of invalid) {
    const response = await j(`/api/projects/${project.id}`, 'PATCH', { sourceLink: url });
    assert.equal(response.response.status, 400, `Should reject ${url}`);
  }
  assert.equal((await j(`/api/projects/${project.id}`)).data.sourceLink, link);
  const removed = await j(`/api/projects/${project.id}`, 'PATCH', { sourceLink: null });
  assert.equal(removed.data.sourceLink, null);
});

test('direct video-file URL loads as an external source without pretending to import bytes', async () => {
  const project = (await j('/api/projects', 'POST', { title: 'Linked match footage' })).data;
  const link = 'https://cdn.example.org/match.mp4?token=123';
  const set = await j(`/api/projects/${project.id}/video-url`, 'PUT', { url: link });
  assert.equal(set.response.status, 200);
  assert.equal(set.data.videoUrl, link);
  assert.equal(set.data.video, null);
  const annotation = sample();
  await j(`/api/projects/${project.id}`, 'PATCH', { duration: 120, annotations: [annotation] });
  const reload = (await j(`/api/projects/${project.id}`)).data;
  assert.equal(reload.duration, 120);
  assert.deepEqual(reload.annotations, [annotation]);
  for (const invalid of ['https://app.veo.co/matches/example', 'http://cdn.example.org/test.mp4', 'https://cdn.example.org/match.mp4/iframe']) {
    const response = await j(`/api/projects/${project.id}/video-url`, 'PUT', { url: invalid });
    assert.equal(response.response.status, 400, `Should reject ${invalid}`);
  }
  const cleared = await j(`/api/projects/${project.id}/video-url`, 'PUT', { url: null });
  assert.equal(cleared.response.status, 200);
  assert.equal(cleared.data.videoUrl, null);
  assert.equal(cleared.data.duration, null);
  assert.deepEqual(cleared.data.annotations, []);
});

test('attaching local footage replaces remote video but keeps Veo source reference', async () => {
  const project = (await j('/api/projects', 'POST', { title: 'Keep original source' })).data;
  const sourceLink = 'https://app.veo.co/matches/example';
  await j(`/api/projects/${project.id}`, 'PATCH', { sourceLink });
  await j(`/api/projects/${project.id}/video-url`, 'PUT', { url: 'https://media.example.org/video.mp4' });
  const response = await fetch(`${root}/api/projects/${project.id}/video`, { method: 'PUT', headers: { 'X-File-Name': encodeURIComponent('veo-match.mp4') }, body: Buffer.from('sample media file content') });
  assert.equal(response.status, 201);
  const reloaded = (await j(`/api/projects/${project.id}`)).data;
  assert.equal(reloaded.sourceLink, sourceLink);
  assert.equal(reloaded.videoUrl, null);
  assert.equal(reloaded.video.originalName, 'veo-match.mp4');
  const replaced = await j(`/api/projects/${project.id}/video-url`, 'PUT', { url: 'https://media.example.org/replacement.webm' });
  assert.equal(replaced.response.status, 200);
  assert.equal(replaced.data.video, null);
  assert.equal(replaced.data.sourceLink, sourceLink);
  assert.equal((await fetch(`${root}/api/videos/${reloaded.video.id}`)).status, 404);
  await assert.rejects(stat(join(directory, 'videos', reloaded.video.storageName)), { code: 'ENOENT' });
});

// The importer is exercised with a fake yt-dlp executable. These tests verify
// disk commits, URL validation and cancellation without contacting Veo.
test('Veo match URL validator keeps source highlight but extracts the full-match URL', async () => {
  const { matchMediaUrl } = await import('../server/veo-import.mjs');
  const sourceLink = 'https://app.veo.co/matches/20261101-example-match/?highlight=01234567-8910-2345-6789-012345678901&scroll=MT';
  const result = matchMediaUrl(sourceLink);
  assert.equal(result.sourceLink, sourceLink);
  assert.equal(result.extractionUrl, 'https://app.veo.co/matches/20261101-example-match/');
  for (const bad of [
    'http://app.veo.co/matches/abc', 'https://app.veo.co.evil.example/matches/abc',
    'https://app.veo.co/api/app/matches/abc', 'https://app.veo.co/matches/abc/../../secret',
    'https://app.veo.co/matches/abc/another', 'https://app.veo.co:8080/matches/abc'
  ]) {
    assert.throws(() => matchMediaUrl(bad), undefined, bad);
  }
});

const stub = join(directory, 'mock-ytdlp.mjs');
async function setupMock() {
  const { writeFile, chmod } = await import('node:fs/promises');
  await writeFile(stub, `#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const args=process.argv.slice(2);
if (!args.includes('--progress') || args.includes('--print')) process.exit(12);
const dir=args[args.indexOf('--paths')+1];
if (!dir || !args.some(x=>x.startsWith('https://app.veo.co/matches/'))) process.exit(9);
if (process.env.MOCK_YTDLP_MODE==='error') { console.error('ERROR: HTTP Error 403 Forbidden'); process.exit(1); }
if (process.env.MOCK_YTDLP_MODE==='slow') { console.log('[download]   5.0% of 200MiB'); setInterval(()=>{},1000); } else {
  await mkdir(dir,{recursive:true});
  console.log('[download]  45.7% of 300KiB');
  await writeFile(join(dir,'match.mp4'), Buffer.from('fake video file from mock resolver'));
  console.log('[download] 100.0% of 300KiB');
}
`);
  await chmod(stub, 0o755);
  process.env.TOUCHLINE_YTDLP_TEST_SHIM = stub;
}
async function waitImport(projectId, desired, timeout = 3500) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const status = (await j(`/api/projects/${projectId}/veo-import`)).data;
    if (desired.includes(status.status)) return status;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.fail('Veo importer did not settle');
}
test('Veo importer attaches downloaded bytes to a project with range playback', async () => {
  await setupMock();
  process.env.MOCK_YTDLP_MODE = 'success';
  const p = (await j('/api/projects','POST',{title:'Veo match'})).data;
  const sourceLink = 'https://app.veo.co/matches/example-match-1/?highlight=abc&scroll=MT';
  const start = await j(`/api/projects/${p.id}/veo-import`, 'POST', {url:sourceLink});
  assert.equal(start.response.status, 202);
  assert.equal(start.data.status, 'running');
  const duplicate = await j(`/api/projects/${p.id}/veo-import`, 'POST', {url:sourceLink});
  assert.equal(duplicate.response.status, 409);
  const status = await waitImport(p.id,['completed','failed']);
  assert.equal(status.status,'completed',JSON.stringify(status));
  const loaded=(await j(`/api/projects/${p.id}`)).data;
  assert.equal(loaded.sourceLink,sourceLink);
  assert.equal(loaded.video.mimeType,'video/mp4');
  assert.equal(loaded.video.originalName,'example-match-1.mp4');
  const res=await fetch(root+`/api/videos/${loaded.video.id}`,{headers:{range:'bytes=0-3'}});
  assert.equal(res.status,206);
  assert.equal(await res.text(),'fake');
});
test('failed Veo import preserves existing footage and drawings, reports useful error', async () => {
  await setupMock();
  process.env.MOCK_YTDLP_MODE = 'error';
  const p = (await j('/api/projects','POST',{title:'Keep previous'})).data;
  const upload = await fetch(`${root}/api/projects/${p.id}/video`,{method:'PUT',headers:{'X-File-Name':'old.mp4'},body:Buffer.from('original')});
  assert.equal(upload.status,201);
  const oldVideo=await upload.json();
  const annotation=sample();
  await j(`/api/projects/${p.id}`,'PATCH',{annotations:[annotation],duration:100});
  const start=await j(`/api/projects/${p.id}/veo-import`,'POST',{url:'https://app.veo.co/matches/another-match/'});
  assert.equal(start.response.status,202);
  const done=await waitImport(p.id,['failed','completed']);
  assert.equal(done.status,'failed');
  assert.match(done.error,/requires access|blocked/i);
  const loaded=(await j(`/api/projects/${p.id}`)).data;
  assert.equal(loaded.video.id,oldVideo.id);
  assert.deepEqual(loaded.annotations,[annotation]);
  assert.equal(loaded.duration,100);
  const playback=await fetch(`${root}/api/videos/${oldVideo.id}`);
  assert.equal(await playback.text(),'original');
});
test('cancelled Veo import leaves existing footage and blocks concurrent replacements',async()=>{
  await setupMock();
  process.env.MOCK_YTDLP_MODE = 'slow';
  const p=(await j('/api/projects','POST',{title:'Cancellation'})).data;
  assert.equal((await j(`/api/projects/${p.id}/veo-import`,'POST',{url:'https://app.veo.co/matches/example/'})).response.status,202);
  assert.equal((await j(`/api/projects/${p.id}/video-url`,'PUT',{url:'https://media.example.com/test.mp4'})).response.status,409);
  assert.equal((await j(`/api/projects/${p.id}`,'DELETE')).response.status,409);
  const progressUntil = Date.now() + 2000;
  let progress;
  do {
    progress = (await j(`/api/projects/${p.id}/veo-import`)).data;
    if (progress.percent === 5) break;
    await new Promise((r) => setTimeout(r, 40));
  } while (Date.now() < progressUntil);
  assert.equal(progress.percent, 5, 'Veo yt-dlp output must update download percent');
  assert.match(progress.progressDetail, /5\.0% of 200MiB/, 'Transfer information should be visible to the user');
  assert.equal(progress.phase, 'Downloading match recording');
  assert.equal((await j(`/api/projects/${p.id}/veo-import`,'DELETE')).response.status,200);
  const done=await waitImport(p.id,['cancelled','failed']);
  assert.equal(done.status,'cancelled');
  const loaded=(await j(`/api/projects/${p.id}`)).data;
  assert.equal(loaded.video,null);
});
test('missing yt-dlp reports how to install instead of a fake successful import',async()=>{
  delete process.env.TOUCHLINE_YTDLP_TEST_SHIM;
  process.env.TOUCHLINE_YTDLP_PATH = join(directory, 'does-not-exist-ytdlp');
  const p = (await j('/api/projects','POST',{title:'Missing resolver'})).data;
  assert.equal((await j(`/api/projects/${p.id}/veo-import`,'POST',{url:'https://app.veo.co/matches/example/'})).response.status,202);
  const done=await waitImport(p.id,['failed','completed']);
  assert.equal(done.status,'failed');
  assert.match(done.error,/yt-dlp is not installed/i);
});
