import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  analyzeFrame,
  analyzeTransitionEffects,
  validateEarlyFrames,
  validateEffectDistributions,
  validateEffectPresence,
  type EffectLayer,
} from '../support/visual-analysis';

type Rgb = readonly [number, number, number];

function solidPng(width: number, height: number, color: Rgb): PNG {
  const image = new PNG({ width, height });
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = color[0];
    image.data[offset + 1] = color[1];
    image.data[offset + 2] = color[2];
    image.data[offset + 3] = 255;
  }
  return image;
}

function setPixel(image: PNG, x: number, y: number, color: Rgb): void {
  const offset = (y * image.width + x) * 4;
  image.data[offset] = color[0];
  image.data[offset + 1] = color[1];
  image.data[offset + 2] = color[2];
  image.data[offset + 3] = 255;
}

function effectFixture(omit?: EffectLayer): { zero: Buffer; middle: Buffer; complete: Buffer } {
  const zero = solidPng(64, 64, [12, 12, 12]);
  const middle = solidPng(64, 64, [12, 12, 12]);
  const complete = solidPng(64, 64, [245, 245, 240]);
  const pixels: Record<EffectLayer, { color: Rgb; positions: readonly (readonly [number, number])[] }> = {
    char: { color: [52, 30, 20], positions: [[48, 32], [49, 33], [50, 31]] },
    smoke: { color: [115, 110, 105], positions: [[32, 48], [33, 49], [31, 50]] },
    ember: { color: [170, 100, 90], positions: [[16, 32], [15, 33], [14, 31]] },
    fire: { color: [250, 175, 70], positions: [[32, 16], [33, 15], [31, 14]] },
    highChroma: { color: [150, 35, 120], positions: [[44, 44], [45, 45], [46, 46]] },
  };
  for (const [layer, specification] of Object.entries(pixels) as [EffectLayer, typeof pixels[EffectLayer]][]) {
    if (layer === omit) continue;
    for (const [x, y] of specification.positions) setPixel(middle, x, y, specification.color);
  }

  // A stable gray glyph/background must never satisfy a dynamic effect predicate.
  for (const [x, y] of [[30, 30], [31, 31]] as const) {
    setPixel(zero, x, y, [90, 90, 90]);
    setPixel(middle, x, y, [90, 90, 90]);
    setPixel(complete, x, y, [90, 90, 90]);
  }
  return {
    zero: PNG.sync.write(zero),
    middle: PNG.sync.write(middle),
    complete: PNG.sync.write(complete),
  };
}

function charPositionsFixture(
  positions: readonly (readonly [number, number])[],
): { zero: Buffer; middle: Buffer; complete: Buffer } {
  const zero = solidPng(64, 64, [12, 12, 12]);
  const middle = solidPng(64, 64, [12, 12, 12]);
  const complete = solidPng(64, 64, [245, 245, 240]);
  for (const [x, y] of positions) setPixel(middle, x, y, [52, 30, 20]);
  return {
    zero: PNG.sync.write(zero),
    middle: PNG.sync.write(middle),
    complete: PNG.sync.write(complete),
  };
}

function analyzeCharPositions(
  positions: readonly (readonly [number, number])[],
  origin = { x: 32, y: 32 },
) {
  const fixture = charPositionsFixture(positions);
  return analyzeTransitionEffects(
    fixture.zero,
    fixture.middle,
    fixture.complete,
    origin,
    { width: 64, height: 64 },
  );
}

describe('visual analysis', () => {
  it('rejects target pixels already exposed at absolute 0ms', () => {
    const zero = solidPng(100, 100, [12, 12, 12]);
    for (let index = 0; index < 100; index += 1) {
      setPixel(zero, index, 0, [245, 245, 240]);
    }
    const hold = solidPng(100, 100, [12, 12, 12]);
    const zeroMetrics = analyzeFrame(PNG.sync.write(zero), 'dark', 'light', { x: 50, y: 50 }, {
      width: 100,
      height: 100,
    });
    const holdMetrics = analyzeFrame(PNG.sync.write(hold), 'dark', 'light', { x: 50, y: 50 }, {
      width: 100,
      height: 100,
    });

    expect(validateEarlyFrames(zeroMetrics, holdMetrics)).toContain('0ms-target-area');
  });

  it('rejects absolute target area and radius at 200ms even when the same reveal exists at 0ms', () => {
    const zero = solidPng(100, 100, [12, 12, 12]);
    const hold = solidPng(100, 100, [12, 12, 12]);
    for (let index = 0; index < 25; index += 1) {
      const x = 85 + index % 5;
      const y = 45 + Math.floor(index / 5);
      setPixel(zero, x, y, [245, 245, 240]);
      setPixel(hold, x, y, [245, 245, 240]);
    }
    const options = [{ x: 50, y: 50 }, { width: 100, height: 100 }] as const;
    const zeroMetrics = analyzeFrame(PNG.sync.write(zero), 'dark', 'light', ...options);
    const holdMetrics = analyzeFrame(PNG.sync.write(hold), 'dark', 'light', ...options);

    expect(validateEarlyFrames(zeroMetrics, holdMetrics)).toEqual(expect.arrayContaining([
      '0ms-target-area',
      '200ms-target-area',
      '200ms-target-radius',
    ]));
  });

  it('classifies mutually exclusive dynamic layers and excludes a static gray glyph', () => {
    const fixture = effectFixture();
    const metrics = analyzeTransitionEffects(
      fixture.zero,
      fixture.middle,
      fixture.complete,
      { x: 32, y: 32 },
      { width: 64, height: 64 },
    );

    expect(metrics.endpointDistinctPixels).toBe(15);
    expect(metrics.classifiedPixels).toBe(15);
    expect(metrics.unclassifiedDistinctPixels).toBe(0);
    expect(Object.fromEntries(Object.entries(metrics.layers).map(([name, layer]) => [name, layer.count])))
      .toEqual({ char: 3, smoke: 3, ember: 3, fire: 3, highChroma: 3 });
  });

  it('separates medium warm embers from the strongest high-chroma burn pixels', () => {
    const fixture = effectFixture();
    const middle = PNG.sync.read(fixture.middle);
    setPixel(middle, 42, 20, [180, 85, 25]);
    const metrics = analyzeTransitionEffects(
      fixture.zero,
      PNG.sync.write(middle),
      fixture.complete,
      { x: 32, y: 32 },
      { width: 64, height: 64 },
    );

    expect(metrics.layers.ember.count).toBe(3);
    expect(metrics.layers.highChroma.count).toBe(4);
  });

  it.each(['char', 'smoke', 'ember', 'fire', 'highChroma'] as const)(
    'reports a missing %s layer independently',
    (omitted) => {
      const fixture = effectFixture(omitted);
      const metrics = analyzeTransitionEffects(
        fixture.zero,
        fixture.middle,
        fixture.complete,
        { x: 32, y: 32 },
        { width: 64, height: 64 },
      );

      expect(validateEffectPresence(metrics)).toEqual([`missing-${omitted}`]);
    },
  );

  it('rejects effect buckets whose area or spatial distribution leaves calibrated bounds', () => {
    const fixture = effectFixture();
    const metrics = analyzeTransitionEffects(
      fixture.zero,
      fixture.middle,
      fixture.complete,
      { x: 32, y: 32 },
      { width: 64, height: 64 },
    );
    const ranges = {
      char: {
        bandFraction: { minimum: 0.1, maximum: 0.2 },
        radialSpan: { minimum: 0.1, maximum: 0.2 },
        angularBins: { minimum: 4, maximum: 6 },
      },
    } as const;

    expect(validateEffectDistributions(metrics, ranges)).toEqual([
      'char-bandFraction',
      'char-radialSpan',
      'char-angularBins',
    ]);
  });

  it('rejects a bodily radial shift that preserves area, radial span, and angular bin count', () => {
    const origin = { x: 32.5, y: 32.5 };
    const baseline = analyzeCharPositions([[44, 32], [46, 32], [48, 32], [50, 32]], origin);
    const shifted = analyzeCharPositions([[52, 32], [54, 32], [56, 32], [58, 32]], origin);
    const ranges = {
      char: {
        bandFraction: { minimum: 0.0001, maximum: 0.01 },
        radialSpan: { minimum: 0.09, maximum: 0.1 },
        angularBins: { minimum: 1, maximum: 1 },
        radialCenter: { minimum: 0.23, maximum: 0.255 },
        angularReference: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        angularTotalVariationMaximum: 0.1,
      },
    } as const;

    expect(baseline.layers.char.count).toBe(4);
    expect(shifted.layers.char.count).toBe(4);
    expect(baseline.layers.char.radialSpan).toBeCloseTo(0.09375, 8);
    expect(shifted.layers.char.radialSpan).toBeCloseTo(0.09375, 8);
    expect(baseline.layers.char.angularBins).toBe(1);
    expect(shifted.layers.char.angularBins).toBe(1);
    expect(validateEffectDistributions(baseline, ranges as never)).toEqual([]);
    expect(validateEffectDistributions(shifted, ranges as never)).toEqual(['char-radialCenter']);
  });

  it('rejects an angular rotation that preserves area, radial span, and angular bin count', () => {
    const baselinePositions = [[44, 32], [50, 32], [43, 36], [49, 39], [42, 39], [46, 44]] as const;
    const rotatedPositions = baselinePositions.map(([x, y]) => [63 - y, x] as const);
    const baseline = analyzeCharPositions(baselinePositions);
    const rotated = analyzeCharPositions(rotatedPositions);
    const ranges = {
      char: {
        bandFraction: { minimum: 0.0001, maximum: 0.01 },
        radialSpan: { minimum: 0.1, maximum: 0.11 },
        angularBins: { minimum: 3, maximum: 3 },
        radialCenter: { minimum: 0.235, maximum: 0.26 },
        angularReference: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 / 3, 1 / 3, 1 / 3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        angularTotalVariationMaximum: 0.1,
      },
    } as const;

    expect(baseline.layers.char.count).toBe(6);
    expect(rotated.layers.char.count).toBe(6);
    expect(baseline.layers.char.radialSpan).toBeCloseTo(0.10617, 4);
    expect(rotated.layers.char.radialSpan).toBeCloseTo(0.10617, 4);
    expect(baseline.layers.char.angularBins).toBe(3);
    expect(rotated.layers.char.angularBins).toBe(3);
    expect(validateEffectDistributions(baseline, ranges as never)).toEqual([]);
    expect(validateEffectDistributions(rotated, ranges as never)).toEqual(['char-angularDistribution']);
  });

  it('rejects angular mass concentration with unchanged area, radial extrema, and occupied bins', () => {
    const baseline = analyzeCharPositions([[44, 32], [50, 32], [43, 36], [49, 39], [42, 39], [46, 44]]);
    const concentrated = analyzeCharPositions([[44, 32], [45, 32], [48, 32], [50, 32], [43, 36], [46, 44]]);
    const ranges = {
      char: {
        bandFraction: { minimum: 0.0001, maximum: 0.01 },
        radialSpan: { minimum: 0.1, maximum: 0.11 },
        angularBins: { minimum: 3, maximum: 3 },
        radialCenter: { minimum: 0.235, maximum: 0.26 },
        angularReference: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1 / 3, 1 / 3, 1 / 3, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        angularTotalVariationMaximum: 0.1,
      },
    } as const;

    expect(concentrated.layers.char.count).toBe(6);
    expect(concentrated.layers.char.radialSpan).toBeCloseTo(baseline.layers.char.radialSpan, 8);
    expect(concentrated.layers.char.angularBins).toBe(3);
    expect(validateEffectDistributions(baseline, ranges as never)).toEqual([]);
    expect(validateEffectDistributions(concentrated, ranges as never))
      .toEqual(['char-angularDistribution']);
  });
});
