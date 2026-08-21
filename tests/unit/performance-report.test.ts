import { describe, expect, it } from 'vitest';
import { summarizeFrameIntervals } from '../support/performance-report';

describe('summarizeFrameIntervals', () => {
  it('retains raw intervals so percentile and slow-frame counts can be recomputed', () => {
    const report = summarizeFrameIntervals([10, 15, 20, 40]);

    expect(report.intervals).toEqual([10, 15, 20, 40]);
    const sorted = [...report.intervals].sort((left, right) => left - right);
    const p95 = sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)];
    expect(p95).toBe(report.p95);
    expect(report.intervals.filter((interval) => interval > 34)).toHaveLength(report.over34ms);
  });

  it.each([
    ['empty', []],
    ['one callback', [16]],
    ['three catastrophic callbacks', [900, 900, 900]],
    ['seventy-four callbacks', new Array(74).fill(16)],
  ] as const)('rejects the %s sequence below the 75-sample benchmark minimum', (_name, intervals) => {
    const summarizeWithMinimum = summarizeFrameIntervals as unknown as (
      values: readonly number[],
      minimumSamples: number,
    ) => unknown;

    expect(() => summarizeWithMinimum(intervals, 75)).toThrow('at least 75 frame intervals');
  });
});
