import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CANONICAL_POSES } from '../../src/jelly-toggle-3d/physics-fixtures';
import {
  createJellyRenderer,
  JellyRendererError,
} from '../../src/jelly-toggle-3d/renderer';

type TextureSize = Readonly<{ width: number; height: number; depthOrArrayLayers: number }>;

class FakeBuffer {
  readonly bytes: Uint8Array;
  destroyed = false;
  mapState: GPUBufferMapState = 'unmapped';
  lastWriteSize = 0;

  constructor(
    readonly descriptor: GPUBufferDescriptor,
    private readonly onDestroy: () => void,
  ) {
    this.bytes = new Uint8Array(Number(descriptor.size));
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onDestroy();
  }

  async mapAsync(): Promise<void> {
    this.mapState = 'mapped';
  }

  getMappedRange(offset = 0, size = this.bytes.byteLength - offset): ArrayBuffer {
    return this.bytes.slice(offset, offset + size).buffer as ArrayBuffer;
  }

  unmap(): void {
    this.mapState = 'unmapped';
  }
}

class FakeTexture {
  destroyed = false;
  readonly size: TextureSize;

  constructor(
    readonly descriptor: GPUTextureDescriptor,
    private readonly onDestroy: () => void,
  ) {
    const raw = descriptor.size;
    this.size = Symbol.iterator in Object(raw)
      ? {
          width: Number([...raw as Iterable<number>][0] ?? 1),
          height: Number([...raw as Iterable<number>][1] ?? 1),
          depthOrArrayLayers: Number([...raw as Iterable<number>][2] ?? 1),
        }
      : {
          width: Number((raw as GPUExtent3DDict).width),
          height: Number((raw as GPUExtent3DDict).height ?? 1),
          depthOrArrayLayers: Number((raw as GPUExtent3DDict).depthOrArrayLayers ?? 1),
        };
  }

  createView(descriptor?: GPUTextureViewDescriptor): GPUTextureView {
    return { descriptor, texture: this } as unknown as GPUTextureView;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.onDestroy();
  }
}

interface FakeGpuHarness {
  readonly device: GPUDevice;
  readonly context: GPUCanvasContext;
  readonly buffers: FakeBuffer[];
  readonly textures: FakeTexture[];
  readonly poseWriteSizes: number[];
  readonly pipelineCount: number;
  readonly submissions: number;
  readonly configuredFormat: GPUTextureFormat | undefined;
  failNextWrite: boolean;
  emitUncaptured(error: Error): void;
}

function sourceBytes(data: AllowSharedBufferSource, dataOffset = 0, size?: number): Uint8Array {
  const view = ArrayBuffer.isView(data)
    ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : new Uint8Array(data);
  return view.subarray(dataOffset, size === undefined ? undefined : dataOffset + size);
}

function createFakeGpu(): FakeGpuHarness {
  const buffers: FakeBuffer[] = [];
  const textures: FakeTexture[] = [];
  const poseWriteSizes: number[] = [];
  const listeners = new Set<(event: GPUUncapturedErrorEvent) => void>();
  let pipelineCount = 0;
  let submissions = 0;
  let configuredFormat: GPUTextureFormat | undefined;
  let destroyedBuffers = 0;
  let destroyedTextures = 0;

  const pass = {
    setPipeline: () => undefined,
    setBindGroup: () => undefined,
    setVertexBuffer: () => undefined,
    setIndexBuffer: () => undefined,
    setViewport: () => undefined,
    setScissorRect: () => undefined,
    setBlendConstant: () => undefined,
    setStencilReference: () => undefined,
    dispatchWorkgroups: () => undefined,
    draw: () => undefined,
    drawIndexed: () => undefined,
    end: () => undefined,
  };
  const makePipeline = () => ({ getBindGroupLayout: () => ({}) });

  const queue = {
    submit: () => {
      submissions += 1;
    },
    writeBuffer: (
      buffer: FakeBuffer,
      bufferOffset: number,
      data: AllowSharedBufferSource,
      dataOffset = 0,
      size?: number,
    ) => {
      if (harness.failNextWrite) {
        harness.failNextWrite = false;
        throw new Error('synthetic queue failure');
      }
      const source = sourceBytes(data, dataOffset, size);
      buffer.bytes.set(source, bufferOffset);
      buffer.lastWriteSize = source.byteLength;
      if (source.byteLength >= 16 * 2 * Float32Array.BYTES_PER_ELEMENT) {
        poseWriteSizes.push(source.byteLength);
      }
    },
    writeTexture: () => undefined,
    copyExternalImageToTexture: () => undefined,
    onSubmittedWorkDone: async () => undefined,
  } as unknown as GPUQueue;

  const device = {
    label: 'contract fake',
    features: new Set<string>(),
    limits: {},
    queue,
    lost: new Promise<GPUDeviceLostInfo>(() => undefined),
    addEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.add(listener as (event: GPUUncapturedErrorEvent) => void);
    },
    removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject) => {
      listeners.delete(listener as (event: GPUUncapturedErrorEvent) => void);
    },
    createBuffer: (descriptor: GPUBufferDescriptor) => {
      const buffer = new FakeBuffer(descriptor, () => { destroyedBuffers += 1; });
      buffers.push(buffer);
      return buffer;
    },
    createTexture: (descriptor: GPUTextureDescriptor) => {
      const texture = new FakeTexture(descriptor, () => { destroyedTextures += 1; });
      textures.push(texture);
      return texture;
    },
    createSampler: () => ({}),
    createShaderModule: () => ({ getCompilationInfo: async () => ({ messages: [] }) }),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    createBindGroup: () => ({}),
    createComputePipeline: () => {
      pipelineCount += 1;
      return makePipeline();
    },
    createComputePipelineAsync: async () => {
      pipelineCount += 1;
      return makePipeline();
    },
    createRenderPipeline: () => {
      pipelineCount += 1;
      return makePipeline();
    },
    createRenderPipelineAsync: async () => {
      pipelineCount += 1;
      return makePipeline();
    },
    createCommandEncoder: () => ({
      beginComputePass: () => pass,
      beginRenderPass: () => pass,
      clearBuffer: () => undefined,
      copyBufferToBuffer: () => undefined,
      copyBufferToTexture: () => undefined,
      copyTextureToBuffer: () => undefined,
      copyTextureToTexture: () => undefined,
      finish: () => ({}),
    }),
    destroy: () => undefined,
    pushErrorScope: () => undefined,
    popErrorScope: async () => null,
  } as unknown as GPUDevice;

  const swapchainTexture = new FakeTexture(
    { size: [1, 1], format: 'bgra8unorm', usage: 0 } as GPUTextureDescriptor,
    () => undefined,
  );
  const context = {
    canvas: undefined,
    configure: (configuration: GPUCanvasConfiguration) => {
      configuredFormat = configuration.format;
    },
    unconfigure: () => undefined,
    getCurrentTexture: () => swapchainTexture as unknown as GPUTexture,
  } as unknown as GPUCanvasContext;

  const harness: FakeGpuHarness = {
    device,
    context,
    buffers,
    textures,
    poseWriteSizes,
    get pipelineCount() { return pipelineCount; },
    get submissions() { return submissions; },
    get configuredFormat() { return configuredFormat; },
    failNextWrite: false,
    emitUncaptured(error: Error) {
      const event = { type: 'uncapturederror', error } as unknown as GPUUncapturedErrorEvent;
      for (const listener of listeners) listener(event);
    },
  };
  Object.defineProperties(harness, {
    destroyedBuffers: { get: () => destroyedBuffers },
    destroyedTextures: { get: () => destroyedTextures },
  });
  return harness;
}

const originalGpu = Object.getOwnPropertyDescriptor(navigator, 'gpu');

function installGpu(canvas: HTMLCanvasElement, fake: FakeGpuHarness): void {
  Object.defineProperty(canvas, 'getContext', {
    configurable: true,
    value: (kind: string) => kind === 'webgpu' ? fake.context : null,
  });
  Object.defineProperty(navigator, 'gpu', {
    configurable: true,
    value: {
      getPreferredCanvasFormat: () => 'bgra8unorm',
      requestAdapter: async () => ({ requestDevice: async () => fake.device }),
    } as unknown as GPU,
  });
}

beforeEach(() => {
  vi.stubGlobal('GPUBufferUsage', {
    MAP_READ: 1,
    COPY_SRC: 2,
    COPY_DST: 4,
    INDEX: 8,
    VERTEX: 16,
    UNIFORM: 32,
    STORAGE: 64,
  });
  vi.stubGlobal('GPUTextureUsage', {
    COPY_SRC: 1,
    COPY_DST: 2,
    TEXTURE_BINDING: 4,
    STORAGE_BINDING: 8,
    RENDER_ATTACHMENT: 16,
  });
  vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
  vi.stubGlobal('GPUMapMode', { READ: 1, WRITE: 2 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu);
  else Reflect.deleteProperty(navigator, 'gpu');
});

describe('jelly toggle WebGPU renderer resource contract', () => {
  it('retains immutable resources while replacing bounded size-dependent textures', async () => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);

    const renderer = await createJellyRenderer(canvas, 'diagnostic');
    const pipelineGenerationSize = fake.pipelineCount;
    const immutableBufferCount = fake.buffers.length;
    const sdfTexture = fake.textures.find((texture) =>
      texture.descriptor.format === 'rgba16float'
      && texture.size.width === 256
      && texture.size.height === 128,
    );

    expect(pipelineGenerationSize).toBeGreaterThan(0);
    expect(sdfTexture).toBeDefined();
    expect(fake.configuredFormat).toBe('bgra8unorm');
    expect(renderer.stats.buffersCreated).toBe(fake.buffers.length);

    const writesBeforePose = fake.poseWriteSizes.length;
    renderer.setPose(CANONICAL_POSES.off, false);
    expect(fake.poseWriteSizes.slice(writesBeforePose)).toEqual([136, 128, 136]);
    renderer.draw({ jitterIndex: 0, historyValid: false, diagnostic: true });

    const texturesBeforeResize = renderer.stats.texturesCreated;
    const destroyedBeforeResize = renderer.stats.texturesDestroyed;
    expect(renderer.resize(96, 52, 2)).toBe(true);
    expect(canvas.width).toBe(192);
    expect(canvas.height).toBe(104);
    expect(renderer.stats.texturesDestroyed).toBeGreaterThan(destroyedBeforeResize);
    expect(renderer.stats.texturesCreated).toBeGreaterThan(texturesBeforeResize);
    expect(sdfTexture?.destroyed).toBe(false);

    const texturesAfterResize = renderer.stats.texturesCreated;
    expect(renderer.resize(96, 52, 2)).toBe(false);
    expect(renderer.stats.texturesCreated).toBe(texturesAfterResize);
    expect(fake.pipelineCount).toBe(pipelineGenerationSize);
    expect(fake.buffers.length).toBe(immutableBufferCount);

    expect(renderer.resize(200, 100, 4)).toBe(true);
    expect(canvas.width).toBe(264);
    expect(canvas.height).toBe(132);

    fake.emitUncaptured(new Error('synthetic validation error'));
    expect(renderer.stats.uncapturedErrors).toBe(1);

    await expect(renderer.readDiagnostics()).rejects.toThrow(
      'Diagnostic field readback is not implemented until Task 5',
    );

    renderer.destroy();
    const afterFirstDestroy = { ...renderer.stats };
    renderer.destroy();

    expect(renderer.stats).toEqual(afterFirstDestroy);
    expect(renderer.stats.buffersDestroyed).toBe(renderer.stats.buffersCreated);
    expect(renderer.stats.texturesDestroyed).toBe(renderer.stats.texturesCreated);
    expect(fake.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(fake.textures.every((texture) => texture.destroyed)).toBe(true);
  });

  it('surfaces upload failures as typed renderer errors', async () => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);
    const renderer = await createJellyRenderer(canvas);
    fake.failNextWrite = true;

    expect(() => renderer.setPose(CANONICAL_POSES.on, false)).toThrow(JellyRendererError);

    renderer.destroy();
  });

  it('pins the TypeGPU metadata format dependency to the verified upstream resolution', () => {
    const workspace = readFileSync('pnpm-workspace.yaml', 'utf8');
    const lockfile = readFileSync('pnpm-lock.yaml', 'utf8');

    expect(workspace).toMatch(/overrides:\s+tinyest: 0\.3\.1/);
    expect(lockfile).toMatch(/overrides:\s+tinyest: 0\.3\.1/);
    expect(lockfile).toContain('tinyest@0.3.1:');
    expect(lockfile).not.toContain('tinyest@0.3.2:');
  });
});
