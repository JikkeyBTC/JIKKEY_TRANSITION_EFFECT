import { describe, expect, it } from 'vitest';
import { BURN_DURATION_MS, burnProgressAt } from '../../src/burn-transition/progress';

describe('burnProgressAt', () => {
  it('matches the reference hold and quadratic acceleration curve', () => {
    expect(BURN_DURATION_MS).toBe(2_500);
    expect(burnProgressAt(0)).toBe(0);
    expect(burnProgressAt(200)).toBeCloseTo(0.003, 8);
    expect(burnProgressAt(1_350)).toBeCloseTo(0.25225, 8);
    expect(burnProgressAt(2_500)).toBe(1);
  });

  it('clamps time outside the transition', () => {
    expect(burnProgressAt(-10)).toBe(0);
    expect(burnProgressAt(9_999)).toBe(1);
  });
});
