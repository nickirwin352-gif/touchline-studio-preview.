import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const temp=await mkdtemp(join(tmpdir(),'touchline-free-storage-'));
process.env.TOUCHLINE_DATA_DIR=temp;
const { freeModeEnabled, sanitizeFreeSnapshot, restoreFreeSnapshots }=await import('../server/free-persistence.mjs');
const { listProjects }=await import('../server/storage.mjs');
test('free hosting flag is explicit',()=>{
  assert.equal(freeModeEnabled({TOUCHLINE_FREE_MODE:'1'}),true);
  assert.equal(freeModeEnabled({TOUCHLINE_FREE_MODE:'0'}),false);
});
test('browser snapshots restore Veo links, drawings and clip structure without secret video URLs',async t=>{
  t.after(()=>rm(temp,{recursive:true,force:true}));
  const sourceLink='https://app.veo.co/matches/2026-public-match-42/?highlight=one';
  const snapshot={
    id:'b5e2f741-1f98-4420-b931-b2e4bc8fe371',title:'Public Match',
    sourceLink,remoteVideo:{kind:'veo',matchId:'spoofed'},
    duration:210,annotations:[],freezes:[],zooms:[],clips:[],playlists:[],
    autoFreezeAnnotations:true,createdAt:new Date().toISOString()
  };
  const clean=sanitizeFreeSnapshot(snapshot);
  assert.equal(clean.video,null);
  assert.equal(clean.remoteVideo.matchId,'2026-public-match-42');
  assert.equal(clean.sourceLink,sourceLink);
  assert.equal(JSON.stringify(clean).includes('signed'),false);
  const first=await restoreFreeSnapshots([snapshot],{TOUCHLINE_FREE_MODE:'1'});
  assert.equal(first.restored,1);
  const stored=await listProjects();
  assert.equal(stored.length,1);
  assert.equal(stored[0].title,'Public Match');
  await assert.rejects(restoreFreeSnapshots([snapshot],{TOUCHLINE_FREE_MODE:'1'}),/not be overwritten/);
});
test('restore is off outside free hosting and rejects malformed input',async()=>{
  await assert.rejects(restoreFreeSnapshots([],{TOUCHLINE_FREE_MODE:'0'}),/not enabled/);
  assert.throws(()=>sanitizeFreeSnapshot({id:'../secrets',title:'Bad'}),/identifier/);
  assert.throws(()=>sanitizeFreeSnapshot({id:'b5e2f741-1f98-4420-b931-b2e4bc8fe372',title:'Bad',annotations:[{id:'bad'}]}),/annotations/);
});
