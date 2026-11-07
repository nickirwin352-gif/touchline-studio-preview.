/**
 * Local-only MP4 export queue. Never accepts arbitrary file paths or command-line
 * arguments from the browser. Source, clips and annotations come from a saved
 * project; remote Veo URLs are resolved temporarily and are never persisted.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { DATA_DIR, VIDEO_DIR, getProject } from './storage.mjs';
import { resolvedStream, assertSafeStreamUrl } from './veo-stream.mjs';

export const EXPORT_DIR = join(DATA_DIR, 'exports');
const jobs = new Map();
let activeId = null;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const round = (n) => Math.round(n);
const safeFilename = (name) => (name.normalize('NFKD').replace(/[^\w .-]+/g, '').trim().replace(/\s+/g, '_').slice(0, 65) || 'football_clip');

function assTime(seconds) {
  const hundredths = Math.round(seconds * 100);
  const h = Math.floor(hundredths / 360000), m = Math.floor(hundredths % 360000 / 6000);
  const s = Math.floor(hundredths % 6000 / 100), cs = hundredths % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}
const X = (v) => round(v * 1920);
const Y = (v) => round(v * 1080);
const p = (x, y) => `${round(x)} ${round(y)}`;
const assColour = (hex) => `&H${hex.slice(5,7)}${hex.slice(3,5)}${hex.slice(1,3)}&`.toUpperCase();
const cleanText = (value) => String(value || 'Label').replace(/[{}\\]/g, '').replace(/[\r\n]+/g, ' ').slice(0, 120);

function thickLine(x1, y1, x2, y2, thickness) {
  const dx = x2-x1, dy = y2-y1, length = Math.hypot(dx,dy) || 1;
  const nx = -(dy / length) * thickness / 2, ny = (dx / length) * thickness / 2;
  return `m ${p(x1+nx,y1+ny)} l ${p(x2+nx,y2+ny)} ${p(x2-nx,y2-ny)} ${p(x1-nx,y1-ny)}`;
}
function annotationVector(a) {
  const x1=X(a.x1),y1=Y(a.y1),x2=X(a.x2),y2=Y(a.y2), stroke=Math.max(2, a.width*1.9);
  if (a.type === 'curve') {
    const bend=Number(a.bend ?? -.18), cx=(x1+x2)/2+(y2-y1)*bend,cy=(y1+y2)/2-(x2-x1)*bend;
    const pts=[];
    for(let i=0;i<=25;i++) {const t=i/25;pts.push([((1-t)**2)*x1+2*(1-t)*t*cx+t*t*x2,((1-t)**2)*y1+2*(1-t)*t*cy+t*t*y2]);}
    const pieces=pts.slice(0,-1).map((q,i)=>thickLine(...q,...pts[i+1],stroke));
    const angle=Math.atan2(y2-cy,x2-cx),len=Math.max(22,stroke*5);
    pieces.push(`m ${p(x2,y2)} l ${p(x2-len*Math.cos(angle-.5),y2-len*Math.sin(angle-.5))} ${p(x2-len*Math.cos(angle+.5),y2-len*Math.sin(angle+.5))}`);
    return {path:pieces.join(' '),filled:true};
  }
  if (a.type==='zone') {
    const left=Math.min(x1,x2),top=Math.min(y1,y2),right=Math.max(x1,x2),bottom=Math.max(y1,y2);
    return {path:`m ${p(left,top)} l ${p(right,top)} ${p(right,bottom)} ${p(left,bottom)}`,filled:false};
  }
  if (a.type==='highlight'||a.type==='spotlight'||a.type==='footmarker') {
    const cx=(x1+x2)/2,cy=(y1+y2)/2,rx=Math.abs(x2-x1)/2,ry=Math.abs(y2-y1)/2,k=.5522847498;
    return {path:`m ${p(cx+rx,cy)} b ${p(cx+rx,cy+k*ry)} ${p(cx+k*rx,cy+ry)} ${p(cx,cy+ry)} b ${p(cx-k*rx,cy+ry)} ${p(cx-rx,cy+k*ry)} ${p(cx-rx,cy)} b ${p(cx-rx,cy-k*ry)} ${p(cx-k*rx,cy-ry)} ${p(cx,cy-ry)} b ${p(cx+k*rx,cy-ry)} ${p(cx+rx,cy-k*ry)} ${p(cx+rx,cy)}`,filled:false};
  }
  if (a.type === 'line' || a.type === 'arrow') {
    if (a.type === 'line') return { path: thickLine(x1,y1,x2,y2,stroke), filled: true };
    const angle=Math.atan2(y2-y1,x2-x1), len=Math.max(22,stroke*5);
    const hx=x2-len*Math.cos(angle),hy=y2-len*Math.sin(angle);
    const nx=-Math.sin(angle)*stroke/2,ny=Math.cos(angle)*stroke/2;
    const leftX=x2-len*1.1*Math.cos(angle-Math.PI/5),leftY=y2-len*1.1*Math.sin(angle-Math.PI/5);
    const rightX=x2-len*1.1*Math.cos(angle+Math.PI/5),rightY=y2-len*1.1*Math.sin(angle+Math.PI/5);
    return { path:`m ${p(x1+nx,y1+ny)} l ${p(hx+nx,hy+ny)} ${p(leftX,leftY)} ${p(x2,y2)} ${p(rightX,rightY)} ${p(hx-nx,hy-ny)} ${p(x1-nx,y1-ny)}`,filled:true };
  }
  if (a.type === 'rect') {
    const left=Math.min(x1,x2),top=Math.min(y1,y2),right=Math.max(x1,x2),bottom=Math.max(y1,y2);
    return { path:`m ${p(left,top)} l ${p(right,top)} ${p(right,bottom)} ${p(left,bottom)}`, filled:false };
  }
  if (a.type === 'ellipse') {
    const cx=(x1+x2)/2,cy=(y1+y2)/2,rx=Math.abs(x2-x1)/2,ry=Math.abs(y2-y1)/2,k=0.5522847498;
    return {path:`m ${p(cx+rx,cy)} b ${p(cx+rx,cy+k*ry)} ${p(cx+k*rx,cy+ry)} ${p(cx,cy+ry)} b ${p(cx-k*rx,cy+ry)} ${p(cx-rx,cy+k*ry)} ${p(cx-rx,cy)} b ${p(cx-rx,cy-k*ry)} ${p(cx-k*rx,cy-ry)} ${p(cx,cy-ry)} b ${p(cx+k*rx,cy-ry)} ${p(cx+rx,cy-k*ry)} ${p(cx+rx,cy)}`,filled:false};
  }
  if (a.type === 'pen') {
    if (!a.points?.length) return null;
    const pts=a.points.map(q => [X(q.x),Y(q.y)]);
    if (pts.length === 1) pts.push([pts[0][0]+1,pts[0][1]+1]);
    // ASS outline applies to a thin vector path; this keeps the stroke close to the editor.
    return { path:`m ${p(...pts[0])} l ${pts.slice(1).map(q => p(...q)).join(' ')}`, filled:false };
  }
  return null;
}

/** Exported for deterministic tests. Timings are relative to the selected segment. */
export function makeAss(annotations, clip, withAnnotations=true) {
  const header=`[Script Info]\nScriptType: v4.00+\nPlayResX: 1920\nPlayResY: 1080\nScaledBorderAndShadow: yes\nWrapStyle: 2\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,38,&H00FFFFFF,&H00FFFFFF,&H00101820,&H00000000,-1,0,0,0,100,100,0,0,1,0,0,7,0,0,0,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n`;
  if (!withAnnotations) return header;
  const events=[];
  for(const a of annotations) {
    const start=Math.max(a.start,clip.start),end=Math.min(a.end,clip.end);
    if(end-start<.01) continue;
    const colour=assColour(a.color), fadeMs=Math.min(Math.round((a.fade || 0)*1000),Math.round((end-start)*500));
    const effect=fadeMs>0?`\\fad(${fadeMs},${fadeMs})`:'';
    // Keyframed circles/spotlights: one ASS event per movement segment; timing is relative to the export clip.
    const keys=[{time:a.start,x:a.x1,y:a.y1},...(a.keyframes||[])].sort((b,c)=>b.time-c.time);
    const bounds=[a.start,...keys.map(k=>k.time).filter(t=>t>a.start&&t<a.end),a.end].filter((t,i,arr)=>i===0||t>arr[i-1]);
    let segments=a.keyframes?.length ? bounds.slice(0,-1).map((b,i)=>[b,bounds[i+1]]) : [[a.start,a.end]];
    if(a.type==='spotlight' && a.keyframes?.length){
      const frames=[];for(let t=start;t<end-.01;t+=.12)frames.push([t,Math.min(end,t+.12)]);
      segments=frames;
    }
    for(const [segmentStart,segmentEnd] of segments) {
      const s=Math.max(start,segmentStart),e=Math.min(end,segmentEnd);
      if(e-s<.01) continue;
      const posAt=t=>{
        if(!a.keyframes?.length) return {x:a.x1,y:a.y1};
        if(t<=keys[0].time) return keys[0];
        for(let i=1;i<keys.length;i++) if(t<=keys[i].time){const l=keys[i-1],r=keys[i],u=(t-l.time)/Math.max(.00001,r.time-l.time);return{x:l.x+(r.x-l.x)*u,y:l.y+(r.y-l.y)*u};}
        return keys.at(-1);
      };
      const from=posAt(s),to=posAt(e),dx=from.x-a.x1,dy=from.y-a.y1;
      const copy={...a,x1:a.x1+dx,y1:a.y1+dy,x2:a.x2+dx,y2:a.y2+dy,points:(a.points||[]).map(p=>({x:p.x+dx,y:p.y+dy}))};
      const motion=a.keyframes?.length && (Math.abs(from.x-to.x)+Math.abs(from.y-to.y)>.0001)
        ? `\\move(${X(from.x)},${Y(from.y)},${X(to.x)},${Y(to.y)})` : `\\pos(${X(from.x)},${Y(from.y)})`;
      let override;
      if(a.type==='text') {
        override=`{\\an7${motion}\\1c${colour}\\3c&H001018&\\bord3\\shad1\\fs${round((18+a.width*4)*1.9)}${effect}}${cleanText(a.text)}`;
      } else if(a.type==='spotlight') {
        // Inverse vector clip darkens the frame *outside* the highlighted ellipse.
        const ellipse=annotationVector(copy);
        override=`{\\an7\\pos(0,0)\\p1\\1c&H000000&\\1a&H65&\\bord0\\iclip(1,${ellipse.path})${(!a.keyframes?.length ? effect : '')}}m 0 0 l 1920 0 1920 1080 0 1080{\\p0}`;
      } else {
        const vector=annotationVector(copy);if(!vector) continue;
        if(a.type==='zone'){
          const fillLine=`{\\an7\\pos(0,0)\\p1\\1c${colour}\\1a&HBB&\\bord0}m ${p(X(copy.x1),Y(copy.y1))} l ${p(X(copy.x2),Y(copy.y1))} ${p(X(copy.x2),Y(copy.y2))} ${p(X(copy.x1),Y(copy.y2))}{\\p0}`;
          events.push(`Dialogue: -1,${assTime(s-clip.start)},${assTime(e-clip.start)},Default,,0,0,0,,${fillLine}`);
        }
        // ASS vector geometry uses absolute coordinates; \move on an anchor must be offset from the starting x1/y1.
        const originMotion=a.keyframes?.length && (Math.abs(from.x-to.x)+Math.abs(from.y-to.y)>.0001)
          ? `\\move(0,0,${X(to.x-from.x)},${Y(to.y-from.y)})`: '\\pos(0,0)';
        const fill=a.type==='zone' ? `\\1a&HBB&` : '';
        override=vector.filled
          ? `{\\an7${originMotion}\\p1\\1c${colour}${fill}\\bord0\\shad0${effect}}${vector.path}{\\p0}`
          : `{\\an7${originMotion}\\p1\\1a&HFF&\\3a&H00&\\3c${colour}\\bord${(a.width*1.9/2).toFixed(1)}\\shad0${effect}}${vector.path}{\\p0}`;
      }
      events.push(`Dialogue: ${a.type==='spotlight'?-1:0},${assTime(s-clip.start)},${assTime(e-clip.start)},Default,,0,0,0,,${override}`);
    }
  }
  return header+events.join('\n')+(events.length?'\n':'');
}

const ffmpegProgram = () => {
  const explicit=process.env.TOUCHLINE_FFMPEG_PATH;
  if (explicit) return explicit;
  const bundled=resolve(process.cwd(),'tools',process.platform==='win32'?'ffmpeg.exe':'ffmpeg');
  return existsSync(bundled)?bundled:'ffmpeg';
};
async function checkFFmpeg() {
  const program=ffmpegProgram();
  return await new Promise((resolveCheck,reject) => {
    const child=spawn(program,['-hide_banner','-version'],{windowsHide:true,stdio:'ignore'});
    child.on('error',e => reject(fail(e.code==='ENOENT'?'FFmpeg is not installed. Install FFmpeg then restart Touchline Studio.':'Cannot start FFmpeg',503)));
    child.on('close',code => code===0?resolveCheck(program):reject(fail('FFmpeg is not available',503)));
  });
}

function statusOf(job) { return {id:job.id,projectId:job.projectId,name:job.name,status:job.status,percent:job.percent,phase:job.phase,error:job.error,bytes:job.bytes,hasAnnotations:job.hasAnnotations,startedAt:job.startedAt}; }
export function getExportJob(id) { const job=jobs.get(id); if (!job) throw fail('Export job not found',404); return statusOf(job); }
export function hasActiveExport(projectId) { return !!activeId && jobs.get(activeId)?.projectId===projectId; }
export async function discardExportsForProject(projectId) {
  for (const [id,job] of jobs) {
    if (job.projectId!==projectId || job.status==='running') continue;
    if (job.path) await rm(job.path,{force:true}).catch(()=>{});
    jobs.delete(id);
  }
}
export function cancelExport(id) {
  const job=jobs.get(id); if (!job) throw fail('Export job not found',404);
  if (job.status !== 'running') return statusOf(job);
  job.cancelled=true;
  job.child?.kill('SIGTERM');
  job.phase='Cancelling export…';
  return statusOf(job);
}

async function resolveInput(project) {
  if (project.video) {
    const filename=join(VIDEO_DIR,project.video.storageName);
    await stat(filename);
    return filename;
  }
  if (project.remoteVideo) return resolvedStream(project);
  if (project.videoUrl) {
    const url=new URL(project.videoUrl);
    if (!['.mp4','.mov','.m4v','.webm'].includes(extname(url.pathname).toLowerCase())) throw fail('Only direct video-file URLs can be exported.');
    return assertSafeStreamUrl(project.videoUrl);
  }
  throw fail('This project has no playable footage.');
}

async function runCommand(job, program, args, cwd, beginSeconds, durationSeconds, overallDuration) {
  return new Promise((resolveDone,reject) => {
    if (job.cancelled) return reject(fail('Export cancelled',409));
    const child=spawn(program,args,{cwd,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});
    job.child=child;
    let output='',errors='';
    child.stdout.on('data',chunk=>{
      output+=(chunk.toString());
      if (output.length > 20000) output=output.slice(-10000);
      const matches=[...output.matchAll(/out_time_(?:us|ms)=(\d+)/g)];
      const value=matches.at(-1);
      if (value && durationSeconds>0) job.percent=Math.min(99.5,Math.round(1000*(beginSeconds+Math.min(durationSeconds,Number(value[1])/1e6))/overallDuration)/10);
    });
    child.stderr.on('data',chunk => {errors=(errors+chunk.toString()).slice(-4000);});
    child.on('error',e=>reject(fail(e.code==='ENOENT'?'FFmpeg was not found. Install FFmpeg and restart Touchline Studio.':'Could not start FFmpeg',503)));
    child.on('close',code=>{
      job.child=null;
      if(job.cancelled) return reject(fail('Export cancelled',409));
      if(code===0) resolveDone();
      else {
        // Do not expose remote signed URLs or tokens from ffmpeg stderr to the UI.
        if(/No such filter: subtitles|No such filter: ass|Error initializing filter 'subtitles'/.test(errors)) reject(fail('This FFmpeg build needs the libass subtitles filter to burn in drawings.',503));
        else reject(fail('FFmpeg could not render this clip. Verify the video is still accessible and uses a supported codec.',502));
      }
    });
  });
}

// Re-time a finished clip by inserting held video frames and silent audio.
// Using the already subtitled source ensures the export freezes EXACTLY what the analyst saw.
export function freezeFilterGraph(freezes, length, hasAudio) {
  const events=freezes.filter(f=>f.at>=0 && f.at<length-.05).sort((a,b)=>a.at-b.at);
  if(!events.length) return null;
  const sections=[];let prev=0;
  for(const f of events){if(f.at>prev+.001)sections.push({kind:'play',start:prev,end:f.at});sections.push({kind:'hold',at:f.at,hold:f.hold});prev=f.at;}
  sections.push({kind:'play',start:prev,end:length});
  const videoSplit=sections.map((_,i)=>`[v${i}]`).join('');
  const filters=[`[0:v]fps=25,split=${sections.length}${videoSplit}`];
  if(hasAudio){const sourceCount=sections.filter(s=>s.kind==='play').length;filters.push(`[0:a]asplit=${sourceCount}${Array.from({length:sourceCount},(_,i)=>`[a${i}]`).join('')}`);}
  let ai=0;const concat=[];
  for(let i=0;i<sections.length;i++){
    const s=sections[i];
    if(s.kind==='hold') filters.push(`[v${i}]trim=start=${s.at}:duration=0.08,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop=${Math.ceil(s.hold*25)},setpts=N/(25*TB),trim=duration=${s.hold},setpts=PTS-STARTPTS[vo${i}]`);
    else filters.push(`[v${i}]trim=start=${s.start}:end=${s.end},setpts=PTS-STARTPTS[vo${i}]`);
    concat.push(`[vo${i}]`);
    if(hasAudio){
      if(s.kind==='hold') filters.push(`anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=${s.hold},asetpts=PTS-STARTPTS[ao${i}]`);
      else filters.push(`[a${ai++}]atrim=start=${s.start}:end=${s.end},asetpts=PTS-STARTPTS[ao${i}]`);
      concat.push(`[ao${i}]`);
    }
  }
  filters.push(`${concat.join('')}concat=n=${sections.length}:v=1:a=${hasAudio?1:0}[vout]${hasAudio?'[aout]':''}`);
  return filters.join(';');
}
async function audioPresent(path) {
  const program=ffmpegProgram().replace(/ffmpeg(?:\.exe)?$/i,process.platform==='win32'?'ffprobe.exe':'ffprobe');
  try {const output=await new Promise((resolve,reject)=>{
    const child=spawn(program,['-v','error','-select_streams','a','-show_entries','stream=index','-of','csv=p=0',path],{windowsHide:true});
    let data='';child.stdout.on('data',c=>data+=c.toString());child.on('error',reject);child.on('close',code=>code===0?resolve(data):reject(new Error('ffprobe unavailable')));
  });return !!output.trim();}catch{throw fail('FFprobe is required to export freeze frames. Install the full FFmpeg package and restart Touchline Studio.',503);}
}
function zoompanFilter(zooms,clip,quality) {
  const found=(zooms||[]).filter(z=>z.start<clip.end&&z.end>clip.start);
  if(!found.length)return null;
  const expr=(values,defaultValue)=>found.slice().reverse().reduce((acc,z)=>{
    const st=Math.max(0,z.start-clip.start).toFixed(3),en=Math.max(0,z.end-clip.start).toFixed(3);
    return `if(between(in_time\\,${st}\\,${en})\\,${values(z)}\\,${acc})`;
  },defaultValue);
  const z=expr(v=>v.scale.toFixed(3),'1');
  // x/y are input-pixel coordinates and use current zoom factor.
  const x=expr(v=>`max(0\\,min(iw-iw/zoom\\,iw*${v.x.toFixed(4)}-iw/(2*zoom)))`,'(iw-iw/zoom)/2');
  const y=expr(v=>`max(0\\,min(ih-ih/zoom\\,ih*${v.y.toFixed(4)}-ih/(2*zoom)))`,'(ih-ih/zoom)/2');
  return `zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${quality==='720p'?'1280x720':'1920x1080'}:fps=25`;
}

async function perform(job, project, clips, options) {
  const work=await mkdtemp(join(EXPORT_DIR,'work-'));
  job.work=work;
  try {
    job.phase='Checking FFmpeg and video access…';
    const program=await checkFFmpeg();
    if(job.cancelled) throw fail('Export cancelled',409);
    const source=await resolveInput(project);
    const total=clips.reduce((n,c)=>n+c.end-c.start,0);
    let done=0;
    const parts=[];
    for(let i=0;i<clips.length;i++) {
      if(job.cancelled) throw fail('Export cancelled',409);
      const clip=clips[i], duration=clip.end-clip.start, target=`part-${String(i).padStart(3,'0')}.mp4`;
      const ass=`annotations-${i}.ass`;
      await writeFile(join(work,ass), makeAss(project.annotations || [],clip,options.annotations), 'utf8');
      job.phase=`Rendering clip ${i+1} of ${clips.length}: ${clip.title}`;
      const videoFilters=[];
      if(options.quality==='720p') videoFilters.push('scale=w=1280:h=720:force_original_aspect_ratio=decrease','pad=1280:720:(ow-iw)/2:(oh-ih)/2');
      else videoFilters.push('scale=w=1920:h=1080:force_original_aspect_ratio=decrease','pad=1920:1080:(ow-iw)/2:(oh-ih)/2');
      // Render markings against the actual video frame BEFORE adding any padding.
      // This keeps positions aligned for 4:3 and other non-16:9 source footage.
      videoFilters.unshift(...(options.annotations ? [`subtitles=filename=${ass}`] : []));
      videoFilters.push('setsar=1');
      const zoom=zoompanFilter(project.zooms,clip,options.quality);
      if(zoom) videoFilters.push(zoom); // Zoom both footage AND already-rendered drawings.

      const args=['-hide_banner','-nostdin','-loglevel','error','-y','-ss',String(clip.start),'-i',source,'-t',String(duration),'-map','0:v:0','-map','0:a:0?','-vf',videoFilters.join(','),'-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p','-c:a','aac','-b:a','128k','-ar','48000','-ac','2','-movflags','+faststart','-progress','pipe:1',target];
      await runCommand(job,program,args,work,done,duration,total);
      const freezes=(project.freezes||[]).filter(f=>f.at>=clip.start&&f.at<clip.end-.05).map(f=>({...f,at:Number((f.at-clip.start).toFixed(3))}));
      if(freezes.length){
        job.phase=`Adding ${freezes.length} freeze frame${freezes.length===1?'':'s'}…`;
        const hasAudio=await audioPresent(join(work,target));
        const filter=freezeFilterGraph(freezes,duration,hasAudio);
        const frozen=`frozen-${String(i).padStart(3,'0')}.mp4`;
        await runCommand(job,program,['-hide_banner','-nostdin','-loglevel','error','-y','-i',target,'-filter_complex',filter,'-map','[vout]',...(hasAudio?['-map','[aout]']:[]),'-c:v','libx264','-preset','veryfast','-crf','22','-pix_fmt','yuv420p',...(hasAudio?['-c:a','aac','-b:a','128k']:[]),'-movflags','+faststart',frozen],work,done,0,total);
        await rm(join(work,target),{force:true});
        parts.push(frozen);
      } else parts.push(target);
      done+=duration;
    }
    const output=join(EXPORT_DIR,`${job.id}.mp4`);
    if(parts.length===1) await rename(join(work,parts[0]),output);
    else {
      job.phase='Joining clips into one MP4…';
      // The concat file is created exclusively from fixed internal part names.
      await writeFile(join(work,'segments.txt'),parts.map(x=>`file '${x}'`).join('\n')+'\n');
      await runCommand(job,program,['-hide_banner','-nostdin','-loglevel','error','-y','-f','concat','-safe','0','-i','segments.txt','-c','copy','-movflags','+faststart',output],work,total,0,total);
    }
    if(job.cancelled) {await rm(output,{force:true}); throw fail('Export cancelled',409);}
    job.bytes=(await stat(output)).size;
    job.status='completed'; job.percent=100; job.phase='Ready to download';
    job.path=output;
  } finally { await rm(work,{recursive:true,force:true}).catch(()=>{}); job.work=null; job.child=null; }
}

export async function startExport(projectId, data) {
  if(activeId) throw fail('Another export is in progress. Finish or cancel it before starting a new one.',409);
  if(!data || typeof data!=='object' || Array.isArray(data) || !['720p','1080p'].includes(data.quality) || typeof data.annotations!=='boolean') throw fail('Choose export resolution and annotation option');
  if((!!data.clipId)===(!!data.playlistId)) throw fail('Select one saved clip or one playlist');
  const project=await getProject(projectId);
  if(!project.video && !project.videoUrl && !project.remoteVideo) throw fail('Import footage before exporting');
  const clipMap=new Map((project.clips || []).map(c=>[c.id,c]));
  let clips,name;
  if(data.clipId) {
    const clip=clipMap.get(data.clipId);
    if(!clip) throw fail('Saved clip not found',404);
    clips=[clip]; name=clip.title;
  } else {
    const playlist=(project.playlists || []).find(p=>p.id===data.playlistId);
    if(!playlist) throw fail('Playlist not found',404);
    clips=playlist.clipIds.map(id=>clipMap.get(id)); name=playlist.title;
    if(clips.some(c=>!c)) throw fail('Playlist references a missing clip');
  }
  const seconds=clips.reduce((sum,c)=>sum+(c.end-c.start),0);
  if(!clips.length || clips.length>40 || seconds>2700) throw fail('Export must contain 1–40 clips and at most 45 minutes of footage');
  const job={id:randomUUID(),projectId,name:`${safeFilename(name)}.mp4`,status:'running',percent:0,phase:'Preparing export…',startedAt:new Date().toISOString(),error:null,bytes:null,hasAnnotations:data.annotations,cancelled:false,child:null,path:null,work:null};
  await mkdir(EXPORT_DIR,{recursive:true});
  jobs.set(job.id,job); activeId=job.id;
  // Return immediately. The browser polls the job, and local storage remains intact if it fails.
  void perform(job,project,clips,data).catch(e=>{
    job.status=job.cancelled?'cancelled':'failed'; job.error=e?.message||'Export failed'; job.phase=job.status==='cancelled'?'Cancelled':'Export failed';
  }).finally(()=>{if(activeId===job.id)activeId=null;});
  return statusOf(job);
}

export async function downloadExport(jobId,req,res) {
  const job=jobs.get(jobId);
  if(!job) throw fail('Export not found',404);
  if(job.status!=='completed' || !job.path) throw fail('Export is not ready',409);
  const info=await stat(job.path);
  res.writeHead(200,{'Content-Type':'video/mp4','Content-Disposition':`attachment; filename="${job.name}"`,'Content-Length':info.size,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
  if(req.method==='HEAD') return res.end();
  await pipeline(createReadStream(job.path),res);
}
