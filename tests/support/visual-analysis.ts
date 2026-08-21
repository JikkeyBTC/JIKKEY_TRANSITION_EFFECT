import { PNG } from 'pngjs';

export type Theme = 'dark' | 'light';
export type EffectLayer = 'char' | 'smoke' | 'ember' | 'fire' | 'highChroma';
export interface Origin { readonly x: number; readonly y: number }
export interface Viewport { readonly width: number; readonly height: number }
export interface FrameMetrics {
  readonly encodedWidth: number;
  readonly encodedHeight: number;
  readonly opaqueFraction: number;
  readonly oldFraction: number;
  readonly targetFraction: number;
  readonly targetMaxRadius: number;
  readonly targetNearOrigin: number;
  readonly oldFarFromOrigin: number;
}
export interface EffectLayerMetrics {
  readonly count: number;
  readonly bandFraction: number;
  readonly radialP10: number;
  readonly radialP90: number;
  readonly radialCenter: number;
  readonly radialSpan: number;
  readonly angularBins: number;
  readonly angularHistogram: readonly number[];
}
export interface TransitionEffectMetrics {
  readonly endpointDistinctPixels: number;
  readonly classifiedPixels: number;
  readonly unclassifiedDistinctPixels: number;
  readonly layers: Readonly<Record<EffectLayer, EffectLayerMetrics>>;
}
export interface MetricRange { readonly minimum: number; readonly maximum: number }
export interface EffectDistributionRange {
  readonly bandFraction: MetricRange;
  readonly radialSpan: MetricRange;
  readonly angularBins: MetricRange;
  readonly radialCenter?: MetricRange;
  readonly angularReference?: readonly number[];
  readonly angularTotalVariationMaximum?: number;
}

type Rgb = readonly [number, number, number];
const COLORS: Record<Theme, Rgb> = { dark: [12, 12, 12], light: [245, 245, 240] };
const EFFECT_LAYERS: readonly EffectLayer[] = ['char', 'smoke', 'ember', 'fire', 'highChroma'];

function nearColor(data: Buffer, offset: number, color: Rgb, tolerance = 18): boolean {
  const red = data[offset]! - color[0];
  const green = data[offset + 1]! - color[1];
  const blue = data[offset + 2]! - color[2];
  return red * red + green * green + blue * blue <= tolerance * tolerance;
}

function radialPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  origin: Origin,
  viewport: Viewport,
): { radius: number; angle: number } {
  const dx = ((x + 0.5) / width - origin.x / viewport.width)
    * (viewport.width / viewport.height);
  const dy = (y + 0.5) / height - origin.y / viewport.height;
  return { radius: Math.hypot(dx, dy), angle: Math.atan2(dy, dx) };
}

function maximumChannelDelta(left: Buffer, right: Buffer, offset: number): number {
  return Math.max(
    Math.abs(left[offset]! - right[offset]!),
    Math.abs(left[offset + 1]! - right[offset + 1]!),
    Math.abs(left[offset + 2]! - right[offset + 2]!),
  );
}

function classifyEffect(red: number, green: number, blue: number): EffectLayer | null {
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const chroma = maximum - minimum;
  const luma = red * 0.2126 + green * 0.7152 + blue * 0.0722;
  if (luma < 70 && chroma <= 48 && red >= green && green >= blue) return 'char';
  if (luma >= 70 && luma <= 200 && chroma <= 28) return 'smoke';
  if (red >= 235 && green >= 105 && blue <= 140
    && red - green >= 20 && green - blue >= 20) return 'fire';
  if (chroma >= 90 && red >= 100 && red - green >= 30) return 'highChroma';
  if (red >= 100 && red < 235 && green >= 20 && blue <= 130
    && red - green >= 25 && green - blue >= 5) return 'ember';
  return null;
}

function layerMetrics(
  positions: readonly { radius: number; angle: number }[],
  bandPixels: number,
): EffectLayerMetrics {
  const radii = positions.map(({ radius }) => radius).sort((left, right) => left - right);
  const p10Index = Math.floor(Math.max(0, radii.length - 1) * 0.1);
  const p90Index = Math.ceil(Math.max(0, radii.length - 1) * 0.9);
  const radialP10 = radii[p10Index] ?? 0;
  const radialP90 = radii[p90Index] ?? 0;
  const angularCounts = new Array<number>(24).fill(0);
  for (const { angle } of positions) {
    const bin = Math.min(23, Math.max(
      0,
      Math.floor(((angle + Math.PI) / (2 * Math.PI)) * 24),
    ));
    angularCounts[bin] = (angularCounts[bin] ?? 0) + 1;
  }
  return {
    count: positions.length,
    bandFraction: positions.length / Math.max(1, bandPixels),
    radialP10,
    radialP90,
    radialCenter: (radialP10 + radialP90) / 2,
    radialSpan: radialP90 - radialP10,
    angularBins: angularCounts.filter((count) => count > 0).length,
    angularHistogram: angularCounts.map((count) => count / Math.max(1, positions.length)),
  };
}

export function analyzeFrame(
  bytes: Buffer,
  oldTheme: Theme,
  targetTheme: Theme,
  origin: Origin,
  viewport: Viewport,
): FrameMetrics {
  const image = PNG.sync.read(bytes);
  const pixelCount = image.width * image.height;
  let opaque = 0;
  let old = 0;
  let target = 0;
  let targetMaxRadius = 0;
  let near = 0;
  let targetNear = 0;
  let far = 0;
  let oldFar = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const offset = (y * image.width + x) * 4;
      const oldPixel = nearColor(image.data, offset, COLORS[oldTheme]);
      const targetPixel = nearColor(image.data, offset, COLORS[targetTheme]);
      const { radius } = radialPosition(x, y, image.width, image.height, origin, viewport);
      if (image.data[offset + 3] === 255) opaque += 1;
      if (oldPixel) old += 1;
      if (targetPixel) {
        target += 1;
        targetMaxRadius = Math.max(targetMaxRadius, radius);
      }
      if (radius < 0.14) {
        near += 1;
        if (targetPixel) targetNear += 1;
      }
      if (radius > 0.72) {
        far += 1;
        if (oldPixel) oldFar += 1;
      }
    }
  }
  return {
    encodedWidth: image.width,
    encodedHeight: image.height,
    opaqueFraction: opaque / pixelCount,
    oldFraction: old / pixelCount,
    targetFraction: target / pixelCount,
    targetMaxRadius,
    targetNearOrigin: targetNear / Math.max(1, near),
    oldFarFromOrigin: oldFar / Math.max(1, far),
  };
}

export function validateEarlyFrames(zero: FrameMetrics, hold: FrameMetrics): string[] {
  const violations: string[] = [];
  if (zero.targetFraction > 0.000005) violations.push('0ms-target-area');
  if (hold.targetFraction > 0.0001) violations.push('200ms-target-area');
  if (hold.targetMaxRadius > 0.02) violations.push('200ms-target-radius');
  if (hold.oldFarFromOrigin < 0.98) violations.push('200ms-old-far-field');
  return violations;
}

export function analyzeTransitionEffects(
  zeroBytes: Buffer,
  middleBytes: Buffer,
  completeBytes: Buffer,
  origin: Origin,
  viewport: Viewport,
): TransitionEffectMetrics {
  const zero = PNG.sync.read(zeroBytes);
  const middle = PNG.sync.read(middleBytes);
  const complete = PNG.sync.read(completeBytes);
  if (zero.width !== middle.width || zero.height !== middle.height
    || zero.width !== complete.width || zero.height !== complete.height) {
    throw new Error('Transition effect frames must have identical physical dimensions');
  }
  const positions: Record<EffectLayer, { radius: number; angle: number }[]> = {
    char: [],
    smoke: [],
    ember: [],
    fire: [],
    highChroma: [],
  };
  let bandPixels = 0;
  let endpointDistinctPixels = 0;
  let classifiedPixels = 0;
  for (let y = 0; y < middle.height; y += 1) {
    for (let x = 0; x < middle.width; x += 1) {
      const offset = (y * middle.width + x) * 4;
      const position = radialPosition(x, y, middle.width, middle.height, origin, viewport);
      if (position.radius < 0.18 || position.radius > 0.72) continue;
      bandPixels += 1;
      if (maximumChannelDelta(middle.data, zero.data, offset) < 12
        || maximumChannelDelta(middle.data, complete.data, offset) < 12) continue;
      endpointDistinctPixels += 1;
      const layer = classifyEffect(
        middle.data[offset]!,
        middle.data[offset + 1]!,
        middle.data[offset + 2]!,
      );
      if (!layer) continue;
      classifiedPixels += 1;
      positions[layer].push(position);
    }
  }
  return {
    endpointDistinctPixels,
    classifiedPixels,
    unclassifiedDistinctPixels: endpointDistinctPixels - classifiedPixels,
    layers: {
      char: layerMetrics(positions.char, bandPixels),
      smoke: layerMetrics(positions.smoke, bandPixels),
      ember: layerMetrics(positions.ember, bandPixels),
      fire: layerMetrics(positions.fire, bandPixels),
      highChroma: layerMetrics(positions.highChroma, bandPixels),
    },
  };
}

export function validateEffectPresence(metrics: TransitionEffectMetrics): string[] {
  return EFFECT_LAYERS
    .filter((layer) => metrics.layers[layer].count === 0)
    .map((layer) => `missing-${layer}`);
}

export function validateEffectDistributions(
  metrics: TransitionEffectMetrics,
  ranges: Readonly<Partial<Record<EffectLayer, EffectDistributionRange>>>,
): string[] {
  const violations: string[] = [];
  for (const layer of EFFECT_LAYERS) {
    const range = ranges[layer];
    if (!range) continue;
    for (const metric of ['bandFraction', 'radialSpan', 'angularBins'] as const) {
      const value = metrics.layers[layer][metric];
      if (value < range[metric].minimum || value > range[metric].maximum) {
        violations.push(`${layer}-${metric}`);
      }
    }
    if (range.radialCenter) {
      const { radialCenter } = metrics.layers[layer];
      if (radialCenter < range.radialCenter.minimum
        || radialCenter > range.radialCenter.maximum) {
        violations.push(`${layer}-radialCenter`);
      }
    }
    if (range.angularReference && range.angularTotalVariationMaximum !== undefined) {
      if (range.angularReference.length !== 24) {
        throw new Error('Angular distribution references must contain exactly 24 bins');
      }
      const distance = metrics.layers[layer].angularHistogram.reduce(
        (total, mass, index) => total + Math.abs(mass - range.angularReference![index]!),
        0,
      ) / 2;
      if (distance > range.angularTotalVariationMaximum) {
        violations.push(`${layer}-angularDistribution`);
      }
    }
  }
  return violations;
}
