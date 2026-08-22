import type { JellyDiagnosticReadback } from '../../src/jelly-toggle-3d/renderer';

export interface JellyFrameFixture {
  readonly width: number;
  readonly height: number;
  readonly srgb: Uint8Array;
  readonly diagnostics: JellyDiagnosticReadback;
  readonly metadata: Readonly<Record<string, string | number>>;
}

export type JellyVisualLayer =
  | 'silhouette'
  | 'rim'
  | 'transmission'
  | 'highlight'
  | 'shadow'
  | 'caustic';

export interface JellyVisualMetrics {
  readonly actualLayerAreas: Readonly<Record<JellyVisualLayer, number>>;
  readonly expectedLayerAreas: Readonly<Record<JellyVisualLayer, number>>;
  readonly silhouetteIou: number;
  readonly edgeErrorPx: readonly [number, number, number, number];
  readonly bridgeThicknessRatio: number;
  readonly headCapRatio: number;
  readonly jellyMeanDeltaE: number;
  readonly jellyP95DeltaE: number;
  readonly rimIou: number;
  readonly rimAreaRatio: number;
  readonly highlightIou: number;
  readonly highlightAreaRatio: number;
  readonly transmissionIou: number;
  readonly transmissionLumaRatio: number;
  readonly shadowIou: number;
  readonly causticIou: number;
  readonly shadowCentroidErrorPx: number;
  readonly causticCentroidErrorPx: number;
  readonly cropSsim: number;
}

export interface JellyDiagnosticStateSummary {
  readonly state: string;
  readonly causticLuma: {
    readonly maximum: number;
    readonly meanPositive: number;
    readonly positiveCount: number;
    readonly countsAtOrAbove: Readonly<Record<'0.001' | '0.005' | '0.01' | '0.02', number>>;
  };
}

type Lab = readonly [number, number, number];
type Box = readonly [left: number, top: number, right: number, bottom: number];

const MASK_THRESHOLDS = Object.freeze({
  silhouette: Math.fround(0.5),
  rim: Math.fround(0.2),
  transmission: Math.fround(0.02),
  highlight: Math.fround(0.05),
  shadow: Math.fround(0.02),
  caustic: Math.fround(0.001),
});

const MINIMUM_EXPECTED_LAYER_AREA: Readonly<Record<JellyVisualLayer, number>> = Object.freeze({
  silhouette: 4,
  rim: 1,
  transmission: 1,
  highlight: 1,
  shadow: 1,
  caustic: 1,
});

const VISUAL_LAYERS = Object.freeze([
  'silhouette',
  'rim',
  'transmission',
  'highlight',
  'shadow',
  'caustic',
] as const satisfies readonly JellyVisualLayer[]);

export function summarizeJellyDiagnosticState(
  state: string,
  fixture: JellyFrameFixture,
): JellyDiagnosticStateSummary {
  assertFixture(fixture, `${state} diagnostic summary`);
  const thresholds = [
    ['0.001', Math.fround(0.001)],
    ['0.005', Math.fround(0.005)],
    ['0.01', Math.fround(0.01)],
    ['0.02', Math.fround(0.02)],
  ] as const;
  const counts = {
    '0.001': 0,
    '0.005': 0,
    '0.01': 0,
    '0.02': 0,
  };
  let maximum = 0;
  let positiveCount = 0;
  let positiveSum = 0;
  const attachmentB = fixture.diagnostics.attachmentB;
  for (let offset = 1; offset < attachmentB.length; offset += 4) {
    const value = attachmentB[offset]!;
    if (value > 0) {
      maximum = Math.max(maximum, value);
      positiveCount += 1;
      positiveSum += value;
    }
    for (const [label, threshold] of thresholds) {
      if (value >= threshold) counts[label] += 1;
    }
  }
  return {
    state,
    causticLuma: {
      maximum,
      meanPositive: positiveCount === 0 ? 0 : positiveSum / positiveCount,
      positiveCount,
      countsAtOrAbove: counts,
    },
  };
}

export function emitJellyDiagnosticSummaries(options: {
  readonly enabled: boolean;
  readonly frames: readonly {
    readonly state: string;
    readonly fixture: JellyFrameFixture;
  }[];
  readonly log: (message: string) => void;
}): boolean {
  if (!options.enabled) return false;
  options.log(JSON.stringify({
    label: 'JELLY_DIAGNOSTIC_SUMMARIES',
    summaries: options.frames.map(({ state, fixture }) =>
      summarizeJellyDiagnosticState(state, fixture)),
  }));
  return true;
}

export function findFirstArchPeak(extents: readonly number[]): number {
  for (let index = 1; index < extents.length - 1; index += 1) {
    if (extents[index - 1]! < extents[index]! && extents[index]! >= extents[index + 1]!) {
      return index;
    }
  }
  throw new Error('No local arch peak was found');
}

function assertFixture(fixture: JellyFrameFixture, name: string): void {
  if (!Number.isInteger(fixture.width) || fixture.width <= 0) {
    throw new Error(`${name} width must be a positive integer`);
  }
  if (!Number.isInteger(fixture.height) || fixture.height <= 0) {
    throw new Error(`${name} height must be a positive integer`);
  }
  const values = fixture.width * fixture.height * 4;
  if (fixture.srgb.length !== values) throw new Error(`${name} sRGB dimensions do not match`);
  if (
    fixture.diagnostics.width !== fixture.width
    || fixture.diagnostics.height !== fixture.height
    || fixture.diagnostics.attachmentA.length !== values
    || fixture.diagnostics.attachmentB.length !== values
  ) {
    throw new Error(`${name} diagnostic dimensions do not match`);
  }
  for (let offset = 0; offset < values; offset += 4) {
    for (let channel = 0; channel < 4; channel += 1) {
      if (
        !Number.isFinite(fixture.diagnostics.attachmentA[offset + channel])
        || !Number.isFinite(fixture.diagnostics.attachmentB[offset + channel])
      ) {
        throw new Error(`${name} diagnostic fields must be finite`);
      }
    }
    if (
      fixture.diagnostics.attachmentB[offset + 2] !== 0
      || fixture.diagnostics.attachmentB[offset + 3] !== 0
    ) {
      throw new Error(`${name} reserved B.zw channels must be zero`);
    }
  }
}

function maskFor(fixture: JellyFrameFixture, layer: JellyVisualLayer): Uint8Array {
  const pixelCount = fixture.width * fixture.height;
  const mask = new Uint8Array(pixelCount);
  const a = fixture.diagnostics.attachmentA;
  const b = fixture.diagnostics.attachmentB;
  for (let pixel = 0; pixel < pixelCount; pixel += 1) {
    const offset = pixel * 4;
    const hit = a[offset]! >= MASK_THRESHOLDS.silhouette;
    mask[pixel] = Number(switchLayer(layer, hit, a, b, offset));
  }
  return mask;
}

function switchLayer(
  layer: JellyVisualLayer,
  hit: boolean,
  a: Float32Array,
  b: Float32Array,
  offset: number,
): boolean {
  switch (layer) {
    case 'silhouette': return hit;
    case 'rim': return hit && a[offset + 1]! >= MASK_THRESHOLDS.rim;
    case 'transmission': return hit && a[offset + 2]! >= MASK_THRESHOLDS.transmission;
    case 'highlight': return hit && a[offset + 3]! >= MASK_THRESHOLDS.highlight;
    case 'shadow': return b[offset]! >= MASK_THRESHOLDS.shadow;
    case 'caustic': return b[offset + 1]! >= MASK_THRESHOLDS.caustic;
  }
}

function area(mask: Uint8Array): number {
  let result = 0;
  for (const value of mask) result += value;
  return result;
}

function iou(actual: Uint8Array, expected: Uint8Array): number {
  let intersection = 0;
  let union = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const either = Boolean(actual[index] || expected[index]);
    if (either) union += 1;
    if (actual[index] && expected[index]) intersection += 1;
  }
  return union === 0 ? 1 : intersection / union;
}

function areaRatio(actual: Uint8Array, expected: Uint8Array): number {
  const expectedArea = area(expected);
  const actualArea = area(actual);
  return expectedArea === 0 ? (actualArea === 0 ? 1 : Number.POSITIVE_INFINITY) : actualArea / expectedArea;
}

function bounds(mask: Uint8Array, width: number, height: number): Box | null {
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    left = Math.min(left, x);
    top = Math.min(top, y);
    right = Math.max(right, x);
    bottom = Math.max(bottom, y);
  }
  return right < left ? null : [left, top, right, bottom];
}

function edgeError(actual: Box | null, expected: Box | null): readonly [number, number, number, number] {
  if (!actual && !expected) return [0, 0, 0, 0];
  if (!actual || !expected) {
    return [Infinity, Infinity, Infinity, Infinity];
  }
  return [
    Math.abs(actual[0] - expected[0]),
    Math.abs(actual[1] - expected[1]),
    Math.abs(actual[2] - expected[2]),
    Math.abs(actual[3] - expected[3]),
  ];
}

function centroid(mask: Uint8Array, width: number): readonly [number, number] | null {
  let x = 0;
  let y = 0;
  let count = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    x += pixel % width;
    y += Math.floor(pixel / width);
    count += 1;
  }
  return count === 0 ? null : [x / count, y / count];
}

function centroidError(
  actual: Uint8Array,
  expected: Uint8Array,
  width: number,
): number {
  const actualCenter = centroid(actual, width);
  const expectedCenter = centroid(expected, width);
  if (!actualCenter && !expectedCenter) return 0;
  if (!actualCenter || !expectedCenter) return Infinity;
  return Math.hypot(actualCenter[0] - expectedCenter[0], actualCenter[1] - expectedCenter[1]);
}

function srgbChannelToLinear(value: number): number {
  const channel = value / 255;
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function rgbToLab(bytes: Uint8Array, offset: number): Lab {
  const red = srgbChannelToLinear(bytes[offset]!);
  const green = srgbChannelToLinear(bytes[offset + 1]!);
  const blue = srgbChannelToLinear(bytes[offset + 2]!);
  const x = (red * 0.4124564 + green * 0.3575761 + blue * 0.1804375) / 0.95047;
  const y = red * 0.2126729 + green * 0.7151522 + blue * 0.072175;
  const z = (red * 0.0193339 + green * 0.119192 + blue * 0.9503041) / 1.08883;
  const transform = (value: number): number => value > 216 / 24389
    ? Math.cbrt(value)
    : (24389 / 27 * value + 16) / 116;
  const fx = transform(x);
  const fy = transform(y);
  const fz = transform(z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function degrees(radians: number): number {
  const value = radians * 180 / Math.PI;
  return value >= 0 ? value : value + 360;
}

function radians(degreesValue: number): number {
  return degreesValue * Math.PI / 180;
}

/** CIEDE2000 with the reference weighting factors kL=kC=kH=1. */
export function cieDe2000(first: Lab, second: Lab): number {
  const [l1, a1, b1] = first;
  const [l2, a2, b2] = second;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cBar = (c1 + c2) / 2;
  const cBar7 = cBar ** 7;
  const g = 0.5 * (1 - Math.sqrt(cBar7 / (cBar7 + 25 ** 7)));
  const a1Prime = (1 + g) * a1;
  const a2Prime = (1 + g) * a2;
  const c1Prime = Math.hypot(a1Prime, b1);
  const c2Prime = Math.hypot(a2Prime, b2);
  const h1Prime = c1Prime === 0 ? 0 : degrees(Math.atan2(b1, a1Prime));
  const h2Prime = c2Prime === 0 ? 0 : degrees(Math.atan2(b2, a2Prime));
  const deltaL = l2 - l1;
  const deltaC = c2Prime - c1Prime;
  let deltaHAngle = h2Prime - h1Prime;
  if (c1Prime * c2Prime === 0) deltaHAngle = 0;
  else if (deltaHAngle > 180) deltaHAngle -= 360;
  else if (deltaHAngle < -180) deltaHAngle += 360;
  const deltaH = 2 * Math.sqrt(c1Prime * c2Prime) * Math.sin(radians(deltaHAngle / 2));
  const lBar = (l1 + l2) / 2;
  const cPrimeBar = (c1Prime + c2Prime) / 2;
  let hPrimeBar = h1Prime + h2Prime;
  if (c1Prime * c2Prime === 0) hPrimeBar = h1Prime + h2Prime;
  else if (Math.abs(h1Prime - h2Prime) <= 180) hPrimeBar /= 2;
  else if (h1Prime + h2Prime < 360) hPrimeBar = (hPrimeBar + 360) / 2;
  else hPrimeBar = (hPrimeBar - 360) / 2;
  const t = 1
    - 0.17 * Math.cos(radians(hPrimeBar - 30))
    + 0.24 * Math.cos(radians(2 * hPrimeBar))
    + 0.32 * Math.cos(radians(3 * hPrimeBar + 6))
    - 0.20 * Math.cos(radians(4 * hPrimeBar - 63));
  const deltaTheta = 30 * Math.exp(-(((hPrimeBar - 275) / 25) ** 2));
  const cPrimeBar7 = cPrimeBar ** 7;
  const rc = 2 * Math.sqrt(cPrimeBar7 / (cPrimeBar7 + 25 ** 7));
  const sl = 1 + 0.015 * (lBar - 50) ** 2 / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cPrimeBar;
  const sh = 1 + 0.015 * cPrimeBar * t;
  const rt = -Math.sin(radians(2 * deltaTheta)) * rc;
  const lTerm = deltaL / sl;
  const cTerm = deltaC / sc;
  const hTerm = deltaH / sh;
  return Math.sqrt(lTerm ** 2 + cTerm ** 2 + hTerm ** 2 + rt * cTerm * hTerm);
}

export function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  if (!Number.isFinite(quantile) || quantile < 0 || quantile > 1) {
    throw new Error('Percentile quantile must be between zero and one');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = (sorted.length - 1) * quantile;
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (rank - lower);
}

/** Global-luminance SSIM, with the standard 8-bit constants. */
export function ssim(actual: Float64Array, expected: Float64Array): number {
  if (actual.length !== expected.length) throw new Error('SSIM dimensions do not match');
  if (actual.length === 0) return 0;
  let actualMean = 0;
  let expectedMean = 0;
  for (let index = 0; index < actual.length; index += 1) {
    actualMean += actual[index]!;
    expectedMean += expected[index]!;
  }
  actualMean /= actual.length;
  expectedMean /= expected.length;
  let actualVariance = 0;
  let expectedVariance = 0;
  let covariance = 0;
  for (let index = 0; index < actual.length; index += 1) {
    const actualDelta = actual[index]! - actualMean;
    const expectedDelta = expected[index]! - expectedMean;
    actualVariance += actualDelta ** 2;
    expectedVariance += expectedDelta ** 2;
    covariance += actualDelta * expectedDelta;
  }
  const divisor = Math.max(1, actual.length - 1);
  actualVariance /= divisor;
  expectedVariance /= divisor;
  covariance /= divisor;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  return (
    (2 * actualMean * expectedMean + c1) * (2 * covariance + c2)
    / ((actualMean ** 2 + expectedMean ** 2 + c1) * (actualVariance + expectedVariance + c2))
  );
}

export function linearSrgbLuma(bytes: Uint8Array, offset: number): number {
  return 255 * (
    0.2126 * srgbChannelToLinear(bytes[offset]!)
    + 0.7152 * srgbChannelToLinear(bytes[offset + 1]!)
    + 0.0722 * srgbChannelToLinear(bytes[offset + 2]!)
  );
}

function cropLuma(bytes: Uint8Array, width: number, box: Box | null): Float64Array {
  if (!box) return new Float64Array();
  const result = new Float64Array((box[2] - box[0] + 1) * (box[3] - box[1] + 1));
  let target = 0;
  for (let y = box[1]; y <= box[3]; y += 1) {
    for (let x = box[0]; x <= box[2]; x += 1) {
      result[target++] = linearSrgbLuma(bytes, (y * width + x) * 4);
    }
  }
  return result;
}

function enclosingBox(first: Box | null, second: Box | null): Box | null {
  if (!first) return second;
  if (!second) return first;
  return [
    Math.min(first[0], second[0]),
    Math.min(first[1], second[1]),
    Math.max(first[2], second[2]),
    Math.max(first[3], second[3]),
  ];
}

function meanDiagnostic(
  field: Float32Array,
  channel: number,
  mask: Uint8Array,
): number {
  let sum = 0;
  let count = 0;
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    if (!mask[pixel]) continue;
    sum += field[pixel * 4 + channel]!;
    count += 1;
  }
  return count === 0 ? 0 : sum / count;
}

function finiteRatio(actual: number, expected: number): number {
  return expected === 0 ? (actual === 0 ? 1 : Infinity) : actual / expected;
}

function shapeMeasurements(mask: Uint8Array, width: number, height: number): readonly [number, number] {
  const box = bounds(mask, width, height);
  if (!box) return [0, 0];
  const spans: number[] = [];
  for (let x = box[0]; x <= box[2]; x += 1) {
    let top = height;
    let bottom = -1;
    for (let y = box[1]; y <= box[3]; y += 1) {
      if (mask[y * width + x]) {
        top = Math.min(top, y);
        bottom = Math.max(bottom, y);
      }
    }
    spans.push(bottom < top ? 0 : bottom - top + 1);
  }
  const bridgeEnd = Math.max(1, Math.ceil(spans.length * 0.7));
  const bridge = percentile(spans.slice(0, bridgeEnd).filter((value) => value > 0), 0.5);
  const headStart = Math.max(0, Math.floor(spans.length * 0.75));
  const head = Math.max(0, ...spans.slice(headStart));
  return [bridge, head];
}

export function analyzeJellyFrame(
  actual: JellyFrameFixture,
  expected: JellyFrameFixture,
): JellyVisualMetrics {
  assertFixture(actual, 'actual');
  assertFixture(expected, 'expected');
  if (actual.width !== expected.width || actual.height !== expected.height) {
    throw new Error('Actual and expected fixture dimensions do not match');
  }

  const actualMasks = Object.fromEntries(
    VISUAL_LAYERS
      .map((layer) => [layer, maskFor(actual, layer)]),
  ) as Record<JellyVisualLayer, Uint8Array>;
  const expectedMasks = Object.fromEntries(
    VISUAL_LAYERS
      .map((layer) => [layer, maskFor(expected, layer)]),
  ) as Record<JellyVisualLayer, Uint8Array>;
  const actualLayerAreas = Object.fromEntries(
    VISUAL_LAYERS.map((layer) => [layer, area(actualMasks[layer])]),
  ) as Record<JellyVisualLayer, number>;
  const expectedLayerAreas = Object.fromEntries(
    VISUAL_LAYERS.map((layer) => [layer, area(expectedMasks[layer])]),
  ) as Record<JellyVisualLayer, number>;
  const actualBox = bounds(actualMasks.silhouette, actual.width, actual.height);
  const expectedBox = bounds(expectedMasks.silhouette, expected.width, expected.height);
  const deltaE: number[] = [];
  for (let pixel = 0; pixel < expectedMasks.silhouette.length; pixel += 1) {
    if (!expectedMasks.silhouette[pixel]) continue;
    const offset = pixel * 4;
    deltaE.push(cieDe2000(rgbToLab(actual.srgb, offset), rgbToLab(expected.srgb, offset)));
  }
  const [actualBridge, actualHead] = shapeMeasurements(
    actualMasks.silhouette,
    actual.width,
    actual.height,
  );
  const [expectedBridge, expectedHead] = shapeMeasurements(
    expectedMasks.silhouette,
    expected.width,
    expected.height,
  );
  const actualTransmissionLuma = meanDiagnostic(
    actual.diagnostics.attachmentA,
    2,
    actualMasks.transmission,
  );
  const expectedTransmissionLuma = meanDiagnostic(
    expected.diagnostics.attachmentA,
    2,
    expectedMasks.transmission,
  );
  const cropBox = enclosingBox(actualBox, expectedBox);

  return {
    actualLayerAreas,
    expectedLayerAreas,
    silhouetteIou: iou(actualMasks.silhouette, expectedMasks.silhouette),
    edgeErrorPx: edgeError(actualBox, expectedBox),
    bridgeThicknessRatio: finiteRatio(actualBridge, expectedBridge),
    headCapRatio: finiteRatio(actualHead, expectedHead),
    jellyMeanDeltaE: deltaE.length === 0
      ? Infinity
      : deltaE.reduce((sum, value) => sum + value, 0) / deltaE.length,
    jellyP95DeltaE: deltaE.length === 0 ? Infinity : percentile(deltaE, 0.95),
    rimIou: iou(actualMasks.rim, expectedMasks.rim),
    rimAreaRatio: areaRatio(actualMasks.rim, expectedMasks.rim),
    highlightIou: iou(actualMasks.highlight, expectedMasks.highlight),
    highlightAreaRatio: areaRatio(actualMasks.highlight, expectedMasks.highlight),
    transmissionIou: iou(actualMasks.transmission, expectedMasks.transmission),
    transmissionLumaRatio: finiteRatio(actualTransmissionLuma, expectedTransmissionLuma),
    shadowIou: iou(actualMasks.shadow, expectedMasks.shadow),
    causticIou: iou(actualMasks.caustic, expectedMasks.caustic),
    shadowCentroidErrorPx: centroidError(actualMasks.shadow, expectedMasks.shadow, actual.width),
    causticCentroidErrorPx: centroidError(actualMasks.caustic, expectedMasks.caustic, actual.width),
    cropSsim: ssim(
      cropLuma(actual.srgb, actual.width, cropBox),
      cropLuma(expected.srgb, expected.width, cropBox),
    ),
  };
}

function inRatioRange(value: number, tolerance: number): boolean {
  return Number.isFinite(value) && value >= 1 - tolerance && value <= 1 + tolerance;
}

function requireRange(condition: boolean, layer: string, detail: string): void {
  if (!condition) throw new Error(`${layer} visual gate failed: ${detail}`);
}

export function assertJellyVisualRanges(metrics: JellyVisualMetrics): void {
  for (const layer of VISUAL_LAYERS) {
    requireRange(
      Number.isFinite(metrics.expectedLayerAreas[layer])
        && metrics.expectedLayerAreas[layer] >= MINIMUM_EXPECTED_LAYER_AREA[layer],
      layer,
      'expected layer is empty or below the minimum fixture area',
    );
    requireRange(
      Number.isFinite(metrics.actualLayerAreas[layer]) && metrics.actualLayerAreas[layer] > 0,
      layer,
      'actual layer is empty',
    );
  }
  requireRange(Number.isFinite(metrics.silhouetteIou) && metrics.silhouetteIou >= 0.97, 'silhouette', 'IoU');
  requireRange(metrics.edgeErrorPx.every((value) => Number.isFinite(value) && value <= 2), 'bbox', 'edge error');
  requireRange(inRatioRange(metrics.bridgeThicknessRatio, 0.05), 'bridge', 'thickness');
  requireRange(inRatioRange(metrics.headCapRatio, 0.05), 'head cap', 'diameter');
  requireRange(
    Number.isFinite(metrics.jellyMeanDeltaE)
      && Number.isFinite(metrics.jellyP95DeltaE)
      && metrics.jellyMeanDeltaE <= 3
      && metrics.jellyP95DeltaE <= 8,
    'jelly color',
    'CIEDE2000',
  );
  requireRange(
    Number.isFinite(metrics.rimIou)
      && metrics.rimIou >= 0.85
      && inRatioRange(metrics.rimAreaRatio, 0.1),
    'rim',
    'IoU/area',
  );
  requireRange(
    Number.isFinite(metrics.highlightIou)
      && metrics.highlightIou >= 0.85
      && inRatioRange(metrics.highlightAreaRatio, 0.1),
    'highlight',
    'IoU/area',
  );
  requireRange(
    Number.isFinite(metrics.transmissionIou)
      && metrics.transmissionIou >= 0.85
      && inRatioRange(metrics.transmissionLumaRatio, 0.08),
    'transmission',
    'IoU/luma',
  );
  requireRange(
    Number.isFinite(metrics.shadowIou)
      && metrics.shadowIou >= 0.82
      && Number.isFinite(metrics.shadowCentroidErrorPx)
      && metrics.shadowCentroidErrorPx <= 3,
    'shadow',
    'IoU/centroid',
  );
  requireRange(
    Number.isFinite(metrics.causticIou)
      && metrics.causticIou >= 0.82
      && Number.isFinite(metrics.causticCentroidErrorPx)
      && metrics.causticCentroidErrorPx <= 3,
    'caustic',
    'IoU/centroid',
  );
  requireRange(Number.isFinite(metrics.cropSsim) && metrics.cropSsim >= 0.985, 'SSIM', 'settled crop');
}
