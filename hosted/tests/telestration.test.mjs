import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
const dir=await mkdtemp(join(tmpdir(),'touchline-telestrate-'));
process.env.TOUCHLINE_DATA_DIR=dir;
const {createAppServer}=await import('../server/index.mjs');
const {makeAss,freezeFilterGraph}=await import('../server/export.mjs');
const {validateAnnotation}=await import('../server/storage.mjs');
const {poseAt,opacityAt}=await import('../web/assets/model.js');
let server,base;
before(async()=>{server=createAppServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));base=`http://127.0.0.1:${server.address().port}`;});
after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
const time='2026-11-07T12:00:00.000Z';
const ann=(type,changes={})=>({id:randomUUID(),type,x1:.25,y1:.25,x2:.38,y2:.4,points:[],text:'Player 7',color:'#b7ff66',width:5,start:0,end:2.6,...changes});
const clip={id:randomUUID(),title:'Player focus',start:.2,end:2.8,category:'Pressing',notes:'',createdAt:time,updatedAt:time};
const freezes=[{id:randomUUID(),at:1.0,hold:1.5,label:'Pause the press'}];
const zooms=[{id:randomUUID(),start:.5,end:2.5,x:.4,y:.5,scale:1.6}];
async function req(path,method='GET',body){const r=await fetch(base+path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined});return{status:r.status,data:await r.json()};}
async function fixture(){const path=join(dir,'sample.mp4');await exec('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=s=320x180:r=25:d=3.5','-f','lavfi','-i','sine=frequency=220:sample_rate=48000:duration=3.5','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac','-shortest',path]);return await readFile(path);}
async function waitJob(id){for(let i=0;i<130;i++){const r=(await req(`/api/exports/${id}`)).data;if(r.status!=='running')return r;await new Promise(r=>setTimeout(r,200));}throw Error('export timeout');}
test('new annotations support keyframe interpolation, fade, validation and ASS rendering',()=>{
  const highlight=ann('highlight',{start:0,end:3,fade:.3,keyframes:[{time:0,x:.25,y:.25},{time:2,x:.6,y:.5}]});
  assert.equal(validateAnnotation(highlight),true);
  assert.ok(Math.abs(poseAt(highlight,1).x1-.425)<.002);
  assert.ok(Math.abs(poseAt(highlight,1).y1-.375)<.002);
  assert.ok(Math.abs(opacityAt(highlight,.15)-.5)<1e-5);
  assert.equal(validateAnnotation({...highlight,keyframes:[{time:2.5,x:2,y:0}]}),false);
  const ass=makeAss([highlight,ann('spotlight'),ann('curve'),ann('zone')],{start:0,end:3});
  assert.match(ass,/\\move\(/);assert.match(ass,/\\iclip\(/);assert.match(ass,/\\fad\(/);
  assert.ok((ass.match(/Dialogue: -?\d+/g)||[]).length>=5);
  assert.match(freezeFilterGraph([{at:1,hold:2}],3,true),/anullsrc/);
});
test('freeze and zoom settings persist; invalid structures are refused',async()=>{
  const p=(await req('/api/projects','POST',{title:'Pressing analysis'})).data;
  const resp=await fetch(base+`/api/projects/${p.id}/video`,{method:'PUT',headers:{'X-File-Name':'match.mp4'},body:await fixture()});
  assert.equal(resp.status,201);
  const rejected=await req(`/api/projects/${p.id}`,'PATCH',{freezes:[{...freezes[0],hold:999}]});assert.equal(rejected.status,400);
  const annotations=[ann('highlight',{start:.2,end:2.8,keyframes:[{time:.2,x:.25,y:.25},{time:2.8,x:.5,y:.4}]}),ann('curve'),ann('zone'),ann('spotlight',{start:.8,end:1.5})];
  const saved=await req(`/api/projects/${p.id}`,'PATCH',{duration:3.5,clips:[clip],annotations,freezes,zooms});
  assert.equal(saved.status,200,JSON.stringify(saved.data));
  const loaded=await req(`/api/projects/${p.id}`);
  assert.deepEqual(loaded.data.freezes,freezes);assert.deepEqual(loaded.data.zooms,zooms);
  const started=await req(`/api/projects/${p.id}/exports`,'POST',{clipId:clip.id,quality:'720p',annotations:true});
  assert.equal(started.status,202,JSON.stringify(started.data));
  const job=await waitJob(started.data.id);assert.equal(job.status,'completed',job.error);
  const result=await fetch(`${base}/api/exports/${job.id}/download`);
  assert.equal(result.status,200);
  const out=join(dir,'result.mp4');await writeFile(out,Buffer.from(await result.arrayBuffer()));
  const info=JSON.parse((await exec('ffprobe',['-v','error','-show_format','-show_streams','-of','json',out])).stdout);
  const duration=Number(info.format.duration);
  assert.ok(duration>3.6&&duration<4.65,`freeze should add 1.5 seconds to a 2.6s clip: ${duration}`);
  assert.equal(info.streams.find(x=>x.codec_type==='audio').codec_name,'aac');
  assert.equal(info.streams.find(x=>x.codec_type==='video').width,1280);
});
test('freeze renderer handles holds at the clip start and silent videos',async()=>{
  const input=join(dir,'silent-base.mp4'),out=join(dir,'silent-frozen.mp4');
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','color=c=blue:s=320x180:r=25:d=2','-c:v','libx264','-pix_fmt','yuv420p',input]);
  const graph=freezeFilterGraph([{at:0,hold:.5},{at:1,hold:.8}],2,false);
  await exec('ffmpeg',['-hide_banner','-loglevel','error','-y','-i',input,'-filter_complex',graph,'-map','[vout]','-c:v','libx264','-pix_fmt','yuv420p',out]);
  const info=JSON.parse((await exec('ffprobe',['-v','error','-show_format','-of','json',out])).stdout);
  assert.ok(Number(info.format.duration)>3.15 && Number(info.format.duration)<3.6,info.format.duration);
});
test('source replacement resets freeze and zoom effects with previous timeline',async()=>{
  const p=(await req('/api/projects','POST',{title:'Replacement test'})).data;
  const video=await fixture();
  const first=await fetch(`${base}/api/projects/${p.id}/video`,{method:'PUT',headers:{'X-File-Name':'old.mp4'},body:video});assert.equal(first.status,201);
  const saved=await req(`/api/projects/${p.id}`,'PATCH',{duration:3.5,freezes,zooms});assert.equal(saved.status,200);
  const second=await fetch(`${base}/api/projects/${p.id}/video`,{method:'PUT',headers:{'X-File-Name':'new.mp4'},body:video});assert.equal(second.status,201);
  const updated=await req(`/api/projects/${p.id}`);
  assert.deepEqual(updated.data.freezes,[]);assert.deepEqual(updated.data.zooms,[]);
});
