import { describe, expect, it } from 'vitest';

import { createXorshift32 } from '../../src/jelly-toggle-3d/random';

describe('fixture random source', () => {
  it('repeats the documented xorshift32 sequence from seed 0x4A454C4C', () => {
    const first = createXorshift32(0x4A454C4C);
    const second = createXorshift32(0x4A454C4C);
    const sequence = Array.from({ length: 8 }, () => first());
    expect(sequence).toEqual(Array.from({ length: 8 }, () => second()));
    expect(sequence).toEqual([
      0.6029515811242163,
      0.5761811977718025,
      0.5066290830727667,
      0.24995801178738475,
      0.600017698481679,
      0.9716787219513208,
      0.6779766487888992,
      0.38615441392175853,
    ]);
    first.reset();
    expect(Array.from({ length: 8 }, () => first())).toEqual(sequence);
  });

  it('uses the complete seed instead of collapsing distinct fixture seeds', () => {
    const fixture = createXorshift32(0x4A454C4C);
    const distinct = createXorshift32(0x4A454C4D);
    expect(Array.from({ length: 8 }, () => distinct())).not.toEqual(
      Array.from({ length: 8 }, () => fixture()),
    );
  });

  it('rejects the absorbing zero state', () => {
    expect(() => createXorshift32(0)).toThrow(/non-zero seed/);
  });
});
