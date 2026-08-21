import type { BurnClock } from './burn-transition';

export class ManualBurnClock implements BurnClock {
  private currentTime = 10_000;
  private nextHandle = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  now(): number { return this.currentTime; }

  requestFrame(callback: FrameRequestCallback): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.callbacks.delete(handle);
  }

  hasPendingFrame(): boolean {
    return this.callbacks.size > 0;
  }

  set(milliseconds: number): void {
    if (this.callbacks.size !== 0) {
      throw new Error('Cannot set a running manual burn clock');
    }
    this.currentTime = milliseconds;
  }

  step(milliseconds: number): void {
    this.currentTime += milliseconds;
    const pending = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of pending) callback(this.currentTime);
  }
}
