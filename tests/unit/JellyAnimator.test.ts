import { describe, expect, it } from 'vitest';
import { JellyAnimator } from '../../src/jelly-toggle/JellyAnimator';
import type { JellyState } from '../../src/jelly-toggle/physics';

class FakeFrameClock {
  private nextId = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();
  private timestamp = 0;

  readonly request = (callback: FrameRequestCallback): number => {
    const id = this.nextId;
    this.nextId += 1;
    this.callbacks.set(id, callback);
    return id;
  };

  readonly cancel = (id: number): void => {
    this.callbacks.delete(id);
  };

  readonly now = (): number => this.timestamp;

  get pendingCount(): number {
    return this.callbacks.size;
  }

  step(timestamp: number): void {
    const entry = this.callbacks.entries().next().value as
      | [number, FrameRequestCallback]
      | undefined;
    if (!entry) throw new Error('No jelly frame is pending');
    const [id, callback] = entry;
    this.callbacks.delete(id);
    this.timestamp = timestamp;
    callback(timestamp);
  }

  setTime(timestamp: number): void {
    this.timestamp = timestamp;
  }
}

describe('JellyAnimator', () => {
  it('renders its initial side without scheduling an idle frame', () => {
    const clock = new FakeFrameClock();
    const frames: JellyState[] = [];

    new JellyAnimator({
      initialChecked: true,
      motion: 'always',
      requestFrame: clock.request,
      cancelFrame: clock.cancel,
      now: clock.now,
      prefersReducedMotion: () => false,
      onFrame: (state) => frames.push(state),
    });

    expect(clock.pendingCount).toBe(0);
    expect(frames).toEqual([{
      head: { position: 37, velocity: 0 },
      tail: { position: 37, velocity: 0 },
      settledFrames: 3,
      accumulatorSeconds: 0,
    }]);
  });

  it('stretches while moving and stops requesting frames after settling', () => {
    const clock = new FakeFrameClock();
    const frames: JellyState[] = [];
    const activity: boolean[] = [];
    const animator = new JellyAnimator({
      initialChecked: false,
      motion: 'always',
      requestFrame: clock.request,
      cancelFrame: clock.cancel,
      now: clock.now,
      prefersReducedMotion: () => false,
      onFrame: (state) => frames.push(state),
      onAnimatingChange: (animating) => activity.push(animating),
    });

    animator.setChecked(true);
    expect(clock.pendingCount).toBe(1);
    expect(activity).toEqual([true]);

    let timestamp = 0;
    for (let frame = 0; frame < 180 && clock.pendingCount > 0; frame += 1) {
      clock.step(timestamp);
      timestamp += 1_000 / 60;
    }

    expect(frames.some((state) => state.head.position > state.tail.position)).toBe(true);
    expect(frames.at(-1)).toEqual({
      head: { position: 37, velocity: 0 },
      tail: { position: 37, velocity: 0 },
      settledFrames: 3,
      accumulatorSeconds: 0,
    });
    expect(clock.pendingCount).toBe(0);
    expect(activity).toEqual([true, false]);
  });

  it('snaps without scheduling when motion is disabled or reduced', () => {
    for (const options of [
      { motion: 'never' as const, prefersReducedMotion: () => false },
      { motion: 'respect-preference' as const, prefersReducedMotion: () => true },
    ]) {
      const clock = new FakeFrameClock();
      const frames: JellyState[] = [];
      const animator = new JellyAnimator({
        initialChecked: true,
        ...options,
        requestFrame: clock.request,
        cancelFrame: clock.cancel,
        now: clock.now,
        onFrame: (state) => frames.push(state),
      });

      animator.setChecked(false);

      expect(clock.pendingCount).toBe(0);
      expect(frames.at(-1)).toEqual({
        head: { position: 15, velocity: 0 },
        tail: { position: 15, velocity: 0 },
        settledFrames: 3,
        accumulatorSeconds: 0,
      });
    }
  });

  it('uses a failsafe to stop after a long suspended frame', () => {
    const clock = new FakeFrameClock();
    const frames: JellyState[] = [];
    const animator = new JellyAnimator({
      initialChecked: false,
      motion: 'always',
      requestFrame: clock.request,
      cancelFrame: clock.cancel,
      now: clock.now,
      prefersReducedMotion: () => false,
      onFrame: (state) => frames.push(state),
    });

    animator.setChecked(true);
    clock.step(100);
    clock.step(1_301);

    expect(clock.pendingCount).toBe(0);
    expect(frames.at(-1)).toEqual({
      head: { position: 37, velocity: 0 },
      tail: { position: 37, velocity: 0 },
      settledFrames: 3,
      accumulatorSeconds: 0,
    });
  });

  it('starts the failsafe deadline when setChecked is called', () => {
    const clock = new FakeFrameClock();
    const frames: JellyState[] = [];
    const animator = new JellyAnimator({
      initialChecked: false,
      motion: 'always',
      requestFrame: clock.request,
      cancelFrame: clock.cancel,
      now: clock.now,
      prefersReducedMotion: () => false,
      onFrame: (state) => frames.push(state),
    });

    clock.setTime(100);
    animator.setChecked(true);
    clock.step(1_301);

    expect(clock.pendingCount).toBe(0);
    expect(frames.at(-1)).toEqual({
      head: { position: 37, velocity: 0 },
      tail: { position: 37, velocity: 0 },
      settledFrames: 3,
      accumulatorSeconds: 0,
    });
  });

  it('does not renew the failsafe for repeated calls to the same target', () => {
    const clock = new FakeFrameClock();
    const frames: JellyState[] = [];
    const animator = new JellyAnimator({
      initialChecked: false,
      motion: 'always',
      requestFrame: clock.request,
      cancelFrame: clock.cancel,
      now: clock.now,
      prefersReducedMotion: () => false,
      onFrame: (state) => frames.push(state),
    });

    animator.setChecked(true);
    clock.step(0);
    for (const timestamp of [400, 800, 1_199]) {
      clock.setTime(timestamp);
      animator.setChecked(true);
      clock.step(timestamp);
    }
    clock.setTime(1_201);
    animator.setChecked(true);
    clock.step(1_201);

    expect(clock.pendingCount).toBe(0);
    expect(frames.at(-1)).toEqual({
      head: { position: 37, velocity: 0 },
      tail: { position: 37, velocity: 0 },
      settledFrames: 3,
      accumulatorSeconds: 0,
    });
  });

  it('does not schedule another frame when onFrame destroys it', () => {
    const clock = new FakeFrameClock();
    const activity: boolean[] = [];
    let destroyOnFrame = false;
    let animator!: JellyAnimator;
    animator = new JellyAnimator({
      initialChecked: false,
      motion: 'always',
      requestFrame: clock.request,
      cancelFrame: clock.cancel,
      now: clock.now,
      prefersReducedMotion: () => false,
      onFrame: () => {
        if (destroyOnFrame) animator.destroy();
      },
      onAnimatingChange: (animating) => activity.push(animating),
    });

    animator.setChecked(true);
    destroyOnFrame = true;
    clock.step(0);

    expect(clock.pendingCount).toBe(0);
    expect(activity).toEqual([true, false]);
  });

  it('does not schedule a frame when onAnimatingChange destroys it', () => {
    const clock = new FakeFrameClock();
    const activity: boolean[] = [];
    let animator!: JellyAnimator;
    animator = new JellyAnimator({
      initialChecked: false,
      motion: 'always',
      requestFrame: clock.request,
      cancelFrame: clock.cancel,
      now: clock.now,
      prefersReducedMotion: () => false,
      onFrame: () => undefined,
      onAnimatingChange: (animating) => {
        activity.push(animating);
        if (animating) animator.destroy();
      },
    });

    animator.setChecked(true);

    expect(clock.pendingCount).toBe(0);
    expect(activity).toEqual([true, false]);
  });

  it('does not orphan a frame when onAnimatingChange retargets to rest', () => {
    const clock = new FakeFrameClock();
    const frames: JellyState[] = [];
    const activity: boolean[] = [];
    let retargeted = false;
    let animator!: JellyAnimator;
    animator = new JellyAnimator({
      initialChecked: false,
      motion: 'always',
      requestFrame: clock.request,
      cancelFrame: clock.cancel,
      now: clock.now,
      prefersReducedMotion: () => false,
      onFrame: (state) => frames.push(state),
      onAnimatingChange: (animating) => {
        activity.push(animating);
        if (animating && !retargeted) {
          retargeted = true;
          animator.setChecked(false);
        }
      },
    });

    animator.setChecked(true);

    expect(clock.pendingCount).toBe(0);
    expect(activity).toEqual([true, false]);
    expect(frames.at(-1)).toEqual({
      head: { position: 15, velocity: 0 },
      tail: { position: 15, velocity: 0 },
      settledFrames: 3,
      accumulatorSeconds: 0,
    });
  });

  it('keeps one owned frame when onFrame retargets in the opposite direction', () => {
    const clock = new FakeFrameClock();
    const frames: JellyState[] = [];
    let retargetOnFrame = false;
    let animator!: JellyAnimator;
    animator = new JellyAnimator({
      initialChecked: false,
      motion: 'always',
      requestFrame: clock.request,
      cancelFrame: clock.cancel,
      now: clock.now,
      prefersReducedMotion: () => false,
      onFrame: (state) => {
        frames.push(state);
        if (retargetOnFrame) {
          retargetOnFrame = false;
          animator.setChecked(false);
        }
      },
    });

    animator.setChecked(true);
    clock.step(0);
    retargetOnFrame = true;
    clock.step(1_000 / 60);

    expect(clock.pendingCount).toBe(1);
    let timestamp = 2_000 / 60;
    for (let frame = 0; frame < 180 && clock.pendingCount > 0; frame += 1) {
      clock.step(timestamp);
      timestamp += 1_000 / 60;
    }
    expect(clock.pendingCount).toBe(0);
    expect(frames.at(-1)).toEqual({
      head: { position: 15, velocity: 0 },
      tail: { position: 15, velocity: 0 },
      settledFrames: 3,
      accumulatorSeconds: 0,
    });
  });
});
