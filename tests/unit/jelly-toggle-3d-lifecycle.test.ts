import { describe, expect, it, vi } from 'vitest';

import {
  createJellyToggle3DWithRuntime,
  type JellyToggle3D,
  type JellyToggleRuntime,
} from '../../src/jelly-toggle-3d/JellyToggle3D';
import { CANONICAL_POSES } from '../../src/jelly-toggle-3d/physics-fixtures';
import { createJellyPhysics, type JellyPhysics, type JellyTarget, type Point2 } from '../../src/jelly-toggle-3d/physics';
import type { JellyRenderer } from '../../src/jelly-toggle-3d/renderer';
import { createTaaState } from '../../src/jelly-toggle-3d/taa';

interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(reason: unknown): void }
function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

class ManualRaf {
  readonly request = vi.fn((callback: FrameRequestCallback): number => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  });
  readonly cancel = vi.fn((id: number): void => { this.callbacks.delete(id); });
  private readonly callbacks = new Map<number, FrameRequestCallback>();
  private nextId = 1;
  private now = 0;
  get pending(): number { return this.callbacks.size; }
  flush(milliseconds = 1000 / 60): void {
    const entry = this.callbacks.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) throw new Error('No RAF is pending');
    this.callbacks.delete(entry[0]);
    this.now += milliseconds;
    entry[1](this.now);
  }
  flushAll(limit = 300): number {
    let count = 0;
    while (this.callbacks.size > 0 && count < limit) { this.flush(); count += 1; }
    if (this.callbacks.size > 0) throw new Error(`RAF did not become idle within ${limit} frames`);
    return count;
  }
}

class MutableMediaQuery {
  matches: boolean;
  readonly media: string;
  private readonly listeners = new Set<(event: MediaQueryListEvent) => void>();
  constructor(media: string, matches: boolean) { this.media = media; this.matches = matches; }
  addEventListener(_type: 'change', listener: EventListenerOrEventListenerObject): void {
    this.listeners.add(listener as (event: MediaQueryListEvent) => void);
  }
  removeEventListener(_type: 'change', listener: EventListenerOrEventListenerObject): void {
    this.listeners.delete(listener as (event: MediaQueryListEvent) => void);
  }
  set(matches: boolean): void {
    this.matches = matches;
    const event = { matches, media: this.media } as MediaQueryListEvent;
    for (const listener of [...this.listeners]) listener(event);
  }
}

interface RendererFake extends JellyRenderer {
  readonly drawCalls: Array<{ jitterIndex: number; historyValid: boolean }>;
  readonly poses: Array<{ points: readonly Point2[]; discontinuous: boolean }>;
  readonly resizeCalls: Array<[number, number, number]>;
  readonly destroyMock: ReturnType<typeof vi.fn>;
  drawHook?: () => void;
  lose(): void;
}

function createRendererFake(options: {
  destroyThrows?: boolean;
  resizeThrows?: boolean;
  resizeResults?: boolean[];
} = {}): RendererFake {
  const lost = createDeferred<GPUDeviceLostInfo>();
  const drawCalls: Array<{ jitterIndex: number; historyValid: boolean }> = [];
  const poses: Array<{ points: readonly Point2[]; discontinuous: boolean }> = [];
  const resizeCalls: Array<[number, number, number]> = [];
  const stats = { rafRequests: 0, submissions: 0, buffersCreated: 0, buffersDestroyed: 0, texturesCreated: 0, texturesDestroyed: 0, uncapturedErrors: 0 };
  const resizeResults = [...(options.resizeResults ?? [])];
  const destroyMock = vi.fn(() => { if (options.destroyThrows) throw new Error('destroy failed'); });
  return {
    device: {} as GPUDevice,
    stats,
    lost: lost.promise,
    drawCalls,
    poses,
    resizeCalls,
    destroyMock,
    resize(width, height, dpr) {
      resizeCalls.push([width, height, dpr]);
      if (options.resizeThrows) throw new Error('resize failed');
      return resizeResults.shift() ?? true;
    },
    setPose(points, discontinuous) { poses.push({ points: points.map((point) => ({ ...point })), discontinuous }); },
    draw(drawOptions) { this.drawHook?.(); drawCalls.push(drawOptions); stats.submissions += 1; },
    resetHistory: vi.fn(),
    readDiagnostics: async () => { throw new Error('not used'); },
    destroy: destroyMock,
    lose() { lost.resolve({ reason: 'unknown', message: 'test loss' } as GPUDeviceLostInfo); },
  };
}

interface Harness {
  readonly button: HTMLButtonElement;
  readonly toggle: JellyToggle3D;
  readonly runtime: JellyToggleRuntime;
  readonly raf: ManualRaf;
  readonly reduced: MutableMediaQuery;
  readonly forced: MutableMediaQuery;
  readonly errors: unknown[];
  readonly observedResizeBox: () => ResizeObserverBoxOptions | undefined;
  readonly resolutionSignal: () => AbortSignal | undefined;
  resize(): void;
  emitResolutionChange(): void;
  setDpr(value: number): void;
}

function createHarness(options: {
  checked?: boolean; ariaChecked?: string; ariaLabel?: string; label?: string;
  reduced?: boolean; forced?: boolean; respectReducedMotion?: boolean;
  onChange?: (checked: boolean) => void;
  renderers?: Array<JellyRenderer | Promise<JellyRenderer> | Error>;
  physicsFactory?: (target: JellyTarget) => JellyPhysics;
  observerDisconnectThrows?: boolean; cancelThrows?: boolean;
} = {}): Harness {
  const button = document.createElement('button');
  if (options.ariaChecked !== undefined) button.setAttribute('aria-checked', options.ariaChecked);
  if (options.ariaLabel !== undefined) button.setAttribute('aria-label', options.ariaLabel);
  const raf = new ManualRaf();
  const reduced = new MutableMediaQuery('(prefers-reduced-motion: reduce)', options.reduced ?? false);
  const forced = new MutableMediaQuery('(forced-colors: active)', options.forced ?? false);
  const errors: unknown[] = [];
  const rendererQueue = [...(options.renderers ?? [createRendererFake()])];
  let resizeCallback: ResizeObserverCallback = () => undefined;
  let resolutionCallback: () => void = () => undefined;
  let resizeBox: ResizeObserverBoxOptions | undefined;
  let ownedResolutionSignal: AbortSignal | undefined;
  let dpr = 1;
  const runtime = {
    createRenderer: vi.fn(async () => {
      const next = rendererQueue.shift();
      if (!next) throw new Error('No renderer queued');
      if (next instanceof Error) throw next;
      return await next;
    }),
    createPhysics: options.physicsFactory ?? ((target) => createJellyPhysics(target)),
    createTaa: () => createTaaState(),
    requestAnimationFrame: raf.request,
    cancelAnimationFrame: (id) => { raf.cancel(id); if (options.cancelThrows) throw new Error('cancel failed'); },
    createResizeObserver: (callback) => {
      resizeCallback = callback;
      return {
        observe: vi.fn((_target: Element, observeOptions?: ResizeObserverOptions) => { resizeBox = observeOptions?.box; }),
        disconnect: () => { if (options.observerDisconnectThrows) throw new Error('disconnect failed'); },
      };
    },
    matchMedia: (query) => (query.includes('forced') ? forced : reduced) as never,
    observeResolutionChanges: (callback: () => void, signal: AbortSignal) => {
      resolutionCallback = callback;
      ownedResolutionSignal = signal;
    },
    devicePixelRatio: () => dpr,
    reportError: (error) => { errors.push(error); },
  } as JellyToggleRuntime;
  const toggle = createJellyToggle3DWithRuntime({
    element: button,
    ...(options.checked === undefined ? {} : { checked: options.checked }),
    ...(options.label === undefined ? {} : { label: options.label }),
    ...(options.respectReducedMotion === undefined ? {} : { respectReducedMotion: options.respectReducedMotion }),
    ...(options.onChange === undefined ? {} : { onChange: options.onChange }),
  }, runtime);
  return { button, toggle, runtime, raf, reduced, forced, errors,
    observedResizeBox: () => resizeBox,
    resolutionSignal: () => ownedResolutionSignal,
    resize: () => resizeCallback([], {} as ResizeObserver),
    emitResolutionChange: () => resolutionCallback(),
    setDpr: (value) => { dpr = value; } };
}

async function settleMicrotasks(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

describe('createJellyToggle3D', () => {
  it('owns native semantics and calls onChange once per activation', () => {
    const onChange = vi.fn();
    const { button, toggle } = createHarness({ onChange });
    button.click();
    expect(button.type).toBe('button');
    expect(button.getAttribute('role')).toBe('switch');
    expect(button.getAttribute('aria-label')).toBe('Jelly toggle');
    expect(button.getAttribute('aria-checked')).toBe('true');
    expect(toggle.checked).toBe(true);
    expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
    toggle.setChecked(false);
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ checked: false, ariaChecked: 'true', label: 'Option', ariaLabel: 'Existing' }, false, 'Option'],
    [{ ariaChecked: 'true', ariaLabel: 'Existing' }, true, 'Existing'],
    [{}, false, 'Jelly toggle'],
  ] as const)('applies checked and label precedence %#', (input, expectedChecked, expectedLabel) => {
    const { button, toggle } = createHarness(input);
    expect(toggle.checked).toBe(expectedChecked);
    expect(button.getAttribute('aria-checked')).toBe(String(expectedChecked));
    expect(button.getAttribute('aria-label')).toBe(expectedLabel);
    expect(button.hasAttribute('aria-pressed')).toBe(false);
  });

  it('owns exactly one canvas and one fallback throughout retries', async () => {
    const harness = createHarness({ renderers: [new Error('unavailable'), createRendererFake()] });
    await expect(harness.toggle.ready).resolves.toBe('fallback');
    await expect(harness.toggle.retryWebGPU()).resolves.toBe('webgpu');
    expect(harness.button.querySelectorAll('canvas.jelly-toggle-3d__canvas')).toHaveLength(1);
    expect(harness.button.querySelectorAll('span.jelly-toggle-3d__fallback')).toHaveLength(1);
    expect(harness.button.querySelector('canvas')?.getAttribute('aria-hidden')).toBe('true');
    expect(harness.button.querySelector('span')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('uses the latest input when initialization completes', async () => {
    const deferred = createDeferred<JellyRenderer>();
    const renderer = createRendererFake();
    const { button, toggle } = createHarness({ renderers: [deferred.promise] });
    button.click();
    deferred.resolve(renderer);
    await expect(toggle.ready).resolves.toBe('webgpu');
    expect(toggle.checked).toBe(true);
    expect(renderer.poses.at(-1)?.points).toEqual(CANONICAL_POSES.on);
  });

  it('reveals initial ON only after a hidden invalid-history seed draw', async () => {
    const renderer = createRendererFake();
    const harness = createHarness({ checked: true, renderers: [renderer] });
    const visibility: Array<[boolean, boolean]> = [];
    renderer.drawHook = () => visibility.push([
      Boolean((harness.button.querySelector('canvas') as HTMLCanvasElement).hidden),
      Boolean((harness.button.querySelector('span') as HTMLSpanElement).hidden),
    ]);
    await expect(harness.toggle.ready).resolves.toBe('webgpu');
    expect(renderer.poses.at(-1)?.points).toEqual(CANONICAL_POSES.on);
    expect(renderer.drawCalls).toHaveLength(1);
    expect(renderer.drawCalls[0]).toMatchObject({ historyValid: false });
    expect(visibility[0]).toEqual([true, false]);
    expect((harness.button.querySelector('canvas') as HTMLCanvasElement).hidden).toBe(false);
    expect(harness.raf.flushAll()).toBe(15);
    expect(renderer.drawCalls).toHaveLength(16);
  });

  it('ignores unchanged reveal ResizeObserver and duplicate resolution deliveries', async () => {
    const renderer = createRendererFake({ resizeResults: [true, false, false, false] });
    const harness = createHarness({ checked: true, renderers: [renderer] });
    await harness.toggle.ready;
    expect(renderer.drawCalls).toHaveLength(1);
    expect(harness.raf.pending).toBe(1);
    harness.resize();
    harness.emitResolutionChange();
    harness.emitResolutionChange();
    expect(renderer.resizeCalls).toHaveLength(4);
    expect(renderer.drawCalls).toHaveLength(1);
    expect(harness.raf.pending).toBe(1);
    expect(harness.raf.flushAll()).toBe(15);
    expect(renderer.drawCalls).toHaveLength(16);
  });

  it('suppresses disabled activation', () => {
    const onChange = vi.fn();
    const { button, toggle } = createHarness({ onChange });
    button.disabled = true;
    button.click();
    expect(toggle.checked).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('reports callback errors and keeps the committed state renderable', async () => {
    const renderer = createRendererFake();
    const { button, toggle, errors, raf } = createHarness({
      renderers: [renderer], onChange: () => { throw new Error('consumer failed'); },
    });
    await toggle.ready; raf.flushAll(); button.click();
    expect(() => raf.flush()).not.toThrow();
    expect(toggle.checked).toBe(true);
    expect(errors).toHaveLength(1);
  });

  it('lets a reentrant callback own the latest state and only one RAF', async () => {
    let toggle!: JellyToggle3D;
    const harness = createHarness({ renderers: [createRendererFake()], onChange: () => toggle.setChecked(false) });
    toggle = harness.toggle;
    await toggle.ready; harness.raf.flushAll(); harness.button.click();
    expect(toggle.checked).toBe(false);
    expect(harness.raf.pending).toBeLessThanOrEqual(1);
  });

  it('allows callback-driven destroy without resuming visual work', async () => {
    let toggle!: JellyToggle3D;
    const harness = createHarness({ renderers: [createRendererFake()], onChange: () => toggle.destroy() });
    toggle = harness.toggle;
    await toggle.ready; harness.raf.flushAll(); harness.button.click();
    expect(toggle.checked).toBe(true);
    expect(harness.button.getAttribute('aria-checked')).toBe('true');
    expect(harness.button.querySelector('.jelly-toggle-3d__canvas')).toBeNull();
    expect(harness.raf.pending).toBe(0);
    expect(harness.observedResizeBox()).toBe('device-pixel-content-box');
  });

  it('keeps the deepest reentrant native activation as the final state', async () => {
    const onChange = vi.fn((checked: boolean) => { if (checked) harness.button.click(); });
    const harness = createHarness({ renderers: [createRendererFake()], onChange });
    await harness.toggle.ready; harness.raf.flushAll(); harness.button.click();
    expect(harness.toggle.checked).toBe(false);
    expect(onChange.mock.calls).toEqual([[true], [false]]);
    expect(harness.raf.pending).toBeLessThanOrEqual(1);
  });

  it('does no work for the same target and preserves velocity on rapid reversal', async () => {
    const renderer = createRendererFake();
    const { button, toggle, raf } = createHarness({ renderers: [renderer] });
    await toggle.ready; raf.flushAll();
    const idleRequests = raf.request.mock.calls.length;
    toggle.setChecked(false);
    expect(raf.request).toHaveBeenCalledTimes(idleRequests);
    button.click();
    for (let i = 0; i < 8; i += 1) raf.flush();
    button.click(); raf.flush();
    expect(renderer.poses.at(-1)?.points).not.toEqual(CANONICAL_POSES.off);
    expect(renderer.poses.at(-1)?.points).not.toEqual(CANONICAL_POSES.on);
    raf.flushAll();
    expect(toggle.checked).toBe(false);
    expect(raf.pending).toBe(0);
  });

  it('snaps reduced-motion changes and performs exactly 16 bounded draws', async () => {
    const renderer = createRendererFake();
    const { toggle, raf } = createHarness({ reduced: true, renderers: [renderer] });
    await toggle.ready; raf.flushAll();
    const baseline = renderer.drawCalls.length;
    toggle.setChecked(true);
    expect(raf.flushAll()).toBe(15);
    expect(renderer.drawCalls.length - baseline).toBe(16);
    expect(renderer.poses.at(-1)).toMatchObject({ points: CANONICAL_POSES.on, discontinuous: true });
  });

  it('snaps an active animation when reduced motion changes at runtime', async () => {
    const renderer = createRendererFake();
    const { button, toggle, reduced, raf } = createHarness({ renderers: [renderer] });
    await toggle.ready; raf.flushAll(); button.click(); raf.flush();
    const baseline = renderer.drawCalls.length;
    reduced.set(true);
    expect(renderer.drawCalls.length - baseline).toBe(1);
    expect(raf.flushAll()).toBe(15);
    expect(renderer.drawCalls.length - baseline).toBe(16);
    reduced.set(false);
    expect(raf.pending).toBe(0);
  });

  it('stops GPU work in forced colors and resumes latest canonical state with 16 draws', async () => {
    const renderer = createRendererFake();
    const { toggle, forced, raf, button } = createHarness({ renderers: [renderer] });
    await toggle.ready; raf.flushAll(); forced.set(true); toggle.setChecked(true);
    expect(raf.pending).toBe(0);
    expect((button.querySelector('canvas') as HTMLCanvasElement).hidden).toBe(true);
    const baseline = renderer.drawCalls.length;
    forced.set(false);
    expect(raf.flushAll()).toBe(15);
    expect(renderer.drawCalls.length - baseline).toBe(16);
    expect(renderer.poses.at(-1)?.points).toEqual(CANONICAL_POSES.on);
  });

  it('seeds the latest canonical state while hidden before forced-colors exit reveals it', async () => {
    const renderer = createRendererFake();
    const harness = createHarness({ renderers: [renderer] });
    await harness.toggle.ready; harness.raf.flushAll();
    harness.forced.set(true); harness.toggle.setChecked(true);
    harness.setDpr(2); harness.emitResolutionChange();
    const baseline = renderer.drawCalls.length;
    const visibility: boolean[] = [];
    renderer.drawHook = () => visibility.push(Boolean((harness.button.querySelector('canvas') as HTMLCanvasElement).hidden));
    harness.forced.set(false);
    expect(renderer.drawCalls.length - baseline).toBe(1);
    expect(renderer.drawCalls.at(-1)).toMatchObject({ historyValid: false });
    expect(visibility).toEqual([true]);
    expect((harness.button.querySelector('canvas') as HTMLCanvasElement).hidden).toBe(false);
    expect(renderer.resizeCalls.at(-1)).toEqual([88, 44, 2]);
    expect(harness.raf.flushAll()).toBe(15);
    expect(renderer.drawCalls.length - baseline).toBe(16);
  });

  it('starts forced-colors idle and recovers the latest semantic state', async () => {
    const renderer = createRendererFake();
    const harness = createHarness({ forced: true, renderers: [renderer] });
    await expect(harness.toggle.ready).resolves.toBe('webgpu');
    expect(harness.raf.pending).toBe(0);
    harness.button.click();
    expect(harness.toggle.checked).toBe(true);
    expect(renderer.drawCalls).toHaveLength(0);
    harness.forced.set(false);
    expect(harness.raf.flushAll()).toBe(15);
    expect(renderer.poses.at(-1)?.points).toEqual(CANONICAL_POSES.on);
  });

  it('ignores reduced motion when respectReducedMotion is false', async () => {
    const renderer = createRendererFake();
    const harness = createHarness({ reduced: true, respectReducedMotion: false, renderers: [renderer] });
    await harness.toggle.ready; harness.raf.flushAll(); harness.button.click(); harness.raf.flush();
    expect(renderer.poses.at(-1)?.points).not.toEqual(CANONICAL_POSES.on);
    expect(harness.raf.pending).toBe(1);
    harness.raf.flushAll();
  });

  it('resizes for DPR changes and redraws to bounded idle', async () => {
    const renderer = createRendererFake();
    const harness = createHarness({ renderers: [renderer] });
    await harness.toggle.ready; harness.raf.flushAll(); harness.setDpr(2.5); harness.resize();
    expect(renderer.resizeCalls.at(-1)).toEqual([88, 44, 2.5]);
    expect(harness.raf.flushAll()).toBe(15);
  });

  it('seeds hidden history immediately before redraw reveals replacement backing', async () => {
    const renderer = createRendererFake();
    const harness = createHarness({ renderers: [renderer] });
    await harness.toggle.ready; harness.raf.flushAll();
    const baseline = renderer.drawCalls.length;
    const visibility: boolean[] = [];
    renderer.drawHook = () => visibility.push(Boolean((harness.button.querySelector('canvas') as HTMLCanvasElement).hidden));
    harness.toggle.redraw();
    expect(renderer.drawCalls.length - baseline).toBe(1);
    expect(renderer.drawCalls.at(-1)).toMatchObject({ historyValid: false });
    expect(visibility).toEqual([true]);
    expect((harness.button.querySelector('canvas') as HTMLCanvasElement).hidden).toBe(false);
    expect(harness.raf.flushAll()).toBe(15);
    expect(renderer.drawCalls.length - baseline).toBe(16);
  });

  it('migrates DPR from complete idle on the owned resolution event and returns idle', async () => {
    const renderer = createRendererFake();
    const harness = createHarness({ renderers: [renderer] });
    await harness.toggle.ready; harness.raf.flushAll();
    const baseline = renderer.drawCalls.length;
    expect(harness.raf.pending).toBe(0);
    harness.setDpr(2);
    harness.emitResolutionChange();
    expect(renderer.resizeCalls.at(-1)).toEqual([88, 44, 2]);
    expect(renderer.drawCalls.length - baseline).toBe(1);
    expect(harness.raf.flushAll()).toBe(15);
    expect(renderer.drawCalls.length - baseline).toBe(16);
    expect(harness.raf.pending).toBe(0);
  });

  it('invalidates history when DPR changes during an active frame', async () => {
    const renderer = createRendererFake();
    const harness = createHarness({ renderers: [renderer] });
    await harness.toggle.ready; harness.raf.flushAll(); harness.button.click();
    const resets = vi.mocked(renderer.resetHistory).mock.calls.length;
    harness.setDpr(2); harness.raf.flush();
    expect(renderer.resizeCalls.at(-1)).toEqual([88, 44, 2]);
    expect(renderer.resetHistory).toHaveBeenCalledTimes(resets + 1);
    harness.raf.flushAll();
  });

  it('automatically retries only the first device loss', async () => {
    const first = createRendererFake(); const second = createRendererFake();
    const harness = createHarness({ renderers: [first, second] });
    await harness.toggle.ready; harness.raf.flushAll(); first.lose(); await settleMicrotasks();
    expect(harness.runtime.createRenderer).toHaveBeenCalledTimes(2);
    expect(first.destroyMock).toHaveBeenCalledOnce();
    harness.raf.flushAll(); second.lose(); await settleMicrotasks();
    expect(harness.runtime.createRenderer).toHaveBeenCalledTimes(2);
    expect(harness.raf.pending).toBe(0);
    expect(harness.button.dataset.jellyToggleFallbackReason).toBe('device-lost');
  });

  it('keeps failed automatic recovery idle without a third attempt and permits manual retry', async () => {
    const first = createRendererFake();
    const manual = createRendererFake();
    const harness = createHarness({ renderers: [first, new Error('automatic failed'), manual] });
    await harness.toggle.ready; harness.raf.flushAll(); first.lose();
    await settleMicrotasks(); await settleMicrotasks();
    expect(harness.runtime.createRenderer).toHaveBeenCalledTimes(2);
    expect(harness.raf.pending).toBe(0);
    expect(harness.button.dataset.jellyToggleFallbackReason).toBe('device-lost');
    await expect(harness.toggle.retryWebGPU()).resolves.toBe('webgpu');
    expect(harness.runtime.createRenderer).toHaveBeenCalledTimes(3);
  });

  it('preserves normalized fallback reason and clears it after successful recovery', async () => {
    const renderer = createRendererFake();
    const harness = createHarness({ renderers: [new Error('no adapter'), renderer] });
    await expect(harness.toggle.ready).resolves.toBe('fallback');
    expect(harness.button.dataset.jellyToggleFallbackReason).toBe('initialization-failed');
    await expect(harness.toggle.retryWebGPU()).resolves.toBe('webgpu');
    expect(harness.button.dataset.jellyToggleFallbackReason).toBeUndefined();
  });

  it('keeps recovery hidden and seeds the latest state before revealing after device loss', async () => {
    const first = createRendererFake();
    const deferred = createDeferred<JellyRenderer>();
    const recovered = createRendererFake({ resizeResults: [true, false] });
    const harness = createHarness({ renderers: [first, deferred.promise] });
    await harness.toggle.ready; harness.raf.flushAll(); first.lose(); await settleMicrotasks();
    expect(harness.button.dataset.jellyToggleFallbackReason).toBe('device-lost');
    harness.button.click();
    const visibility: boolean[] = [];
    recovered.drawHook = () => visibility.push(Boolean((harness.button.querySelector('canvas') as HTMLCanvasElement).hidden));
    deferred.resolve(recovered); await settleMicrotasks();
    expect(recovered.poses.at(-1)?.points).toEqual(CANONICAL_POSES.on);
    expect(recovered.drawCalls).toHaveLength(1);
    expect(visibility).toEqual([true]);
    expect((harness.button.querySelector('canvas') as HTMLCanvasElement).hidden).toBe(false);
    expect(harness.button.dataset.jellyToggleFallbackReason).toBeUndefined();
    harness.resize();
    expect(recovered.drawCalls).toHaveLength(1);
    expect(harness.raf.flushAll()).toBe(15);
    expect(recovered.drawCalls).toHaveLength(16);
  });

  it('retries a device already lost while its initialization attempt is settling', async () => {
    const alreadyLost = createRendererFake();
    const recovered = createRendererFake();
    alreadyLost.lose();
    const harness = createHarness({ renderers: [alreadyLost, recovered] });
    await harness.toggle.ready;
    await settleMicrotasks();
    expect(harness.runtime.createRenderer).toHaveBeenCalledTimes(2);
    expect(alreadyLost.destroyMock).toHaveBeenCalledOnce();
  });

  it('deduplicates manual retries and failed retry remains idle', async () => {
    const deferred = createDeferred<JellyRenderer>();
    const harness = createHarness({ renderers: [new Error('initial'), deferred.promise] });
    await expect(harness.toggle.ready).resolves.toBe('fallback');
    const retryA = harness.toggle.retryWebGPU(); const retryB = harness.toggle.retryWebGPU();
    expect(harness.runtime.createRenderer).toHaveBeenCalledTimes(2);
    deferred.reject(new Error('retry failed'));
    await expect(retryA).resolves.toBe('fallback');
    await expect(retryB).resolves.toBe('fallback');
    expect(harness.raf.pending).toBe(0);
  });

  it('destroys a stale renderer that resolves after destroy', async () => {
    const deferred = createDeferred<JellyRenderer>(); const renderer = createRendererFake();
    const { toggle } = createHarness({ renderers: [deferred.promise] });
    toggle.destroy(); deferred.resolve(renderer);
    await expect(toggle.ready).resolves.toBe('destroyed'); await settleMicrotasks();
    expect(renderer.destroyMock).toHaveBeenCalledOnce();
  });

  it('resolves a pending manual retry as destroyed and cleans its stale renderer', async () => {
    const deferred = createDeferred<JellyRenderer>();
    const harness = createHarness({ renderers: [new Error('initial'), deferred.promise] });
    await harness.toggle.ready;
    const retry = harness.toggle.retryWebGPU();
    harness.toggle.destroy();
    const renderer = createRendererFake();
    deferred.resolve(renderer);
    await expect(retry).resolves.toBe('destroyed');
    expect(renderer.destroyMock).toHaveBeenCalledOnce();
  });

  it('gives device loss precedence over resize and stale generation work', async () => {
    const first = createRendererFake(); const recovery = createDeferred<JellyRenderer>();
    const harness = createHarness({ renderers: [first, recovery.promise] });
    await harness.toggle.ready; harness.raf.flushAll(); first.lose(); await settleMicrotasks();
    const resizeCount = first.resizeCalls.length; harness.resize();
    expect(first.resizeCalls).toHaveLength(resizeCount);
    expect(harness.raf.pending).toBe(0);
    harness.toggle.destroy(); const stale = createRendererFake(); recovery.resolve(stale); await settleMicrotasks();
    expect(stale.destroyMock).toHaveBeenCalledOnce();
  });

  it('destroys idempotently and exception-safely while preserving final aria state', async () => {
    const renderer = createRendererFake({ destroyThrows: true });
    const harness = createHarness({ checked: true, renderers: [renderer], observerDisconnectThrows: true, cancelThrows: true });
    await harness.toggle.ready;
    expect(() => harness.toggle.destroy()).not.toThrow();
    expect(() => harness.toggle.destroy()).not.toThrow();
    expect(harness.button.getAttribute('aria-checked')).toBe('true');
    expect(harness.button.querySelector('.jelly-toggle-3d__canvas')).toBeNull();
    expect(harness.button.querySelector('.jelly-toggle-3d__fallback')).toBeNull();
    expect(renderer.destroyMock).toHaveBeenCalledOnce();
    expect(harness.errors).toHaveLength(3);
    expect(harness.resolutionSignal()?.aborted).toBe(true);
    await expect(harness.toggle.retryWebGPU()).resolves.toBe('destroyed');
  });
});
