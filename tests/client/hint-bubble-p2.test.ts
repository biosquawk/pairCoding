import { test } from 'node:test';
import assert from 'node:assert/strict';
import { placeHintBubble, intersectsHintRect } from '../../src/components/hintBubbleGeometryP2';
test('clamps actual dimensions to container, not viewport or assumed 390px', () => {
  const p = placeHintBubble({ width: 180, height: 90 }, { width: 360, height: 240 }, { x: 900, y: -50 }, null);
  assert.deepEqual(p, { x: 0, y: 0, width: 180, height: 90, parked: false });
});
test('drag and splitter shrink keep all edges reachable with measured long text', () => {
  for (const width of [1200, 420, 160]) for (const height of [800, 180, 32]) {
    const p = placeHintBubble({ width, height }, { width: 344, height: 217 }, { x: -500, y: 5000 }, null);
    assert.ok(p.x >= 0 && p.y >= 0 && p.x + p.width <= width && p.y + p.height <= height);
  }
});
test('moves away from active cursor/selection when a feasible area exists', () => {
  const c = { width: 500, height: 500 }, code = { left: 0, top: 35, width: 500, height: 40 };
  const p = placeHintBubble(c, { width: 360, height: 120 }, { x: 20, y: 40 }, code);
  assert.equal(p.parked, false);
  assert.equal(intersectsHintRect({ left: c.width - p.x - p.width, top: p.y, width: p.width, height: p.height }, code), false);
});
test('explicit parked fallback when no overlay can avoid active selection', () => {
  assert.equal(placeHintBubble({ width: 120, height: 60 }, { width: 120, height: 60 }, { x: 0, y: 0 }, { left: 0, top: 0, width: 120, height: 60 }).parked, true);
});
test('no selection / offscreen code needs no fallback; touching edge is not overlap', () => {
  assert.equal(intersectsHintRect({ left: 0, top: 0, width: 100, height: 20 }, { left: 0, top: 20, width: 100, height: 20 }), false);
  assert.equal(placeHintBubble({ width: 500, height: 500 }, { width: 100, height: 100 }, { x: 10, y: 10 }, null).parked, false);
});
