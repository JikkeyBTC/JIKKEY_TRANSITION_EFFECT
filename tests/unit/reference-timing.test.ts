import { describe, expect, it } from 'vitest';

const {
  deadlineDelay,
  timingObservation,
} = require('../../scripts/reference-timing.cjs') as {
  deadlineDelay(clickTime: number, elapsed: number, now: number): number;
  timingObservation(elapsed: number, clickTime: number, observedAt: number, tolerance: number): {
    timingErrorMs: number;
    withinTolerance: boolean;
  };
};

describe('reference timing', () => {
  it('subtracts prior capture overhead from the next absolute click-time deadline', () => {
    expect(deadlineDelay(1_000, 200, 1_085)).toBe(115);
    expect(deadlineDelay(1_000, 200, 1_250)).toBe(0);
  });

  it('records signed timing error and tolerance status per observation', () => {
    expect(timingObservation(200, 1_000, 1_228, 34)).toEqual({
      timingErrorMs: 28,
      withinTolerance: true,
    });
    expect(timingObservation(200, 1_000, 1_241, 34)).toEqual({
      timingErrorMs: 41,
      withinTolerance: false,
    });
  });
});
