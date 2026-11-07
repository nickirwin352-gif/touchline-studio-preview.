import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { clamp, formatTime, opacityAt } from '../app.js';

test('timecode formats match playback time, including long matches',()=>{
  assert.equal(formatTime(0),'00:00');
  assert.equal(formatTime(90.999),'01:30');
  assert.equal(formatTime(3661),'1:01:01');
  assert.equal(formatTime(-4),'00:00');
});
test('drawings fade in and out, and disappear outside their active range',()=>{
  const mark={start:10,end:15,fade:1};
  assert.equal(opacityAt(mark,9),0);
  assert.equal(opacityAt(mark,10),0);
  assert.equal(opacityAt(mark,10.5),.5);
  assert.equal(opacityAt(mark,12),1);
  assert.equal(opacityAt(mark,14.5),.5);
  assert.equal(opacityAt(mark,15.1),0);
  assert.equal(opacityAt({...mark,fade:0},10),1);
});
test('coordinates remain inside the video canvas',()=>{
  assert.equal(clamp(-1,0,1),0);
  assert.equal(clamp(1.3,0,1),1);
  assert.equal(clamp(.3,0,1),.3);
  assert.equal(clamp(NaN,0,1),0);
});
test('static page uses relative assets and exposes core editor controls',async()=>{
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  for(const id of ['stage','overlay','projects','pick-file','seek','add-freeze','quick-clip','markup-list','prop-fade','export-project']) {
    assert.match(html,new RegExp('id="'+id+'"'),'Missing '+id);
  }
  assert.match(html,/\.\/app\.js\?rev=/);
  assert.match(html,/\.\/styles\.css\?rev=/);
  assert.doesNotMatch(html,/src="\/assets\//);
});
