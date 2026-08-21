import {
  createJellyState,
  isJellySettled,
  jellyTarget,
  stepJellyState,
  type JellyState,
} from './physics';

export type JellyMotion = 'always' | 'never' | 'respect-preference';

export interface JellyAnimatorOptions {
  readonly initialChecked: boolean;
  readonly motion: JellyMotion;
  readonly onFrame: (state: JellyState, checked: boolean) => void;
  readonly onAnimatingChange?: (animating: boolean) => void;
  readonly requestFrame?: (callback: FrameRequestCallback) => number;
  readonly cancelFrame?: (id: number) => void;
  readonly prefersReducedMotion?: () => boolean;
  readonly now?: () => number;
}

const MAX_DURATION_MILLISECONDS = 1_200;

export class JellyAnimator {
  private readonly motion: JellyMotion;
  private readonly onFrame: (state: JellyState, checked: boolean) => void;
  private readonly onAnimatingChange: ((animating: boolean) => void) | undefined;
  private readonly requestFrame: (callback: FrameRequestCallback) => number;
  private readonly cancelFrame: (id: number) => void;
  private readonly prefersReducedMotion: () => boolean;
  private readonly now: () => number;
  private state: JellyState;
  private checked: boolean;
  private frameId: number | null = null;
  private lastTimestamp: number | null = null;
  private deadlineTimestamp: number | null = null;
  private animating = false;
  private destroyed = false;
  private revision = 0;

  constructor(options: JellyAnimatorOptions) {
    this.motion = options.motion;
    this.onFrame = options.onFrame;
    this.onAnimatingChange = options.onAnimatingChange;
    this.requestFrame = options.requestFrame ?? ((callback) => requestAnimationFrame(callback));
    this.cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    this.prefersReducedMotion = options.prefersReducedMotion
      ?? (() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.now = options.now ?? (() => performance.now());
    this.checked = options.initialChecked;
    this.state = createJellyState(this.checked);
    this.onFrame(this.state, this.checked);
  }

  setChecked(checked: boolean): void {
    if (this.destroyed) return;
    const revision = ++this.revision;
    const targetChanged = checked !== this.checked;
    this.checked = checked;
    const target = jellyTarget(checked);
    const shouldAnimate = this.motion === 'always'
      || (this.motion === 'respect-preference' && !this.prefersReducedMotion());
    if (!shouldAnimate || isJellySettled(this.state, target)) {
      this.stopScheduledFrame();
      this.lastTimestamp = null;
      this.deadlineTimestamp = null;
      this.state = createJellyState(checked);
      this.onFrame(this.state, this.checked);
      if (this.destroyed || revision !== this.revision) return;
      this.setAnimating(false);
      return;
    }

    if (!this.animating || targetChanged) {
      this.lastTimestamp = null;
      this.deadlineTimestamp = this.now() + MAX_DURATION_MILLISECONDS;
    }
    this.setAnimating(true);
    if (this.destroyed || revision !== this.revision) return;
    if (this.frameId === null) this.scheduleFrame();
  }

  redraw(): void {
    if (this.destroyed) return;
    this.onFrame(this.state, this.checked);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.revision += 1;
    this.stopScheduledFrame();
    this.deadlineTimestamp = null;
    this.setAnimating(false);
  }

  private readonly animateFrame = (timestamp: number): void => {
    this.frameId = null;
    if (this.destroyed) return;
    const revision = this.revision;
    if (this.deadlineTimestamp !== null && timestamp >= this.deadlineTimestamp) {
      this.finishAtTarget(revision);
      return;
    }

    const deltaSeconds = this.lastTimestamp === null
      ? 0
      : Math.max(0, timestamp - this.lastTimestamp) / 1_000;
    this.lastTimestamp = timestamp;
    const target = jellyTarget(this.checked);
    this.state = stepJellyState(this.state, target, deltaSeconds);
    this.onFrame(this.state, this.checked);
    if (this.destroyed || revision !== this.revision) return;
    if (isJellySettled(this.state, target)) {
      this.lastTimestamp = null;
      this.deadlineTimestamp = null;
      this.setAnimating(false);
      return;
    }
    this.scheduleFrame();
  };

  private scheduleFrame(): void {
    if (this.destroyed || this.frameId !== null) return;
    this.frameId = this.requestFrame(this.animateFrame);
  }

  private finishAtTarget(revision: number): void {
    this.lastTimestamp = null;
    this.deadlineTimestamp = null;
    this.state = createJellyState(this.checked);
    this.onFrame(this.state, this.checked);
    if (this.destroyed || revision !== this.revision) return;
    this.setAnimating(false);
  }

  private stopScheduledFrame(): void {
    if (this.frameId === null) return;
    this.cancelFrame(this.frameId);
    this.frameId = null;
  }

  private setAnimating(animating: boolean): void {
    if (this.animating === animating) return;
    this.animating = animating;
    this.onAnimatingChange?.(animating);
  }
}
