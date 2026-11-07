import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { validateVeoLink } from './links.mjs';
import { validateProjectClips } from './clips.mjs';

export const DATA_DIR = process.env.TOUCHLINE_DATA_DIR || join(process.cwd(), 'data');
export const PROJECT_DIR = join(DATA_DIR, 'projects');
export const VIDEO_DIR = join(DATA_DIR, 'videos');

export async function ensureStorage() {
  await Promise.all([mkdir(PROJECT_DIR, { recursive: true }), mkdir(VIDEO_DIR, { recursive: true })]);
}

export function validId(id) {
  return typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id);
}

function projectPath(id) {
  if (!validId(id)) throw Object.assign(new Error('Invalid project ID'), { status: 400 });
  return join(PROJECT_DIR, `${id}.json`);
}

const locks = new Map();
export async function locked(id, action) {
  const previous = locks.get(id) || Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  const settled = current.catch(() => {});
  locks.set(id, settled);
  try {
    return await current;
  } finally {
    if (locks.get(id) === settled) locks.delete(id);
  }
}

export async function getProject(id) {
  try {
    return JSON.parse(await readFile(projectPath(id), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') throw Object.assign(new Error('Project not found'), { status: 404 });
    throw error;
  }
}

export async function writeProject(project) {
  const path = projectPath(project.id);
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(project, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return project;
}

export async function createProject(title = 'Untitled analysis') {
  await ensureStorage();
  const now = new Date().toISOString();
  const project = {
    schemaVersion: 3,
    id: randomUUID(),
    title: title.trim().slice(0, 100) || 'Untitled analysis',
    video: null,
    videoUrl: null, // Direct HTTPS video-file URL; browser plays remotely, without copying bytes
    sourceLink: null, // Original Veo match URL; signed streaming URLs are never saved
    remoteVideo: null, // Optional {kind:'veo',matchId,createdAt}; resolve playback URL on demand
    duration: null,
    annotations: [],
    freezes: [],
    autoFreezeAnnotations: true,
    zooms: [],
    clips: [],
    playlists: [],
    createdAt: now,
    updatedAt: now
  };
  return writeProject(project);
}

export async function updateProject(id, updater) {
  return locked(id, async () => {
    const current = await getProject(id);
    const next = updater(current);
    // Lazy migration: v0.4 project files remain readable; next save upgrades metadata only.
    next.schemaVersion = 3;
    next.freezes ??= [];
    next.autoFreezeAnnotations ??= true;
    next.zooms ??= [];
    next.clips ??= [];
    next.playlists ??= [];
    validateProjectClips(next);
    next.updatedAt = new Date().toISOString();
    return writeProject(next);
  });
}

export async function listProjects() {
  await ensureStorage();
  const files = (await readdir(PROJECT_DIR)).filter((f) => f.endsWith('.json'));
  const projects = await Promise.all(files.map(async (file) => {
    try { return JSON.parse(await readFile(join(PROJECT_DIR, file), 'utf8')); }
    catch { return null; }
  }));
  return projects.filter(Boolean).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteProject(id) {
  return locked(id, async () => {
    const project = await getProject(id);
    await rm(projectPath(id));
    if (project.video) {
      await rm(join(VIDEO_DIR, project.video.storageName), { force: true }).catch(() => {});
    }
    return project;
  });
}

export function validateAnnotation(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  if (!validId(a.id) || !['arrow', 'line', 'rect', 'ellipse', 'text', 'pen', 'highlight', 'spotlight', 'curve', 'zone', 'footmarker'].includes(a.type)) return false;
  if (![a.x1, a.y1, a.x2, a.y2].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1)) return false;
  if (typeof a.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(a.color)) return false;
  if (!Number.isFinite(a.width) || a.width < 1 || a.width > 16) return false;
  if (typeof a.text !== 'string' || a.text.length > 120) return false;
  if (![a.start, a.end].every((n) => Number.isFinite(n) && n >= 0 && n <= 24 * 3600) || a.end < a.start) return false;
  if (!Array.isArray(a.points) || a.points.length > 4000 || !a.points.every((p) => p && [p.x, p.y].every((n) => Number.isFinite(n) && n >= 0 && n <= 1))) return false;
  if (a.bend !== undefined && (!Number.isFinite(a.bend) || a.bend < -.5 || a.bend > .5)) return false;
  if (a.fade !== undefined && (!Number.isFinite(a.fade) || a.fade < 0 || a.fade > 2)) return false;
  if (a.keyframes !== undefined && (!Array.isArray(a.keyframes) || a.keyframes.length > 100 || !a.keyframes.every(k => k && Number.isFinite(k.time) && k.time >= a.start && k.time <= a.end && Number.isFinite(k.x) && k.x >= 0 && k.x <= 1 && Number.isFinite(k.y) && k.y >= 0 && k.y <= 1))) return false;
  return true;
}
export function validateFreeze(f) {
  return f && validId(f.id) && Number.isFinite(f.at) && f.at >= 0 && f.at <= 86400 && Number.isFinite(f.hold) && f.hold >= .5 && f.hold <= 20 && typeof f.label === 'string' && f.label.length <= 100;
}
export function validateZoom(z) {
  return z && validId(z.id) && [z.start,z.end,z.x,z.y,z.scale].every(Number.isFinite) && z.start>=0 && z.end>z.start && z.end<=86400 && z.x>=0 && z.x<=1 && z.y>=0 && z.y<=1 && z.scale>=1.1 && z.scale<=2.5;
}

export function validatePatch(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Object.assign(new Error('Expected JSON object'), { status: 400 });
  const patch = {};
  if ('title' in body) {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 100) throw Object.assign(new Error('Title must be 1–100 characters'), { status: 400 });
    patch.title = body.title.trim();
  }
  if ('sourceLink' in body) {
    if (body.sourceLink !== null) patch.sourceLink = validateVeoLink(body.sourceLink);
    else { patch.sourceLink = null; patch.remoteVideo = null; }
  }
  if ('duration' in body) {
    if (body.duration !== null && (!Number.isFinite(body.duration) || body.duration < 0 || body.duration > 24 * 3600)) throw Object.assign(new Error('Invalid duration'), { status: 400 });
    patch.duration = body.duration;
  }
  if ('annotations' in body) {
    if (!Array.isArray(body.annotations) || body.annotations.length > 10000 || !body.annotations.every(validateAnnotation)) throw Object.assign(new Error('Invalid annotations'), { status: 400 });
    const ids = new Set(body.annotations.map((a) => a.id));
    if (ids.size !== body.annotations.length) throw Object.assign(new Error('Duplicate annotation IDs'), { status: 400 });
    patch.annotations = body.annotations;
  }
  if ('autoFreezeAnnotations' in body) {
    if (typeof body.autoFreezeAnnotations !== 'boolean') throw Object.assign(new Error('Invalid automatic freeze setting'), {status:400});
    patch.autoFreezeAnnotations = body.autoFreezeAnnotations;
  }
  if ('freezes' in body) {
    if (!Array.isArray(body.freezes) || body.freezes.length > 200 || !body.freezes.every(validateFreeze) || new Set(body.freezes.map(f=>f.id)).size !== body.freezes.length) throw Object.assign(new Error('Invalid freeze frames'),{status:400});
    patch.freezes = body.freezes;
  }
  if ('zooms' in body) {
    if (!Array.isArray(body.zooms) || body.zooms.length > 100 || !body.zooms.every(validateZoom) || new Set(body.zooms.map(z=>z.id)).size !== body.zooms.length) throw Object.assign(new Error('Invalid zoom effects'),{status:400});
    patch.zooms = body.zooms;
  }
  if ('clips' in body) patch.clips = body.clips;
  if ('playlists' in body) patch.playlists = body.playlists;
  if (Object.keys(patch).length === 0) throw Object.assign(new Error('Nothing to update'), { status: 400 });
  // Full cross-reference validation happens after patch merge in updateProject.
  return patch;
}
