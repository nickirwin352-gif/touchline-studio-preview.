import test from 'node:test';
import assert from 'node:assert/strict';
import {formatClipClock,parseClipClock,CLIP_PRESETS} from '../web/assets/clip-ui.js';
test('clip times display as match minutes:seconds and parse back into numeric seconds',()=>{
  for(const [value,want] of [[0,'00:00'],[5,'00:05'],[75,'01:15'],[619,'10:19'],[4520,'75:20'],[7323,'122:03']]){
    assert.equal(formatClipClock(value),want); assert.equal(parseClipClock(want),value);
  }
  assert.equal(parseClipClock('1:05:20'),3920);
  assert.equal(parseClipClock('90:20'),5420);
  assert.equal(formatClipClock(61.6),'01:02');
});
test('incorrect or unsafe time fields are rejected',()=>{
  for(const value of ['','120','a1:23','1:99','10:60','1:60:01','00:-1','1500:00','1:2:3:4','00:10.5']){
    assert.throws(()=>parseClipClock(value),undefined,`Should refuse ${value}`);
  }
});
test('football event names are distinct and have matching event categories',()=>{
  assert.ok(CLIP_PRESETS.length>=20);
  assert.equal(new Set(CLIP_PRESETS.map(x=>x.label)).size,CLIP_PRESETS.length);
  assert.equal(CLIP_PRESETS.find(x=>x.label==='High press').category,'Pressing');
  assert.ok(CLIP_PRESETS.find(x=>x.label==='Goal'));
});
