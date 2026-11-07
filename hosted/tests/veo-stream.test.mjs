import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

const dir = await mkdtemp(join(tmpdir(), 'touchline-stream-test-'));
process.env.TOUCHLINE_DATA_DIR = dir;
const { createProject, getProject, updateProject } = await import('../server/storage.mjs');
const { activateVeoStream, deactivateVeoStream, requestVideoRange, clearResolvedStream, assertSafeStreamUrl } = await import('../server/veo-stream.mjs');
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
  const opened = await activateVeoStream(created.id, link, extractor);
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
  const streamed = await activateVeoStream(p.id, link, extractor);
  await assert.rejects(streamCase(streamed, 'bytes=0-10', 'GET', { status: 200 }), /partial playback/);
  await assert.rejects(streamCase(streamed, 'bytes=0-10', 'GET', { contentRange: 'bytes 1-10/62' }), /invalid byte-range/);
  await assert.rejects(streamCase(streamed, 'bytes=-99'), /Unsupported byte range/);
  await assert.rejects(assertSafeStreamUrl('http://127.0.0.1:3000/secret'), /public HTTPS/);
  await assert.rejects(assertSafeStreamUrl('https://127.0.0.1/secret'), /public HTTPS/);
  await assert.rejects(assertSafeStreamUrl('https://user:pass@example.com/secret'), /public HTTPS/);
});
