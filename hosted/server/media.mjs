import { createReadStream, createWriteStream } from 'node:fs';
import { rm, rename, stat } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { extname, join } from 'node:path';
import { VIDEO_DIR, ensureStorage, getProject, listProjects, updateProject } from './storage.mjs';
import { validateVideoUrl } from './links.mjs';

export const MAX_VIDEO_BYTES = 8 * 1024 ** 3; // 8 GiB, streamed not buffered
const MEDIA_TYPES = new Map([
  ['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'],
  ['.mov', 'video/quicktime'], ['.webm', 'video/webm']
]);

export function safeFilename(name) {
  if (typeof name !== 'string' || name.length > 250 || !name.trim()) throw Object.assign(new Error('Invalid filename'), { status: 400 });
  return name.split(/[\\/]/).pop().replace(/[\x00-\x1f]/g, '').trim();
}

export function validateFileName(filename) {
  const name = safeFilename(filename);
  const ext = extname(name).toLowerCase();
  if (!MEDIA_TYPES.has(ext)) throw Object.assign(new Error('Supported imports: MP4, M4V, MOV, WebM'), { status: 415 });
  return { name, ext, mimeType: MEDIA_TYPES.get(ext) };
}

export async function uploadVideo(req, projectId, filename) {
  const { name, ext, mimeType } = validateFileName(filename);
  await getProject(projectId);
  await ensureStorage();
  const length = Number(req.headers['content-length']);
  if (Number.isFinite(length) && length > MAX_VIDEO_BYTES) throw Object.assign(new Error('File exceeds 8 GiB local limit'), { status: 413 });
  const id = randomUUID();
  const storageName = `${id}${ext}`;
  const tmp = join(VIDEO_DIR, `${id}.uploading`);
  const final = join(VIDEO_DIR, storageName);
  let bytes = 0;
  const limiter = new Transform({
    transform(chunk, encoding, callback) {
      bytes += chunk.length;
      if (bytes > MAX_VIDEO_BYTES) callback(Object.assign(new Error('File exceeds 8 GiB local limit'), { status: 413 }));
      else callback(null, chunk);
    }
  });
  try {
    await pipeline(req, limiter, createWriteStream(tmp, { flags: 'wx', mode: 0o600 }));
    if (bytes === 0) throw Object.assign(new Error('Empty video file'), { status: 400 });
    await rename(tmp, final);
    const record = { id, originalName: name, storageName, mimeType, size: bytes, createdAt: new Date().toISOString() };
    let old;
    try {
      await updateProject(projectId, (project) => {
        old = project.video;
        return { ...project, video: record, videoUrl: null, remoteVideo: null, duration: null, annotations: [], freezes: [], zooms: [], clips: [], playlists: [] };
      });
    } catch (error) {
      await rm(final, { force: true });
      throw error;
    }
    if (old) await rm(join(VIDEO_DIR, old.storageName), { force: true }).catch(() => {});
    return record;
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

export function parseRange(header, size) {
  if (!header) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return null;
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || start > end) return null;
  return { start, end: Math.min(end, size - 1), partial: true };
}

export async function serveVideo(req, res, id) {
  const projects = await listProjects();
  const video = projects.map((p) => p.video).find((v) => v?.id === id);
  if (!video) throw Object.assign(new Error('Video not found'), { status: 404 });
  const path = join(VIDEO_DIR, video.storageName);
  let info;
  try { info = await stat(path); }
  catch { throw Object.assign(new Error('Video file is missing'), { status: 404 }); }
  const range = parseRange(req.headers.range, info.size);
  if (!range) {
    res.writeHead(416, { 'Content-Range': `bytes */${info.size}`, 'Accept-Ranges': 'bytes' });
    return res.end();
  }
  const headers = {
    'Content-Type': video.mimeType,
    'Accept-Ranges': 'bytes',
    'Content-Length': range.end - range.start + 1,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff'
  };
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`;
  res.writeHead(range.partial ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();
  const file = createReadStream(path, { start: range.start, end: range.end });
  file.on('error', () => res.destroy());
  res.on('close', () => file.destroy());
  file.pipe(res);
}

// A direct video-file link plays in the browser, not through our unauthenticated Node server.
// Existing local footage is deleted only after the project update has committed.
export async function setVideoUrl(projectId, url) {
  const nextUrl = url === null ? null : validateVideoUrl(url);
  let oldVideo = null;
  const updated = await updateProject(projectId, (project) => {
    oldVideo = project.video;
    return { ...project, video: null, videoUrl: nextUrl, remoteVideo: null, annotations: [], freezes: [], zooms: [], clips: [], playlists: [], duration: null };
  });
  if (oldVideo) await rm(join(VIDEO_DIR, oldVideo.storageName), { force: true }).catch(() => {});
  return updated;
}
