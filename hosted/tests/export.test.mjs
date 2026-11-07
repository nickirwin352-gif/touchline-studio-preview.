import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const dir=await mkdtemp(join(tmpdir(),'touchline-export-'));
process.env.TOUCHLINE_DATA_DIR=dir;
const {createAppServer}=await import('../server/index.mjs');
const {makeAss}=await import('../server/export.mjs');
let server,root;
before(async()=>{server=createAppServer(); await new Promise(r=>server.listen(0,'127.0.0.1',r));root=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{await new Promise(r=>server.close(r)); await rm(dir,{recursive:true,force:true});});
const now='2026-11-07T12:00:00Z';
const newClip=(title,start,end)=>({id:randomUUID(),title,start,end,category:'Pressing',notes:'',createdAt:now,updatedAt:now});
const ann=(type,config={})=>({id:randomUUID(),type,x1:.15,y1:.15,x2:.8,y2:.7,points:[],text:'MATCH ANALYSIS',color:'#b7ff66',width:5,start:.1,end:1.4,...config});
async function req(path,method='GET',data) { const resp=await fetch(root+path,{method,headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined});return {status:resp.status,data:await resp.json()}; }
async function fixture(){
  const output=join(dir,'fixture.mp4');
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','color=c=black:s=320x180:r=25:d=3','-f','lavfi','-i','sine=frequency=600:sample_rate=48000:duration=3','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest','-y',output]);
  return readFile(output);
}
let sourceBytes;
before(async()=>{sourceBytes=await fixture();});
async function projectWithClips() {
  const p=(await req('/api/projects','POST',{title:'Friendly vs Academy'})).data;
  const response=await fetch(`${root}/api/projects/${p.id}/video`,{method:'PUT',headers:{'X-File-Name':'fixture.mp4'},body:sourceBytes});
  assert.equal(response.status,201);
  const c1=newClip('High press',0.2,1.2), c2=newClip('Counterattack',1.7,2.5);
  const playlist={id:randomUUID(),title:'Two actions',clipIds:[c1.id,c2.id],createdAt:now,updatedAt:now};
  const annotations=[ann('arrow'),ann('line',{start:1.8,end:2.3}),ann('rect'),ann('ellipse'),ann('text'),ann('pen',{points:[{x:.1,y:.1},{x:.2,y:.2},{x:.4,y:.1}]})];
  assert.equal((await req(`/api/projects/${p.id}`,'PATCH',{duration:3,clips:[c1,c2],playlists:[playlist],annotations})).status,200);
  return {p,c1,c2,playlist};
}
async function awaitJob(id) {
  for(let i=0;i<120;i++) {
    const result=(await req(`/api/exports/${id}`)).data;
    if(result.status!=='running') return result;
    await new Promise(r=>setTimeout(r,150));
  }
  throw new Error('Export did not finish within test deadline');
}
test('ASS rendering includes all tactical shapes, correctly clipped to the selected time window',()=>{
  const clip={start:5,end:9};
  const sample=[ann('arrow',{start:6,end:8}),ann('text',{start:7,end:9,text:'{INJECTION}\\bad'})];
  const subs=makeAss(sample,clip);
  assert.match(subs,/Dialogue: 0,0:00:01\.00,0:00:03\.00/);
  assert.match(subs,/Dialogue: 0,0:00:02\.00,0:00:04\.00/);
  assert.match(subs,/INJECTIONbad/);
  assert.doesNotMatch(subs,/\{INJECTION\}|\\bad/);
  assert.equal((subs.match(/^Dialogue: /gm)||[]).length,2);
  assert.equal((makeAss(sample,clip,false).match(/^Dialogue: /gm)||[]).length,0);
});
test('exports a playable H.264 MP4 with audio and burned-in annotations',async()=>{
  const {p,c1}=await projectWithClips();
  assert.equal((await req(`/api/projects/${p.id}/exports`,'POST',{clipId:randomUUID(),quality:'720p',annotations:true})).status,404);
  const started=await req(`/api/projects/${p.id}/exports`,'POST',{clipId:c1.id,quality:'720p',annotations:true});
  assert.equal(started.status,202);
  const finished=await awaitJob(started.data.id);
  assert.equal(finished.status,'completed',finished.error);
  assert.equal(finished.percent,100);
  assert.ok(finished.bytes>1000);
  const file=await fetch(`${root}/api/exports/${finished.id}/download`);
  assert.equal(file.status,200);
  assert.match(file.headers.get('content-type'),/video\/mp4/);
  assert.match(file.headers.get('content-disposition'),/High_press.mp4/);
  const bytes=Buffer.from(await file.arrayBuffer());
  const path=join(dir,'out.mp4');
  await import('node:fs/promises').then(fs=>fs.writeFile(path,bytes));
  const info=JSON.parse((await exec('ffprobe',['-v','quiet','-show_format','-show_streams','-of','json',path])).stdout);
  const video=info.streams.find(s=>s.codec_type==='video');
  const audio=info.streams.find(s=>s.codec_type==='audio');
  assert.equal(video.codec_name,'h264');
  assert.equal(video.width,1280);
  assert.equal(video.height,720);
  assert.equal(audio.codec_name,'aac');
  assert.ok(Number(info.format.duration)>.8 && Number(info.format.duration)<1.5,info.format.duration);
  // Decode pixels of a frame with annotation visible; the black fixture must gain non-black pixels.
  const raw=(await exec('ffmpeg',['-hide_banner','-loglevel','error','-ss','0.3','-i',path,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','-'],{encoding:'buffer',maxBuffer:1280*720*3+1e6})).stdout;
  assert.ok([...raw].some(v=>v>60),'Drawings should change pixels in the black source');
});
test('playlist export joins clips, allows unannotated 1080p, rejects invalid selections',async()=>{
  const {p,playlist}=await projectWithClips();
  const invalid=await req(`/api/projects/${p.id}/exports`,'POST',{playlistId:playlist.id,quality:'4k',annotations:true});
  assert.equal(invalid.status,400);
  const started=await req(`/api/projects/${p.id}/exports`,'POST',{playlistId:playlist.id,quality:'1080p',annotations:false});
  assert.equal(started.status,202);
  const duplicate=await req(`/api/projects/${p.id}/exports`,'POST',{playlistId:playlist.id,quality:'720p',annotations:true});
  assert.equal(duplicate.status,409);
  const job=await awaitJob(started.data.id);
  assert.equal(job.status,'completed',job.error);
  const file=await fetch(`${root}/api/exports/${job.id}/download`);
  assert.equal(file.status,200);
  const path=join(dir,'playlist.mp4');
  await import('node:fs/promises').then(async fs=>fs.writeFile(path,Buffer.from(await file.arrayBuffer())));
  const info=JSON.parse((await exec('ffprobe',['-v','quiet','-show_format','-show_streams','-of','json',path])).stdout);
  assert.equal(info.streams.find(x=>x.codec_type==='video').width,1920);
  assert.ok(Number(info.format.duration)>1.55 && Number(info.format.duration)<2.4,info.format.duration);
});
