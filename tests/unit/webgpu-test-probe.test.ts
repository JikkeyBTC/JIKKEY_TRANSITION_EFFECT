import { describe, expect, it } from 'vitest';
import { createContext, runInContext } from 'node:vm';
import {
  WEBGPU_PROBE_INJECTED_SOURCE,
  attachWebGpuTestProbe,
  bootstrapAndAttachWebGpuTestProbe,
  evaluateWebGpuProbeSnapshot,
  type WebGpuDebugger,
} from '../../electron/webgpu-test-probe';

class FakeDebugger implements WebGpuDebugger {
  readonly calls: string[] = [];
  attached = false;
  result: unknown = { requestAdapter: 2, canvasContext: 3, queueSubmit: 4 };

  isAttached(): boolean {
    return this.attached;
  }

  attach(version?: string): void {
    this.calls.push(`attach:${version}`);
    this.attached = true;
  }

  async sendCommand(method: string, parameters?: Record<string, unknown>): Promise<unknown> {
    this.calls.push(method);
    if (method === 'Page.addScriptToEvaluateOnNewDocument') {
      expect(parameters).toEqual({ source: WEBGPU_PROBE_INJECTED_SOURCE });
    }
    if (method === 'Runtime.evaluate') {
      return { result: { value: this.result } };
    }
    return {};
  }

  detach(): void {
    this.calls.push('detach');
    this.attached = false;
  }
}

describe('Electron WebGPU test probe', () => {
  it('loads one hidden about:blank document before attaching the pre-navigation probe', async () => {
    const electronDebugger = new FakeDebugger();
    const calls = electronDebugger.calls;
    const target = {
      debugger: electronDebugger,
      async loadURL(url: string) {
        calls.push(`loadURL:${url}`);
      },
    };

    const probe = await bootstrapAndAttachWebGpuTestProbe(target);

    expect(calls).toEqual([
      'loadURL:about:blank',
      'attach:1.3',
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
    ]);
    probe.detach();
  });

  it('attaches and finishes both Page setup commands before resolving to the caller', async () => {
    const electronDebugger = new FakeDebugger();

    const probe = await attachWebGpuTestProbe({ debugger: electronDebugger });

    expect(electronDebugger.calls).toEqual([
      'attach:1.3',
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
    ]);
    probe.detach();
    probe.detach();
    expect(electronDebugger.calls.filter((call) => call === 'detach')).toHaveLength(1);
  });

  it('detaches when setup fails after attaching', async () => {
    const electronDebugger = new FakeDebugger();
    electronDebugger.sendCommand = async (method: string) => {
      electronDebugger.calls.push(method);
      throw new Error('CDP setup failed');
    };

    await expect(attachWebGpuTestProbe({ debugger: electronDebugger })).rejects.toThrow('CDP setup failed');
    expect(electronDebugger.calls).toEqual(['attach:1.3', 'Page.enable', 'detach']);
  });

  it('evaluates and validates a by-value snapshot', async () => {
    const electronDebugger = new FakeDebugger();
    electronDebugger.attached = true;

    await expect(evaluateWebGpuProbeSnapshot(electronDebugger)).resolves.toEqual({
      requestAdapter: 2,
      canvasContext: 3,
      queueSubmit: 4,
    });

    electronDebugger.result = { requestAdapter: -1, canvasContext: 0, queueSubmit: 0 };
    await expect(evaluateWebGpuProbeSnapshot(electronDebugger)).rejects.toThrow('Invalid WebGPU probe snapshot');
  });

  it('counts only WebGPU calls while preserving receivers, arguments, and return values', async () => {
    const adapterResult = Promise.resolve({ adapter: true });
    const contextResult = { context: true };
    const submitResult = { submitted: true };
    const received: unknown[][] = [];
    const gpu = {
      requestAdapter(...arguments_: unknown[]) {
        expect(this).toBe(gpu);
        received.push(arguments_);
        return adapterResult;
      },
    };
    class HTMLCanvasElement {
      getContext(...arguments_: unknown[]) {
        expect(this).toBe(canvas);
        received.push(arguments_);
        return contextResult;
      }
    }
    class GPUQueue {
      submit(...arguments_: unknown[]) {
        expect(this).toBe(queue);
        received.push(arguments_);
        return submitResult;
      }
    }
    const canvas = new HTMLCanvasElement();
    const queue = new GPUQueue();
    const context = createContext({ navigator: { gpu }, HTMLCanvasElement, GPUQueue, Symbol, Reflect, Object });
    runInContext(WEBGPU_PROBE_INJECTED_SOURCE, context);

    expect(gpu.requestAdapter({ powerPreference: 'high-performance' })).toBe(adapterResult);
    expect(canvas.getContext('2d', { alpha: false })).toBe(contextResult);
    expect(canvas.getContext('webgpu', { alphaMode: 'premultiplied' })).toBe(contextResult);
    expect(queue.submit(['commands'])).toBe(submitResult);

    const snapshot = await runInContext(
      'globalThis[Symbol.for("jikkey.webgpu-test-probe")].snapshot()',
      context,
    );
    expect(snapshot).toEqual({ requestAdapter: 1, canvasContext: 1, queueSubmit: 1 });
    expect(received).toEqual([
      [{ powerPreference: 'high-performance' }],
      ['2d', { alpha: false }],
      ['webgpu', { alphaMode: 'premultiplied' }],
      [['commands']],
    ]);
  });
});
