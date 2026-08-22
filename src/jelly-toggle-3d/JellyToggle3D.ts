import { createJellyPhysics, type JellyPhysics, type JellyTarget } from './physics';
import { createJellyRenderer, type JellyRenderer } from './renderer';
import { createTaaState, type TaaState } from './taa';

const CANVAS_CSS_WIDTH = 88;
const CANVAS_CSS_HEIGHT = 44;

export type JellyToggleReadyState = 'webgpu' | 'fallback' | 'destroyed';

export interface JellyToggle3DOptions {
  element: HTMLButtonElement;
  checked?: boolean;
  label?: string;
  respectReducedMotion?: boolean;
  onChange?: (checked: boolean) => void;
}

export interface JellyToggle3D {
  readonly ready: Promise<JellyToggleReadyState>;
  readonly checked: boolean;
  setChecked(checked: boolean, options?: { animate?: boolean }): void;
  redraw(): void;
  retryWebGPU(): Promise<JellyToggleReadyState>;
  destroy(): void;
}

/** Internal dependency boundary used by the lifecycle tests. Not re-exported publicly. */
export interface JellyToggleRuntime {
  createRenderer(canvas: HTMLCanvasElement): Promise<JellyRenderer>;
  createPhysics(target: JellyTarget): JellyPhysics;
  createTaa(): TaaState;
  requestAnimationFrame(callback: FrameRequestCallback): number;
  cancelAnimationFrame(handle: number): void;
  createResizeObserver(callback: ResizeObserverCallback): Pick<ResizeObserver, 'observe' | 'disconnect'>;
  matchMedia(query: string): Pick<MediaQueryList, 'matches' | 'addEventListener' | 'removeEventListener'>;
  devicePixelRatio(): number;
  reportError(error: unknown): void;
}

type RenderMode = 'initializing' | 'webgpu' | 'fallback' | 'destroyed';

function defaultRuntime(): JellyToggleRuntime {
  return {
    createRenderer: (canvas) => createJellyRenderer(canvas),
    createPhysics: (target) => createJellyPhysics(target),
    createTaa: () => createTaaState(),
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
    createResizeObserver: (callback) => new ResizeObserver(callback),
    matchMedia: (query) => window.matchMedia(query),
    devicePixelRatio: () => window.devicePixelRatio,
    reportError: (error) => {
      if (typeof globalThis.reportError === 'function') globalThis.reportError(error);
      else console.error(error);
    },
  };
}

export function createJellyToggle3DWithRuntime(
  options: JellyToggle3DOptions,
  runtime: JellyToggleRuntime,
): JellyToggle3D {
  const { element } = options;
  let semanticChecked = options.checked ?? element.getAttribute('aria-checked') === 'true';
  let semanticRevision = 0;
  let mode: RenderMode = 'initializing';
  let lifecycleGeneration = 0;
  let deviceGeneration = 0;
  let destroyed = false;
  let renderer: JellyRenderer | null = null;
  let physics = runtime.createPhysics(targetFor(semanticChecked));
  let taa = runtime.createTaa();
  let rafId: number | null = null;
  let lastFrameTime: number | null = null;
  let jitterIndex = 0;
  let pendingAttempt: Promise<JellyToggleReadyState> | null = null;
  let automaticLossRetryUsed = false;
  let lastDpr = finiteDpr(runtime.devicePixelRatio());

  const abortController = new AbortController();
  const reducedQuery = runtime.matchMedia('(prefers-reduced-motion: reduce)');
  const forcedQuery = runtime.matchMedia('(forced-colors: active)');
  let reducedMotion = options.respectReducedMotion !== false && reducedQuery.matches;
  let forcedColors = forcedQuery.matches;

  element.type = 'button';
  element.classList.add('jelly-toggle-3d');
  element.setAttribute('role', 'switch');
  element.setAttribute(
    'aria-label',
    options.label ?? element.getAttribute('aria-label') ?? 'Jelly toggle',
  );
  element.setAttribute('aria-checked', String(semanticChecked));
  element.removeAttribute('aria-pressed');

  const canvas = document.createElement('canvas');
  canvas.className = 'jelly-toggle-3d__canvas';
  canvas.setAttribute('aria-hidden', 'true');
  const fallback = document.createElement('span');
  fallback.className = 'jelly-toggle-3d__fallback';
  fallback.setAttribute('aria-hidden', 'true');
  element.append(canvas, fallback);

  let resolveReady!: (state: JellyToggleReadyState) => void;
  let readySettled = false;
  const ready = new Promise<JellyToggleReadyState>((resolve) => { resolveReady = resolve; });

  const report = (error: unknown): void => {
    try { runtime.reportError(error); } catch { /* Consumer reporting must never break ownership cleanup. */ }
  };

  const safely = (action: () => void): void => {
    try { action(); } catch (error) { report(error); }
  };

  const settleReady = (state: JellyToggleReadyState): void => {
    if (readySettled) return;
    readySettled = true;
    resolveReady(state);
  };

  const showCurrentMode = (): void => {
    const showGpu = mode === 'webgpu' && !forcedColors;
    canvas.hidden = !showGpu;
    fallback.hidden = showGpu;
    element.dataset.jellyToggleMode = showGpu ? 'webgpu' : mode === 'destroyed' ? 'destroyed' : 'fallback';
  };
  showCurrentMode();

  const cancelFrame = (): void => {
    if (rafId === null) return;
    const ownedId = rafId;
    rafId = null;
    lastFrameTime = null;
    safely(() => runtime.cancelAnimationFrame(ownedId));
  };

  const failCurrentRenderer = (failed: JellyRenderer, generation: number, error: unknown): void => {
    report(error);
    if (renderer !== failed || deviceGeneration !== generation || destroyed) return;
    deviceGeneration += 1;
    renderer = null;
    mode = 'fallback';
    cancelFrame();
    safely(() => failed.destroy());
    showCurrentMode();
  };

  const size = (): readonly [number, number] => {
    const bounds = canvas.getBoundingClientRect();
    return [bounds.width || CANVAS_CSS_WIDTH, bounds.height || CANVAS_CSS_HEIGHT];
  };

  const resizeRenderer = (active: JellyRenderer, generation: number): boolean => {
    if (destroyed || renderer !== active || deviceGeneration !== generation || mode !== 'webgpu') return false;
    const [width, height] = size();
    const dpr = finiteDpr(runtime.devicePixelRatio());
    try {
      const changed = active.resize(width, height, dpr);
      if (destroyed || renderer !== active || deviceGeneration !== generation || mode !== 'webgpu') return false;
      lastDpr = dpr;
      return changed;
    } catch (error) {
      failCurrentRenderer(active, generation, error);
      return false;
    }
  };

  const scheduleFrame = (): void => {
    if (destroyed || mode !== 'webgpu' || forcedColors || !renderer || rafId !== null) return;
    const lifecycle = lifecycleGeneration;
    const device = deviceGeneration;
    let callbackRanSynchronously = false;
    rafId = -1;
    try {
      const nextId = runtime.requestAnimationFrame((timestamp) => {
        callbackRanSynchronously = true;
        rafId = null;
        if (destroyed || lifecycle !== lifecycleGeneration || device !== deviceGeneration) return;
        runFrame(timestamp, lifecycle, device);
      });
      if (!callbackRanSynchronously) rafId = nextId;
    } catch (error) {
      rafId = null;
      report(error);
    }
  };

  const runFrame = (timestamp: number, lifecycle: number, device: number): void => {
    const active = renderer;
    if (
      destroyed || lifecycle !== lifecycleGeneration || device !== deviceGeneration
      || mode !== 'webgpu' || forcedColors || !active
    ) return;

    if (finiteDpr(runtime.devicePixelRatio()) !== lastDpr) {
      const resized = resizeRenderer(active, device);
      if (mode !== 'webgpu') return;
      if (resized) {
        try { active.resetHistory(); } catch (error) {
          failCurrentRenderer(active, device, error);
          return;
        }
        taa.invalidate();
      }
    }

    const elapsed = lastFrameTime === null
      ? 1 / 60
      : Math.max(0, (timestamp - lastFrameTime) / 1000);
    lastFrameTime = timestamp;
    const ticks = physics.advance(elapsed);
    const snapshot = physics.snapshot;

    try {
      if (ticks > 0) {
        if (snapshot.settled) {
          active.setPose(snapshot.current, true);
          taa.invalidate();
        } else {
          active.setPose(snapshot.display, false);
          const sample = taa.consumeStationarySample();
          taa.noteMotion();
          active.draw({ jitterIndex: jitterIndex++, historyValid: sample.historyValid });
        }
      }

      if (snapshot.settled && taa.needsSample) {
        const sample = taa.consumeStationarySample();
        active.draw({ jitterIndex: jitterIndex++, historyValid: sample.historyValid });
      }
    } catch (error) {
      failCurrentRenderer(active, device, error);
      return;
    }

    if (destroyed || lifecycle !== lifecycleGeneration || device !== deviceGeneration) return;
    if (!physics.snapshot.settled || taa.needsSample) scheduleFrame();
    else lastFrameTime = null;
  };

  const uploadCanonical = (): void => {
    const active = renderer;
    const device = deviceGeneration;
    if (!active || mode !== 'webgpu' || forcedColors || destroyed) return;
    try {
      active.setPose(physics.snapshot.current, true);
      active.resetHistory();
      taa.invalidate();
      lastFrameTime = null;
      scheduleFrame();
    } catch (error) {
      failCurrentRenderer(active, device, error);
    }
  };

  const applyVisualTarget = (next: boolean, animate = true): void => {
    if (destroyed) return;
    const target = targetFor(next);
    if (!animate || reducedMotion || forcedColors) {
      physics.snap(target);
      uploadCanonical();
      return;
    }
    if (!physics.setTarget(target)) return;
    if (mode === 'webgpu' && !forcedColors) {
      taa.noteMotion();
      lastFrameTime = null;
      scheduleFrame();
    }
  };

  const setSemantic = (next: boolean, notify: boolean, animate = true): void => {
    if (destroyed || next === semanticChecked) return;
    semanticChecked = next;
    semanticRevision += 1;
    const ownRevision = semanticRevision;
    element.setAttribute('aria-checked', String(next));
    if (notify && options.onChange) {
      try { options.onChange(next); } catch (error) { report(error); }
    }
    if (destroyed || ownRevision !== semanticRevision) return;
    applyVisualTarget(next, animate);
  };

  const onClick = (): void => {
    if (destroyed || element.disabled) return;
    setSemantic(!semanticChecked, true, true);
  };

  const onReducedMotion = (event: Event): void => {
    if (destroyed || options.respectReducedMotion === false) return;
    const next = (event as MediaQueryListEvent).matches;
    if (next === reducedMotion) return;
    reducedMotion = next;
    if (!next) return;
    physics.snap(targetFor(semanticChecked));
    uploadCanonical();
  };

  const onForcedColors = (event: Event): void => {
    if (destroyed) return;
    const next = (event as MediaQueryListEvent).matches;
    if (next === forcedColors) return;
    forcedColors = next;
    if (forcedColors) {
      cancelFrame();
      physics.snap(targetFor(semanticChecked));
      showCurrentMode();
      return;
    }
    showCurrentMode();
    uploadCanonical();
  };

  element.addEventListener('click', onClick, { signal: abortController.signal });
  reducedQuery.addEventListener('change', onReducedMotion as EventListener, {
    signal: abortController.signal,
  });
  forcedQuery.addEventListener('change', onForcedColors as EventListener, {
    signal: abortController.signal,
  });

  const resizeObserver = runtime.createResizeObserver(() => {
    if (destroyed || mode !== 'webgpu' || forcedColors) return;
    api.redraw();
  });
  resizeObserver.observe(canvas);

  const handleDeviceLoss = (lostRenderer: JellyRenderer, generation: number): void => {
    if (destroyed || renderer !== lostRenderer || deviceGeneration !== generation) return;
    deviceGeneration += 1;
    renderer = null;
    mode = 'fallback';
    cancelFrame();
    safely(() => lostRenderer.destroy());
    showCurrentMode();
    if (!automaticLossRetryUsed) {
      automaticLossRetryUsed = true;
      const settlingAttempt = pendingAttempt;
      if (settlingAttempt) {
        void settlingAttempt.then(startLossRecovery, startLossRecovery);
      } else {
        void beginAttempt();
      }
    }
  };

  const startLossRecovery = (): void => {
    if (!destroyed && mode === 'fallback' && renderer === null) void beginAttempt();
  };

  const runAttempt = async (): Promise<JellyToggleReadyState> => {
    if (destroyed) return 'destroyed';
    const lifecycle = lifecycleGeneration;
    const generation = ++deviceGeneration;
    mode = 'initializing';
    cancelFrame();
    showCurrentMode();

    let acquired: JellyRenderer;
    try {
      acquired = await runtime.createRenderer(canvas);
    } catch {
      if (destroyed || lifecycle !== lifecycleGeneration || generation !== deviceGeneration) {
        return destroyed ? 'destroyed' : 'fallback';
      }
      mode = 'fallback';
      showCurrentMode();
      return 'fallback';
    }

    if (destroyed || lifecycle !== lifecycleGeneration || generation !== deviceGeneration) {
      safely(() => acquired.destroy());
      return destroyed ? 'destroyed' : 'fallback';
    }

    renderer = acquired;
    try {
      physics = runtime.createPhysics(targetFor(semanticChecked));
      taa = runtime.createTaa();
      jitterIndex = 0;
      mode = 'webgpu';
      const [width, height] = size();
      lastDpr = finiteDpr(runtime.devicePixelRatio());
      acquired.resize(width, height, lastDpr);
      acquired.setPose(physics.snapshot.current, true);
      acquired.resetHistory();
      taa.invalidate();
    } catch (error) {
      failCurrentRenderer(acquired, generation, error);
      return 'fallback';
    }

    acquired.lost.then(
      () => handleDeviceLoss(acquired, generation),
      (error) => failCurrentRenderer(acquired, generation, error),
    );
    showCurrentMode();
    if (!forcedColors) scheduleFrame();
    return 'webgpu';
  };

  function beginAttempt(): Promise<JellyToggleReadyState> {
    if (destroyed) return Promise.resolve('destroyed');
    if (pendingAttempt) return pendingAttempt;
    if (mode === 'webgpu' && renderer) return Promise.resolve('webgpu');
    const attempt = runAttempt();
    pendingAttempt = attempt;
    const clearAttempt = (): void => {
      if (pendingAttempt === attempt) pendingAttempt = null;
    };
    void attempt.then(clearAttempt, clearAttempt);
    return attempt;
  }

  const api: JellyToggle3D = {
    ready,
    get checked() { return semanticChecked; },
    setChecked(next, setOptions) {
      setSemantic(Boolean(next), false, setOptions?.animate !== false);
    },
    redraw() {
      if (destroyed || mode !== 'webgpu' || forcedColors || !renderer) return;
      const active = renderer;
      const generation = deviceGeneration;
      if (!resizeRenderer(active, generation) && mode !== 'webgpu') return;
      try {
        active.setPose(
          physics.snapshot.settled ? physics.snapshot.current : physics.snapshot.display,
          false,
        );
        active.resetHistory();
        taa.invalidate();
        lastFrameTime = null;
        scheduleFrame();
      } catch (error) {
        failCurrentRenderer(active, generation, error);
      }
    },
    retryWebGPU() {
      if (destroyed) return Promise.resolve('destroyed');
      return beginAttempt();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      mode = 'destroyed';
      lifecycleGeneration += 1;
      deviceGeneration += 1;
      semanticRevision += 1;
      safely(() => reducedQuery.removeEventListener('change', onReducedMotion as EventListener));
      safely(() => forcedQuery.removeEventListener('change', onForcedColors as EventListener));
      abortController.abort();
      cancelFrame();
      safely(() => resizeObserver.disconnect());
      const ownedRenderer = renderer;
      renderer = null;
      if (ownedRenderer) safely(() => ownedRenderer.destroy());
      canvas.remove();
      fallback.remove();
      showCurrentMode();
      settleReady('destroyed');
    },
  };

  void beginAttempt().then(settleReady, () => settleReady(destroyed ? 'destroyed' : 'fallback'));
  return api;
}

function targetFor(checked: boolean): JellyTarget {
  return checked ? 'on' : 'off';
}

function finiteDpr(value: number): number {
  return Number.isFinite(value) ? Math.min(3, Math.max(1, value)) : 1;
}

export function createJellyToggle3D(options: JellyToggle3DOptions): JellyToggle3D {
  return createJellyToggle3DWithRuntime(options, defaultRuntime());
}
