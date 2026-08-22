import { describe, expect, it } from 'vitest';

import { assertJellyFixtureSurface } from '../../src/jelly-toggle-3d/fixture-environment';

describe('jelly fixture surface contract', () => {
  it('requires the real viewport, browser DPR, and backing dimensions exactly', () => {
    const exact = {
      innerWidth: 800,
      innerHeight: 600,
      devicePixelRatio: 2,
      backingWidth: 176,
      backingHeight: 88,
    };
    expect(() => assertJellyFixtureSurface(exact)).not.toThrow();

    for (const [field, value] of [
      ['innerWidth', 799],
      ['innerHeight', 601],
      ['devicePixelRatio', 1],
      ['backingWidth', 175],
      ['backingHeight', 89],
    ] as const) {
      expect(() => assertJellyFixtureSurface({ ...exact, [field]: value })).toThrow(field);
    }
  });
});
