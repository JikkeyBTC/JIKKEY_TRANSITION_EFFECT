import { describe, expect, it, vi } from 'vitest';
import { ManualBurnClock } from '../../src/demo-clock';

describe('ManualBurnClock', () => {
  it('positions an idle clock at an absolute timestamp', () => {
    const clock = new ManualBurnClock();

    clock.set(42);

    expect(clock.now()).toBe(42);
  });

  it('rejects absolute positioning while a frame is pending', () => {
    const clock = new ManualBurnClock();
    clock.requestFrame(vi.fn());

    expect(() => clock.set(42)).toThrow('Cannot set a running manual burn clock');
    expect(clock.now()).toBe(10_000);
  });
});
