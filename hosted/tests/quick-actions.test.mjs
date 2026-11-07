import test from 'node:test';
import assert from 'node:assert/strict';
import { quickClipRange } from '../web/assets/clip-ui.js';

test('Quick Clip and Quick Tag use five seconds each side and clamp to match bounds',()=>{
  assert.deepEqual(quickClipRange(63,5400),{start:58,end:68});
  assert.deepEqual(quickClipRange(1,5400),{start:0,end:6});
  assert.deepEqual(quickClipRange(5398,5400),{start:5393,end:5400});
  assert.deepEqual(quickClipRange(0,3),{start:0,end:3});
  assert.throws(()=>quickClipRange(4,NaN));
});
test('automatic freeze preference is stored on a project without breaking old fields',async()=>{
  const {mkdtemp,rm}=await import('node:fs/promises');
  const {tmpdir}=await import('node:os');
  const {join}=await import('node:path');
  const dir=await mkdtemp(join(tmpdir(),'touchline-auto-freeze-'));
  process.env.TOUCHLINE_DATA_DIR=dir;
  const storage=await import('../server/storage.mjs');
  try {
    const created=await storage.createProject('Auto freeze');
    assert.equal(created.autoFreezeAnnotations,true);
    const patch=storage.validatePatch({autoFreezeAnnotations:false});
    await storage.updateProject(created.id,p=>({...p,...patch}));
    assert.equal((await storage.getProject(created.id)).autoFreezeAnnotations,false);
    assert.throws(()=>storage.validatePatch({autoFreezeAnnotations:'yes'}));
  }finally{await rm(dir,{force:true,recursive:true});}
});
