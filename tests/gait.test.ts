import test from 'node:test';
import assert from 'node:assert/strict';
import { SpiderGait } from '../src/browser/gait.js';

test('spider keeps stance feet planted and walks with alternating groups of articulated legs', () => {
  const gait = new SpiderGait(), origin = { x: 200, y: 200 }, velocity = { x: 60, y: 0 };
  const initial = gait.update(origin, 0, velocity, 0.016);
  assert.equal(initial.length, 8);
  const smallMove = gait.update({ x: 204, y: 200 }, 0, velocity, 0.016);
  assert.deepEqual(smallMove.map(l => l.ground), initial.map(l => l.ground));
  assert.notDeepEqual(smallMove.map(l => l.hip), initial.map(l => l.hip));
  const firstStep = gait.update({ x: 225, y: 200 }, 0, velocity, 0.08);
  assert.equal(firstStep.filter(l => l.stepping).length, 4);
  assert.ok(firstStep.filter(l => l.stepping).every(l => l.group === 0 && l.lift > 0));
  firstStep.forEach((leg, i) => { if (!leg.stepping) assert.deepEqual(leg.ground, initial[i].ground); });
  const frozen = gait.update({ x: 225, y: 200 }, 0, velocity, 0);
  assert.deepEqual(frozen, firstStep);
  gait.update({ x: 240, y: 200 }, 0, velocity, 0.3);
  const secondStep = gait.update({ x: 242, y: 200 }, 0, velocity, 0.08);
  assert.equal(secondStep.filter(l => l.stepping).length, 4);
  assert.ok(secondStep.filter(l => l.stepping).every(l => l.group === 1));
  for (const leg of secondStep) {
    assert.ok(Number.isFinite(leg.knee.x) && Number.isFinite(leg.knee.y));
    const area = (leg.knee.x - leg.hip.x) * (leg.foot.y - leg.hip.y) - (leg.knee.y - leg.hip.y) * (leg.foot.x - leg.hip.x);
    assert.ok(Math.abs(area) > 10, 'Each leg has a visible knee bend');
  }
});
