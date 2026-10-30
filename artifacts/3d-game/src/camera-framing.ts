export type CameraFrameInput = {
  settledTowerTop: number;
  activeBlockTop: number;
  aspect: number;
  fov: number;
  cameraElevation: number;
  distancePreference?: 'close' | 'standard' | 'wide';
};

export type CameraFrame = {
  targetY: number;
  distance: number;
  framedTop: number;
};

export type CameraFrameState = {
  targetY: number;
  distance: number;
};

export function createInitialCameraFrame(): CameraFrameState {
  return { targetY: 0.65, distance: 14 };
}

export function calculateCameraFrame({
  settledTowerTop,
  activeBlockTop,
  aspect,
  fov,
  cameraElevation,
  distancePreference = 'standard',
}: CameraFrameInput): CameraFrame {
  const framedTop = Math.max(activeBlockTop, settledTowerTop + 3.5);
  const trackedTop = Math.max(activeBlockTop, settledTowerTop);
  const targetY = Math.max(0.65, (0.28 + trackedTop) / 2);
  const frameFill = 0.76;
  const verticalSpan = Math.max(5.2, framedTop - 0.28 + 1);
  const halfFovTangent = Math.tan((fov * Math.PI) / 360);
  const safeAspect = Math.max(aspect || 1, 0.38);
  const verticalFitDistance = (verticalSpan * Math.cos(cameraElevation)) / (2 * halfFovTangent * frameFill);
  const horizontalFitDistance = 5.4 / (2 * halfFovTangent * safeAspect * frameFill);
  const safeFitDistance = Math.max(verticalFitDistance, horizontalFitDistance);
  const preferredDistance = distancePreference === 'close' ? 11.5 : distancePreference === 'wide' ? 17 : 14;

  return {
    targetY,
    distance: Math.max(preferredDistance, safeFitDistance),
    framedTop,
  };
}
