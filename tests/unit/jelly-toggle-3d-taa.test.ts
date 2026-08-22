import { describe, expect, it } from 'vitest';

import { createTaaState } from '../../src/jelly-toggle-3d/taa';

describe('jelly toggle TAA state', () => {
  it('seeds once, blends fifteen times, then becomes idle', () => {
    const taa = createTaaState();
    taa.invalidate();

    const samples = Array.from({ length: 16 }, () => taa.consumeStationarySample());

    expect(samples[0]).toMatchObject({ historyValid: false, blend: 0 });
    expect(samples.slice(1)).toEqual(Array(15).fill({ historyValid: true, blend: 0.9 }));
    expect(taa.needsSample).toBe(false);
  });

  it('restarts stationary convergence after motion without discarding valid history', () => {
    const taa = createTaaState();
    taa.invalidate();
    taa.consumeStationarySample();
    taa.consumeStationarySample();

    taa.noteMotion();

    expect(taa.needsSample).toBe(true);
    expect(taa.consumeStationarySample()).toEqual({ historyValid: true, blend: 0.9 });
  });

  it('invalidates both histories after a discontinuity', () => {
    const taa = createTaaState();
    taa.invalidate();
    taa.consumeStationarySample();
    taa.noteMotion();
    taa.consumeStationarySample();

    taa.invalidate();

    expect(taa.consumeStationarySample()).toEqual({ historyValid: false, blend: 0 });
  });
});
