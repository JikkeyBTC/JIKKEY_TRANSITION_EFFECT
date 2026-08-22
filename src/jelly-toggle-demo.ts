import './jelly-toggle-demo.css';
import './jelly-toggle-3d/component.css';

import { createJellyToggle3D } from './jelly-toggle-3d';
import {
  createJellyToggle3DWithRuntime,
  type JellyToggle3D,
  type JellyToggleReadyState,
  type JellyToggleRuntime,
} from './jelly-toggle-3d/JellyToggle3D';
import { createJellyPhysics, type JellyPhysics, type JellyTarget } from './jelly-toggle-3d/physics';
import { createJellyRenderer, type JellyRenderer, type JellyRendererStats } from './jelly-toggle-3d/renderer';
import { createTaaState } from './jelly-toggle-3d/taa';

const parameters = new URLSearchParams(location.search);
const testMode = parameters.get('test') === '1';
const hideWebGpu = testMode && parameters.get('gpu') === 'hidden';
const deferWebGpu = testMode && parameters.get('init') === 'manual';
const element = document.querySelector<HTMLButtonElement>('#jelly-toggle');
if (!element) throw new Error('Missing jelly toggle button');

class ManualJellyClock {
  private time = 0;
  private nextHandle = 1;
  private readonly callbacks = new Map<number, FrameRequestCallback>();

  request(callback: FrameRequestCallback): number {
    const handle = this.nextHandle++;
    this.callbacks.set(handle, callback);
    return handle;
  }

  cancel(handle: number): void {
    this.callbacks.delete(handle);
  }

  step(milliseconds: number): void {
    this.time += milliseconds;
    const callbacks = [...this.callbacks.values()];
    this.callbacks.clear();
    for (const callback of callbacks) callback(this.time);
  }

  hasPendingFrame(): boolean {
    return this.callbacks.size > 0;
  }
}

let releaseInitialization = (): void => undefined;
const initializationGate = deferWebGpu
  ? new Promise<void>((resolve) => { releaseInitialization = resolve; })
  : Promise.resolve();
const manualClock = testMode ? new ManualJellyClock() : null;
let testDpr = window.devicePixelRatio;
let activePhysics: JellyPhysics | undefined;
let activeRenderer: JellyRenderer | undefined;
let toggle: JellyToggle3D | undefined;
let readyState: JellyToggleReadyState | 'pending' = 'pending';

if (hideWebGpu) {
  try {
    Object.defineProperty(navigator, 'gpu', { configurable: true, value: undefined });
  } catch {
    // The runtime guard below still exercises the same first-load fallback path.
  }
}

const runtime: JellyToggleRuntime = {
  async createRenderer(canvas) {
    await initializationGate;
    if (hideWebGpu || !navigator.gpu) throw new Error('WebGPU hidden by the test route');
    const renderer = await createJellyRenderer(canvas);
    activeRenderer = renderer;
    return renderer;
  },
  createPhysics(target) {
    const physics = createJellyPhysics(target);
    activePhysics = physics;
    return physics;
  },
  createTaa: () => createTaaState(),
  requestAnimationFrame: (callback) => manualClock
    ? manualClock.request(callback)
    : window.requestAnimationFrame(callback),
  cancelAnimationFrame: (handle) => {
    if (manualClock) manualClock.cancel(handle);
    else window.cancelAnimationFrame(handle);
  },
  createResizeObserver: (callback) => new ResizeObserver(callback),
  matchMedia: (query) => window.matchMedia(query),
  observeResolutionChanges: (callback, signal) => {
    window.addEventListener('resize', callback, { signal });
    let resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const rearm = (): void => {
      resolutionQuery.addEventListener('change', onChange, { once: true, signal });
    };
    const onChange = (): void => {
      callback();
      if (signal.aborted) return;
      resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      rearm();
    };
    rearm();
  },
  devicePixelRatio: () => testMode ? testDpr : window.devicePixelRatio,
  reportError: (error) => {
    if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
    else console.error(error);
  },
};

if (testMode) {
  document.documentElement.dataset.jellyReady = 'pending';
  const hook = Object.freeze({
    hasPendingFrame: (): boolean => manualClock?.hasPendingFrame() ?? false,
    step: (milliseconds: number): void => manualClock?.step(milliseconds),
    readyState: (): JellyToggleReadyState | 'pending' => readyState,
    releaseInitialization: (): void => releaseInitialization(),
    setDevicePixelRatio: (value: number): void => {
      testDpr = value;
      window.dispatchEvent(new Event('resize'));
    },
    checked: (): boolean => toggle?.checked ?? element.getAttribute('aria-checked') === 'true',
    target: (): JellyTarget | undefined => activePhysics?.snapshot.target,
    pose: () => activePhysics?.snapshot,
    stats: (): JellyRendererStats | undefined => activeRenderer?.stats,
    destroy: (): void => toggle?.destroy(),
  });
  window.__jellyTest = hook;
}

toggle = testMode
  ? createJellyToggle3DWithRuntime({ element }, runtime)
  : createJellyToggle3D({ element });
void toggle.ready.then((state) => {
  readyState = state;
  document.documentElement.dataset.jellyReady = state;
});
