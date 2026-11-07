/**
 * On-demand Veo playback: store only an analysis reference; never store a signed
 * CDN URL on disk. Resolve using yt-dlp, then proxy bounded HTTP byte ranges.
 * The server binds localhost only, does not fetch user-provided arbitrary URLs,
 * and rejects non-public extraction destinations and redirects.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { getProject, updateProject, VIDEO_DIR } from './storage.mjs';
import { matchMediaUrl, requireIdle } from './veo-import.mjs';

const BYTE_CHUNK = 4 * 1024 * 1024;
const CACHE_MS = 8 * 60 * 1000;
const cache = new Map();
const pending = new Map();
const fail = (message, status = 502) => Object.assign(new Error(message), { status });

function isPublicIP(address) {
  const family = isIP(address);
  if (family === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 ||
      a === 192 && (b === 168 || b === 0 && c === 0) ||
      a === 100 && b >= 64 && b <= 127 || a === 198 && b >= 18 && b <= 19 ||
      a === 192 && b === 0 && c === 0 || a === 198 && b === 51 && c === 100 ||
      a === 203 && b === 0 && c === 113);
  }
  if (family === 6) {
    const s = address.toLowerCase();
    return !(s === '::1' || s === '::' || s.startsWith('fc') || s.startsWith('fd') ||
      s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') ||
      s.startsWith('feb') || s.startsWith('ff') || s.startsWith('::ffff:') ||
      s.startsWith('2001:db8:'));
  }
  return false;
}
export async function assertSafeStreamUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw fail('Video stream has an invalid URL'); }
  if (url.protocol !== 'https:' || url.port && url.port !== '443' ||
      url.username || url.password || !url.hostname || isIP(url.hostname) ||
      url.hostname === 'localhost' || url.hostname.endsWith('.localhost')) {
    throw fail('Video stream destination is not a public HTTPS endpoint');
  }
  let addresses;
  try { addresses = await lookup(url.hostname, { all: true }); }
  catch { throw fail('Could not resolve video server'); }
  if (!addresses.length || addresses.some((a) => !isPublicIP(a.address))) throw fail('Video stream destination is not public');
  return url.toString();
}

function extractorBinary() {
  if (process.env.TOUCHLINE_YTDLP_PATH) return process.env.TOUCHLINE_YTDLP_PATH;
  const local = resolve(process.cwd(), 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  return existsSync(local) ? local : 'yt-dlp';
}
export async function extractVeoVideoUrl(matchUrl) {
  const { extractionUrl } = matchMediaUrl(matchUrl);
  const args = ['--ignore-config', '--no-playlist', '--no-warnings', '--no-download',
    '--socket-timeout', '20', '--retries', '2', '-f', 'best[ext=mp4]/best', '-g', extractionUrl];
  const program = process.env.TOUCHLINE_STREAM_TEST_SHIM ? process.execPath : extractorBinary();
  const argv = process.env.TOUCHLINE_STREAM_TEST_SHIM ? [process.env.TOUCHLINE_STREAM_TEST_SHIM, ...args] : args;
  const child = spawn(program, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  let stdout = '', stderr = '';
  child.stdout.on('data', (c) => { stdout += c.toString(); if (stdout.length > 16000) child.kill(); });
  child.stderr.on('data', (c) => { stderr = (stderr + c.toString()).slice(-6000); });
  const timeout = setTimeout(() => child.kill(), 45000);
  let spawnError;
  child.on('error', (e) => { spawnError = e; });
  const code = await new Promise((done) => child.on('close', done));
  clearTimeout(timeout);
  if (spawnError?.code === 'ENOENT') throw fail('yt-dlp is not installed. Install it and restart Touchline Studio.', 503);
  if (code !== 0 || spawnError) {
    if (/HTTP Error\s*(401|403)|Forbidden|Unauthorized/i.test(stderr)) throw fail('Veo denied access to this recording', 403);
    throw fail('Could not resolve the Veo video. Check the link, permissions and yt-dlp version.');
  }
  const urls = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (urls.length !== 1) throw fail('Veo did not provide one playable video stream');
  return assertSafeStreamUrl(urls[0]);
}

export async function resolvedStream(project, extractor = extractVeoVideoUrl) {
  if (!project.remoteVideo || project.remoteVideo.kind !== 'veo' || !project.sourceLink)
    throw fail('This project does not have Veo streaming enabled', 404);
  const prior = cache.get(project.id);
  if (prior?.sourceLink === project.sourceLink && prior.expires > Date.now()) return prior.url;
  if (pending.has(project.id)) return pending.get(project.id);
  const task = (async () => {
    const url = await extractor(project.sourceLink);
    cache.set(project.id, { url, sourceLink: project.sourceLink, expires: Date.now() + CACHE_MS });
    return url;
  })();
  pending.set(project.id, task);
  try { return await task; } finally { pending.delete(project.id); }
}
export function clearResolvedStream(projectId) { cache.delete(projectId); pending.delete(projectId); }

export async function activateVeoStream(projectId, suppliedUrl, extractor = extractVeoVideoUrl) {
  requireIdle(projectId);
  const match = matchMediaUrl(suppliedUrl);
  await getProject(projectId);
  // Fail before modifying the existing project so old footage/annotations survive.
  const resolvedUrl = await extractor(match.extractionUrl);
  let oldVideo = null;
  const updated = await updateProject(projectId, (p) => {
    oldVideo = p.video;
    return { ...p, remoteVideo: { kind: 'veo', matchId: match.matchId, createdAt: new Date().toISOString() },
      sourceLink: match.sourceLink, video: null, videoUrl: null, duration: null, annotations: [], freezes: [], zooms: [], clips: [], playlists: [] };
  });
  clearResolvedStream(projectId);
  cache.set(projectId, { url: resolvedUrl, sourceLink: match.sourceLink, expires: Date.now() + CACHE_MS });
  if (oldVideo) await rm(join(VIDEO_DIR, oldVideo.storageName), { force: true }).catch(() => {});
  return updated;
}
export async function deactivateVeoStream(projectId) {
  const updated = await updateProject(projectId, (p) => ({ ...p, remoteVideo: null,
    sourceLink: null, duration: null, annotations: [], freezes: [], zooms: [], clips: [], playlists: [] }));
  clearResolvedStream(projectId);
  return updated;
}

function inboundRange(header) {
  if (!header) return `bytes=0-${BYTE_CHUNK-1}`;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header);
  if (!m) throw fail('Unsupported byte range', 416);
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : start + BYTE_CHUNK - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw fail('Invalid byte range', 416);
  return `bytes=${start}-${Math.min(end, start + BYTE_CHUNK - 1)}`;
}
async function guardedFetch(url, init, fetcher, checker) {
  let next = url;
  for (let i = 0; i <= 3; i++) {
    await checker(next);
    const response = await fetcher(next, { ...init, redirect: 'manual' });
    if (![301,302,303,307,308].includes(response.status)) return response;
    await response.body?.cancel?.();
    const location = response.headers.get('location');
    if (!location) throw fail('Video server redirect had no destination');
    next = new URL(location, next).toString();
  }
  throw fail('Too many video server redirects');
}

export async function requestVideoRange(project, req, res, options = {}) {
  const extractor = options.extractor || extractVeoVideoUrl;
  const fetcher = options.fetcher || fetch;
  const checker = options.checker || assertSafeStreamUrl;
  const range = inboundRange(req.headers.range);
  let url = await resolvedStream(project, extractor);
  let upstream;
  const controller = new AbortController();
  res.once('close', () => controller.abort());
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      upstream = await guardedFetch(url, { method: 'GET', headers: { Range: range, 'Accept-Encoding': 'identity' }, signal: controller.signal }, fetcher, checker);
      if (![401,403].includes(upstream.status) || attempt === 1) break;
      await upstream.body?.cancel?.();
      clearResolvedStream(project.id);
      url = await resolvedStream(project, extractor);
    }
    if (upstream.status === 416) throw fail('The video server rejected that seek position', 416);
    if (upstream.status !== 206) {
      await upstream.body?.cancel?.();
      throw fail('This video server cannot provide partial playback. Use Download full match instead.');
    }
    const contentRange = upstream.headers.get('content-range');
    const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange || '');
    if (!match || Number(match[1]) !== Number(/^bytes=(\d+)/.exec(range)[1]) ||
        Number(match[2]) < Number(match[1]) || Number(match[2]) - Number(match[1]) + 1 > BYTE_CHUNK ||
        !Number.isSafeInteger(Number(match[3]))) {
      await upstream.body?.cancel?.();
      throw fail('The video server returned an invalid byte-range response');
    }
    const length = Number(match[2]) - Number(match[1]) + 1;
    const headers = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes',
      'Content-Range': contentRange, 'Content-Length': length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };
    res.writeHead(206, headers);
    if (req.method === 'HEAD') { await upstream.body?.cancel?.(); return res.end(); }
    if (!upstream.body) throw fail('Video stream returned no bytes');
    await pipeline(Readable.fromWeb(upstream.body), res);
  } catch (error) {
    controller.abort();
    if (res.headersSent) res.destroy();
    else throw error;
  }
}
