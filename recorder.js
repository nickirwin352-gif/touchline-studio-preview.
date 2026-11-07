/**
 * Touchline Studio browser renderer.
 * Captures an actual local video with timeline drawings and freeze holds,
 * entirely in the browser. No Python, FFmpeg, server or network upload.
 */
export const clampRange = (n, low, high) => Math.min(high, Math.max(low, Number.isFinite(Number(n)) ? Number(n) : low));
export function zoomStateAt(zooms, t) {
  const z = (zooms || []).find(q => t >= q.at && t <= q.at + q.hold && q.hold > 0);
  if (!z) return { x: .5, y: .5, scale: 1 };
  const ramp = Math.min(.42, z.hold / 3);
  const fraction = clampRange(Math.min((t - z.at) / ramp, (z.at + z.hold - t) / ramp), 0, 1);
  const smooth = fraction * fraction * (3 - 2 * fraction);
  return { x: clampRange(z.x, 0, 1), y: clampRange(z.y, 0, 1), scale: 1 + (clampRange(z.scale, 1, 3) - 1) * smooth };
}
export function preferredRecordingMime(Recorder = typeof MediaRecorder !== 'undefined' ? MediaRecorder : null) {
  if (!Recorder?.isTypeSupported) return null;
  return ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    .find(type => Recorder.isTypeSupported(type)) || null;
}
export function validExportRange(start, end, duration, maxSeconds = 180) {
  const a = clampRange(start, 0, duration), b = clampRange(end, 0, duration);
  return b > a && b - a >= .25 && b - a <= maxSeconds;
}
function opacityAtTime(a, t) {
  if (t < a.start || t > a.end) return 0;
  const f = Math.max(0, Number(a.fade) || 0);
  return f ? clampRange(Math.min((t-a.start)/f, (a.end-t)/f), 0, 1) : 1;
}
function pathArrow(ctx, x1, y1, x2, y2, weight) {
  ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
  const angle=Math.atan2(y2-y1,x2-x1), size=13+weight*2;
  ctx.beginPath();ctx.moveTo(x2,y2);
  ctx.lineTo(x2-size*Math.cos(angle-.44),y2-size*Math.sin(angle-.44));
  ctx.lineTo(x2-size*Math.cos(angle+.44),y2-size*Math.sin(angle+.44));
  ctx.closePath();ctx.fill();
}
/** Draws vector annotations at their real timeline times, including fades/animations. */
export function paintAnnotations(ctx, annotations, t, width, height) {
  const H=height/width*1000;
  ctx.save();ctx.scale(width/1000,height/H);
  for (const a of annotations || []) {
    const alpha=opacityAtTime(a,t);
    if (alpha<=0) continue;
    const x=clampRange(a.x,0,1)*1000,y=clampRange(a.y,0,1)*H;
    const x2=clampRange(a.x2??a.x,0,1)*1000,y2=clampRange(a.y2??a.y,0,1)*H;
    const weight=clampRange(a.weight||4,1,12);
    ctx.save();ctx.globalAlpha=alpha;ctx.strokeStyle=a.color||'#b7ff75';ctx.fillStyle=a.color||'#b7ff75';
    ctx.lineWidth=weight*1.4;ctx.lineCap='round';ctx.lineJoin='round';
    if(a.appearance==='pop' && ['ring','text','spotlight'].includes(a.type)){
      const delta=clampRange((t-a.start)/.32,0,1);
      const overshoot=1+Math.sin(delta*Math.PI)*.12;
      const scale=(.65+.35*delta)*overshoot;
      ctx.translate(x,y);ctx.scale(scale,scale);ctx.translate(-x,-y);
    }
    switch(a.type){
      case 'ring': {
        const rx=Math.max(10,30+weight*3),ry=Math.max(4,7+weight*1.1);
        ctx.save();ctx.globalAlpha=alpha*.32;ctx.lineWidth=weight*3;ctx.beginPath();ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2);ctx.stroke();ctx.restore();
        ctx.lineWidth=Math.max(2,weight*.7);ctx.beginPath();ctx.ellipse(x,y,rx,ry,0,0,Math.PI*2);ctx.stroke();break;
      }
      case 'spotlight':
        ctx.save();ctx.globalAlpha=alpha*.16;ctx.beginPath();ctx.arc(x,y,Math.max(32,weight*11),0,Math.PI*2);ctx.fill();ctx.restore();
        ctx.beginPath();ctx.arc(x,y,Math.max(32,weight*11),0,Math.PI*2);ctx.stroke();break;
      case 'ellipse':
        ctx.beginPath();ctx.ellipse((x+x2)/2,(y+y2)/2,Math.max(.5,Math.abs(x2-x)/2),Math.max(.5,Math.abs(y2-y)/2),0,0,Math.PI*2);ctx.stroke();break;
      case 'rect':
        ctx.strokeRect(Math.min(x,x2),Math.min(y,y2),Math.max(1,Math.abs(x2-x)),Math.max(1,Math.abs(y2-y)));break;
      case 'pen': {
        const points=(a.points||[]).filter(q=>Number.isFinite(q.x)&&Number.isFinite(q.y));
        if(points.length){ctx.beginPath();ctx.moveTo(points[0].x*1000,points[0].y*H);
          for(const p of points.slice(1))ctx.lineTo(p.x*1000,p.y*H);ctx.stroke();}
        break;
      }
      case 'text':
        ctx.font='800 '+(22+weight*2)+'px system-ui, Arial, sans-serif';
        ctx.textBaseline='middle';ctx.lineWidth=5;ctx.strokeStyle='#06121a';
        ctx.strokeText((a.label||'Label').slice(0,120),x,y);ctx.fillText((a.label||'Label').slice(0,120),x,y);break;
      case 'arrow':pathArrow(ctx,x,y,x2,y2,weight);break;
      case 'line':ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x2,y2);ctx.stroke();break;
    }
    ctx.restore();
  }
  ctx.restore();
}
export function paintVideoFrame(ctx, video, annotations, zooms, t, width, height) {
  ctx.save();ctx.clearRect(0,0,width,height);
  const z=zoomStateAt(zooms,t);
  ctx.translate(z.x*width,z.y*height);ctx.scale(z.scale,z.scale);ctx.translate(-z.x*width,-z.y*height);
  ctx.drawImage(video,0,0,width,height);
  paintAnnotations(ctx,annotations,t,width,height);
  ctx.restore();
}
const mediaSources = new WeakMap();
async function connectVideoAudio(video) {
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return null;
  let pair=mediaSources.get(video);
  if (!pair) {
    const AudioContextClass=typeof AudioContext !== 'undefined'?AudioContext:webkitAudioContext;
    const ctx=new AudioContextClass();
    const source=ctx.createMediaElementSource(video);
    source.connect(ctx.destination);
    pair={ctx,source};mediaSources.set(video,pair);
  }
  await pair.ctx.resume();
  const destination=pair.ctx.createMediaStreamDestination();
  pair.source.connect(destination);
  return {destination, disconnect(){try{pair.source.disconnect(destination);}catch{}}};
}
async function seekMedia(video, t) {
  if(Math.abs(video.currentTime-t)<.03)return;
  await new Promise((resolve,reject)=>{
    let timeout;
    const done=(err)=>{
      clearTimeout(timeout);video.removeEventListener('seeked',ok);video.removeEventListener('error',bad);
      if(err)reject(err);else resolve();
    };
    const ok=()=>done(),bad=()=>done(new Error('Could not seek the video'));
    video.addEventListener('seeked',ok,{once:true});video.addEventListener('error',bad,{once:true});
    timeout=setTimeout(()=>done(new Error('Video seek timed out')),12000);
    try{video.currentTime=t;}catch(err){done(err);}
  });
}
export async function recordAnnotatedClip({
  video, annotations, freezes, zooms, start, end, width = 1280, withAudio = true,
  signal, onProgress = ()=>{}
}) {
  if(!validExportRange(start,end,video.duration))throw new Error('Select a clip between 0.25 seconds and 3 minutes.');
  if(typeof MediaRecorder==='undefined' || !HTMLCanvasElement.prototype.captureStream)throw new Error('This browser cannot record videos. Try the latest Chrome or Edge.');
  const mime=preferredRecordingMime();
  if(!mime)throw new Error('This browser does not support MP4/WebM recording.');
  if(signal?.aborted)throw new DOMException('Cancelled','AbortError');
  const outputWidth=Math.round(clampRange(width,480,1920)/2)*2;
  const outputHeight=Math.round(outputWidth*(video.videoHeight||9)/(video.videoWidth||16)/2)*2;
  if(!Number.isFinite(outputHeight)||outputHeight<2)throw new Error('Cannot identify video dimensions.');
  const canvas=document.createElement('canvas');canvas.width=outputWidth;canvas.height=outputHeight;
  const ctx=canvas.getContext('2d',{alpha:false});
  if(!ctx)throw new Error('Cannot create video canvas.');
  await seekMedia(video,start);
  try {
    paintVideoFrame(ctx,video,annotations,zooms,start,outputWidth,outputHeight);
    ctx.getImageData(0,0,1,1); // detect cross-origin canvas restrictions before beginning
  } catch(err) { throw new Error('Browser security blocked rendering this video. Use an MP4 file from your device.'); }
  const canvasStream=canvas.captureStream(30);
  let audio=null, stream=canvasStream, recorder=null, raf=0, finished=false, stopped=false, aborted=false;
  const chunks=[];
  try {
    if(withAudio) {
      try {
        audio=await connectVideoAudio(video);
        if(audio)stream=new MediaStream([...canvasStream.getVideoTracks(),...audio.destination.stream.getAudioTracks()]);
      } catch(err){console.warn('Audio unavailable; exporting silent video',err);}
    }
    recorder=new MediaRecorder(stream,{mimeType:mime,videoBitsPerSecond:Math.max(2500000,Math.round(outputWidth/1280*5500000))});
    const result=new Promise((resolve,reject)=>{
      recorder.ondataavailable=evt=>{if(evt.data?.size)chunks.push(evt.data);};
      recorder.onerror=evt=>reject(evt.error||new Error('Recording failed.'));
      recorder.onstop=()=>{
        if(aborted)return reject(new DOMException('Cancelled','AbortError'));
        if(!chunks.length)return reject(new Error('Browser did not produce video data.'));
        const blob=new Blob(chunks,{type:mime});
        resolve({blob,mimeType:mime,extension:mime.includes('mp4')?'mp4':'webm',audioIncluded:!!audio});
      };
    });
    const safeStop=()=>{
      if(stopped)return;stopped=true;cancelAnimationFrame(raf);video.pause();
      if(recorder.state!=='inactive')recorder.stop();
    };
    const cancel=()=>{aborted=true;safeStop();};
    signal?.addEventListener('abort',cancel,{once:true});
    const activeFreezes=(freezes||[]).filter(f=>f.at>start+.05 && f.at<end-.05).sort((a,b)=>a.at-b.at);
    let nextFreeze=0, holdUntil=0;
    const draw=(time)=>{
      if(finished||stopped)return;
      const t=video.currentTime;
      try{
        if(holdUntil && time>=holdUntil){
          holdUntil=0;video.play().catch(()=>{safeStop();});
        }
        if(!holdUntil && nextFreeze<activeFreezes.length && t>=activeFreezes[nextFreeze].at){
          const f=activeFreezes[nextFreeze++];holdUntil=time+clampRange(f.hold,.5,20)*1000;video.pause();
        }
        paintVideoFrame(ctx,video,annotations,zooms,t,outputWidth,outputHeight);
        onProgress(Math.round(clampRange((t-start)/(end-start),0,1)*100),t);
        if(t>=end-.035 || video.ended) {safeStop();return;}
      }catch(err){console.error('Rendering failed',err);aborted=true;safeStop();return;}
      raf=requestAnimationFrame(draw);
    };
    recorder.start(1000);
    raf=requestAnimationFrame(draw);
    await video.play();
    const output=await result;
    finished=true;
    return output;
  } finally {
    cancelAnimationFrame(raf);video.pause();
    if(recorder && recorder.state!=='inactive')recorder.stop();
    canvasStream.getTracks().forEach(track=>track.stop());
    audio?.disconnect();
    signal?.removeEventListener('abort',()=>{});
  }
}
