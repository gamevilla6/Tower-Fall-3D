import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  getCenterOfMassXZ,
  getDifficultyTier,
  getDropSpeedMultiplier,
  getGustInterval,
  getPlacementPoints,
  getPlatformHalfExtent,
  getStreakMultiplier,
  isMysteryBlockNumber,
  isOffCenter,
  isPerfectPlacement,
} from './game-mechanics.ts';

describe('progressive game mechanics', () => {
  it('schedules mystery blocks every fifth spawn', () => {
    assert.equal(isMysteryBlockNumber(4), false);
    assert.equal(isMysteryBlockNumber(5), true);
    assert.equal(isMysteryBlockNumber(10), true);
    assert.equal(isMysteryBlockNumber(0), false);
  });

  it('increases streak multipliers in capped steps and rewards clean combos', () => {
    assert.equal(getStreakMultiplier(2), 1);
    assert.equal(getStreakMultiplier(3), 1.25);
    assert.equal(getStreakMultiplier(30), 3);
    assert.equal(getPlacementPoints(1, true), 150);
    assert.equal(getPlacementPoints(3, false), 125);
  });

  it('gradually increases falling speed and shrinks the platform every ten meters', () => {
    assert.equal(getDropSpeedMultiplier(0), 1);
    assert.ok(getDropSpeedMultiplier(10) > getDropSpeedMultiplier(0));
    assert.equal(getDropSpeedMultiplier(100), 2.4);
    assert.equal(getDifficultyTier(9.9), 0);
    assert.equal(getDifficultyTier(10), 1);
    assert.ok(getPlatformHalfExtent(10) < getPlatformHalfExtent(0));
    assert.equal(getPlatformHalfExtent(1000), 1.05);
  });

  it('keeps gust intervals between three and five successful blocks', () => {
    assert.equal(getGustInterval(0), 3);
    assert.equal(getGustInterval(0.5), 4);
    assert.equal(getGustInterval(1), 5);
  });

  it('calculates mass-weighted tower center and balance warning thresholds', () => {
    const center = getCenterOfMassXZ([
      { x: -0.5, z: 0, mass: 1 },
      { x: 0.5, z: 0, mass: 3 },
    ]);
    assert.deepEqual(center, { x: 0.25, z: 0 });
    assert.equal(isOffCenter(center.x, center.z, 0.85), false);
    assert.equal(isOffCenter(0.9, 0, 0.85), true);
    assert.deepEqual(getCenterOfMassXZ([]), { x: 0, z: 0 });
  });

  it('awards perfect placements only for centered, low-wobble landings', () => {
    assert.equal(isPerfectPlacement(0.2, 0.08, 0.1), true);
    assert.equal(isPerfectPlacement(0.4, 0.02, 0.02), false);
    assert.equal(isPerfectPlacement(0.1, 0.2, 0.02), false);
  });
});
