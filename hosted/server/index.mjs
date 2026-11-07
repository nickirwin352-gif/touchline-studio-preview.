import { createServer } from 'node:http';
import { cloudModeEnabled, requireCloudAccess, validateCloudConfig } from './cloud-access.mjs';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createProject, deleteProject, ensureStorage, getProject, listProjects, updateProject, validId, validatePatch } from './storage.mjs';
import { serveVideo, uploadVideo, setVideoUrl } from './media.mjs';
import { beginVeoImport, getImportStatus, cancelVeoImport, requireIdle } from './veo-import.mjs';
import { activateVeoStream, deactivateVeoStream, requestVideoRange, clearResolvedStream } from './veo-stream.mjs';
import { startExport, getExportJob, cancelExport, downloadExport, hasActiveExport, discardExportsForProject } from './export.mjs';
import { startAiJob, getAiJob, cancelAiJob, cancelAiForProject, hasActiveAiJob } from './ai-tracking.mjs';

const WEB_ROOT = resolve(fileURLToPath(new URL('../web/', import.meta.url)));
const types = new Map([['.html', 'text/html; charset=utf-8'], ['.css', 'text/css; charset=utf-8'], ['.js', 'text/javascript; charset=utf-8'], ['.svg', 'image/svg+xml'], ['.ico', 'image/x-icon']]);

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function errorResponse(res, error) {
  if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
  else res.destroy();
  if (!error.status) console.error(error);
}
async function readJson(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) throw Object.assign(new Error('Request JSON too large'), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}
async function staticFile(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return json(res, 400, { error: 'Bad URL' }); }
  const target = resolve(WEB_ROOT, '.' + (decoded === '/' ? '/index.html' : decoded));
  if (target !== WEB_ROOT && !target.startsWith(WEB_ROOT + sep)) return json(res, 403, { error: 'Forbidden' });
  let s;
  try { s = await stat(target); } catch { return json(res, 404, { error: 'Not found' }); }
  if (!s.isFile()) return json(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': types.get(extname(target)) || 'application/octet-stream', 'Content-Length': s.size, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
  if (req.method === 'HEAD') return res.end();
  createReadStream(target).pipe(res);
}

export async function handler(req, res) {
  try {
    if (requireCloudAccess(req, res)) return;
    const url = new URL(req.url, 'http://127.0.0.1');
    const path = url.pathname;
    if (path === '/api/health' && req.method === 'GET') return json(res, 200, { status: 'ok', app: 'Touchline Studio', version: '1.1.0' });
    if (path === '/api/projects') {
      if (req.method === 'GET') return json(res, 200, await listProjects());
      if (req.method === 'POST') {
        const body = await readJson(req);
        if (!body || (body.title !== undefined && (typeof body.title !== 'string' || body.title.length > 100))) return json(res, 400, { error: 'Invalid project title' });
        return json(res, 201, await createProject(body.title || 'Untitled analysis'));
      }
    }
    const aiJob = /^\/api\/ai-jobs\/([^/]+)$/.exec(path);
    if (aiJob && validId(aiJob[1])) {
      if(req.method==='GET') return json(res,200,getAiJob(aiJob[1]));
      if(req.method==='DELETE') return json(res,200,cancelAiJob(aiJob[1]));
    }
    const aiStart = /^\/api\/projects\/([^/]+)\/ai-track$/.exec(path);
    if (aiStart && req.method==='POST') {
      if(!validId(aiStart[1])) return json(res,400,{error:'Invalid project ID'});
      return json(res,202,await startAiJob(aiStart[1],await readJson(req)));
    }
    const exportMatch = /^\/api\/exports\/([^/]+)(\/download)?$/.exec(path);
    if (exportMatch && validId(exportMatch[1])) {
      if (exportMatch[2] && ['GET','HEAD'].includes(req.method)) return downloadExport(exportMatch[1], req, res);
      if (!exportMatch[2] && req.method === 'GET') return json(res, 200, getExportJob(exportMatch[1]));
      if (!exportMatch[2] && req.method === 'DELETE') return json(res, 200, cancelExport(exportMatch[1]));
    }
    const exportStart = /^\/api\/projects\/([^/]+)\/exports$/.exec(path);
    if (exportStart && req.method === 'POST') {
      if (!validId(exportStart[1])) return json(res, 400, { error: 'Invalid project ID' });
      return json(res, 202, await startExport(exportStart[1], await readJson(req)));
    }
    const projectMatch = /^\/api\/projects\/([^/]+)$/.exec(path);
    if (projectMatch) {
      const id = projectMatch[1];
      if (!validId(id)) return json(res, 400, { error: 'Invalid project ID' });
      if (req.method === 'GET') return json(res, 200, await getProject(id));
      if (req.method === 'PATCH') {
        const patch = validatePatch(await readJson(req));
        return json(res, 200, await updateProject(id, (project) => ({ ...project, ...patch })));
      }
      if (req.method === 'DELETE') { if (hasActiveAiJob(id)) return json(res,409,{error:"Finish or cancel player tracking before replacing footage"});
        if (hasActiveExport(id)) return json(res,409,{error:'Wait for or cancel the active export before deleting this project'}); requireIdle(id); cancelAiForProject(id); clearResolvedStream(id); await deleteProject(id); await discardExportsForProject(id); return json(res, 200, { deleted: true }); }
    }
    const veoStreamMatch = /^\/api\/projects\/([^/]+)\/veo-stream$/.exec(path);
    if (veoStreamMatch) {
      const id = veoStreamMatch[1];
      if (!validId(id)) return json(res, 400, { error: 'Invalid project ID' });
      if (req.method === 'POST') {
        if (hasActiveAiJob(id)) return json(res,409,{error:"Finish or cancel player tracking before replacing footage"});
        if (hasActiveExport(id)) return json(res,409,{error:'Finish or cancel this match’s export before replacing footage'});
        const body = await readJson(req);
        if (!body || typeof body.url !== 'string') return json(res, 400, { error: 'Missing Veo URL' });
        return json(res, 200, await activateVeoStream(id, body.url));
      }
      if (req.method === 'DELETE') { if (hasActiveAiJob(id)) return json(res,409,{error:"Finish or cancel player tracking before replacing footage"});
        if (hasActiveExport(id)) return json(res,409,{error:'Finish or cancel the export first'}); return json(res, 200, await deactivateVeoStream(id)); }
      if (req.method === 'GET' || req.method === 'HEAD') return await requestVideoRange(await getProject(id), req, res);
    }
    const veoImportMatch = /^\/api\/projects\/([^/]+)\/veo-import$/.exec(path);
    if (veoImportMatch) {
      const id = veoImportMatch[1];
      if (!validId(id)) return json(res, 400, { error: 'Invalid project ID' });
      if (req.method === 'GET') { await getProject(id); return json(res, 200, getImportStatus(id)); }
      if (req.method === 'POST') {
        if (hasActiveAiJob(id)) return json(res,409,{error:"Finish or cancel player tracking before replacing footage"});
        if (hasActiveExport(id)) return json(res,409,{error:'Finish or cancel this match’s export before replacing footage'});
        const body = await readJson(req);
        if (!body || typeof body.url !== 'string') return json(res, 400, { error: 'Missing Veo match URL' });
        return json(res, 202, await beginVeoImport(id, body.url));
      }
      if (req.method === 'DELETE') return json(res, 200, cancelVeoImport(id));
    }
    const videoUrlMatch = /^\/api\/projects\/([^/]+)\/video-url$/.exec(path);
    if (videoUrlMatch && req.method === 'PUT') {
      if (!validId(videoUrlMatch[1])) return json(res, 400, { error: 'Invalid project ID' });
      if (hasActiveAiJob(videoUrlMatch[1])) return json(res,409,{error:"Finish player tracking first"});
      if (hasActiveExport(videoUrlMatch[1])) return json(res,409,{error:'Finish or cancel this match’s export before replacing footage'});
      requireIdle(videoUrlMatch[1]);
      const body = await readJson(req);
      if (!body || !Object.hasOwn(body, 'url')) return json(res, 400, { error: 'Missing URL' });
      return json(res, 200, await setVideoUrl(videoUrlMatch[1], body.url));
    }
    const uploadMatch = /^\/api\/projects\/([^/]+)\/video$/.exec(path);
    if (uploadMatch && req.method === 'PUT') {
      const id = uploadMatch[1];
      if (!validId(id)) return json(res, 400, { error: 'Invalid project ID' });
      if (hasActiveAiJob(id)) return json(res,409,{error:"Finish or cancel player tracking before replacing footage"});
        if (hasActiveExport(id)) return json(res,409,{error:'Finish or cancel this match’s export before replacing footage'});
      requireIdle(id);
      const nameHeader = req.headers['x-file-name'];
      let name;
      try { name = decodeURIComponent(Array.isArray(nameHeader) ? nameHeader[0] : nameHeader || ''); }
      catch { return json(res, 400, { error: 'Invalid filename encoding' }); }
      return json(res, 201, await uploadVideo(req, id, name));
    }
    const videoMatch = /^\/api\/videos\/([^/]+)$/.exec(path);
    if (videoMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      if (!validId(videoMatch[1])) return json(res, 400, { error: 'Invalid video ID' });
      return await serveVideo(req, res, videoMatch[1]);
    }
    if (path.startsWith('/api/')) return json(res, 404, { error: 'API route not found' });
    return staticFile(req, res, path);
  } catch (error) {
    errorResponse(res, error);
  }
}

export function createAppServer() { return createServer(handler); }

const executedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (executedDirectly) {
  validateCloudConfig();
  await ensureStorage();
  const port = Number(process.env.PORT || 3000);
  const host = cloudModeEnabled() ? '0.0.0.0' : '127.0.0.1'; // Cloud must be authenticated; local mode stays loopback-only.
  createAppServer().listen(port, host, () => {
    console.log(`\n  Touchline Studio — http://${host}:${port}\n  Data: ${process.env.TOUCHLINE_DATA_DIR || join(process.cwd(), 'data')}\n  Press Ctrl+C to stop.\n`);
  });
}
