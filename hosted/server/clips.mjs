// Clip/playlist project schema. These are timestamp references, not copies of footage.
// Every playlist reference must identify a clip in the same project.
const validId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id);

const fail = (message) => { throw Object.assign(new Error(message), { status: 400 }); };
const validDate = (value) => typeof value === 'string' && value.length <= 35 && Number.isFinite(Date.parse(value));
const validLabel = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validSeconds = (value) => Number.isFinite(value) && value >= 0 && value <= 24 * 3600;

export function validateClip(clip) {
  return !!clip && typeof clip === 'object' && !Array.isArray(clip) &&
    validId(clip.id) && validLabel(clip.title, 100) &&
    validSeconds(clip.start) && validSeconds(clip.end) && clip.end > clip.start &&
    validLabel(clip.category, 40) && typeof clip.notes === 'string' && clip.notes.length <= 500 &&
    validDate(clip.createdAt) && validDate(clip.updatedAt);
}
export function validatePlaylist(playlist) {
  return !!playlist && typeof playlist === 'object' && !Array.isArray(playlist) &&
    validId(playlist.id) && validLabel(playlist.title, 100) &&
    Array.isArray(playlist.clipIds) && playlist.clipIds.length <= 5000 &&
    playlist.clipIds.every(validId) && validDate(playlist.createdAt) && validDate(playlist.updatedAt);
}
export function validateProjectClips(project) {
  const clips = project.clips ?? [];
  const playlists = project.playlists ?? [];
  if (!Array.isArray(clips) || clips.length > 5000 || !clips.every(validateClip)) fail('Invalid clips. Check time ranges and clip details.');
  if (!Array.isArray(playlists) || playlists.length > 200 || !playlists.every(validatePlaylist)) fail('Invalid playlists.');
  const clipIds = new Set(clips.map(c => c.id));
  if (clipIds.size !== clips.length) fail('Duplicate clip IDs.');
  const playlistIds = new Set(playlists.map(p => p.id));
  if (playlistIds.size !== playlists.length) fail('Duplicate playlist IDs.');
  for (const playlist of playlists) {
    if (playlist.clipIds.some(id => !clipIds.has(id))) fail('Playlist references a clip that does not exist in this match.');
  }
  // A clip can never extend beyond known media duration (allow tiny metadata rounding).
  if (Number.isFinite(project.duration) && project.duration > 0 &&
      clips.some(c => c.end > project.duration + 0.1)) fail('Clip end exceeds the video duration.');
  if (!project.video && !project.videoUrl && !project.remoteVideo && clips.length) fail('Clips require attached footage.');
  return true;
}
