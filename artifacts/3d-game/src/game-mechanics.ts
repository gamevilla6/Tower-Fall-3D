export type MysteryEffect = 'spring' | 'heavy' | 'mini';

export type WeightedPosition = {
  x: number;
  z: number;
  mass: number;
};

export const BASE_PLATFORM_HALF_EXTENT = 1.9;
export const BASE_BLOCK_POINTS = 100;

export function isMysteryBlockNumber(blockNumber: number): boolean {
  return Number.isInteger(blockNumber) && blockNumber > 0 && blockNumber % 5 === 0;
}

export function getStreakMultiplier(streak: number): number {
  const safeStreak = Math.max(0, Math.floor(streak));
  return Math.min(3, 1 + Math.floor(safeStreak / 3) * 0.25);
}

export function getPlacementPoints(streak: number, perfect: boolean): number {
  const comboMultiplier = perfect ? 1.5 : 1;
  return Math.round(BASE_BLOCK_POINTS * Math.min(3, getStreakMultiplier(streak) * comboMultiplier));
}

export function getDropSpeedMultiplier(blocksPlaced: number): number {
  return 1 + Math.min(1.4, Math.max(0, blocksPlaced) * 0.035);
}

export function getDifficultyTier(heightMeters: number): number {
  return Math.floor(Math.max(0, heightMeters) / 10);
}

export function getPlatformHalfExtent(heightMeters: number): number {
  const tier = getDifficultyTier(heightMeters);
  return Math.max(1.05, BASE_PLATFORM_HALF_EXTENT - 0.12 * tier - 0.015 * tier * tier);
}

export function getGustInterval(randomValue: number): number {
  const normalized = Math.min(0.999999, Math.max(0, randomValue));
  return 3 + Math.floor(normalized * 3);
}

export function getCenterOfMassXZ(positions: WeightedPosition[]): { x: number; z: number } {
  let totalMass = 0;
  let weightedX = 0;
  let weightedZ = 0;

  for (const position of positions) {
    const mass = Number.isFinite(position.mass) ? Math.max(0, position.mass) : 0;
    if (mass === 0 || !Number.isFinite(position.x) || !Number.isFinite(position.z)) continue;
    totalMass += mass;
    weightedX += position.x * mass;
    weightedZ += position.z * mass;
  }

  return totalMass > 0
    ? { x: weightedX / totalMass, z: weightedZ / totalMass }
    : { x: 0, z: 0 };
}

export function isOffCenter(centerX: number, centerZ: number, threshold: number): boolean {
  return Math.hypot(centerX, centerZ) > Math.max(0, threshold);
}

export function isPerfectPlacement(distanceFromStackCenter: number, linearSpeed: number, angularSpeed: number): boolean {
  return distanceFromStackCenter <= 0.28 && linearSpeed <= 0.1 && angularSpeed <= 0.12;
}
