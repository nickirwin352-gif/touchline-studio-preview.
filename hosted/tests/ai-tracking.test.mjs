import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject } from '../server/storage.mjs';
import { getAiJob, startAiJob, validateAiRequest, cancelAiJob } from '../server/ai-tracking.mjs';

const pause=ms=>new Promise(done=>setTimeout(done,ms));
async function settle(id){for(let n=0;n<100;n++){const state=getAiJob(id);if(state.status!=='running')return state;await pause(30);}throw new Error('job did not settle');}

test('AI requests reject invalid coordinates, durations, modes and timestamps',()=>{
  assert.throws(()=>validateAiRequest({mode:'unknown',time:3}));
  assert.throws(()=>validateAiRequest({mode:'track',time:3,x:4,y:0,seconds:10}));
  assert.throws(()=>validateAiRequest({mode:'track',time:3,x:.5,y:.3,seconds:120}));
  assert.throws(()=>validateAiRequest({mode:'detect',time:-1}));
  assert.deepEqual(validateAiRequest({mode:'track',time:25.1234,x:.4,y:.7,seconds:10}),{mode:'track',time:25.123,x:.4,y:.7,seconds:10});
});

test('AI worker returns detected people, preserves original project and never persists source URL',async()=>{
  const project=await createProject('AI worker test');
  const folder=await mkdtemp(join(tmpdir(),'touchline-ai-'));
  const script=join(folder,'fake_worker.py');
  await writeFile(script,`import json,sys
config=json.loads(sys.stdin.read())
print(json.dumps({'type':'progress','phase':'Detecting actual video','percent':45}),flush=True)
print(json.dumps({'type':'result','mode':'detect','people':[{'box':[.1,.2,.2,.6],'foot':{'x':.15,'y':.6},'confidence':.95}]}),flush=True)
`);
  try{
    const start=await startAiJob(project.id,{mode:'detect',time:0},{python:'python3',script,source:join(folder,'dummy.mp4')});
    assert.equal(start.status,'running');
    const job=await settle(start.id);
    assert.equal(job.status,'completed');
    assert.equal(job.percent,100);
    assert.equal(job.result.people[0].foot.y,.6);
    assert.equal(JSON.stringify(job).includes('dummy.mp4'),false);
  } finally {await rm(folder,{recursive:true,force:true});}
});

test('AI worker controlled failure is reported and no fake track is saved',async()=>{
  const project=await createProject('AI error test');
  const folder=await mkdtemp(join(tmpdir(),'touchline-ai-'));
  const script=join(folder,'fake_fail.py');
  await writeFile(script,`import sys,json
_ = json.loads(sys.stdin.read())
print(json.dumps({'type':'error','message':'No player detected at selected point'}),flush=True)
sys.exit(1)
`);
  try{
    const job=await startAiJob(project.id,{mode:'track',time:1,x:.4,y:.5,seconds:6},{python:'python3',script,source:'dummy'});
    const result=await settle(job.id);
    assert.equal(result.status,'failed');
    assert.match(result.error,/No player detected/);
    assert.equal(result.result,null);
  } finally {await rm(folder,{recursive:true,force:true});}
});

test('AI cancellation stops worker without creating a marker',async()=>{
  const project=await createProject('AI cancellation test');
  const folder=await mkdtemp(join(tmpdir(),'touchline-ai-'));
  const script=join(folder,'slow.py');
  await writeFile(script,`import sys,time,json
_ = json.loads(sys.stdin.read())
time.sleep(15)
print(json.dumps({'type':'result','mode':'detect','people':[]}),flush=True)
`);
  try{
    const start=await startAiJob(project.id,{mode:'detect',time:2},{python:'python3',script,source:'dummy'});
    assert.equal(cancelAiJob(start.id).status,'cancelled');
    await pause(100);
    assert.equal(getAiJob(start.id).result,null);
  } finally {await rm(folder,{recursive:true,force:true});}
});

test('AI foot marker validates as ordinary annotation and renders moving ASS vectors',async()=>{
  const {validateAnnotation}=await import('../server/storage.mjs');
  const {makeAss}=await import('../server/export.mjs');
  const ann={id:'9a2ff923-8dd8-4bf7-89c3-1523b6b84a34',type:'footmarker',x1:.17,y1:.65,x2:.20,y2:.69,
    points:[],text:'',color:'#b7ff66',width:4,start:.2,end:2.5,fade:0,
    keyframes:[{time:.2,x:.17,y:.65},{time:1.5,x:.45,y:.65},{time:2.4,x:.68,y:.65}]};
  assert.equal(validateAnnotation(ann),true);
  const output=makeAss([ann],{start:0,end:3},true);
  assert.match(output,/Dialogue:/);
  assert.match(output,/\\move\(0,0,/);
  assert.match(output,/\\p1/);
  assert.ok((output.match(/Dialogue:/g)||[]).length>=2);
});
