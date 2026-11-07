/**
 * Local-only, opt-in AI tracking jobs. Browser never handles model URLs or signed Veo URLs.
 * The model worker gets a short-lived source over stdin; neither weights nor video are
 * uploaded to a cloud AI provider.  One local job at a time avoids memory/GPU overload.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getProject, VIDEO_DIR } from './storage.mjs';
import { resolvedStream, assertSafeStreamUrl } from './veo-stream.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SCRIPT = join(ROOT,'ai','worker.py');
const jobs = new Map();
let running = null;
const fail = (message, status = 400) => Object.assign(new Error(message),{status});

function pythonPath() {
  if (process.env.TOUCHLINE_AI_PYTHON) return process.env.TOUCHLINE_AI_PYTHON;
  return join(ROOT,'.venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
}
function ffmpegPath() {
  return process.env.TOUCHLINE_FFMPEG_PATH || (existsSync(join(ROOT,'tools',process.platform==='win32'?'ffmpeg.exe':'ffmpeg')) ? join(ROOT,'tools',process.platform==='win32'?'ffmpeg.exe':'ffmpeg') : 'ffmpeg');
}
async function videoSource(p) {
  if (p.video) {
    if (!p.video.storageName || basename(p.video.storageName)!==p.video.storageName) throw fail('Invalid video file reference',400);
    const path=join(VIDEO_DIR,p.video.storageName);
    await stat(path);
    return path;
  }
  if (p.remoteVideo) return resolvedStream(p);
  if (p.videoUrl) {
    const url=new URL(p.videoUrl);
    if (!['.mp4','.mov','.m4v','.webm'].includes(extname(url.pathname).toLowerCase())) throw fail('AI detection needs a direct video-file URL or an imported Veo match');
    return assertSafeStreamUrl(p.videoUrl);
  }
  throw fail('Open a playable video before tracking players');
}
export function validateAiRequest(value) {
  if (!value || typeof value!=='object' || Array.isArray(value) || !['detect','track'].includes(value.mode)) throw fail('Choose Detect players or Track selected player');
  if (typeof value.time!=='number' || !Number.isFinite(value.time) || value.time<0 || value.time>86400) throw fail('Invalid starting video time');
  const req={mode:value.mode,time:Number(value.time.toFixed(3))};
  if (value.mode==='track') {
    if (![value.x,value.y].every(n=>typeof n==='number' && Number.isFinite(n) && n>=0 && n<=1)) throw fail('Select a detected player in the video first');
    if (typeof value.seconds!=='number' || !Number.isFinite(value.seconds) || value.seconds<2 || value.seconds>15) throw fail('Tracking is limited to 2–15 seconds per run');
    Object.assign(req,{x:value.x,y:value.y,seconds:Number(value.seconds.toFixed(2))});
  }
  return req;
}
function state(job) {
  return {id:job.id,projectId:job.projectId,mode:job.mode,status:job.status,phase:job.phase,percent:job.percent,error:job.error,result:job.result,startedAt:job.startedAt};
}
export function getAiJob(id) {
  const job=jobs.get(id);
  if(!job)throw fail('AI job not found',404);
  return state(job);
}
export function hasActiveAiJob(projectId) {
  return !!running && jobs.get(running)?.projectId===projectId;
}
export function cancelAiJob(id) {
  const job=jobs.get(id);if(!job)throw fail('AI job not found',404);
  if(job.status==='running') {job.status='cancelled';job.phase='Cancelled';job.error=null;job.child?.kill(); if(running===id)running=null;}
  return state(job);
}
export function cancelAiForProject(projectId) {
  for (const [id,job] of jobs) if(job.projectId===projectId && job.status==='running') cancelAiJob(id);
}

export async function startAiJob(projectId, rawRequest, opts={}) {
  if (running) throw fail('A player-detection job is already running. Finish or cancel it before starting another.',409);
  const request=validateAiRequest(rawRequest);
  const p=await getProject(projectId);
  if(p.duration!==null && request.time>=p.duration) throw fail('Choose a point within the match');
  if(p.duration!==null && request.mode==='track') request.seconds=Math.min(request.seconds,Math.max(0,p.duration-request.time));
  if(request.mode==='track' && request.seconds<1) throw fail('Move earlier in the match before tracking');
  const python=opts.python || pythonPath();
  if (!opts.python && !existsSync(python)) throw fail('AI tracking is not installed yet. Run SETUP_AI_WINDOWS.cmd once, then restart the app.',503);
  // Resolve only project-owned sources (never accept an arbitrary URL/path from request JSON).
  const source=opts.source || await videoSource(p);
  const id=randomUUID();
  const job={id,projectId,mode:request.mode,status:'running',percent:0,phase:'Starting player detector…',error:null,result:null,startedAt:new Date().toISOString(),child:null};
  if(jobs.size>60) for(const [oldId,oldJob] of jobs) {if(oldJob.status!=='running'){jobs.delete(oldId);break;}}
  jobs.set(id,job);
  running=id;
  const config={...request,source,ffmpeg:opts.ffmpeg || ffmpegPath(),ffprobe:opts.ffprobe || ffmpegPath().replace(/ffmpeg(?:\.exe)?$/i,process.platform==='win32'?'ffprobe.exe':'ffprobe')};
  const child=spawn(python,[opts.script || SCRIPT,request.mode],{cwd:ROOT,stdio:['pipe','pipe','pipe'],windowsHide:true,shell:false});
  job.child=child;
  // Avoid passing signed Veo URLs on a process command line or persisting them to disk.
  child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify(config));
  let pending='';let haveResult=false;
  child.stdout.on('data',chunk=>{
    pending+=chunk.toString();
    if(pending.length>200000){pending='';return;}
    const lines=pending.split('\n');pending=lines.pop();
    for(const line of lines) {
      if(line.length>150000)continue;
      let data;try{data=JSON.parse(line);}catch{continue;}
      if(job.status!=='running')continue;
      if(data.type==='progress'){
        job.percent=Math.min(99,Math.max(0,Number(data.percent)||0));
        job.phase=String(data.phase||'Analysing video').slice(0,150);
      }else if(data.type==='result'){
        // Disallow arbitrary output: the frontend receives only coordinates and confidence.
        if(data.mode==='detect' && Array.isArray(data.people)){
          job.result={mode:'detect',time:request.time,people:data.people.slice(0,80)};
          haveResult=true;
        }else if(data.mode==='track' && Array.isArray(data.points) && data.points.length>=3 && data.points.length<=100){
          job.result={mode:'track',points:data.points,reason:String(data.reason||'completed').slice(0,100),trackId:data.trackId,frames:data.frames,coverage:data.coverage,meanConfidence:data.meanConfidence};
          haveResult=true;
        }
      }else if(data.type==='error'){
        // Avoid reporting a URL/credential if a third-party library included one.
        const err=String(data.message||'Tracking failed');
        job.error=/https?:\/\/|token=|signature=/i.test(err)?'Player tracking could not access or decode this footage.':err.slice(0,250);
      }
    }
  });
  child.stderr.on('data',()=>{}); // Never leak signed video URLs/model internals.
  child.on('error',()=>{if(job.status==='running'){job.status='failed';job.error='Could not launch Python. Run SETUP_AI_WINDOWS.cmd and restart Touchline Studio.';} if(running===id)running=null;});
  child.on('close',code=>{
    job.child=null;
    if(job.status==='running') {
      job.status=code===0 && haveResult?'completed':'failed';
      if(job.status==='completed'){job.phase='Analysis ready';job.percent=100;}
      else job.error ||= 'The player model could not complete the analysis. Check the AI setup guide and try a shorter clip.';
    }
    if(running===id)running=null;
  });
  return state(job);
}
