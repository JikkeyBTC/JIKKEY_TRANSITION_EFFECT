import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BurnClock,
  BurnToggleResult,
  BurnTransitionOptions,
  CapturedViewport,
} from '../../src/burn-transition/types';

const rendererMock = vi.hoisted(() => ({
  prepare: vi.fn(),
  maximumTextureSize: vi.fn(() => 16_384),
  resize: vi.fn(),
  setFrame: vi.fn(),
  setOrigin: vi.fn(),
  draw: vi.fn(),
  show: vi.fn(),
  hide: vi.fn(),
  releaseFrame: vi.fn(),
  destroy: vi.fn(),
}));

vi.mock('../../src/burn-transition/gl-program', () => ({
  WebGLBurnRenderer: vi.fn(function MockWebGLBurnRenderer() { return rendererMock; }),
}));

import { BurnTransition } from '../../src/burn-transition/BurnTransition';

const liveTransitions: BurnTransition[] = [];

function createTransition(options: BurnTransitionOptions): BurnTransition {
  const transition = new BurnTransition(options);
  liveTransitions.push(transition);
  return transition;
}

class ManualClock implements BurnClock {
  private value = 10_000;
  private nextHandle = 1;
  private callbacks = new Map<number, FrameRequestCallback>();

  now(): number { return this.value; }
  requestFrame(callback: FrameRequestCallback): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }
  cancelFrame(handle: number): void { this.callbacks.delete(handle); }
  step(milliseconds: number): void {
    this.value += milliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(this.value);
  }
}

const frame: CapturedViewport = {
  png: new Uint8Array([137, 80, 78, 71]),
  scaleFactor: 1,
};

let defaultBitmap: ImageBitmap;

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

const waitForOverlay = async () => {
  await vi.waitFor(() => expect(rendererMock.show).toHaveBeenCalledOnce());
};

async function waitForToggleResult(
  completion: Promise<BurnToggleResult>,
  expected: BurnToggleResult,
): Promise<void> {
  let result: BurnToggleResult | undefined;
  let rejection: unknown;
  void completion.then(
    (value) => { result = value; },
    (error: unknown) => { rejection = error; },
  );
  await vi.waitFor(() => {
    expect(rejection).toBeUndefined();
    expect(result).toEqual(expected);
  }, { timeout: 300, interval: 10 });
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const method of Object.values(rendererMock)) method.mockReset();
  rendererMock.maximumTextureSize.mockReturnValue(16_384);
  defaultBitmap = {
    width: 1_280,
    height: 720,
    close: vi.fn(),
  } as unknown as ImageBitmap;
  vi.stubGlobal('createImageBitmap', vi.fn(async () => defaultBitmap));
  Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 1 });
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1_280 });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 720 });
});

afterEach(() => {
  for (const transition of liveTransitions) transition.destroy();
  liveTransitions.length = 0;
  vi.unstubAllGlobals();
});

describe('BurnTransition', () => {
  it('covers the old frame before applying the theme and completes at 2500ms', async () => {
    const clock = new ManualClock();
    const order: string[] = [];
    rendererMock.show.mockImplementation(() => { order.push('show'); });
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();

    const completion = transition.toggle({
      origin: { x: 640, y: 360 },
      applyTheme: () => { order.push('theme'); },
    });
    await waitForOverlay();
    expect(order).toEqual(['show']);

    clock.step(16);
    await flush();
    expect(order).toEqual(['show', 'theme']);
    clock.step(16);
    await flush();
    clock.step(2_500);
    await flush();

    await expect(completion).resolves.toEqual({ status: 'completed' });
    expect(rendererMock.setOrigin).toHaveBeenCalledWith({ x: 0.5, y: 0.5 });
    expect(rendererMock.draw).toHaveBeenLastCalledWith(1, expect.any(Number));
    expect(defaultBitmap.close).toHaveBeenCalledOnce();
    expect(rendererMock.releaseFrame).toHaveBeenCalledOnce();
    expect(rendererMock.hide).toHaveBeenCalled();
  });

  it('ignores a second toggle while the first is active', async () => {
    const clock = new ManualClock();
    const capture = vi.fn(async () => frame);
    const ignoredTheme = vi.fn();
    const transition = createTransition({ capture, clock });
    await transition.prepare();
    void transition.toggle({ origin: { x: 10, y: 10 }, applyTheme: vi.fn() });
    await waitForOverlay();

    await expect(transition.toggle({ origin: { x: 20, y: 20 }, applyTheme: ignoredTheme }))
      .resolves.toEqual({ status: 'ignored', reason: 'busy' });
    expect(capture).toHaveBeenCalledOnce();
    expect(ignoredTheme).not.toHaveBeenCalled();
    transition.destroy();
  });

  it('applies the theme once and returns capture fallback when capture rejects', async () => {
    const applyTheme = vi.fn();
    const transition = createTransition({
      capture: async () => { throw new Error('capture failed'); },
      clock: new ManualClock(),
    });
    await transition.prepare();

    await expect(transition.toggle({ origin: { x: 0, y: 0 }, applyTheme }))
      .resolves.toEqual({ status: 'fallback', reason: 'capture' });
    expect(applyTheme).toHaveBeenCalledOnce();
    expect(rendererMock.hide).toHaveBeenCalledOnce();
    expect(rendererMock.releaseFrame).toHaveBeenCalledOnce();
  });

  it('does not retry a rejected theme callback', async () => {
    const failure = new Error('theme commit failed');
    const applyTheme = vi.fn(async () => { throw failure; });
    const clock = new ManualClock();
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await waitForOverlay();
    clock.step(16);
    await expect(completion).rejects.toBe(failure);
    expect(applyTheme).toHaveBeenCalledOnce();
    expect(rendererMock.releaseFrame).toHaveBeenCalledOnce();
  });

  it('finishes with resize fallback when the viewport changes mid-transition', async () => {
    const clock = new ManualClock();
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await waitForOverlay();
    window.dispatchEvent(new Event('resize'));
    await expect(completion).resolves.toEqual({ status: 'fallback', reason: 'resize' });
    expect(applyTheme).toHaveBeenCalledOnce();
    expect(rendererMock.releaseFrame).toHaveBeenCalledOnce();
  }, 1_000);

  it('returns destroyed without changing the theme after destroy', async () => {
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();
    transition.destroy();
    transition.destroy();
    const applyTheme = vi.fn();
    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme }))
      .resolves.toEqual({ status: 'ignored', reason: 'destroyed' });
    expect(applyTheme).not.toHaveBeenCalled();
    expect(rendererMock.destroy).toHaveBeenCalledOnce();
    expect(document.querySelector('canvas[data-burn-overlay]')).toBeNull();
  });

  it('returns context-lost fallback and restores the renderer', async () => {
    const clock = new ManualClock();
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await waitForOverlay();
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;
    const contextLost = new Event('webglcontextlost', { cancelable: true });
    canvas.dispatchEvent(contextLost);
    await expect(completion).resolves.toEqual({ status: 'fallback', reason: 'context-lost' });
    expect(contextLost.defaultPrevented).toBe(true);
    expect(applyTheme).toHaveBeenCalledOnce();
    expect(rendererMock.releaseFrame).toHaveBeenCalledOnce();

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    expect(rendererMock.prepare).toHaveBeenCalledTimes(2);
  }, 1_000);

  it('skips capture when reduced motion is respected', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const capture = vi.fn(async () => { throw new Error('capture must be skipped'); });
    const applyTheme = vi.fn();
    const transition = createTransition({
      capture,
      clock: new ManualClock(),
      respectReducedMotion: true,
    });
    await transition.prepare();
    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme }))
      .resolves.toEqual({ status: 'completed' });
    expect(capture).not.toHaveBeenCalled();
    expect(applyTheme).toHaveBeenCalledOnce();
  });

  it('keeps reduced-motion theme commits busy until they settle', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    let finishTheme!: () => void;
    const themeGate = new Promise<void>((resolve) => { finishTheme = resolve; });
    const applyTheme = vi.fn(() => themeGate);
    const ignoredTheme = vi.fn();
    const transition = createTransition({
      capture: async () => frame,
      clock: new ManualClock(),
      respectReducedMotion: true,
    });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledOnce());

    await expect(transition.toggle({ origin: { x: 2, y: 2 }, applyTheme: ignoredTheme }))
      .resolves.toEqual({ status: 'ignored', reason: 'busy' });
    expect(ignoredTheme).not.toHaveBeenCalled();
    finishTheme();
    await expect(completion).resolves.toEqual({ status: 'completed' });
  });

  it('propagates a reduced-motion theme rejection without retrying it', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const failure = new Error('reduced theme failed');
    const capture = vi.fn(async () => frame);
    const applyTheme = vi.fn(async () => { throw failure; });
    const transition = createTransition({
      capture,
      clock: new ManualClock(),
      respectReducedMotion: true,
    });
    await transition.prepare();

    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme })).rejects.toBe(failure);
    expect(capture).not.toHaveBeenCalled();
    expect(applyTheme).toHaveBeenCalledOnce();
  });

  it('uses physical capture dimensions for the backing store at HiDPI', async () => {
    const clock = new ManualClock();
    const hidpiFrame: CapturedViewport = {
      ...frame,
      scaleFactor: 2,
    };
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 2_560,
      height: 1_440,
      close: vi.fn(),
    })));
    const transition = createTransition({ capture: async () => hidpiFrame, clock });
    await transition.prepare();
    const completion = transition.toggle({
      origin: { x: 640, y: 360 },
      applyTheme: vi.fn(),
    });
    await waitForOverlay();
    expect(rendererMock.resize).toHaveBeenCalledWith(
      { width: 2_560, height: 1_440 },
      1,
      8_294_400,
    );
    transition.destroy();
    await expect(completion).resolves.toEqual({ status: 'ignored', reason: 'destroyed' });
  });

  it('resamples a capture before upload when it exceeds the GPU texture limit', async () => {
    const clock = new ManualClock();
    const decoded = { width: 4_096, height: 2_304, close: vi.fn() } as unknown as ImageBitmap;
    const resized = { width: 1_024, height: 576, close: vi.fn() } as unknown as ImageBitmap;
    const createBitmap = vi.fn()
      .mockResolvedValueOnce(decoded)
      .mockResolvedValueOnce(resized);
    vi.stubGlobal('createImageBitmap', createBitmap);
    rendererMock.maximumTextureSize.mockReturnValue(1_024);
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({
      origin: { x: 640, y: 360 },
      applyTheme: vi.fn(),
    });
    await vi.waitFor(() => expect(rendererMock.resize).toHaveBeenCalledOnce());

    expect(createBitmap).toHaveBeenNthCalledWith(2, decoded, {
      resizeWidth: 1_024,
      resizeHeight: 576,
      resizeQuality: 'high',
    });
    expect(decoded.close).toHaveBeenCalledOnce();
    expect(rendererMock.resize).toHaveBeenCalledWith(
      { width: 1_024, height: 576 },
      1,
      8_294_400,
    );
    transition.destroy();
    await expect(completion).resolves.toEqual({ status: 'ignored', reason: 'destroyed' });
    expect(resized.close).toHaveBeenCalledOnce();
  });

  it('settles when destroyed while an asynchronous theme commit is pending', async () => {
    const clock = new ManualClock();
    let finishTheme!: () => void;
    const themeGate = new Promise<void>((resolve) => { finishTheme = resolve; });
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({
      origin: { x: 640, y: 360 },
      applyTheme: () => themeGate,
    });
    await waitForOverlay();
    clock.step(16);
    await flush();
    transition.destroy();
    finishTheme();
    await expect(completion).resolves.toEqual({ status: 'ignored', reason: 'destroyed' });
  });

  it('does not apply a fallback theme after destroy when capture rejects late', async () => {
    let rejectCapture!: (error: Error) => void;
    const captureGate = new Promise<CapturedViewport>((_resolve, reject) => {
      rejectCapture = reject;
    });
    const capture = vi.fn(() => captureGate);
    const applyTheme = vi.fn();
    const transition = createTransition({ capture, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    transition.destroy();
    rejectCapture(new Error('late capture failure'));

    await expect(completion).resolves.toEqual({ status: 'ignored', reason: 'destroyed' });
    expect(applyTheme).not.toHaveBeenCalled();
  });

  it('blocks input while capture is pending and releases it after capture fallback', async () => {
    let rejectCapture!: (error: Error) => void;
    const captureGate = new Promise<CapturedViewport>((_resolve, reject) => {
      rejectCapture = reject;
    });
    const capture = vi.fn(() => captureGate);
    const transition = createTransition({ capture, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: vi.fn() });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;

    expect(canvas.hidden).toBe(false);
    expect(canvas.style.pointerEvents).toBe('auto');
    rejectCapture(new Error('capture failed'));
    await expect(completion).resolves.toEqual({ status: 'fallback', reason: 'capture' });
    expect(canvas.hidden).toBe(true);
    expect(canvas.style.pointerEvents).toBe('none');
  });

  it('returns destroyed when fallback theme application settles after destroy', async () => {
    let finishTheme!: () => void;
    const themeGate = new Promise<void>((resolve) => { finishTheme = resolve; });
    const applyTheme = vi.fn(() => themeGate);
    const transition = createTransition({
      capture: async () => { throw new Error('capture failed'); },
      clock: new ManualClock(),
    });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledOnce());

    transition.destroy();
    finishTheme();
    await expect(completion).resolves.toEqual({ status: 'ignored', reason: 'destroyed' });
  });

  it('returns destroyed when a pending theme callback rejects after destroy', async () => {
    const failure = new Error('late theme failure');
    let rejectTheme!: (error: Error) => void;
    const themeGate = new Promise<void>((_resolve, reject) => { rejectTheme = reject; });
    const applyTheme = vi.fn(() => themeGate);
    const clock = new ManualClock();
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await waitForOverlay();
    clock.step(16);
    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledOnce());

    transition.destroy();
    rejectTheme(failure);
    await expect(completion).resolves.toEqual({ status: 'ignored', reason: 'destroyed' });
  });

  it('returns resize fallback when resize occurs during fallback theme application', async () => {
    let finishTheme!: () => void;
    const themeGate = new Promise<void>((resolve) => { finishTheme = resolve; });
    const applyTheme = vi.fn(() => themeGate);
    const transition = createTransition({
      capture: async () => { throw new Error('capture failed'); },
      clock: new ManualClock(),
    });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledOnce());

    window.dispatchEvent(new Event('resize'));
    finishTheme();
    await expect(completion).resolves.toEqual({ status: 'fallback', reason: 'resize' });
    expect(applyTheme).toHaveBeenCalledOnce();
  });

  it('returns context-lost fallback when context is lost during fallback theme application', async () => {
    let finishTheme!: () => void;
    const themeGate = new Promise<void>((resolve) => { finishTheme = resolve; });
    const applyTheme = vi.fn(() => themeGate);
    const transition = createTransition({
      capture: async () => { throw new Error('capture failed'); },
      clock: new ManualClock(),
    });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledOnce());
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;

    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    finishTheme();
    await expect(completion).resolves.toEqual({ status: 'fallback', reason: 'context-lost' });
    expect(applyTheme).toHaveBeenCalledOnce();
  });

  it('converts PNG decode rejection to capture fallback', async () => {
    const decodeFailure = new Error('invalid PNG');
    vi.stubGlobal('createImageBitmap', vi.fn(async () => { throw decodeFailure; }));
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();

    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme }))
      .resolves.toEqual({ status: 'fallback', reason: 'capture' });
    expect(applyTheme).toHaveBeenCalledOnce();
    expect(rendererMock.show).not.toHaveBeenCalled();
    expect(rendererMock.releaseFrame).toHaveBeenCalledOnce();
  });

  it('rejects non-finite decoded dimensions and closes the bitmap once', async () => {
    const invalid = { width: Number.NaN, height: 720, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => invalid));
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();

    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: vi.fn() }))
      .resolves.toEqual({ status: 'fallback', reason: 'capture' });
    expect(invalid.close).toHaveBeenCalledOnce();
    expect(rendererMock.setFrame).not.toHaveBeenCalled();
  });

  it('rejects a decoded aspect mismatch and closes the bitmap once', async () => {
    const mismatched = { width: 1_280, height: 800, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => mismatched));
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();

    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: vi.fn() }))
      .resolves.toEqual({ status: 'fallback', reason: 'capture' });
    expect(mismatched.close).toHaveBeenCalledOnce();
    expect(rendererMock.setFrame).not.toHaveBeenCalled();
  });

  it('closes the decoded bitmap once when asynchronous resampling rejects', async () => {
    const decoded = { width: 4_096, height: 2_304, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn()
      .mockResolvedValueOnce(decoded)
      .mockRejectedValueOnce(new Error('resample failed')));
    rendererMock.maximumTextureSize.mockReturnValue(1_024);
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();

    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: vi.fn() }))
      .resolves.toEqual({ status: 'fallback', reason: 'capture' });
    expect(decoded.close).toHaveBeenCalledOnce();
    expect(rendererMock.setFrame).not.toHaveBeenCalled();
  });

  it('rejects malformed resample dimensions before WebGL upload', async () => {
    const decoded = { width: 4_096, height: 2_304, close: vi.fn() } as unknown as ImageBitmap;
    const malformed = { width: 1_024, height: 1_024, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn()
      .mockResolvedValueOnce(decoded)
      .mockResolvedValueOnce(malformed));
    rendererMock.maximumTextureSize.mockReturnValue(1_024);
    rendererMock.setFrame.mockImplementationOnce(() => { throw new Error('unsafe upload'); });
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();

    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: vi.fn() }))
      .resolves.toEqual({ status: 'fallback', reason: 'capture' });
    expect(decoded.close).toHaveBeenCalledOnce();
    expect(malformed.close).toHaveBeenCalledOnce();
    expect(rendererMock.setFrame).not.toHaveBeenCalled();
  });

  it('converts texture upload failure to webgl fallback and closes the bitmap once', async () => {
    const bitmap = { width: 1_280, height: 720, close: vi.fn() } as unknown as ImageBitmap;
    vi.stubGlobal('createImageBitmap', vi.fn(async () => bitmap));
    rendererMock.setFrame.mockImplementationOnce(() => { throw new Error('texture upload failed'); });
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();

    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme }))
      .resolves.toEqual({ status: 'fallback', reason: 'webgl' });
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(applyTheme).toHaveBeenCalledOnce();
    expect(rendererMock.releaseFrame).toHaveBeenCalledOnce();
  });

  it('converts animation draw failure to webgl fallback without reapplying the theme', async () => {
    const clock = new ManualClock();
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await waitForOverlay();
    clock.step(16);
    await flush();
    clock.step(16);
    await flush();
    rendererMock.draw.mockImplementationOnce(() => { throw new Error('draw failed'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    clock.step(16);

    await expect(completion).resolves.toEqual({ status: 'fallback', reason: 'webgl' });
    expect(applyTheme).toHaveBeenCalledOnce();
    expect(rendererMock.releaseFrame).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('lets destroy override a completed animation result queued for settlement', async () => {
    const clock = new ManualClock();
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({
      origin: { x: 1, y: 1 },
      applyTheme: vi.fn(),
    });
    await waitForOverlay();
    clock.step(16);
    await flush();
    clock.step(16);
    await flush();

    clock.step(2_500);
    transition.destroy();
    await expect(completion).resolves.toEqual({ status: 'ignored', reason: 'destroyed' });
  });

  it('observes context loss dispatched during renderer show before scheduling a frame', async () => {
    const applyTheme = vi.fn();
    rendererMock.show.mockImplementationOnce(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;
      canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    });
    const transition = createTransition({
      capture: async () => frame,
      clock: new ManualClock(),
    });
    await transition.prepare();

    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme }))
      .resolves.toEqual({ status: 'fallback', reason: 'context-lost' });
    expect(applyTheme).toHaveBeenCalledOnce();
    expect(rendererMock.releaseFrame).toHaveBeenCalledOnce();
  }, 1_000);

  it('lets resize override a completed animation result queued for settlement', async () => {
    const clock = new ManualClock();
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await waitForOverlay();
    clock.step(16);
    await flush();
    clock.step(16);
    await flush();

    clock.step(2_500);
    window.dispatchEvent(new Event('resize'));
    await expect(completion).resolves.toEqual({ status: 'fallback', reason: 'resize' });
    expect(applyTheme).toHaveBeenCalledOnce();
    expect(rendererMock.releaseFrame).toHaveBeenCalledOnce();
  });

  it('lets context loss override a completed animation result queued for settlement', async () => {
    const clock = new ManualClock();
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await waitForOverlay();
    clock.step(16);
    await flush();
    clock.step(16);
    await flush();

    clock.step(2_500);
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    await expect(completion).resolves.toEqual({ status: 'fallback', reason: 'context-lost' });
    expect(applyTheme).toHaveBeenCalledOnce();
    expect(rendererMock.releaseFrame).toHaveBeenCalledOnce();
  });

  it('lets resize override a theme rejection queued while the callback is pending', async () => {
    const failure = new Error('theme failed after resize');
    let rejectTheme!: (error: Error) => void;
    const themeGate = new Promise<void>((_resolve, reject) => { rejectTheme = reject; });
    const applyTheme = vi.fn(() => themeGate);
    const clock = new ManualClock();
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await waitForOverlay();
    clock.step(16);
    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledOnce());

    window.dispatchEvent(new Event('resize'));
    rejectTheme(failure);
    await expect(completion).resolves.toEqual({ status: 'fallback', reason: 'resize' });
    expect(applyTheme).toHaveBeenCalledOnce();
  });

  it('lets context loss override a theme rejection queued while the callback is pending', async () => {
    const failure = new Error('theme failed after context loss');
    let rejectTheme!: (error: Error) => void;
    const themeGate = new Promise<void>((_resolve, reject) => { rejectTheme = reject; });
    const applyTheme = vi.fn(() => themeGate);
    const clock = new ManualClock();
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await waitForOverlay();
    clock.step(16);
    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledOnce());

    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    rejectTheme(failure);
    await expect(completion).resolves.toEqual({ status: 'fallback', reason: 'context-lost' });
    expect(applyTheme).toHaveBeenCalledOnce();
  });

  it('settles destroyed while capture remains pending forever', async () => {
    const capture = vi.fn(() => new Promise<CapturedViewport>(() => undefined));
    const applyTheme = vi.fn();
    const transition = createTransition({ capture, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());

    transition.destroy();
    await waitForToggleResult(completion, { status: 'ignored', reason: 'destroyed' });
    expect(applyTheme).not.toHaveBeenCalled();
  });

  it('settles destroyed and closes a decode bitmap that resolves late', async () => {
    let finishDecode!: (bitmap: ImageBitmap) => void;
    const decodeGate = new Promise<ImageBitmap>((resolve) => { finishDecode = resolve; });
    const createBitmap = vi.fn(() => decodeGate);
    vi.stubGlobal('createImageBitmap', createBitmap);
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledOnce());

    transition.destroy();
    await waitForToggleResult(completion, { status: 'ignored', reason: 'destroyed' });
    expect(applyTheme).not.toHaveBeenCalled();

    const lateBitmap = { width: 1_280, height: 720, close: vi.fn() } as unknown as ImageBitmap;
    finishDecode(lateBitmap);
    await vi.waitFor(() => expect(lateBitmap.close).toHaveBeenCalledOnce());
  });

  it('settles destroyed and closes both bitmaps when resampling resolves late', async () => {
    const decoded = { width: 4_096, height: 2_304, close: vi.fn() } as unknown as ImageBitmap;
    let finishResample!: (bitmap: ImageBitmap) => void;
    const resampleGate = new Promise<ImageBitmap>((resolve) => { finishResample = resolve; });
    const createBitmap = vi.fn()
      .mockResolvedValueOnce(decoded)
      .mockReturnValueOnce(resampleGate);
    vi.stubGlobal('createImageBitmap', createBitmap);
    rendererMock.maximumTextureSize.mockReturnValue(1_024);
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(2));

    transition.destroy();
    await waitForToggleResult(completion, { status: 'ignored', reason: 'destroyed' });
    expect(decoded.close).toHaveBeenCalledOnce();
    expect(applyTheme).not.toHaveBeenCalled();

    const lateBitmap = { width: 1_024, height: 576, close: vi.fn() } as unknown as ImageBitmap;
    finishResample(lateBitmap);
    await vi.waitFor(() => expect(lateBitmap.close).toHaveBeenCalledOnce());
  });

  it('settles destroyed while theme application remains pending forever', async () => {
    const applyTheme = vi.fn(() => new Promise<void>(() => undefined));
    const clock = new ManualClock();
    const transition = createTransition({ capture: async () => frame, clock });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await waitForOverlay();
    clock.step(16);
    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledOnce());

    transition.destroy();
    await waitForToggleResult(completion, { status: 'ignored', reason: 'destroyed' });
  });

  it('settles resize fallback while decode remains pending forever', async () => {
    const createBitmap = vi.fn(() => new Promise<ImageBitmap>(() => undefined));
    vi.stubGlobal('createImageBitmap', createBitmap);
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledOnce());

    window.dispatchEvent(new Event('resize'));
    await waitForToggleResult(completion, { status: 'fallback', reason: 'resize' });
    expect(applyTheme).toHaveBeenCalledOnce();
  });

  it('settles context-lost fallback while decode remains pending forever', async () => {
    const createBitmap = vi.fn(() => new Promise<ImageBitmap>(() => undefined));
    vi.stubGlobal('createImageBitmap', createBitmap);
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledOnce());

    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    await waitForToggleResult(completion, { status: 'fallback', reason: 'context-lost' });
    expect(applyTheme).toHaveBeenCalledOnce();
  });

  it('settles resize fallback and closes the decoded bitmap while resampling remains pending', async () => {
    const decoded = { width: 4_096, height: 2_304, close: vi.fn() } as unknown as ImageBitmap;
    const createBitmap = vi.fn()
      .mockResolvedValueOnce(decoded)
      .mockReturnValueOnce(new Promise<ImageBitmap>(() => undefined));
    vi.stubGlobal('createImageBitmap', createBitmap);
    rendererMock.maximumTextureSize.mockReturnValue(1_024);
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(2));

    window.dispatchEvent(new Event('resize'));
    await waitForToggleResult(completion, { status: 'fallback', reason: 'resize' });
    expect(decoded.close).toHaveBeenCalledOnce();
    expect(applyTheme).toHaveBeenCalledOnce();
  });

  it('settles context-lost fallback and closes the decoded bitmap while resampling is pending', async () => {
    const decoded = { width: 4_096, height: 2_304, close: vi.fn() } as unknown as ImageBitmap;
    const createBitmap = vi.fn()
      .mockResolvedValueOnce(decoded)
      .mockReturnValueOnce(new Promise<ImageBitmap>(() => undefined));
    vi.stubGlobal('createImageBitmap', createBitmap);
    rendererMock.maximumTextureSize.mockReturnValue(1_024);
    const applyTheme = vi.fn();
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(2));

    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    await waitForToggleResult(completion, { status: 'fallback', reason: 'context-lost' });
    expect(decoded.close).toHaveBeenCalledOnce();
    expect(applyTheme).toHaveBeenCalledOnce();
  });

  it('consumes a decode rejection that arrives after destroy', async () => {
    let rejectDecode!: (error: Error) => void;
    const decodeGate = new Promise<ImageBitmap>((_resolve, reject) => { rejectDecode = reject; });
    const createBitmap = vi.fn(() => decodeGate);
    vi.stubGlobal('createImageBitmap', createBitmap);
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: vi.fn() });
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledOnce());

    transition.destroy();
    await waitForToggleResult(completion, { status: 'ignored', reason: 'destroyed' });
    rejectDecode(new Error('late decode rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('consumes a resample rejection that arrives after destroy', async () => {
    const decoded = { width: 4_096, height: 2_304, close: vi.fn() } as unknown as ImageBitmap;
    let rejectResample!: (error: Error) => void;
    const resampleGate = new Promise<ImageBitmap>((_resolve, reject) => {
      rejectResample = reject;
    });
    const createBitmap = vi.fn()
      .mockResolvedValueOnce(decoded)
      .mockReturnValueOnce(resampleGate);
    vi.stubGlobal('createImageBitmap', createBitmap);
    rendererMock.maximumTextureSize.mockReturnValue(1_024);
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: vi.fn() });
    await vi.waitFor(() => expect(createBitmap).toHaveBeenCalledTimes(2));

    transition.destroy();
    await waitForToggleResult(completion, { status: 'ignored', reason: 'destroyed' });
    expect(decoded.close).toHaveBeenCalledOnce();
    rejectResample(new Error('late resample rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('finishes teardown and swallows a renderer destroy failure', async () => {
    const destroyFailure = new Error('renderer destroy failed');
    rendererMock.destroy.mockImplementationOnce(() => { throw destroyFailure; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const transition = createTransition({ capture: async () => frame, clock: new ManualClock() });
    await transition.prepare();
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;
    let thrown: unknown;

    try {
      transition.destroy();
    } catch (error) {
      thrown = error;
    }
    const canvasWasRemoved = document.querySelector('canvas[data-burn-overlay]') === null;
    canvas.remove();

    expect(thrown).toBeUndefined();
    expect(canvasWasRemoved).toBe(true);
    expect(canvas.hidden).toBe(true);
    expect(canvas.style.pointerEvents).toBe('none');
    expect(errorSpy).toHaveBeenCalledOnce();
    expect(rendererMock.destroy).toHaveBeenCalledOnce();
    transition.destroy();
    expect(rendererMock.destroy).toHaveBeenCalledOnce();
  });

  it('returns reduced motion to idle after resize interrupts a pending theme', async () => {
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const pendingTheme = vi.fn(() => new Promise<void>(() => undefined));
    const nextTheme = vi.fn();
    const transition = createTransition({
      capture: async () => frame,
      clock: new ManualClock(),
      respectReducedMotion: true,
    });
    await transition.prepare();
    const interrupted = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: pendingTheme });
    await vi.waitFor(() => expect(pendingTheme).toHaveBeenCalledOnce());

    window.dispatchEvent(new Event('resize'));
    await waitForToggleResult(interrupted, { status: 'fallback', reason: 'resize' });
    await expect(transition.toggle({ origin: { x: 2, y: 2 }, applyTheme: nextTheme }))
      .resolves.toEqual({ status: 'completed' });
    expect(nextTheme).toHaveBeenCalledOnce();
  });

  it('keeps an initial renderer prepare failure sticky across toggles', async () => {
    const prepareFailure = new Error('initial prepare failed');
    rendererMock.prepare.mockImplementationOnce(() => { throw prepareFailure; });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const capture = vi.fn(async () => frame);
    const firstTheme = vi.fn();
    const secondTheme = vi.fn();
    const transition = createTransition({ capture, clock: new ManualClock() });
    await transition.prepare();

    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: firstTheme }))
      .resolves.toEqual({ status: 'fallback', reason: 'webgl' });
    await expect(transition.toggle({ origin: { x: 2, y: 2 }, applyTheme: secondTheme }))
      .resolves.toEqual({ status: 'fallback', reason: 'webgl' });
    expect(capture).not.toHaveBeenCalled();
    expect(firstTheme).toHaveBeenCalledOnce();
    expect(secondTheme).toHaveBeenCalledOnce();
    expect(rendererMock.prepare).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('recovers an initial prepare failure after successful context restoration', async () => {
    rendererMock.prepare.mockImplementationOnce(() => { throw new Error('initial prepare failed'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const capture = vi.fn(async () => frame);
    const transition = createTransition({ capture, clock: new ManualClock() });
    await transition.prepare();
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: vi.fn() });
    await waitForOverlay();
    transition.destroy();

    await expect(completion).resolves.toEqual({ status: 'ignored', reason: 'destroyed' });
    expect(capture).toHaveBeenCalledOnce();
    expect(rendererMock.prepare).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('keeps restoration failure sticky until a later restoration succeeds', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const capture = vi.fn(async () => frame);
    const fallbackTheme = vi.fn();
    const transition = createTransition({ capture, clock: new ManualClock() });
    await transition.prepare();
    const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;
    canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    rendererMock.prepare.mockImplementationOnce(() => { throw new Error('restore failed'); });

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    await expect(transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: fallbackTheme }))
      .resolves.toEqual({ status: 'fallback', reason: 'webgl' });
    expect(capture).not.toHaveBeenCalled();
    expect(fallbackTheme).toHaveBeenCalledOnce();

    canvas.dispatchEvent(new Event('webglcontextrestored'));
    const completion = transition.toggle({ origin: { x: 2, y: 2 }, applyTheme: vi.fn() });
    await waitForOverlay();
    transition.destroy();

    await expect(completion).resolves.toEqual({ status: 'ignored', reason: 'destroyed' });
    expect(capture).toHaveBeenCalledOnce();
    expect(rendererMock.prepare).toHaveBeenCalledTimes(3);
    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it('ignores a capture value that arrives after destroyed settlement', async () => {
    let finishCapture!: (captured: CapturedViewport) => void;
    const captureGate = new Promise<CapturedViewport>((resolve) => { finishCapture = resolve; });
    const capture = vi.fn(() => captureGate);
    const decode = vi.fn(async () => defaultBitmap);
    vi.stubGlobal('createImageBitmap', decode);
    const applyTheme = vi.fn();
    const transition = createTransition({ capture, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());

    transition.destroy();
    await waitForToggleResult(completion, { status: 'ignored', reason: 'destroyed' });
    finishCapture(frame);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(decode).not.toHaveBeenCalled();
    expect(applyTheme).not.toHaveBeenCalled();
  });

  it('consumes a capture rejection that arrives after destroyed settlement', async () => {
    let rejectCapture!: (error: Error) => void;
    const captureGate = new Promise<CapturedViewport>((_resolve, reject) => {
      rejectCapture = reject;
    });
    const capture = vi.fn(() => captureGate);
    const transition = createTransition({ capture, clock: new ManualClock() });
    await transition.prepare();
    const completion = transition.toggle({ origin: { x: 1, y: 1 }, applyTheme: vi.fn() });
    await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());

    transition.destroy();
    await waitForToggleResult(completion, { status: 'ignored', reason: 'destroyed' });
    rejectCapture(new Error('late capture rejection'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
});
