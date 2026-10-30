import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateCameraFrame, createInitialCameraFrame } from './camera-framing.ts';

const FOV = 36;
const ELEVATION = 0.5;
const ORBIT = Math.atan2(9.6, 7.6);
const PORTRAIT_ASPECT = 402 / 874;
const DESKTOP_ASPECT = 1440 / 900;

type Point = { x: number; y: number; z: number };

function projectedBounds(
  frame: ReturnType<typeof calculateCameraFrame>,
  aspect: number,
  points: Point[],
) {
  const target = { x: 0, y: frame.targetY, z: 0 };
  const towardCamera = {
    x: Math.cos(ELEVATION) * Math.cos(ORBIT),
    y: Math.sin(ELEVATION),
    z: Math.cos(ELEVATION) * Math.sin(ORBIT),
  };
  const up = {
    x: Math.sin(ELEVATION) * Math.cos(ORBIT),
    y: Math.cos(ELEVATION),
    z: Math.sin(ELEVATION) * Math.sin(ORBIT),
  };
  const right = { x: -Math.sin(ORBIT), y: 0, z: Math.cos(ORBIT) };
  const tanHalfFov = Math.tan((FOV * Math.PI) / 360);
  const ndc = points.map((point) => {
    const relative = { x: point.x - target.x, y: point.y - target.y, z: point.z - target.z };
    const depth = frame.distance - (
      relative.x * towardCamera.x + relative.y * towardCamera.y + relative.z * towardCamera.z
    );
    const vertical = relative.x * up.x + relative.y * up.y + relative.z * up.z;
    const horizontal = relative.x * right.x + relative.y * right.y + relative.z * right.z;
    return {
      x: horizontal / (depth * tanHalfFov * aspect),
      y: vertical / (depth * tanHalfFov),
    };
  });
  return {
    minX: Math.min(...ndc.map(({ x }) => x)),
    maxX: Math.max(...ndc.map(({ x }) => x)),
    minY: Math.min(...ndc.map(({ y }) => y)),
    maxY: Math.max(...ndc.map(({ y }) => y)),
  };
}

function assertSceneFits(
  settledTowerTop: number,
  activeBlockTop: number,
  aspect: number,
  distancePreference: 'close' | 'standard' | 'wide' = 'standard',
) {
  const frame = calculateCameraFrame({
    settledTowerTop,
    activeBlockTop,
    aspect,
    fov: FOV,
    cameraElevation: ELEVATION,
    distancePreference,
  });
  const points: Point[] = [];

  // Include the platform's full footprint and the top/bottom silhouette of the tower and active piece.
  for (const x of [-1.9, 1.9]) {
    for (const z of [-1.9, 1.9]) {
      points.push({ x, y: -0.28, z }, { x, y: 0.28, z });
    }
  }
  for (const top of [settledTowerTop, activeBlockTop]) {
    if (top <= 0.28) continue;
    for (const x of [-0.9, 0.9]) {
      for (const z of [-0.9, 0.9]) {
        points.push({ x, y: 0.28, z }, { x, y: top, z });
      }
    }
  }

  const bounds = projectedBounds(frame, aspect, points);
  assert.ok(bounds.minY > -1 && bounds.maxY < 1, `vertical scene bounds are clipped: ${JSON.stringify(bounds)}`);
  assert.ok(bounds.minX > -1 && bounds.maxX < 1, `horizontal scene bounds are clipped: ${JSON.stringify(bounds)}`);
  return frame;
}

describe('camera framing', () => {
  for (const [viewportName, aspect] of [
    ['desktop', DESKTOP_ASPECT],
    ['portrait', PORTRAIT_ASPECT],
  ] as const) {
    describe(`${viewportName} viewport`, () => {
      it('keeps the platform visible at the start and after restart', () => {
        const initial = createInitialCameraFrame();
        const afterRestart = createInitialCameraFrame();
        const initialScene = assertSceneFits(0.28, 0.28, aspect);
        const restartedScene = assertSceneFits(0.28, 0.28, aspect);
        assert.equal(afterRestart.targetY, initial.targetY);
        assert.equal(afterRestart.distance, initial.distance);
        assert.equal(restartedScene.targetY, initialScene.targetY);
        assert.equal(restartedScene.distance, initialScene.distance);
        assert.equal(initial.targetY, 0.65);
        assert.equal(initial.distance, 14);
      });

      it('keeps a falling block visible above the platform', () => {
        assertSceneFits(0.28, 3.5, aspect);
      });

      it('keeps a tower of at least six blocks and its active block visible', () => {
        const frame = assertSceneFits(7.5, 10.2, aspect);
        assert.ok(frame.distance > 14);
      });
    });
  }

  it('reframes a tall tower after switching from desktop to portrait', () => {
    const desktop = assertSceneFits(7.5, 10.2, DESKTOP_ASPECT);
    const portrait = assertSceneFits(7.5, 10.2, PORTRAIT_ASPECT);
    assert.ok(portrait.distance > desktop.distance);
  });

  it('supports closer and wider views when the full scene fits', () => {
    const closer = assertSceneFits(0.28, 0.28, DESKTOP_ASPECT, 'close');
    const standard = assertSceneFits(0.28, 0.28, DESKTOP_ASPECT, 'standard');
    const wider = assertSceneFits(0.28, 0.28, DESKTOP_ASPECT, 'wide');

    assert.ok(closer.distance < standard.distance);
    assert.ok(wider.distance > standard.distance);
  });

  it('keeps an active falling block visible with the closer view', () => {
    assertSceneFits(0.28, 3.5, DESKTOP_ASPECT, 'close');
  });

  it('automatically pulls a closer preference back to fit a tall tower in portrait', () => {
    const closer = assertSceneFits(7.5, 10.2, PORTRAIT_ASPECT, 'close');
    const standard = assertSceneFits(7.5, 10.2, PORTRAIT_ASPECT, 'standard');
    assert.ok(closer.distance > 11.5);
    assert.equal(closer.distance, standard.distance);
  });
});
