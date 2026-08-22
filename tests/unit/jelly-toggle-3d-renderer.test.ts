import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import tgpu from 'typegpu';

import { CANONICAL_POSES } from '../../src/jelly-toggle-3d/physics-fixtures';
import {
  createJellyRenderer,
  JellyRendererError,
} from '../../src/jelly-toggle-3d/renderer';
import { diagnosticContributionLuma } from '../../src/jelly-toggle-3d/shaders';

type TextureSize = Readonly<{ width: number; height: number; depthOrArrayLayers: number }>;

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class FakeBuffer {
  readonly bytes: Uint8Array;
  destroyed = false;
  mapState: GPUBufferMapState = 'unmapped';
  lastWriteSize = 0;
  destroyCalls = 0;

  constructor(
    readonly descriptor: GPUBufferDescriptor,
    private readonly onDestroy: () => void,
    private readonly onMapAsync: (buffer: FakeBuffer) => Promise<void>,
  ) {
    this.bytes = new Uint8Array(Number(descriptor.size));
  }

  destroy(): void {
    this.destroyCalls += 1;
    if (this.destroyed) return;
    this.destroyed = true;
    this.onDestroy();
  }

  async mapAsync(): Promise<void> {
    await this.onMapAsync(this);
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
  destroyCalls = 0;
  readbackHalfBits = 0;
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
    this.destroyCalls += 1;
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
  readonly shaderCodes: string[];
  readonly poseWriteSizes: number[];
  readonly pipelineCount: number;
  readonly submissions: number;
  readonly configuredFormat: GPUTextureFormat | undefined;
  readonly deviceDestroyCount: number;
  readonly contextUnconfigureCount: number;
  readonly listenerCount: number;
  failNextWrite: boolean;
  failBufferCreationIn: number | undefined;
  bufferCreationFailure: Error | undefined;
  failTextureCreationIn: number | undefined;
  mapAsyncImpl: (buffer: FakeBuffer) => Promise<void>;
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
  const shaderCodes: string[] = [];
  const listeners = new Set<(event: GPUUncapturedErrorEvent) => void>();
  let pipelineCount = 0;
  let submissions = 0;
  let configuredFormat: GPUTextureFormat | undefined;
  let destroyedBuffers = 0;
  let destroyedTextures = 0;
  let deviceDestroyCount = 0;
  let contextUnconfigureCount = 0;
  let diagnosticTextureIndex = 0;

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
      if (harness.failBufferCreationIn !== undefined) {
        if (harness.failBufferCreationIn === 0) {
          harness.failBufferCreationIn = undefined;
          throw harness.bufferCreationFailure ?? new Error('synthetic buffer allocation failure');
        }
        harness.failBufferCreationIn -= 1;
      }
      const buffer = new FakeBuffer(
        descriptor,
        () => { destroyedBuffers += 1; },
        (candidate) => harness.mapAsyncImpl(candidate),
      );
      buffers.push(buffer);
      return buffer;
    },
    createTexture: (descriptor: GPUTextureDescriptor) => {
      if (harness.failTextureCreationIn !== undefined) {
        if (harness.failTextureCreationIn === 0) {
          harness.failTextureCreationIn = undefined;
          throw new Error('synthetic texture allocation failure');
        }
        harness.failTextureCreationIn -= 1;
      }
      const texture = new FakeTexture(descriptor, () => { destroyedTextures += 1; });
      if (
        descriptor.format === 'rgba16float'
        && !(texture.size.width === 256 && texture.size.height === 128)
      ) {
        texture.readbackHalfBits = diagnosticTextureIndex++ % 2 === 0 ? 0x3c00 : 0x4000;
      }
      textures.push(texture);
      return texture;
    },
    createSampler: () => ({}),
    createShaderModule: (descriptor: GPUShaderModuleDescriptor) => {
      shaderCodes.push(String(descriptor.code));
      return { getCompilationInfo: async () => ({ messages: [] }) };
    },
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
      copyTextureToBuffer: (
        source: GPUTexelCopyTextureInfo,
        destination: GPUTexelCopyBufferInfo,
        copySize: GPUExtent3D,
      ) => {
        const texture = source.texture as unknown as FakeTexture;
        const buffer = destination.buffer as unknown as FakeBuffer;
        const extent = Symbol.iterator in Object(copySize)
          ? [...copySize as Iterable<number>]
          : [
              (copySize as GPUExtent3DDict).width,
              (copySize as GPUExtent3DDict).height ?? 1,
            ];
        const width = Number(extent[0]);
        const height = Number(extent[1]);
        const bytesPerRow = Number(destination.bytesPerRow);
        const data = new DataView(buffer.bytes.buffer);
        for (let y = 0; y < height; y += 1) {
          for (let component = 0; component < width * 4; component += 1) {
            data.setUint16(y * bytesPerRow + component * 2, texture.readbackHalfBits, true);
          }
        }
      },
      copyTextureToTexture: () => undefined,
      finish: () => ({}),
    }),
    destroy: () => { deviceDestroyCount += 1; },
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
    unconfigure: () => { contextUnconfigureCount += 1; },
    getCurrentTexture: () => swapchainTexture as unknown as GPUTexture,
  } as unknown as GPUCanvasContext;

  const harness: FakeGpuHarness = {
    device,
    context,
    buffers,
    textures,
    shaderCodes,
    poseWriteSizes,
    get pipelineCount() { return pipelineCount; },
    get submissions() { return submissions; },
    get configuredFormat() { return configuredFormat; },
    get deviceDestroyCount() { return deviceDestroyCount; },
    get contextUnconfigureCount() { return contextUnconfigureCount; },
    get listenerCount() { return listeners.size; },
    failNextWrite: false,
    failBufferCreationIn: undefined,
    bufferCreationFailure: undefined,
    failTextureCreationIn: undefined,
    mapAsyncImpl: async () => undefined,
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalGpu) Object.defineProperty(navigator, 'gpu', originalGpu);
  else Reflect.deleteProperty(navigator, 'gpu');
});

describe('jelly toggle WebGPU renderer resource contract', () => {
  it('consumes exactly two injected random samples for every upstream scene draw', async () => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);
    const random = vi.fn()
      .mockReturnValueOnce(0.25)
      .mockReturnValueOnce(0.75)
      .mockReturnValueOnce(0.125)
      .mockReturnValueOnce(0.875);

    const renderer = await createJellyRenderer(canvas, 'production', random);
    expect(random).toHaveBeenCalledTimes(2);
    renderer.draw({ jitterIndex: 1, historyValid: true });
    expect(random).toHaveBeenCalledTimes(4);
    renderer.destroy();
  });

  it('uses Math.random as the ordinary production distribution source', async () => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.5);

    const renderer = await createJellyRenderer(canvas);
    expect(random).toHaveBeenCalledTimes(2);
    renderer.draw({ jitterIndex: 1, historyValid: true });
    expect(random).toHaveBeenCalledTimes(4);
    renderer.destroy();
  });

  it('emits named nonzero diagnostic fields through the compiled MRT pipeline', async () => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);

    const renderer = await createJellyRenderer(canvas, 'diagnostic');
    const diagnosticShader = fake.shaderCodes.find((code) => (
      code.includes('@location(1)') && code.includes('@location(2)')
    ));
    expect(diagnosticShader).toContain('diagnosticA');
    expect(diagnosticShader).toContain('diagnosticB');
    expect(diagnosticShader).not.toMatch(/diagnosticA\s*=\s*vec4f\(0(?:\.0)?\)/);
    expect(diagnosticShader).not.toMatch(/diagnosticB\s*=\s*vec4f\(0(?:\.0)?\)/);
    expect(diagnosticShader).not.toMatch(/saturate\(rec709Luma\((?:transmission|reflectionContribution|caustic)\)\)/);

    renderer.destroy();
  });

  it('preserves HDR diagnostic contribution luma above one', () => {
    expect(diagnosticContributionLuma([2, 2, 2])).toBeCloseTo(2, 10);
    expect(diagnosticContributionLuma([4, 0, 0])).toBeCloseTo(0.8504, 10);
  });

  it('keeps the production raymarch artifact free of diagnostic-only work', async () => {
    const productionSource = readFileSync('src/jelly-toggle-3d/shaders.ts', 'utf8');
    expect(productionSource).not.toMatch(
      /calculateLightingDiagnostic|renderBackgroundDiagnostic|rayMarchDiagnostic/,
    );
    expect(productionSource.match(/const calculateLightingCore\s*=/g)).toHaveLength(1);
    expect(productionSource.match(/const renderBackgroundCore\s*=/g)).toHaveLength(1);
    expect(productionSource.match(/const rayMarchCore\s*=/g)).toHaveLength(1);
    expect(productionSource.match(/rayMarchCore\(ray\.origin, ray\.direction, uv\)/g)).toHaveLength(2);
    expect(productionSource.match(/randf\.sample\(\)/g)).toHaveLength(1);

    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);

    const renderer = await createJellyRenderer(canvas, 'production');
    const productionShader = fake.shaderCodes.find((code) => code.includes('fn rayMarchCore('));
    expect(productionShader).toBeDefined();
    expect(productionShader).not.toMatch(/diagnostic|rec709Luma|shadowAttenuation|causticLuma/);
    expect(productionShader!.match(/\n  randSeed2\(/g)).toHaveLength(1);
    const orderedTokens = [
      'fn rayMarchCore(',
      'var background = renderBackgroundCore(',
      'var jelly = ((reflection * F) + (refractedColor * (1f - F)))',
      'var finalJelly = mix(background.color.rgb, jelly, jellyColorUniform.w)',
      'var sample_1 = rayMarchCore(ray.origin, ray.direction, _arg_0.uv)',
      'return vec4f(tanh((sample_1.color.rgb * 1.3f)), 1f)',
    ];
    let previous = -1;
    for (const token of orderedTokens) {
      const next = productionShader!.indexOf(token);
      expect(next, `missing or reordered production token: ${token}`).toBeGreaterThan(previous);
      previous = next;
    }
    renderer.destroy();
  });

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
    expect(renderer.stats.pipelinesCreated).toBe(pipelineGenerationSize);
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
    expect(renderer.stats.pipelinesCreated).toBe(pipelineGenerationSize);
    expect(fake.buffers.length).toBe(immutableBufferCount);

    expect(renderer.resize(200, 100, 4)).toBe(true);
    expect(canvas.width).toBe(264);
    expect(canvas.height).toBe(132);

    fake.emitUncaptured(new Error('synthetic validation error'));
    expect(renderer.stats.uncapturedErrors).toBe(1);

    const buffersBeforeReadback = renderer.stats.buffersCreated;
    const buffersDestroyedBeforeReadback = renderer.stats.buffersDestroyed;
    const readback = await renderer.readDiagnostics();
    expect(readback).toMatchObject({ width: 264, height: 132 });
    expect(readback.attachmentA).toHaveLength(264 * 132 * 4);
    expect(readback.attachmentA[0]).toBe(1);
    expect(readback.attachmentA.at(-1)).toBe(1);
    expect(readback.attachmentB[0]).toBe(2);
    expect(readback.attachmentB.at(-1)).toBe(2);
    expect(renderer.stats.buffersCreated - buffersBeforeReadback).toBe(2);
    expect(renderer.stats.buffersDestroyed - buffersDestroyedBeforeReadback).toBe(2);

    renderer.destroy();
    const afterFirstDestroy = { ...renderer.stats };
    renderer.destroy();

    expect(renderer.stats).toEqual(afterFirstDestroy);
    expect(renderer.stats.buffersDestroyed).toBe(renderer.stats.buffersCreated);
    expect(renderer.stats.texturesDestroyed).toBe(renderer.stats.texturesCreated);
    expect(fake.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(fake.textures.every((texture) => texture.destroyed)).toBe(true);
  });

  it('rejects overlapping diagnostic readbacks and releases staging buffers', async () => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    installGpu(canvas, fake);
    const renderer = await createJellyRenderer(canvas, 'diagnostic');
    const activeBuffersBefore = renderer.stats.buffersCreated - renderer.stats.buffersDestroyed;

    const first = renderer.readDiagnostics();
    await expect(renderer.readDiagnostics()).rejects.toThrow(/already in flight/i);
    await expect(first).resolves.toMatchObject({ width: 264, height: 132 });
    expect(renderer.stats.buffersCreated - renderer.stats.buffersDestroyed).toBe(activeBuffersBefore);

    renderer.destroy();
  });

  it('rejects a pending diagnostic readback after resize and releases both staging buffers', async () => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);
    const renderer = await createJellyRenderer(canvas, 'diagnostic');
    const gates = [deferred(), deferred()];
    let mapCalls = 0;
    fake.mapAsyncImpl = () => gates[mapCalls++]!.promise;

    const pending = renderer.readDiagnostics();
    expect(mapCalls).toBe(2);
    const staging = fake.buffers.slice(-2);
    expect(renderer.resize(96, 52, 2)).toBe(true);
    gates.forEach((gate) => gate.resolve());

    await expect(pending).rejects.toBeInstanceOf(JellyRendererError);
    expect(staging.map((buffer) => buffer.destroyCalls)).toEqual([1, 1]);
    expect(staging.every((buffer) => buffer.destroyed)).toBe(true);

    renderer.destroy();
    expect(renderer.stats.buffersDestroyed).toBe(renderer.stats.buffersCreated);
  });

  it('destroys pending readback staging buffers exactly once during renderer teardown', async () => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);
    const renderer = await createJellyRenderer(canvas, 'diagnostic');
    const gates = [deferred(), deferred()];
    let mapCalls = 0;
    fake.mapAsyncImpl = () => gates[mapCalls++]!.promise;

    const pending = renderer.readDiagnostics();
    expect(mapCalls).toBe(2);
    const staging = fake.buffers.slice(-2);
    renderer.destroy();
    expect(staging.map((buffer) => buffer.destroyCalls)).toEqual([1, 1]);
    gates.forEach((gate) => gate.resolve());

    await expect(pending).rejects.toBeInstanceOf(JellyRendererError);
    expect(staging.map((buffer) => buffer.destroyCalls)).toEqual([1, 1]);
    expect(renderer.stats.buffersDestroyed).toBe(renderer.stats.buffersCreated);
  });

  it('cleans up both staging buffers when mapping rejects', async () => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);
    const renderer = await createJellyRenderer(canvas, 'diagnostic');
    const activeBuffersBefore = renderer.stats.buffersCreated - renderer.stats.buffersDestroyed;
    fake.mapAsyncImpl = async () => {
      throw new Error('synthetic map rejection');
    };

    await expect(renderer.readDiagnostics()).rejects.toMatchObject({
      name: 'JellyRendererError',
      stage: 'readback',
    });
    const staging = fake.buffers.slice(-2);
    expect(staging.map((buffer) => buffer.destroyCalls)).toEqual([1, 1]);
    expect(renderer.stats.buffersCreated - renderer.stats.buffersDestroyed).toBe(activeBuffersBefore);

    renderer.destroy();
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

  it('reports only actual GPU queue submissions', async () => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);
    const renderer = await createJellyRenderer(canvas);

    renderer.resetHistory();
    expect(renderer.stats.submissions).toBe(fake.submissions);

    renderer.setPose(CANONICAL_POSES.on, true);
    expect(renderer.stats.submissions).toBe(fake.submissions);
    renderer.destroy();
  });

  it.each([
    { failureOffset: 1, location: 'inside a replacement bundle' },
    { failureOffset: 4, location: 'after earlier replacement bundles' },
  ])('preserves live resize resources when allocation fails $location', async ({
    failureOffset,
  }) => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);
    const renderer = await createJellyRenderer(canvas, 'diagnostic');
    const oldTextures = fake.textures.filter((texture) => !texture.destroyed);
    const textureCountBefore = fake.textures.length;
    const activeOwnedBefore = renderer.stats.texturesCreated - renderer.stats.texturesDestroyed;
    fake.failTextureCreationIn = failureOffset;

    expect(() => renderer.resize(96, 52, 2)).toThrow(JellyRendererError);

    const partialReplacements = fake.textures.slice(textureCountBefore);
    expect(partialReplacements.length).toBeGreaterThan(0);
    expect(partialReplacements.every((texture) => texture.destroyed)).toBe(true);
    expect(oldTextures.every((texture) => !texture.destroyed)).toBe(true);
    expect(canvas.width).toBe(88);
    expect(canvas.height).toBe(44);
    expect(renderer.stats.texturesCreated - renderer.stats.texturesDestroyed).toBe(
      activeOwnedBefore,
    );

    expect(renderer.resize(96, 52, 2)).toBe(true);
    renderer.destroy();
    expect(renderer.stats.texturesDestroyed).toBe(renderer.stats.texturesCreated);
    expect(fake.textures.every((texture) => texture.destroyed)).toBe(true);
  });

  it('cleans all initialized resources when renderer creation fails', async () => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);
    fake.failTextureCreationIn = 2;

    await expect(createJellyRenderer(canvas, 'diagnostic')).rejects.toBeInstanceOf(
      JellyRendererError,
    );

    expect(fake.buffers.length).toBeGreaterThan(0);
    expect(fake.textures.length).toBeGreaterThan(0);
    expect(fake.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(fake.textures.every((texture) => texture.destroyed)).toBe(true);
    expect(fake.contextUnconfigureCount).toBe(1);
    expect(fake.deviceDestroyCount).toBe(1);
  });

  it.each([
    {
      stage: 'SliderGpu',
      successfulBuffersBeforeFailure: 1,
      expectedTexturesBeforeFailure: 0,
    },
    {
      stage: 'CameraController',
      successfulBuffersBeforeFailure: 5,
      expectedTexturesBeforeFailure: 1,
    },
    {
      stage: 'createJellyShaders',
      successfulBuffersBeforeFailure: 7,
      expectedTexturesBeforeFailure: 1,
    },
  ])('unwinds a partial $stage construction without replacing its error', async ({
    stage,
    successfulBuffersBeforeFailure,
    expectedTexturesBeforeFailure,
  }) => {
    const fake = createFakeGpu();
    const canvas = document.createElement('canvas');
    canvas.width = 88;
    canvas.height = 44;
    installGpu(canvas, fake);
    const probeRoot = tgpu.initFromDevice({ device: fake.device });
    const rootDestroy = vi.spyOn(Object.getPrototypeOf(probeRoot), 'destroy');
    const stageError = new Error(`${stage} construction failure`);
    fake.failBufferCreationIn = successfulBuffersBeforeFailure;
    fake.bufferCreationFailure = stageError;

    const caught = await createJellyRenderer(canvas, 'diagnostic').catch(
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(JellyRendererError);
    expect((caught as JellyRendererError).cause).toBe(stageError);
    expect(fake.buffers.length).toBe(successfulBuffersBeforeFailure);
    expect(fake.textures.length).toBe(expectedTexturesBeforeFailure);
    expect(fake.buffers.every((buffer) => buffer.destroyed)).toBe(true);
    expect(fake.textures.every((texture) => texture.destroyed)).toBe(true);
    expect(fake.buffers.every((buffer) => buffer.destroyCalls === 1)).toBe(true);
    expect(fake.textures.every((texture) => texture.destroyCalls === 1)).toBe(true);
    expect(fake.listenerCount).toBe(0);
    expect(fake.contextUnconfigureCount).toBe(1);
    expect(rootDestroy).toHaveBeenCalledTimes(1);
    expect(fake.deviceDestroyCount).toBe(1);
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
