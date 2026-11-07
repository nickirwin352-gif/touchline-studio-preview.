import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const dir = await mkdtemp(join(tmpdir(), 'touchline-stream-test-'));
process.env.TOUCHLINE_DATA_DIR = dir;
const { createProject, getProject, updateProject } = await import('../server/storage.mjs');
const { activateVeoStream, deactivateVeoStream, requestVideoRange, clearResolvedStream, assertSafeStreamUrl, probeStreamRange, inspectPublicVeoLink, clearVeoPreflights } = await import('../server/veo-stream.mjs');
const link = 'https://app.veo.co/matches/20261101-14s-v-st-j-vc68ac1f/?highlight=abc';
const fakeVideo = 'https://cdn.example.com/signed/video.mp4?signature=private';
const sample = Buffer.from('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789');
const extractor = async () => fakeVideo;

// Real streaming response object, no network: validates the exact HTTP byte contract.
async function streamCase(p, range = 'bytes=0-8', method = 'GET', overrides = {}) {
  const res = new PassThrough();
  let code, headers;
  const chunks = [];
  res.writeHead = (status, props) => { code = status; headers = props; };
  res.on('data', (part) => chunks.push(part));
  const requested = [];
  const fetcher = async (_url, init) => {
    requested.push(init.headers.Range);
    const m = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range);
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), sample.length - 1);
    if (overrides.status) return new Response('bad', { status: overrides.status });
    return new Response(sample.subarray(start, end + 1), { status: 206,
      headers: { 'Content-Range': overrides.contentRange || `bytes ${start}-${end}/${sample.length}` } });
  };
  const req = { method, headers: range === null ? {} : { range } };
  await requestVideoRange(p, req, res, { fetcher, checker: async () => {}, extractor: overrides.extractor || extractor })
    .catch((error) => { if (!res.destroyed) res.destroy(); throw error; });
  return { code, headers, body: Buffer.concat(chunks), requested };
}

test('link streaming creates a reference without a 3.4GB download and preserves the highlight link', async (t) => {
  t.after(async () => rm(dir, { recursive: true, force: true }));
  const created = await createProject('Remote Veo');
  const opened = await activateVeoStream(created.id, link, extractor, async () => ({seekable:true}));
  assert.equal(opened.video, null);
  assert.equal(opened.remoteVideo.kind, 'veo');
  assert.equal(opened.remoteVideo.matchId, '20261101-14s-v-st-j-vc68ac1f');
  assert.equal(opened.sourceLink, link);
  const saved = await getProject(opened.id);
  assert.deepEqual(saved.remoteVideo, opened.remoteVideo);
  assert.equal(JSON.stringify(saved).includes('signature=private'), false);
  const first = await streamCase(saved, 'bytes=3-12');
  assert.equal(first.code, 206);
  assert.equal(first.headers['Content-Range'], `bytes 3-12/${sample.length}`);
  assert.equal(first.body.toString(), 'DEFGHIJKLM');
  assert.deepEqual(first.requested, ['bytes=3-12']);
  const second = await streamCase(saved, 'bytes=44-');
  assert.equal(second.code, 206);
  assert.equal(second.body.toString(), sample.subarray(44).toString());
  assert.deepEqual(second.requested, ['bytes=44-4194347']);
  const head = await streamCase(saved, null, 'HEAD');
  assert.equal(head.code, 206);
  assert.equal(head.body.length, 0);
  const removed = await deactivateVeoStream(opened.id);
  assert.equal(removed.remoteVideo, null);
  assert.equal(removed.sourceLink, null);
  assert.equal(removed.video, null);
  clearResolvedStream(opened.id);
});

test('stream activation failure preserves existing footage and annotations', async () => {
  const project = await createProject('Existing analysis');
  const annotated = await updateProject(project.id, (p) => ({ ...p, annotations: [{ id: 'preserve me' }] }));
  await assert.rejects(activateVeoStream(project.id, link, async () => { throw new Error('Denied'); }), /Denied/);
  const after = await getProject(project.id);
  assert.deepEqual(after.annotations, annotated.annotations);
  assert.equal(after.remoteVideo, null);
});

test('partial playback refuses full file responses, invalid ranges and unsafe destinations', async () => {
  const p = await createProject('Broken source');
  const streamed = await activateVeoStream(p.id, link, extractor, async () => ({seekable:true}));
  await assert.rejects(streamCase(streamed, 'bytes=0-10', 'GET', { status: 200 }), /partial playback/);
  await assert.rejects(streamCase(streamed, 'bytes=0-10', 'GET', { contentRange: 'bytes 1-10/62' }), /invalid byte-range/);
  await assert.rejects(streamCase(streamed, 'bytes=-99'), /Unsupported byte range/);
  await assert.rejects(assertSafeStreamUrl('http://127.0.0.1:3000/secret'), /public HTTPS/);
  await assert.rejects(assertSafeStreamUrl('https://127.0.0.1/secret'), /public HTTPS/);
  await assert.rejects(assertSafeStreamUrl('https://user:pass@example.com/secret'), /public HTTPS/);
});

test('public video is accepted only after an actual bounded seek probe', async () => {
  const target='https://cdn.example.com/veo-match.mp4?temporary=signed';
  let requests=0;
  const successfulFetch=async (_url, init) => {
    requests++;
    assert.equal(init.headers.Range,'bytes=0-1');
    return new Response(Uint8Array.from([0,1]),{
      status:206, headers:{'Content-Range':'bytes 0-1/100000','Content-Type':'video/mp4'}
    });
  };
  const detail=await probeStreamRange(target,{fetcher:successfulFetch,checker:async()=>{}});
  assert.deepEqual(detail,{seekable:true,sizeBytes:100000,contentType:'video/mp4'});
  assert.equal(requests,1);
  await assert.rejects(probeStreamRange(target,{
    fetcher:async()=>new Response('no range support',{status:200}),
    checker:async()=>{}
  }),/did not support video seeking/);
  await assert.rejects(probeStreamRange(target,{
    fetcher:async()=>new Response('denied',{status:403}),
    checker:async()=>{}
  }),/video host blocked the Touchline server/i);
  await assert.rejects(probeStreamRange(target,{
    fetcher:async()=>new Response('bad',{status:206,headers:{'Content-Range':'bytes 3-5/100000'}}),
    checker:async()=>{}
  }),/invalid seek response/);
});

test('preflight reports readiness without exposing signed URLs or changing projects',async()=>{
  clearVeoPreflights();
  const newLink='https://app.veo.co/matches/test-2026-public-football/?highlight=42';
  let extracted=0, probed=0;
  const videoUrl='https://cdn.example.com/signed/secret.mp4?token=private';
  const extract=async(u)=>{extracted++;assert.equal(u,'https://app.veo.co/matches/test-2026-public-football/');return videoUrl;};
  const probe=async(u)=>{probed++;assert.equal(u,videoUrl);return {seekable:true,sizeBytes:345000,contentType:'video/mp4'};};
  const inspected=await inspectPublicVeoLink(newLink,extract,probe);
  assert.deepEqual(inspected,{status:'ready',matchId:'test-2026-public-football',seekable:true});
  assert.equal(JSON.stringify(inspected).includes('token='),false);
  const repeat=await inspectPublicVeoLink(newLink,extract,probe);
  assert.deepEqual(repeat,inspected);
  assert.equal(extracted,1);assert.equal(probed,1);
  const created=await createProject('Keep my annotations');
  const before=await updateProject(created.id,p=>({...p,annotations:[{id:'original'}]}));
  const activated=await activateVeoStream(created.id,newLink,extract,probe);
  assert.equal(activated.remoteVideo.kind,'veo');
  assert.equal(extracted,1);assert.equal(probed,1);
  assert.equal(JSON.stringify(activated).includes('token='),false);
  clearVeoPreflights();
  const failing=await createProject('Cannot play');
  const annotated=await updateProject(failing.id,p=>({...p,annotations:[{id:'safe'}]}));
  await assert.rejects(
    activateVeoStream(failing.id,newLink,extract,async()=>{throw new Error('No seeking');}),
    /No seeking/
  );
  assert.deepEqual((await getProject(failing.id)).annotations,annotated.annotations);
  clearVeoPreflights();
});
