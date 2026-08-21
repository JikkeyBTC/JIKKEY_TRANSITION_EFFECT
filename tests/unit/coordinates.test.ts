import { describe, expect, it } from 'vitest';
import {
  calculateBackingSize,
  calculateTextureSize,
  normalizeOrigin,
} from '../../src/burn-transition/coordinates';

describe('normalizeOrigin', () => {
  it('normalizes and clamps CSS viewport coordinates', () => {
    expect(normalizeOrigin({ x: 960, y: 540 }, { width: 1_920, height: 1_080 }))
      .toEqual({ x: 0.5, y: 0.5 });
    expect(normalizeOrigin({ x: -20, y: 2_000 }, { width: 1_920, height: 1_080 }))
      .toEqual({ x: 0, y: 1 });
  });
});

describe('calculateBackingSize', () => {
  it('uses full DPR through a 4K physical buffer and caps larger buffers', () => {
    expect(calculateBackingSize({ width: 1_920, height: 1_080 }, 2, 8_294_400))
      .toEqual({ width: 3_840, height: 2_160, scale: 2 });
    expect(calculateBackingSize({ width: 3_840, height: 2_160 }, 2, 8_294_400))
      .toEqual({ width: 3_840, height: 2_160, scale: 1 });
  });

  it('preserves aspect ratio while honoring the GPU texture dimension limit', () => {
    expect(calculateTextureSize(
      { width: 8_000, height: 4_000 },
      100_000_000,
      4_096,
    )).toEqual({ width: 4_096, height: 2_048 });
  });
});
