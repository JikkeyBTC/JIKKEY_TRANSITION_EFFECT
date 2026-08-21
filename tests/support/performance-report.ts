export interface FrameIntervalSummary {
  readonly intervals: readonly number[];
  readonly samples: number;
  readonly p95: number;
  readonly over34ms: number;
}

export function summarizeFrameIntervals(
  intervals: readonly number[],
  minimumSamples = 1,
): FrameIntervalSummary {
  const recorded = [...intervals];
  if (recorded.length < minimumSamples) {
    throw new Error(
      `Expected at least ${minimumSamples} frame intervals, received ${recorded.length}`,
    );
  }
  const sorted = [...recorded].sort((left, right) => left - right);
  const percentileIndex = Math.max(0, Math.ceil(sorted.length * 0.95) - 1);
  return {
    intervals: recorded,
    samples: recorded.length,
    p95: sorted[percentileIndex] ?? 0,
    over34ms: recorded.filter((interval) => interval > 34).length,
  };
}
