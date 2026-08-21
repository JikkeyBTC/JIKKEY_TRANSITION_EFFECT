import { calculateTextureSize, normalizeOrigin } from './coordinates';
import { WebGLBurnRenderer } from './gl-program';
import { BURN_DURATION_MS, burnProgressAt } from './progress';
import type {
  BurnClock,
  BurnToggleRequest,
  BurnToggleResult,
  BurnTransitionOptions,
  CapturedViewport,
} from './types';

type ActiveState = 'capturing' | 'covering' | 'animating';
type TransitionState = 'preparing' | 'idle' | ActiveState | 'destroyed';
type FallbackReason = Extract<BurnToggleResult, { status: 'fallback' }>['reason'];

class FallbackError extends Error {
  constructor(readonly reason: FallbackReason, cause?: unknown) {
    super(`Burn transition fallback: ${reason}`, { cause });
  }
}

class DestroyedError extends Error {}

interface ActiveInterruption {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
  settled: boolean;
}

type ExternalOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; error: unknown };

const browserClock: BurnClock = {
  now: () => performance.now(),
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
};

const defaultCapture = (): Promise<CapturedViewport> => window.burnCapture.captureViewport();

export class BurnTransition {
  private readonly canvas = document.createElement('canvas');
  private readonly capture: () => Promise<CapturedViewport>;
  private readonly clock: BurnClock;
  private readonly maxBackingPixels: number;
  private readonly respectReducedMotion: boolean;
  private renderer: WebGLBurnRenderer | null = null;
  private state: TransitionState = 'preparing';
  private webglUnavailable = false;
  private resizeEpoch = 0;
  private abortReason: Extract<FallbackReason, 'resize' | 'context-lost'> | null = null;
  private frameHandle: number | null = null;
  private pendingFrameResolve: (() => void) | null = null;
  private activeAnimationResolve: ((result: BurnToggleResult) => void) | null = null;
  private activeInterruption: ActiveInterruption | null = null;
  private readonly preparePromise: Promise<void>;

  constructor(options: BurnTransitionOptions = {}) {
    this.capture = options.capture ?? defaultCapture;
    this.clock = options.clock ?? browserClock;
    this.maxBackingPixels = options.maxBackingPixels ?? 8_294_400;
    this.respectReducedMotion = options.respectReducedMotion ?? false;
    this.canvas.dataset.burnOverlay = '';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.hidden = true;
    Object.assign(this.canvas.style, {
      position: 'fixed',
      inset: '0',
      width: '100vw',
      height: '100vh',
      zIndex: String(options.zIndex ?? 2_147_483_646),
      pointerEvents: 'none',
    });
    document.documentElement.append(this.canvas);
    window.addEventListener('resize', this.handleResize);
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
    this.preparePromise = this.initialize();
  }

  async prepare(): Promise<void> {
    await this.preparePromise;
  }

  async toggle(request: BurnToggleRequest): Promise<BurnToggleResult> {
    if (this.isDestroyed()) return { status: 'ignored', reason: 'destroyed' };
    await this.prepare();
    if (this.isDestroyed()) return { status: 'ignored', reason: 'destroyed' };
    if (this.state !== 'idle') return { status: 'ignored', reason: 'busy' };

    const startEpoch = this.resizeEpoch;
    const interruption = this.beginActiveInterruption();

    if (this.respectReducedMotion
      && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      this.state = 'capturing';
      try {
        await this.awaitExternal(() => request.applyTheme(), startEpoch);
        const interruptedResult = this.activeInterruptionResult(startEpoch);
        if (interruptedResult) return interruptedResult;
        this.state = 'idle';
        return { status: 'completed' };
      } catch (error) {
        const interruptedResult = this.activeInterruptionResult(startEpoch);
        if (interruptedResult) return interruptedResult;
        this.state = 'idle';
        throw error;
      } finally {
        this.clearActiveInterruption(interruption);
        if (!this.isDestroyed()) {
          this.abortReason = null;
          this.state = 'idle';
        }
      }
    }

    let themeInvoked = false;
    let bitmap: ImageBitmap | null = null;
    this.state = 'capturing';
    this.abortReason = null;
    this.blockInteractions();

    try {
      const renderer = this.renderer;
      if (this.webglUnavailable || !renderer) throw new FallbackError('webgl');
      let maximumTextureSize: number;
      try {
        maximumTextureSize = renderer.maximumTextureSize();
        if (!Number.isFinite(maximumTextureSize) || maximumTextureSize < 1) {
          throw new Error('Invalid WebGL maximum texture size');
        }
      } catch (error) {
        throw new FallbackError('webgl', error);
      }

      try {
        const captured = await this.awaitExternal(() => this.capture(), startEpoch);
        this.throwIfAborted(startEpoch);
        const pngBuffer = new ArrayBuffer(captured.png.byteLength);
        new Uint8Array(pngBuffer).set(captured.png);
        bitmap = await this.awaitExternal(
          () => createImageBitmap(new Blob([pngBuffer], { type: 'image/png' })),
          startEpoch,
          (lateBitmap) => { this.closeBitmap(lateBitmap); },
        );
        this.throwIfAborted(startEpoch);
        if (!this.hasValidDimensions(bitmap)
          || !this.hasViewportAspect(bitmap)) {
          throw new Error('Captured PNG dimensions do not match the renderer viewport');
        }
        const textureSize = calculateTextureSize(
          { width: bitmap.width, height: bitmap.height },
          this.maxBackingPixels,
          maximumTextureSize,
        );
        if (textureSize.width !== bitmap.width || textureSize.height !== bitmap.height) {
          const decoded = bitmap;
          bitmap = null;
          try {
            bitmap = await this.awaitExternal(
              () => createImageBitmap(decoded, {
                resizeWidth: textureSize.width,
                resizeHeight: textureSize.height,
                resizeQuality: 'high',
              }),
              startEpoch,
              (lateBitmap) => { this.closeBitmap(lateBitmap); },
            );
          } finally {
            this.closeBitmap(decoded);
          }
          this.throwIfAborted(startEpoch);
        }
        if (!this.hasValidDimensions(bitmap)
          || bitmap.width !== textureSize.width
          || bitmap.height !== textureSize.height
          || !this.hasViewportAspect(bitmap)
          || bitmap.width * bitmap.height > Math.max(1, this.maxBackingPixels)
          || bitmap.width > maximumTextureSize
          || bitmap.height > maximumTextureSize) {
          throw new Error('Resized capture dimensions are invalid for WebGL');
        }
      } catch (error) {
        this.closeBitmap(bitmap);
        bitmap = null;
        this.throwIfAborted(startEpoch);
        if (error instanceof FallbackError || error instanceof DestroyedError) throw error;
        throw new FallbackError('capture', error);
      }

      try {
        renderer.resize(
          { width: bitmap.width, height: bitmap.height },
          1,
          this.maxBackingPixels,
        );
        renderer.setFrame(bitmap);
        renderer.setOrigin(normalizeOrigin(request.origin, {
          width: window.innerWidth,
          height: window.innerHeight,
        }));
        renderer.draw(0, this.clock.now() / 1_000);
        renderer.show();
      } catch (error) {
        throw new FallbackError('webgl', error);
      } finally {
        this.closeBitmap(bitmap);
        bitmap = null;
      }
      this.throwIfAborted(startEpoch);
      this.state = 'covering';

      await this.nextFrame();
      this.throwIfAborted(startEpoch);
      themeInvoked = true;
      await this.awaitExternal(() => request.applyTheme(), startEpoch);
      this.throwIfAborted(startEpoch);
      await this.nextFrame();
      this.throwIfAborted(startEpoch);

      this.state = 'animating';
      const result = await this.animate();
      const interruptedResult = this.activeInterruptionResult(startEpoch);
      this.cleanupFrame();
      if (interruptedResult) return interruptedResult;
      this.state = 'idle';
      return result;
    } catch (error) {
      this.closeBitmap(bitmap);
      if (error instanceof DestroyedError) {
        this.cleanupFrame();
        return { status: 'ignored', reason: 'destroyed' };
      }
      if (!(error instanceof FallbackError)) {
        const interruptedResult = this.activeInterruptionResult(startEpoch);
        this.cleanupFrame();
        if (interruptedResult) return interruptedResult;
        this.state = 'idle';
        throw error;
      }
      if (!themeInvoked) {
        try {
          themeInvoked = true;
          await this.awaitExternal(() => request.applyTheme(), startEpoch);
        } catch (themeError) {
          const interruptedResult = this.activeInterruptionResult(startEpoch);
          this.cleanupFrame();
          if (interruptedResult) return interruptedResult;
          this.state = 'idle';
          throw themeError;
        }
      }
      const result = this.resultAfterFallbackAwait(startEpoch, error.reason);
      this.cleanupFrame();
      if (!this.isDestroyed()) this.state = 'idle';
      return result;
    }
  }

  destroy(): void {
    if (this.state === 'destroyed') return;
    this.state = 'destroyed';
    this.signalActiveInterruption();
    if (this.frameHandle !== null) this.clock.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.pendingFrameResolve?.();
    this.pendingFrameResolve = null;
    this.activeAnimationResolve?.({ status: 'ignored', reason: 'destroyed' });
    this.activeAnimationResolve = null;
    window.removeEventListener('resize', this.handleResize);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    const renderer = this.renderer;
    this.renderer = null;
    try {
      renderer?.destroy();
    } catch (error) {
      console.error('Burn transition renderer teardown failed', error);
    } finally {
      this.hideOverlay();
      this.canvas.remove();
    }
  }

  private async initialize(): Promise<void> {
    try {
      this.renderer = new WebGLBurnRenderer(this.canvas);
      this.renderer.prepare();
    } catch (error) {
      this.webglUnavailable = true;
      console.error('Burn transition WebGL initialization failed', error);
    } finally {
      if (this.state === 'preparing') this.state = 'idle';
    }
  }

  private readonly handleResize = (): void => {
    this.resizeEpoch += 1;
    if (this.isActive()) this.interruptActiveWait('resize');
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.webglUnavailable = true;
    if (this.isActive()) this.interruptActiveWait('context-lost');
  };

  private readonly handleContextRestored = (): void => {
    if (this.state === 'destroyed' || !this.renderer) return;
    try {
      this.renderer.prepare();
      this.webglUnavailable = false;
    } catch (error) {
      this.webglUnavailable = true;
      console.error('Burn transition WebGL restoration failed', error);
    }
  };

  private isActive(): boolean {
    return this.state === 'capturing' || this.state === 'covering' || this.state === 'animating';
  }

  private isDestroyed(): boolean {
    return this.state === 'destroyed';
  }

  private interruptActiveWait(reason: Extract<FallbackReason, 'resize' | 'context-lost'>): void {
    this.abortReason = reason;
    this.signalActiveInterruption();
    if (this.pendingFrameResolve) {
      if (this.frameHandle !== null) this.clock.cancelFrame(this.frameHandle);
      this.frameHandle = null;
      const resolve = this.pendingFrameResolve;
      this.pendingFrameResolve = null;
      resolve();
      return;
    }
    if (this.activeAnimationResolve) {
      if (this.frameHandle !== null) this.clock.cancelFrame(this.frameHandle);
      this.frameHandle = null;
      const resolve = this.activeAnimationResolve;
      this.activeAnimationResolve = null;
      resolve({ status: 'fallback', reason });
    }
  }

  private throwIfAborted(startEpoch: number): void {
    if (this.isDestroyed()) throw new DestroyedError();
    if (this.resizeEpoch !== startEpoch) throw new FallbackError('resize');
    if (this.abortReason) throw new FallbackError(this.abortReason);
  }

  private nextFrame(): Promise<void> {
    return new Promise((resolve) => {
      this.pendingFrameResolve = resolve;
      this.frameHandle = this.clock.requestFrame(() => {
        this.frameHandle = null;
        this.pendingFrameResolve = null;
        resolve();
      });
    });
  }

  private animate(): Promise<BurnToggleResult> {
    const renderer = this.renderer;
    if (!renderer) return Promise.resolve({ status: 'fallback', reason: 'webgl' });
    const startedAt = this.clock.now();
    return new Promise((resolve) => {
      const finish = (result: BurnToggleResult): void => {
        this.activeAnimationResolve = null;
        resolve(result);
      };
      this.activeAnimationResolve = finish;
      const tick: FrameRequestCallback = (now) => {
        this.frameHandle = null;
        if (this.isDestroyed()) {
          finish({ status: 'ignored', reason: 'destroyed' });
          return;
        }
        if (this.abortReason) {
          finish({ status: 'fallback', reason: this.abortReason });
          return;
        }
        const elapsed = Math.max(0, now - startedAt);
        try {
          renderer.draw(burnProgressAt(elapsed), now / 1_000);
        } catch (error) {
          console.error('Burn transition frame rendering failed', error);
          finish({ status: 'fallback', reason: 'webgl' });
          return;
        }
        if (elapsed >= BURN_DURATION_MS) {
          finish({ status: 'completed' });
          return;
        }
        this.frameHandle = this.clock.requestFrame(tick);
      };
      this.frameHandle = this.clock.requestFrame(tick);
    });
  }

  private cleanupFrame(): void {
    if (this.frameHandle !== null) this.clock.cancelFrame(this.frameHandle);
    this.frameHandle = null;
    this.pendingFrameResolve = null;
    this.activeAnimationResolve = null;
    this.renderer?.hide();
    this.renderer?.releaseFrame();
    this.hideOverlay();
    this.abortReason = null;
    this.activeInterruption = null;
  }

  private resultAfterFallbackAwait(
    startEpoch: number,
    originalReason: FallbackReason,
  ): BurnToggleResult {
    const interruptedResult = this.activeInterruptionResult(startEpoch);
    if (interruptedResult) return interruptedResult;
    return { status: 'fallback', reason: originalReason };
  }

  private activeInterruptionResult(startEpoch: number): BurnToggleResult | null {
    if (this.isDestroyed()) return { status: 'ignored', reason: 'destroyed' };
    if (this.resizeEpoch !== startEpoch) return { status: 'fallback', reason: 'resize' };
    if (this.abortReason) return { status: 'fallback', reason: this.abortReason };
    return null;
  }

  private blockInteractions(): void {
    this.canvas.hidden = false;
    this.canvas.style.pointerEvents = 'auto';
  }

  private hideOverlay(): void {
    this.canvas.hidden = true;
    this.canvas.style.pointerEvents = 'none';
  }

  private closeBitmap(bitmap: ImageBitmap | null): void {
    bitmap?.close();
  }

  private beginActiveInterruption(): ActiveInterruption {
    let wake!: () => void;
    const interruption: ActiveInterruption = {
      promise: new Promise<void>((resolve) => { wake = resolve; }),
      resolve: () => { wake(); },
      settled: false,
    };
    this.activeInterruption = interruption;
    return interruption;
  }

  private signalActiveInterruption(): void {
    const interruption = this.activeInterruption;
    if (!interruption || interruption.settled) return;
    interruption.settled = true;
    interruption.resolve();
  }

  private clearActiveInterruption(interruption: ActiveInterruption): void {
    if (this.activeInterruption === interruption) this.activeInterruption = null;
  }

  private async awaitExternal<T>(
    operation: () => T | PromiseLike<T>,
    startEpoch: number,
    disposeLateValue?: (value: T) => void,
  ): Promise<T> {
    let operationValue: T | PromiseLike<T>;
    try {
      operationValue = operation();
    } catch (error) {
      this.throwIfAborted(startEpoch);
      throw error;
    }
    if ((typeof operationValue !== 'object' && typeof operationValue !== 'function')
      || operationValue === null
      || typeof (operationValue as PromiseLike<T>).then !== 'function') {
      this.throwIfAborted(startEpoch);
      return operationValue as T;
    }

    const operationPromise = Promise.resolve(operationValue);

    const outcomePromise: Promise<ExternalOutcome<T>> = operationPromise.then(
      (value) => ({ status: 'fulfilled', value }),
      (error: unknown) => ({ status: 'rejected', error }),
    );
    const interruption = this.activeInterruption;
    if (!interruption) {
      const outcome = await outcomePromise;
      if (outcome.status === 'rejected') throw outcome.error;
      return outcome.value;
    }

    const raced = await Promise.race([
      outcomePromise.then((outcome) => ({ status: 'operation' as const, outcome })),
      interruption.promise.then(() => ({ status: 'interrupted' as const })),
    ]);

    if (raced.status === 'interrupted') {
      void outcomePromise.then((lateOutcome) => {
        if (lateOutcome.status === 'fulfilled' && disposeLateValue) {
          try {
            disposeLateValue(lateOutcome.value);
          } catch (error) {
            console.error('Burn transition late bitmap cleanup failed', error);
          }
        }
      });
      this.throwIfAborted(startEpoch);
      throw new DestroyedError();
    }

    const interruptedResult = this.activeInterruptionResult(startEpoch);
    if (interruptedResult) {
      if (raced.outcome.status === 'fulfilled' && disposeLateValue) {
        disposeLateValue(raced.outcome.value);
      }
      this.throwIfAborted(startEpoch);
    }
    if (raced.outcome.status === 'rejected') throw raced.outcome.error;
    return raced.outcome.value;
  }

  private hasValidDimensions(bitmap: ImageBitmap): boolean {
    return Number.isFinite(bitmap.width)
      && Number.isFinite(bitmap.height)
      && bitmap.width > 0
      && bitmap.height > 0;
  }

  private hasViewportAspect(bitmap: ImageBitmap): boolean {
    const viewportAspect = window.innerWidth / Math.max(window.innerHeight, 1);
    const bitmapAspect = bitmap.width / bitmap.height;
    return Number.isFinite(bitmapAspect)
      && Number.isFinite(viewportAspect)
      && viewportAspect > 0
      && Math.abs(bitmapAspect / viewportAspect - 1) <= 0.02;
  }
}
