import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { History, isVisible, translate, timecode } from '../web/assets/model.js';
import { parseRange, validateFileName } from '../server/media.mjs';
import { validateAnnotation, validatePatch } from '../server/storage.mjs';

const sample = () => ({ id: randomUUID(), type: 'arrow', x1: .1, y1: .2, x2: .3, y2: .4, points: [], text: '', color: '#b7ff66', width: 4, start: 12, end: 16 });

test('timestamp visibility boundaries are inclusive', () => {
  const a = sample();
  assert.equal(isVisible(a, 11.9), false);
  assert.equal(isVisible(a, 12), true);
  assert.equal(isVisible(a, 16), true);
  assert.equal(isVisible(a, 16.1), false);
  assert.equal(timecode(3723.9), '01:02:03');
});
test('translate keeps shape inside the normalized video frame', () => {
  const a = sample();
  const moved = translate(a, 100, -100);
  assert.ok(Math.abs(moved.x2 - 1) < 1e-9);
  assert.ok(Math.abs(moved.y1 - 0) < 1e-9);
  assert.ok(moved.x2 - moved.x1 > 0.19);
  assert.deepEqual(a, sampleWithId(a.id));
});
function sampleWithId(id) { return { ...sample(), id }; }
test('undo and redo restore exact versions and redo clears on new edit', () => {
  const h = new History();
  const one = sample();
  h.commit([one]);
  h.commit([{ ...one, text: 'test' }]);
  assert.equal(h.current[0].text, 'test');
  h.undo(); assert.equal(h.current[0].text, '');
  h.redo(); assert.equal(h.current[0].text, 'test');
  h.undo();
  h.commit([]);
  assert.equal(h.canRedo, false);
});
test('range parser handles regular, suffix and unsatisfiable requests', () => {
  assert.deepEqual(parseRange('bytes=3-9', 100), { start: 3, end: 9, partial: true });
  assert.deepEqual(parseRange('bytes=-5', 100), { start: 95, end: 99, partial: true });
  assert.deepEqual(parseRange('bytes=98-', 100), { start: 98, end: 99, partial: true });
  assert.equal(parseRange('bytes=100-', 100), null);
  assert.equal(parseRange('bytes=9-1', 100), null);
  assert.equal(parseRange('bytes=0-1,3-4', 100), null);
});
test('annotation validation rejects malformed geometry, colours and durations', () => {
  const a = sample();
  assert.equal(validateAnnotation(a), true);
  assert.equal(validateAnnotation({ ...a, x1: 12 }), false);
  assert.equal(validateAnnotation({ ...a, end: 2 }), false);
  assert.equal(validateAnnotation({ ...a, color: 'red' }), false);
  assert.equal(validateAnnotation({ ...a, points: [{ x: -1, y: .2 }] }), false);
  assert.deepEqual(validatePatch({ annotations: [a] }), { annotations: [a] });
  assert.throws(() => validatePatch({ annotations: [a, a] }), /Duplicate/);
});
test('video extensions are controlled and traversal is stripped', () => {
  assert.equal(validateFileName('match.MOV').ext, '.mov');
  assert.equal(validateFileName('../test.mp4').name, 'test.mp4');
  assert.throws(() => validateFileName('virus.exe'), /Supported imports/);
});
