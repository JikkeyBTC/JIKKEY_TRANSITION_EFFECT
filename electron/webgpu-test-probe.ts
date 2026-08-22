export interface WebGpuProbeSnapshot {
  readonly requestAdapter: number;
  readonly canvasContext: number;
  readonly queueSubmit: number;
}

export interface WebGpuDebugger {
  isAttached(): boolean;
  attach(protocolVersion?: string): void;
  sendCommand(method: string, commandParameters?: Record<string, unknown>): Promise<unknown>;
  detach(): void;
}

export interface WebGpuProbeTarget {
  readonly debugger: WebGpuDebugger;
}

export interface WebGpuProbeBootstrapTarget extends WebGpuProbeTarget {
  loadURL(url: string): Promise<void>;
}

export interface WebGpuTestProbe {
  snapshot(): Promise<WebGpuProbeSnapshot>;
  detach(): void;
}

const PROBE_SYMBOL_KEY = 'jikkey.webgpu-test-probe';

export const WEBGPU_PROBE_INJECTED_SOURCE = String.raw`(() => {
  const probeKey = Symbol.for('${PROBE_SYMBOL_KEY}');
  if (globalThis[probeKey]) return;

  const counts = { requestAdapter: 0, canvasContext: 0, queueSubmit: 0 };
  const wrapMethod = (target, method, countCall) => {
    if (!target) return;
    let owner = target;
    while (owner && !Object.prototype.hasOwnProperty.call(owner, method)) {
      owner = Object.getPrototypeOf(owner);
    }
    if (!owner) return;
    const descriptor = Object.getOwnPropertyDescriptor(owner, method);
    if (!descriptor || typeof descriptor.value !== 'function') return;
    const original = descriptor.value;
    Object.defineProperty(owner, method, {
      ...descriptor,
      value: function (...args) {
        countCall(args);
        return Reflect.apply(original, this, args);
      },
    });
  };

  let gpu;
  try {
    gpu = globalThis.navigator && globalThis.navigator.gpu;
  } catch {
    gpu = undefined;
  }
  wrapMethod(gpu, 'requestAdapter', () => { counts.requestAdapter += 1; });
  wrapMethod(globalThis.HTMLCanvasElement && globalThis.HTMLCanvasElement.prototype, 'getContext', (args) => {
    if (args[0] === 'webgpu') counts.canvasContext += 1;
  });
  wrapMethod(globalThis.GPUQueue && globalThis.GPUQueue.prototype, 'submit', () => {
    counts.queueSubmit += 1;
  });

  Object.defineProperty(globalThis, probeKey, {
    configurable: false,
    enumerable: false,
    value: Object.freeze({
      snapshot: () => ({
        requestAdapter: counts.requestAdapter,
        canvasContext: counts.canvasContext,
        queueSubmit: counts.queueSubmit,
      }),
    }),
    writable: false,
  });
})();`;

const WEBGPU_PROBE_SNAPSHOT_EXPRESSION = `(() => {
  const probe = globalThis[Symbol.for(${JSON.stringify(PROBE_SYMBOL_KEY)})];
  return probe && typeof probe.snapshot === 'function' ? probe.snapshot() : null;
})()`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCounter(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export async function evaluateWebGpuProbeSnapshot(
  electronDebugger: WebGpuDebugger,
): Promise<WebGpuProbeSnapshot> {
  const response = await electronDebugger.sendCommand('Runtime.evaluate', {
    expression: WEBGPU_PROBE_SNAPSHOT_EXPRESSION,
    returnByValue: true,
    awaitPromise: false,
  });
  if (!isRecord(response) || response.exceptionDetails !== undefined) {
    throw new Error('Unable to evaluate WebGPU probe snapshot');
  }
  const remoteResult = response.result;
  const value = isRecord(remoteResult) ? remoteResult.value : undefined;
  if (
    !isRecord(value)
    || !isCounter(value.requestAdapter)
    || !isCounter(value.canvasContext)
    || !isCounter(value.queueSubmit)
  ) {
    throw new Error('Invalid WebGPU probe snapshot');
  }
  return {
    requestAdapter: value.requestAdapter,
    canvasContext: value.canvasContext,
    queueSubmit: value.queueSubmit,
  };
}

export async function attachWebGpuTestProbe(
  target: WebGpuProbeTarget,
): Promise<WebGpuTestProbe> {
  const electronDebugger = target.debugger;
  if (electronDebugger.isAttached()) {
    throw new Error('Cannot attach WebGPU probe: debugger is already attached');
  }

  electronDebugger.attach('1.3');
  try {
    await electronDebugger.sendCommand('Page.enable');
    await electronDebugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', {
      source: WEBGPU_PROBE_INJECTED_SOURCE,
    });
  } catch (error) {
    if (electronDebugger.isAttached()) electronDebugger.detach();
    throw error;
  }

  let detached = false;
  return {
    snapshot: async () => {
      if (detached || !electronDebugger.isAttached()) {
        throw new Error('WebGPU probe is detached');
      }
      return evaluateWebGpuProbeSnapshot(electronDebugger);
    },
    detach: () => {
      if (detached) return;
      detached = true;
      if (electronDebugger.isAttached()) electronDebugger.detach();
    },
  };
}

/**
 * Materializes the renderer Page domain before debugger setup, while keeping
 * the probe installed before the first product document navigation.
 */
export async function bootstrapAndAttachWebGpuTestProbe(
  target: WebGpuProbeBootstrapTarget,
): Promise<WebGpuTestProbe> {
  await target.loadURL('about:blank');
  return attachWebGpuTestProbe(target);
}
