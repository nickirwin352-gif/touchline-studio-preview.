/**
 * Local-only authorised Veo importer. We never accept arbitrary downloader URLs or
 * subprocess command lines. yt-dlp is an OPTIONAL external program installed by
 * the user; failures preserve their existing project footage and annotations.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { DATA_DIR, VIDEO_DIR, ensureStorage, getProject, updateProject } from './storage.mjs';
import { validateVeoLink } from './links.mjs';
import { MAX_VIDEO_BYTES } from './media.mjs';

const jobs = new Map();
const running = (job) => job?.status === 'running';
const VALID_MEDIA = new Map([['.mp4', 'video/mp4'], ['.m4v', 'video/mp4'], ['.mov', 'video/quicktime'], ['.webm', 'video/webm']]);

export function matchMediaUrl(input) {
  const validated = validateVeoLink(input);
  const url = new URL(validated);
  if (url.hostname !== 'app.veo.co' || url.port) {
    throw Object.assign(new Error('For automatic import, paste a match link starting with https://app.veo.co/matches/'), { status: 400 });
  }
  const match = /^\/matches\/([a-zA-Z0-9_-]+)\/?$/.exec(url.pathname);
  if (!match) {
    throw Object.assign(new Error('This is not a Veo match link. Copy the full match page URL from Veo.'), { status: 400 });
  }
  // Ignore highlight/query markers: these address Veo UI, not the whole video.
  return { sourceLink: validated, extractionUrl: `https://app.veo.co/matches/${match[1]}/`, matchId: match[1] };
}

function binary() {
  // User-specified trusted path, or platform PATH. No shell interpolation.
  if (process.env.TOUCHLINE_YTDLP_PATH) return process.env.TOUCHLINE_YTDLP_PATH;
  const localExe = resolve(process.cwd(), 'tools', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
  return existsSync(localExe) ? localExe : 'yt-dlp';
}
function publicJob(job) {
  if (!job) return { status: 'idle' };
  return { status: job.status, phase: job.phase, percent: job.percent, progressDetail: job.progressDetail || null, error: job.error || null };
}
export function getImportStatus(projectId) { return publicJob(jobs.get(projectId)); }
export function isImportRunning(projectId) { return running(jobs.get(projectId)); }
export function requireIdle(projectId) {
  if (isImportRunning(projectId)) throw Object.assign(new Error('A Veo import is running. Cancel it or allow it to finish first.'), { status: 409 });
}

async function download(job, importDir, extractionUrl) {
  const args = [
    '--ignore-config', '--no-playlist', '--newline', '--progress',
    '--retries', '3', '--fragment-retries', '3', '--socket-timeout', '30',
    '--max-filesize', String(MAX_VIDEO_BYTES),
    '--format', 'best[ext=mp4]/best', '--merge-output-format', 'mp4',
    // Do not use --print: it automatically enables quiet mode and suppresses
    // the download messages needed for progress reporting. The file is
    // discovered safely from our dedicated import directory after completion.
    '--paths', importDir, '--output', 'match.%(ext)s', extractionUrl
  ];
  // Test-only seam: run the offline yt-dlp fixture through Node on every OS.
  const program = process.env.TOUCHLINE_YTDLP_TEST_SHIM ? process.execPath : binary();
  const executableArgs = process.env.TOUCHLINE_YTDLP_TEST_SHIM ? [process.env.TOUCHLINE_YTDLP_TEST_SHIM, ...args] : args;
  const child = spawn(program, executableArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: false });
  job.child = child;
  let lines = '';
  const absorb = (chunk) => {
    lines = (lines + chunk.toString('utf8')).slice(-16000);
    // --newline makes actual progress updates visible over stdout/stderr.
    // Some video servers take time to respond, so also describe extraction phases.
    if (/\[Veo\].*Downloading JSON metadata/i.test(lines) && !job.percent) job.phase = 'Reading Veo match details';
    if (/\[Veo\].*Downloading video data/i.test(lines) && !job.percent) job.phase = 'Locating Veo video stream';
    if (/\[download\]\s+Destination:/i.test(lines) && !job.percent) job.phase = 'Downloading match recording';
    const matches = [...lines.matchAll(/\[download\]\s*([\d]{1,3}(?:\.[\d]+)?)%([^\r\n]*)/g)];
    if (matches.length) {
      const last = matches[matches.length - 1];
      const value = Number(last[1]);
      if (value >= 0 && value <= 100) {
        job.percent = Math.max(job.percent || 0, value);
        job.phase = 'Downloading match recording';
        // Transfer size, speed, and ETA come from yt-dlp, not estimates.
        // Restrict to its numeric progress line: no URLs, tokens, or cookies.
        const detail = `${last[1]}%${last[2]}`.trim().replace(/\x1b\[[0-9;]*m/g, '');
        job.progressDetail = detail.slice(0, 140);
      }
    }
  };
  child.stdout.on('data', absorb);
  child.stderr.on('data', absorb);
  let spawnError = null;
  child.on('error', (err) => { spawnError = err; });
  const code = await new Promise((done) => child.on('close', done));
  job.child = null;
  if (job.cancelled) throw new Error('Import cancelled');
  if (spawnError?.code === 'ENOENT') throw new Error('yt-dlp is not installed. Install it using the instructions in the README, then restart Touchline Studio.');
  if (spawnError) throw new Error(`Could not launch yt-dlp: ${spawnError.message}`);
  if (code !== 0) {
    const reason = /(?:HTTP Error\s*40[13]|Forbidden|Unauthorized)/i.test(lines)
      ? 'The Veo recording requires access or its video stream is blocked.'
      : /ffmpeg.*(?:not found|not installed)/i.test(lines)
        ? 'FFmpeg is required for this video format. Install FFmpeg and try again.'
        : /(?:Unsupported URL|no formats|Video unavailable|not available)/i.test(lines)
          ? 'No accessible video was found for this Veo match.'
          : 'Veo import failed. Confirm the link is accessible publicly and that yt-dlp is up to date.';
    throw new Error(reason);
  }
  job.phase = 'Finishing import';
  const entries = await readdir(importDir);
  const candidates = [];
  for (const entry of entries) {
    if (!entry.startsWith('match.')) continue;
    const ext = extname(entry).toLowerCase();
    if (!VALID_MEDIA.has(ext)) continue;
    const full = join(importDir, entry);
    const info = await stat(full);
    if (info.isFile() && info.size > 0) candidates.push({ full, ext, size: info.size });
  }
  candidates.sort((a, b) => b.size - a.size);
  if (!candidates.length) throw new Error('No browser-playable MP4/WebM was produced. Try updating yt-dlp or use an authorised MP4 download.');
  if (candidates[0].size > MAX_VIDEO_BYTES) throw new Error('Veo video exceeds the 8 GiB storage limit.');
  return candidates[0];
}

async function perform(job, match) {
  const tmp = join(DATA_DIR, 'imports', job.token);
  let finalPath;
  try {
    await ensureStorage();
    await mkdir(tmp, { recursive: true });
    const media = await download(job, tmp, match.extractionUrl);
    if (job.cancelled) throw new Error('Import cancelled');
    const videoId = randomUUID();
    const storageName = `${videoId}${media.ext}`;
    finalPath = join(VIDEO_DIR, storageName);
    await rename(media.full, finalPath);
    const record = {
      id: videoId, originalName: `${match.matchId}${media.ext}`,
      storageName, mimeType: VALID_MEDIA.get(media.ext), size: media.size,
      createdAt: new Date().toISOString()
    };
    let previous;
    await updateProject(job.projectId, (project) => {
      previous = project.video;
      return { ...project, video: record, videoUrl: null, remoteVideo: null, sourceLink: match.sourceLink, duration: null, annotations: [], freezes: [], zooms: [], clips: [], playlists: [] };
    });
    finalPath = null; // ownership passed to project storage
    if (previous) await rm(join(VIDEO_DIR, previous.storageName), { force: true }).catch(() => {});
    job.percent = 100;
    job.status = 'completed';
    job.phase = 'Ready to analyse';
  } catch (error) {
    job.status = job.cancelled ? 'cancelled' : 'failed';
    job.error = job.cancelled ? 'Import cancelled' : error.message;
    job.phase = job.status === 'failed' ? 'Import failed' : 'Cancelled';
  } finally {
    if (finalPath) await rm(finalPath, { force: true }).catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    job.child = null;
  }
}

export async function beginVeoImport(projectId, value) {
  const match = matchMediaUrl(value);
  requireIdle(projectId);
  if ([...jobs.values()].some(running)) throw Object.assign(new Error('Another Veo download is running. Finish or cancel it first.'), { status: 409 });
  await getProject(projectId);
  // Preserve the supplied source link even if the download cannot be completed.
  await updateProject(projectId, (project) => ({ ...project, sourceLink: match.sourceLink }));
  const job = {
    token: randomUUID(), projectId, status: 'running', phase: 'Connecting to Veo',
    percent: 0, progressDetail: null, error: null, cancelled: false, child: null
  };
  jobs.set(projectId, job);
  void perform(job, match);
  return publicJob(job);
}
export function cancelVeoImport(projectId) {
  const job = jobs.get(projectId);
  if (!running(job)) throw Object.assign(new Error('No active Veo import to cancel'), { status: 409 });
  job.cancelled = true;
  job.phase = 'Cancelling import';
  job.child?.kill();
  return publicJob(job);
}
