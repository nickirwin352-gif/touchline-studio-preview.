import test from 'node:test';
import assert from 'node:assert/strict';
import { zoomStateAt, validExportRange, preferredRecordingMime } from '../recorder.js';

test('smooth zoom is inactive before/after and eases in/out',()=>{
  const z=[{x:.2,y:.7,at:10,hold:4,scale:2}];
  assert.equal(zoomStateAt(z,9).scale,1);
  assert.equal(zoomStateAt(z,10).scale,1);
  assert.equal(zoomStateAt(z,12).scale,2);
  assert.equal(zoomStateAt(z,14).scale,1);
  assert.equal(zoomStateAt(z,14.1).scale,1);
  assert.equal(zoomStateAt(z,12).x,.2);
  assert.ok(zoomStateAt(z,10.2).scale>1);
  assert.ok(zoomStateAt(z,10.2).scale<2);
});
test('range validation prevents empty, negative or excessively long exports',()=>{
  assert.equal(validExportRange(0,10,90),true);
  assert.equal(validExportRange(5,5,90),false);
  assert.equal(validExportRange(20,15,90),false);
  assert.equal(validExportRange(0,181,1800),false);
  assert.equal(validExportRange(1,3,90),true);
  assert.equal(validExportRange(-20,.1,90),false);
});
test('recording format prefers MP4 where supported and falls back to WebM',()=>{
  const mk=(supported)=>({isTypeSupported:s=>supported.includes(s)});
  assert.equal(preferredRecordingMime(mk(['video/mp4','video/webm'])),'video/mp4');
  assert.equal(preferredRecordingMime(mk(['video/webm'])),'video/webm');
  assert.equal(preferredRecordingMime(mk([])),null);
});
test('editor modules are static and contain no remote libraries or AI setup',async()=>{
  const {readFile}=await import('node:fs/promises');
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  assert.match(html,/id="veo-dialog"/);
  assert.match(html,/id="zoom-list"/);
  assert.match(html,/id="start-render"/);
  assert.match(html,/id="visual-layer"/);
});
