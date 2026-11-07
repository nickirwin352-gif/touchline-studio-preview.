/**
 * Optional recovery of personal browser snapshots after a Free Render cold start.
 * Only enabled in TOUCHLINE_FREE_MODE, and all API routes remain behind the
 * existing single-user cloud password. Saved server data is NEVER overwritten.
 */
import { ensureStorage, listProjects, writeProject, validId, validatePatch } from './storage.mjs';
import { validateProjectClips } from './clips.mjs';
import { validateVideoUrl } from './links.mjs';

const bad = (msg, status=400) => Object.assign(new Error(msg), {status});
const allowedDate = d => typeof d==='string' && Number.isFinite(Date.parse(d)) ? d : new Date().toISOString();

export function freeModeEnabled(env=process.env) {
  return env.TOUCHLINE_FREE_MODE === '1';
}
export function sanitizeFreeSnapshot(s) {
  if (!s || typeof s!=='object' || Array.isArray(s) || !validId(s.id))
    throw bad('Invalid saved project identifier');
  // Revalidate every field. Never accept a local path, a signed CDN URL, or
  // arbitrary imported project objects as a trusted server-side file.
  const input = {
    title: typeof s.title === 'string' ? s.title : 'Recovered analysis',
    duration: s.duration ?? null,
    annotations: s.annotations || [],
    freezes: s.freezes || [],
    zooms: s.zooms || [],
    clips: s.clips || [],
    playlists: s.playlists || [],
    autoFreezeAnnotations: s.autoFreezeAnnotations !== false
  };
  if (s.sourceLink) input.sourceLink=s.sourceLink;
  const patch = validatePatch(input);
  const sourceLink=patch.sourceLink || null;
  let remoteVideo=null;
  if (sourceLink && s.remoteVideo?.kind==='veo') {
    const u=new URL(sourceLink);
    const match=u.hostname==='app.veo.co' && /^\/matches\/([A-Za-z0-9_-]+)\/?$/.exec(u.pathname);
    if (match) remoteVideo={kind:'veo', matchId:match[1],createdAt:allowedDate(s.remoteVideo.createdAt)};
  }
  const videoUrl=s.videoUrl?validateVideoUrl(s.videoUrl):null;
  const result={
    id:s.id,schemaVersion:3,...patch,
    sourceLink,remoteVideo,video:null,videoUrl,
    createdAt:allowedDate(s.createdAt),updatedAt:allowedDate(s.updatedAt)
  };
  validateProjectClips(result);
  return result;
}
export async function restoreFreeSnapshots(snapshots, env=process.env) {
  if(!freeModeEnabled(env))throw bad('Browser restoration is not enabled',404);
  if(!Array.isArray(snapshots) || snapshots.length>30)
    throw bad('Restore up to 30 projects at a time');
  // Validate completely BEFORE any writes, to avoid partial corrupt restores.
  const checked=snapshots.map(sanitizeFreeSnapshot);
  if(new Set(checked.map(p=>p.id)).size!==checked.length)throw bad('Duplicate project identifiers');
  await ensureStorage();
  if((await listProjects()).length)throw bad('The session already contains projects; it will not be overwritten',409);
  for(const project of checked) await writeProject(project);
  return {restored:checked.length,mode:'browser-backed'};
}
