import type { BackingSize, BurnOrigin, NormalizedOrigin, ViewportSize } from './types';

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function normalizeOrigin(origin: BurnOrigin, viewport: ViewportSize): NormalizedOrigin {
  if (viewport.width <= 0 || viewport.height <= 0) return { x: 0.5, y: 0.5 };
  return {
    x: clamp01(origin.x / viewport.width),
    y: clamp01(origin.y / viewport.height),
  };
}

export function calculateBackingSize(
  viewport: ViewportSize,
  devicePixelRatio: number,
  maxPixels: number,
): BackingSize {
  const cssPixels = Math.max(1, viewport.width * viewport.height);
  const requestedScale = Math.max(0.1, devicePixelRatio);
  const pixelBudgetScale = Math.sqrt(Math.max(1, maxPixels) / cssPixels);
  const scale = Math.min(requestedScale, pixelBudgetScale);
  return {
    width: Math.max(1, Math.floor(viewport.width * scale)),
    height: Math.max(1, Math.floor(viewport.height * scale)),
    scale,
  };
}

export function calculateTextureSize(
  source: ViewportSize,
  maxPixels: number,
  maxDimension: number,
): ViewportSize {
  const budget = calculateBackingSize(source, 1, maxPixels);
  const dimensionScale = Math.min(
    1,
    Math.max(1, maxDimension) / Math.max(1, source.width),
    Math.max(1, maxDimension) / Math.max(1, source.height),
  );
  const scale = Math.min(budget.scale, dimensionScale);
  return {
    width: Math.max(1, Math.floor(source.width * scale)),
    height: Math.max(1, Math.floor(source.height * scale)),
  };
}
