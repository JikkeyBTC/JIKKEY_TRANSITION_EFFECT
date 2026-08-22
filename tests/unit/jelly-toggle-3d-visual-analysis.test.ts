import { describe, expect, it, vi } from 'vitest';

import type { JellyDiagnosticReadback } from '../../src/jelly-toggle-3d/renderer';
import {
  analyzeJellyFrame,
  assertJellyVisualRanges,
  cieDe2000,
  emitJellyDiagnosticSummaries,
  findFirstArchPeak,
  linearSrgbLuma,
  percentile,
  ssim,
  summarizeJellyDiagnosticState,
  type JellyFrameFixture,
  type JellyVisualLayer,
} from '../support/jelly-visual-analysis';
import { unpackRgba16FloatRows } from '../../src/jelly-toggle-3d/renderer';

const WIDTH = 6;
const HEIGHT = 4;

function pixelOffset(x: number, y: number): number {
  return (y * WIDTH + x) * 4;
}

function literalFixture(): JellyFrameFixture {
  const srgb = new Uint8Array(WIDTH * HEIGHT * 4);
  const attachmentA = new Float32Array(WIDTH * HEIGHT * 4);
  const attachmentB = new Float32Array(WIDTH * HEIGHT * 4);
  for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel += 1) {
    const offset = pixel * 4;
    srgb.set([238, 236, 232, 255], offset);
  }

  // A non-rectangular silhouette whose diagnostic fields do not overlap.
  const silhouette = [[1, 1], [2, 1], [3, 1], [4, 1], [1, 2], [2, 2], [3, 2], [4, 2]];
  for (const [x, y] of silhouette) {
    const offset = pixelOffset(x!, y!);
    attachmentA[offset] = 1;
    srgb.set([246 - x! * 9, 121 + y! * 5, 42 + x! * 3, 255], offset);
  }
  attachmentA[pixelOffset(1, 1) + 1] = 0.32; // rim only
  attachmentA[pixelOffset(2, 1) + 2] = 0.11; // transmission only
  attachmentA[pixelOffset(3, 1) + 3] = 0.18; // highlight only
  attachmentB[pixelOffset(1, 3)] = 0.14; // shadow only, outside silhouette
  attachmentB[pixelOffset(4, 3) + 1] = 0.20; // caustic only, outside silhouette/shadow

  const diagnostics: JellyDiagnosticReadback = {
    width: WIDTH,
    height: HEIGHT,
    attachmentA,
    attachmentB,
  };
  return {
    width: WIDTH,
    height: HEIGHT,
    srgb,
    diagnostics,
    metadata: { fixture: 'literal', thresholdVersion: 1 },
  };
}

function removeLayer(fixture: JellyFrameFixture, layer: JellyVisualLayer): JellyFrameFixture {
  const copy: JellyFrameFixture = {
    ...fixture,
    srgb: fixture.srgb.slice(),
    diagnostics: {
      ...fixture.diagnostics,
      attachmentA: fixture.diagnostics.attachmentA.slice(),
      attachmentB: fixture.diagnostics.attachmentB.slice(),
    },
  };
  const a = copy.diagnostics.attachmentA;
  const b = copy.diagnostics.attachmentB;
  const channel = {
    silhouette: [a, 0],
    rim: [a, 1],
    transmission: [a, 2],
    highlight: [a, 3],
    shadow: [b, 0],
    caustic: [b, 1],
  } as const;
  const [field, component] = channel[layer];
  for (let offset = component; offset < field.length; offset += 4) field[offset] = 0;
  return copy;
}

describe('jelly visual analysis', () => {
  it('emits all state summaries and returns before a summary-only writer path', () => {
    const log = vi.fn();
    const writer = vi.fn();
    const summaryOnly = emitJellyDiagnosticSummaries({
      enabled: true,
      frames: [
        { state: 'off', fixture: literalFixture() },
        { state: 'arch', fixture: literalFixture() },
        { state: 'on', fixture: literalFixture() },
      ],
      log,
    });
    if (!summaryOnly) writer();

    expect(writer).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledOnce();
    const payload = JSON.parse(log.mock.calls[0]![0] as string) as {
      label: string;
      summaries: Array<{ state: string }>;
    };
    expect(payload.label).toBe('JELLY_DIAGNOSTIC_SUMMARIES');
    expect(payload.summaries.map(({ state }) => state)).toEqual(['off', 'arch', 'on']);
  });

  it('summarizes caustic luma thresholds without mutating the state fixture', () => {
    const fixture = literalFixture();
    const caustic = fixture.diagnostics.attachmentB;
    for (let offset = 1; offset < caustic.length; offset += 4) caustic[offset] = 0;
    [0.0005, 0.001, 0.005, 0.01, 0.02].forEach((value, pixel) => {
      caustic[pixel * 4 + 1] = value;
    });
    const before = caustic.slice();

    const summary = summarizeJellyDiagnosticState('off', fixture);

    expect(summary.state).toBe('off');
    expect(summary.causticLuma.positiveCount).toBe(5);
    expect(summary.causticLuma.maximum).toBeCloseTo(0.02, 7);
    expect(summary.causticLuma.meanPositive).toBeCloseTo(0.0073, 7);
    expect(summary.causticLuma.countsAtOrAbove).toEqual({
      '0.001': 4,
      '0.005': 3,
      '0.01': 2,
      '0.02': 1,
    });
    expect(caustic).toEqual(before);
  });

  it('finds the first local arch maximum and chooses the earlier tie', () => {
    expect(findFirstArchPeak([0, 1, 3, 3, 2, 4, 1])).toBe(2);
    expect(() => findFirstArchPeak([0, 1, 2, 3])).toThrow(/arch peak/i);
  });

  it.each([
    'silhouette',
    'rim',
    'transmission',
    'highlight',
    'shadow',
    'caustic',
  ] as const)('fails when %s is removed', (layer) => {
    const expected = literalFixture();
    const actual = removeLayer(expected, layer);
    expect(() => assertJellyVisualRanges(analyzeJellyFrame(actual, expected))).toThrow(layer);
  });

  it.each([
    'silhouette',
    'rim',
    'transmission',
    'highlight',
    'shadow',
    'caustic',
  ] as const)('fails when %s is absent from both actual and expected fixtures', (layer) => {
    const fixture = literalFixture();
    const actual = removeLayer(fixture, layer);
    const expected = removeLayer(fixture, layer);
    expect(() => assertJellyVisualRanges(analyzeJellyFrame(actual, expected))).toThrow(layer);
  });

  it('classifies threshold boundaries inclusively and rejects nonzero reserved channels', () => {
    const expected = literalFixture();
    const actual = literalFixture();
    const rimOffset = pixelOffset(1, 1) + 1;
    const transmissionOffset = pixelOffset(2, 1) + 2;
    const highlightOffset = pixelOffset(3, 1) + 3;
    actual.diagnostics.attachmentA[rimOffset] = 0.20;
    expected.diagnostics.attachmentA[rimOffset] = 0.20;
    actual.diagnostics.attachmentA[transmissionOffset] = 0.02;
    expected.diagnostics.attachmentA[transmissionOffset] = 0.02;
    actual.diagnostics.attachmentA[highlightOffset] = 0.05;
    expected.diagnostics.attachmentA[highlightOffset] = 0.05;
    actual.diagnostics.attachmentB[pixelOffset(1, 3)] = 0.02;
    expected.diagnostics.attachmentB[pixelOffset(1, 3)] = 0.02;
    actual.diagnostics.attachmentB[pixelOffset(4, 3) + 1] = 0.02;
    expected.diagnostics.attachmentB[pixelOffset(4, 3) + 1] = 0.02;
    expect(() => assertJellyVisualRanges(analyzeJellyFrame(actual, expected))).not.toThrow();

    actual.diagnostics.attachmentB[pixelOffset(0, 0) + 2] = 0.0001;
    expect(() => analyzeJellyFrame(actual, expected)).toThrow(/reserved B\.zw/i);
  });

  it('accepts the calibrated 0.001 caustic boundary and rejects 0.000999', () => {
    const atBoundary = literalFixture();
    for (let offset = 1; offset < atBoundary.diagnostics.attachmentB.length; offset += 4) {
      atBoundary.diagnostics.attachmentB[offset] = 0;
    }
    atBoundary.diagnostics.attachmentB[pixelOffset(4, 3) + 1] = 0.001;
    expect(() => assertJellyVisualRanges(analyzeJellyFrame(atBoundary, atBoundary))).not.toThrow();

    const belowBoundary = literalFixture();
    for (let offset = 1; offset < belowBoundary.diagnostics.attachmentB.length; offset += 4) {
      belowBoundary.diagnostics.attachmentB[offset] = 0;
    }
    belowBoundary.diagnostics.attachmentB[pixelOffset(4, 3) + 1] = 0.000999;
    expect(() => assertJellyVisualRanges(analyzeJellyFrame(belowBoundary, belowBoundary))).toThrow(
      /caustic/i,
    );
  });

  it('rejects non-finite diagnostic fields and linearizes sRGB before luma metrics', () => {
    const actual = literalFixture();
    actual.diagnostics.attachmentA[pixelOffset(1, 1) + 2] = Number.NaN;
    expect(() => analyzeJellyFrame(actual, literalFixture())).toThrow(/finite/i);

    expect(linearSrgbLuma(new Uint8Array([128, 128, 128, 255]), 0)).toBeCloseTo(
      0.2158605001 * 255,
      5,
    );
  });

  it('reports literal bbox edges and centroids in physical pixels', () => {
    const expected = literalFixture();
    const actual = literalFixture();
    actual.diagnostics.attachmentA[pixelOffset(1, 1)] = 0;
    actual.diagnostics.attachmentA[pixelOffset(1, 2)] = 0;
    actual.diagnostics.attachmentB[pixelOffset(1, 3)] = 0;
    actual.diagnostics.attachmentB[pixelOffset(2, 3)] = 0.14;
    const metrics = analyzeJellyFrame(actual, expected);
    expect(metrics.edgeErrorPx).toEqual([1, 0, 0, 0]);
    expect(metrics.shadowCentroidErrorPx).toBe(1);
    expect(metrics.causticCentroidErrorPx).toBe(0);
  });

  it('decodes padded rgba16float rows into tightly packed Float32 data', () => {
    // width=2 is 16 bytes of rgba16f payload followed by padding to 256 bytes.
    const bytes = new Uint8Array(512);
    const row0 = new Uint16Array(bytes.buffer, 0, 8);
    const row1 = new Uint16Array(bytes.buffer, 256, 8);
    row0.set([0x0000, 0x3c00, 0xc000, 0x3800, 0x7bff, 0x0400, 0x0001, 0xbc00]);
    row1.set([0x4000, 0x4200, 0x4400, 0x4500, 0x4600, 0x4700, 0x4800, 0x4900]);
    bytes.fill(0xff, 16, 256);
    bytes.fill(0xff, 272, 512);

    expect([...unpackRgba16FloatRows(bytes, 2, 2, 256)]).toEqual([
      0, 1, -2, 0.5, 65504, 0.00006103515625, 5.960464477539063e-8, -1,
      2, 3, 4, 5, 6, 7, 8, 10,
    ]);
    expect(() => unpackRgba16FloatRows(bytes, 2, 2, 15)).toThrow(/bytesPerRow/i);
  });

  it('computes hand-checked CIEDE2000, percentile, and SSIM references', () => {
    expect(cieDe2000([50, 2.6772, -79.7751], [50, 0, -82.7485])).toBeCloseTo(2.0425, 4);
    expect(cieDe2000([50, 0, 0], [50, 0, 0])).toBe(0);
    expect(percentile([9, 1, 5, 3], 0.95)).toBeCloseTo(8.4, 10);
    expect(percentile([1, 3, 5, 9], 0.5)).toBe(4);
    expect(ssim(new Float64Array([0, 64, 128, 255]), new Float64Array([0, 64, 128, 255]))).toBe(1);
    expect(ssim(new Float64Array([0, 0, 0, 0]), new Float64Array([255, 255, 255, 255])))
      .toBeLessThan(0.001);
  });

  it('accepts exact metric boundaries and rejects the first value outside each gate', () => {
    const baseline = analyzeJellyFrame(literalFixture(), literalFixture());
    const boundary = {
      ...baseline,
      silhouetteIou: 0.97,
      edgeErrorPx: [2, 2, 2, 2] as const,
      jellyMeanDeltaE: 3,
      jellyP95DeltaE: 8,
      rimIou: 0.85,
      highlightIou: 0.85,
      transmissionIou: 0.85,
      shadowIou: 0.82,
      causticIou: 0.82,
      shadowCentroidErrorPx: 3,
      causticCentroidErrorPx: 3,
      cropSsim: 0.985,
      bridgeThicknessRatio: 0.95,
      headCapRatio: 1.05,
      rimAreaRatio: 0.9,
      highlightAreaRatio: 1.1,
      transmissionLumaRatio: 0.92,
    };
    expect(() => assertJellyVisualRanges(boundary)).not.toThrow();

    for (const [name, metrics] of [
      ['silhouette', { ...boundary, silhouetteIou: 0.969 }],
      ['bbox', { ...boundary, edgeErrorPx: [2.01, 0, 0, 0] as const }],
      ['jelly color', { ...boundary, jellyP95DeltaE: 8.01 }],
      ['rim', { ...boundary, rimAreaRatio: 0.899 }],
      ['highlight', { ...boundary, highlightIou: 0.849 }],
      ['transmission', { ...boundary, transmissionLumaRatio: 1.081 }],
      ['shadow', { ...boundary, shadowCentroidErrorPx: 3.01 }],
      ['caustic', { ...boundary, causticIou: 0.819 }],
      ['SSIM', { ...boundary, cropSsim: 0.9849 }],
    ] as const) {
      expect(() => assertJellyVisualRanges(metrics)).toThrow(name);
    }
  });
});
