import './jelly-toggle-demo.css';
import './jelly-toggle-3d/component.css';

import { createJellyToggle3D } from './jelly-toggle-3d';
import {
  createJellyToggle3DWithRuntime,
  type JellyToggle3D,
  type JellyToggleReadyState,
  type JellyToggleRuntime,
} from './jelly-toggle-3d/JellyToggle3D';
import {
  selectJellyFixturePose,
  verifyAndFreezeJellyFixturePose,
  type JellyFixturePose,
  type JellyFixtureState,
} from './jelly-toggle-3d/fixture-pose';
import {
  createJellyPhysics,
  type JellyPhysics,
  type JellyTarget,
  type Point2,
} from './jelly-toggle-3d/physics';
import {
  createJellyRenderer,
  type JellyDiagnosticReadback,
  type JellyRenderer,
  type JellyRendererStats,
} from './jelly-toggle-3d/renderer';
import { createTaaState } from './jelly-toggle-3d/taa';
import { createTestRendererOwner } from './jelly-toggle-3d/test-renderer-owner';
import { assertJellyFixtureSurface } from './jelly-toggle-3d/fixture-environment';
import {
  createXorshift32,
  JELLY_FIXTURE_RANDOM_SEED,
  type ResettableJellyRandomSource,
} from './jelly-toggle-3d/random';

export type { JellyFixtureState } from './jelly-toggle-3d/fixture-pose';

export interface JellyFixtureCapture {
  readonly state: JellyFixtureState;
  readonly tick: number;
  readonly jitterIndex: 15;
  readonly width: number;
  readonly height: number;
  readonly pngDataUrl: string;
  readonly pose: readonly Point2[];
  readonly diagnostics: JellyDiagnosticReadback;
}

export interface JellyLifecycleSnapshot {
  readonly mounts: number;
  readonly listeners: number;
  readonly resizeObservers: number;
  readonly pendingAnimationFrames: number;
  readonly manualPendingFrames: number;
  readonly rendererAttempts: number;
  readonly renderersCreated: number;
  readonly cumulativeStats: JellyRendererStats;
}

export interface JellyDeviceLossSequence {
  readonly attemptsBefore: number;
  readonly attemptsAfterFirstLoss: number;
  readonly attemptsAfterSecondLoss: number;
}

const parameters = new URLSearchParams(location.search);
const testMode = parameters.get('test') === '1';
const hideWebGpu = testMode && parameters.get('gpu') === 'hidden';
const deferWebGpu = testMode && parameters.get('init') === 'manual';
const diagnosticMode = testMode && parameters.get('diagnostic') === '1';
const fixtureCaptureMode = testMode && parameters.get('fixture') === '1';
document.documentElement.toggleAttribute('data-jelly-fixture', fixtureCaptureMode);
const element = (() => {
  const candidate = document.querySelector<HTMLButtonElement>('#jelly-toggle');
  if (!candidate) throw new Error('Missing jelly toggle button');
  return candidate;
})();

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

  pendingFrames(): number {
    return this.callbacks.size;
  }

  reset(): void {
    if (this.callbacks.size !== 0) throw new Error('Cannot reset a jelly clock with pending frames');
    this.time = 0;
    this.nextHandle = 1;
  }
}

let releaseInitialization = (): void => undefined;
const initializationGate = deferWebGpu
  ? new Promise<void>((resolve) => { releaseInitialization = resolve; })
  : Promise.resolve();
const manualClock = testMode ? new ManualJellyClock() : null;
let testDpr = fixtureCaptureMode ? 2 : window.devicePixelRatio;
let activePhysics: JellyPhysics | undefined;
const rendererOwner = createTestRendererOwner();
const renderers: JellyRenderer[] = [];
const fixtureRandomSources = new WeakMap<JellyRenderer, ResettableJellyRandomSource>();
let rendererAttempts = 0;
let toggle: JellyToggle3D | undefined;
let readyState: JellyToggleReadyState | 'pending' = 'pending';
const lifecycleCounts = {
  mounts: 0,
  listeners: 0,
  resizeObservers: 0,
  pendingAnimationFrames: 0,
};

function aggregateRendererStats(): JellyRendererStats {
  const total = {
    rafRequests: 0,
    submissions: 0,
    pipelinesCreated: 0,
    buffersCreated: 0,
    buffersDestroyed: 0,
    texturesCreated: 0,
    texturesDestroyed: 0,
    uncapturedErrors: 0,
  };
  for (const renderer of renderers) {
    const stats = renderer.stats;
    total.rafRequests += stats.rafRequests;
    total.submissions += stats.submissions;
    total.pipelinesCreated += stats.pipelinesCreated;
    total.buffersCreated += stats.buffersCreated;
    total.buffersDestroyed += stats.buffersDestroyed;
    total.texturesCreated += stats.texturesCreated;
    total.texturesDestroyed += stats.texturesDestroyed;
    total.uncapturedErrors += stats.uncapturedErrors;
  }
  return total;
}

function flushManualClock(limit = 300): void {
  if (!manualClock) throw new Error('The manual jelly clock is unavailable');
  let frames = 0;
  while (manualClock.hasPendingFrame() && frames < limit) {
    manualClock.step(1000 / 60);
    frames += 1;
  }
  if (manualClock.hasPendingFrame()) throw new Error(`Jelly animation remained active after ${limit} frames`);
}

async function prepareLiveFixturePose(
  state: JellyFixtureState,
): Promise<{ readonly renderer: JellyRenderer; readonly fixture: JellyFixturePose }> {
  toggle?.destroy();
  activePhysics = undefined;
  manualClock?.reset();
  const mounted = await mountToggle(false);
  if (mounted !== 'webgpu') throw new Error(`Fixture remount entered ${mounted} mode`);
  flushManualClock();

  const fixture = selectJellyFixturePose(state);
  if (state === 'on') {
    toggle?.setChecked(true, { animate: false });
    flushManualClock();
  } else if (state === 'arch') {
    toggle?.setChecked(true, { animate: true });
    for (let tick = 0; tick < fixture.tick; tick += 1) {
      if (!manualClock?.hasPendingFrame()) {
        throw new Error(`Live arch animation stopped before fixture tick ${fixture.tick}`);
      }
      manualClock.step(1000 / 60);
    }
  }

  const renderer = rendererOwner.active;
  // The runtime callback assigns this during the awaited mount; TypeScript cannot
  // observe that cross-callback mutation after the explicit teardown above.
  const snapshot = (activePhysics as JellyPhysics | undefined)?.snapshot;
  if (!renderer || !snapshot) throw new Error('Fresh fixture component has no accepted renderer');
  verifyAndFreezeJellyFixturePose({
    state,
    fixture,
    snapshot,
    renderer,
    uploadedPose: () => rendererOwner.poseFor(renderer),
  });
  return { renderer, fixture };
}

async function captureFixture(state: JellyFixtureState): Promise<JellyFixtureCapture> {
  if (!diagnosticMode) throw new Error('Diagnostic readback requires the diagnostic fixture route');
  const { renderer, fixture, canvas } = await renderFixtureSamples(state);
  await renderer.device.queue.onSubmittedWorkDone();
  const diagnostics = await renderer.readDiagnostics();
  return {
    state,
    tick: fixture.tick,
    jitterIndex: 15,
    width: diagnostics.width,
    height: diagnostics.height,
    pngDataUrl: canvas.toDataURL('image/png'),
    pose: fixture.pose,
    diagnostics,
  };
}

async function renderFixtureSamples(state: JellyFixtureState): Promise<{
  readonly renderer: JellyRenderer;
  readonly fixture: JellyFixturePose;
  readonly canvas: HTMLCanvasElement;
}> {
  if (!fixtureCaptureMode) throw new Error('Fixture rendering requires the test-gated fixture route');
  const { renderer, fixture } = await prepareLiveFixturePose(state);
  const canvas = element.querySelector<HTMLCanvasElement>('canvas');
  if (!renderer || !canvas || readyState !== 'webgpu') throw new Error('Jelly renderer is not ready');
  assertJellyFixtureSurface({
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    devicePixelRatio: window.devicePixelRatio,
    backingWidth: canvas.width,
    backingHeight: canvas.height,
  });
  const randomSource = fixtureRandomSources.get(renderer);
  if (!randomSource) throw new Error('Fixture renderer has no deterministic random source');
  randomSource.reset();
  renderer.resetHistory();
  for (let jitterIndex = 0; jitterIndex < 16; jitterIndex += 1) {
    renderer.draw({ jitterIndex, historyValid: jitterIndex > 0, diagnostic: diagnosticMode });
  }
  return { renderer, fixture, canvas };
}

async function waitForRenderer(
  predicate: (renderer: JellyRenderer | undefined) => boolean,
  description: string,
): Promise<JellyRenderer | undefined> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const renderer = rendererOwner.active;
    if (predicate(renderer)) return renderer;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function destroyTwoDeviceGenerations(): Promise<JellyDeviceLossSequence> {
  const first = rendererOwner.active;
  if (!first) throw new Error('No accepted WebGPU generation is active');
  const attemptsBefore = rendererAttempts;
  first.device.destroy();
  const second = await waitForRenderer(
    (candidate) => candidate !== undefined && candidate !== first,
    'the first automatic WebGPU replacement',
  );
  if (!second) throw new Error('The first automatic WebGPU replacement was not accepted');
  const attemptsAfterFirstLoss = rendererAttempts;
  if (attemptsAfterFirstLoss !== attemptsBefore + 1) {
    throw new Error('The first device loss did not create exactly one replacement generation');
  }

  second.device.destroy();
  await waitForRenderer((candidate) => candidate !== second, 'the second lost generation teardown');
  for (let task = 0; task < 5; task += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  const attemptsAfterSecondLoss = rendererAttempts;
  if (attemptsAfterSecondLoss !== attemptsAfterFirstLoss) {
    throw new Error('A second automatic WebGPU replacement was created');
  }
  return { attemptsBefore, attemptsAfterFirstLoss, attemptsAfterSecondLoss };
}

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
    rendererAttempts += 1;
    const fixtureRandom = fixtureCaptureMode
      ? createXorshift32(JELLY_FIXTURE_RANDOM_SEED)
      : undefined;
    const renderer = rendererOwner.wrap(await createJellyRenderer(
      canvas,
      diagnosticMode ? 'diagnostic' : 'production',
      fixtureRandom,
    ));
    if (fixtureRandom) fixtureRandomSources.set(renderer, fixtureRandom);
    renderers.push(renderer);
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
    let resizeListenerActive = testMode;
    let resolutionListenerActive = false;
    if (testMode) lifecycleCounts.listeners += 1;
    let resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
    const rearm = (): void => {
      if (testMode) {
        resolutionListenerActive = true;
        lifecycleCounts.listeners += 1;
      }
      resolutionQuery.addEventListener('change', onChange, { once: true, signal });
    };
    const onChange = (): void => {
      if (testMode && resolutionListenerActive) {
        resolutionListenerActive = false;
        lifecycleCounts.listeners -= 1;
      }
      callback();
      if (signal.aborted) return;
      resolutionQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      rearm();
    };
    signal.addEventListener('abort', () => {
      if (testMode && resizeListenerActive) {
        resizeListenerActive = false;
        lifecycleCounts.listeners -= 1;
      }
      if (testMode && resolutionListenerActive) {
        resolutionListenerActive = false;
        lifecycleCounts.listeners -= 1;
      }
    }, { once: true });
    rearm();
  },
  devicePixelRatio: () => testMode ? testDpr : window.devicePixelRatio,
  reportError: (error) => {
    if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
    else console.error(error);
  },
  ...(testMode ? {
    lifecycle: {
      mount: (delta: 1 | -1) => { lifecycleCounts.mounts += delta; },
      listener: (delta: number) => { lifecycleCounts.listeners += delta; },
      resizeObserver: (delta: 1 | -1) => { lifecycleCounts.resizeObservers += delta; },
      animationFrame: (delta: 1 | -1) => { lifecycleCounts.pendingAnimationFrames += delta; },
    },
  } : {}),
};

function mountToggle(checked = false): Promise<JellyToggleReadyState> {
  readyState = 'pending';
  document.documentElement.dataset.jellyReady = 'pending';
  element.setAttribute('aria-checked', String(checked));
  delete element.dataset.jellyToggleFallbackReason;
  const instance = createJellyToggle3DWithRuntime({ element, checked }, runtime);
  toggle = instance;
  void instance.ready.then((state) => {
    if (toggle !== instance) return;
    readyState = state;
    document.documentElement.dataset.jellyReady = state;
  });
  return instance.ready;
}

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
    stats: (): JellyRendererStats | undefined => rendererOwner.active?.stats,
    cumulativeStats: (): JellyRendererStats => aggregateRendererStats(),
    lifecycle: (): JellyLifecycleSnapshot => ({
      ...lifecycleCounts,
      manualPendingFrames: manualClock?.pendingFrames() ?? 0,
      rendererAttempts,
      renderersCreated: renderers.length,
      cumulativeStats: aggregateRendererStats(),
    }),
    flush: (): void => flushManualClock(),
    captureFixture,
    captureFixturePng: async (state: JellyFixtureState): Promise<string> => {
      const { renderer, canvas } = await renderFixtureSamples(state);
      await renderer.device.queue.onSubmittedWorkDone();
      return canvas.toDataURL('image/png');
    },
    setChecked: (checked: boolean, animate = true): void => toggle?.setChecked(checked, { animate }),
    waitForQueue: async (): Promise<void> => rendererOwner.active?.device.queue.onSubmittedWorkDone(),
    destroyTwoDeviceGenerations,
    remount: async (checked = false): Promise<JellyToggleReadyState> => {
      toggle?.destroy();
      activePhysics = undefined;
      return mountToggle(checked);
    },
    destroy: (): void => {
      toggle?.destroy();
      activePhysics = undefined;
    },
  });
  window.__jellyTest = hook;
}

if (testMode) {
  void mountToggle();
} else {
  toggle = createJellyToggle3D({ element });
  void toggle.ready.then((state) => { readyState = state; });
}
