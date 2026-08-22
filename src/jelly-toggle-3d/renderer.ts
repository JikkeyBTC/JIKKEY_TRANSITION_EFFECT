// Direct TypeGPU renderer adaptation of WICG/html-in-canvas
// Examples/webgpu-jelly-slider at d4433e329697c4341a9f915f75dbd9608f3939fa (MIT).
import tgpu, { d, type TgpuRoot } from 'typegpu';

import { CameraController } from './camera';
import { CANONICAL_POSES } from './physics-fixtures';
import type { Point2 } from './physics';
import { createJellyShaders, type DiagnosticRenderViews } from './shaders';
import { SliderGpu } from './slider-gpu';
import { TaaResolver } from './taa';
import {
  createColorTextures,
  createDiagnosticTextures,
  destroyTextureEntries,
  rollbackCleanups,
  type RendererResourceAccounting,
} from './utils';

const MAX_BACKING_WIDTH = 264;
const MAX_BACKING_HEIGHT = 132;
const MIN_DPR = 1;
const MAX_DPR = 3;
const CAMERA_FOV = Math.PI / 4;
const GPU_BUFFER_USAGE_MAP_READ = 0x0001;
const GPU_BUFFER_USAGE_COPY_DST = 0x0008;
const GPU_MAP_MODE_READ = 0x0001;

export type JellyRendererMode = 'production' | 'diagnostic';

export interface JellyDiagnosticReadback {
  readonly width: number;
  readonly height: number;
  readonly attachmentA: Float32Array;
  readonly attachmentB: Float32Array;
}

export interface JellyRendererStats {
  readonly rafRequests: number;
  readonly submissions: number;
  readonly pipelinesCreated: number;
  readonly buffersCreated: number;
  readonly buffersDestroyed: number;
  readonly texturesCreated: number;
  readonly texturesDestroyed: number;
  readonly uncapturedErrors: number;
}

export interface JellyRenderer {
  readonly device: GPUDevice;
  readonly stats: JellyRendererStats;
  readonly lost: Promise<GPUDeviceLostInfo>;
  resize(cssWidth: number, cssHeight: number, dpr: number): boolean;
  setPose(points: readonly Point2[], discontinuous: boolean): void;
  draw(options: { jitterIndex: number; historyValid: boolean; diagnostic?: boolean }): void;
  resetHistory(): void;
  readDiagnostics(): Promise<JellyDiagnosticReadback>;
  destroy(): void;
}

type JellyRendererErrorStage = 'initialization' | 'resize' | 'upload' | 'draw' | 'readback';

export class JellyRendererError extends Error {
  readonly stage: JellyRendererErrorStage;

  constructor(stage: JellyRendererErrorStage, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'JellyRendererError';
    this.stage = stage;
  }
}

interface MutableStats {
  rafRequests: number;
  submissions: number;
  pipelinesCreated: number;
  buffersCreated: number;
  buffersDestroyed: number;
  texturesCreated: number;
  texturesDestroyed: number;
  uncapturedErrors: number;
}

function finiteDimension(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function backingDimension(cssPixels: number, dpr: number, cap: number): number {
  const finiteDpr = Number.isFinite(dpr) ? dpr : MIN_DPR;
  const clampedDpr = Math.min(MAX_DPR, Math.max(MIN_DPR, finiteDpr));
  return Math.min(cap, Math.max(1, Math.round(finiteDimension(cssPixels) * clampedDpr)));
}

function alignedBytesPerRow(width: number): number {
  const packed = width * 4 * Uint16Array.BYTES_PER_ELEMENT;
  return Math.ceil(packed / 256) * 256;
}

function halfFloatToNumber(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return fraction === 0 ? sign * 0 : sign * 2 ** -14 * (fraction / 1024);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

/** Converts padded native rgba16float copy rows into the public tightly-packed Float32 API. */
export function unpackRgba16FloatRows(
  bytes: Uint8Array,
  width: number,
  height: number,
  bytesPerRow: number,
): Float32Array {
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error('Diagnostic dimensions must be positive integers');
  }
  const packedBytesPerRow = width * 4 * Uint16Array.BYTES_PER_ELEMENT;
  if (bytesPerRow < packedBytesPerRow || bytesPerRow % 256 !== 0) {
    throw new Error('Diagnostic bytesPerRow must contain the row and be aligned to 256 bytes');
  }
  if (bytes.byteLength < bytesPerRow * height) {
    throw new Error('Diagnostic readback buffer is shorter than its padded rows');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const result = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let component = 0; component < width * 4; component += 1) {
      result[(y * width * 4) + component] = halfFloatToNumber(
        view.getUint16(y * bytesPerRow + component * 2, true),
      );
    }
  }
  return result;
}

function rendererError(
  stage: JellyRendererErrorStage,
  message: string,
  cause: unknown,
): JellyRendererError {
  return cause instanceof JellyRendererError
    ? cause
    : new JellyRendererError(stage, message, { cause });
}

export async function createJellyRenderer(
  canvas: HTMLCanvasElement,
  mode: JellyRendererMode = 'production',
  randomSource: () => number = Math.random,
): Promise<JellyRenderer> {
  const gpu = navigator.gpu;
  if (!gpu) throw new JellyRendererError('initialization', 'WebGPU is unavailable');
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new JellyRendererError('initialization', 'No WebGPU adapter is available');
  const device = await adapter.requestDevice();

  const stats: MutableStats = {
    rafRequests: 0,
    submissions: 0,
    pipelinesCreated: 0,
    buffersCreated: 0,
    buffersDestroyed: 0,
    texturesCreated: 0,
    texturesDestroyed: 0,
    uncapturedErrors: 0,
  };
  const accounting: RendererResourceAccounting = {
    submission: () => { stats.submissions += 1; },
    pipelineCreated: () => { stats.pipelinesCreated += 1; },
    bufferCreated: () => { stats.buffersCreated += 1; },
    bufferDestroyed: () => { stats.buffersDestroyed += 1; },
    textureCreated: () => { stats.texturesCreated += 1; },
    textureDestroyed: () => { stats.texturesDestroyed += 1; },
  };
  const onUncapturedError = (event: GPUUncapturedErrorEvent): void => {
    stats.uncapturedErrors += 1;
    console.error('jelly-toggle WebGPU uncaptured error', {
      message: event.error.message,
      error: event.error,
    });
  };
  device.addEventListener('uncapturederror', onUncapturedError);

  let initializedRoot: TgpuRoot | undefined;
  const initializationCleanups: Array<() => void> = [];
  try {
    const root = tgpu.initFromDevice({ device });
    initializedRoot = root;
    const presentationFormat = gpu.getPreferredCanvasFormat();
    const context = root.configureContext({
      canvas,
      format: presentationFormat,
      alphaMode: 'premultiplied',
    });
    initializationCleanups.push(() => context.unconfigure());
    let width = Math.min(MAX_BACKING_WIDTH, Math.max(1, canvas.width));
    let height = Math.min(MAX_BACKING_HEIGHT, Math.max(1, canvas.height));
    canvas.width = width;
    canvas.height = height;

    const slider = new SliderGpu(root, accounting, CANONICAL_POSES.off);
    initializationCleanups.push(() => slider.destroy());
    const camera = new CameraController(
      root,
      accounting,
      d.vec3f(0, 2.7, 1.9),
      d.vec3f(0, 0, 0),
      d.vec3f(0, 1, 0),
      CAMERA_FOV,
      width,
      height,
    );
    initializationCleanups.push(() => camera.destroy());
    const shaders = createJellyShaders(
      root,
      slider,
      camera,
      presentationFormat,
      mode,
      accounting,
    );
    initializationCleanups.push(() => shaders.destroy());
    let colors = createColorTextures(root, width, height, accounting);
    initializationCleanups.push(() => destroyTextureEntries(colors, accounting));
    const taa = new TaaResolver(root, width, height, accounting);
    initializationCleanups.push(() => taa.destroy());
    let diagnostics = mode === 'diagnostic'
      ? createDiagnosticTextures(root, width, height, accounting)
      : undefined;
    if (diagnostics) {
      initializationCleanups.push(() => destroyTextureEntries(diagnostics!, accounting));
    }
    let destroyed = false;
    let resourceGeneration = 0;
    let readbackInFlight = false;
    const readbackBuffers = new Set<GPUBuffer>();

    const assertAlive = (stage: JellyRendererErrorStage): void => {
      if (destroyed) throw new JellyRendererError(stage, 'The jelly renderer has been destroyed');
    };

    const drawFrame = (jitterIndex: number, historyValid: boolean): void => {
      const currentFrame = Math.abs(Math.floor(jitterIndex)) % 2;
      camera.jitter(jitterIndex);
      shaders.setRandomSeed(randomSource(), randomSource());
      const diagnosticViews: DiagnosticRenderViews | undefined = diagnostics
        ? {
            diagnosticA: diagnostics[0]!.render,
            diagnosticB: diagnostics[1]!.render,
          }
        : undefined;
      shaders.drawRaymarch(colors[currentFrame]!.sampled, diagnosticViews);
      const resolved = taa.resolve(colors[currentFrame]!.sampled, currentFrame, historyValid);
      shaders.present(resolved, context);
    };

    // TypeGPU pipelines compile lazily. A bounded seed frame makes this the sole
    // pipeline generation for the device lifetime and initializes both histories.
    drawFrame(0, false);
    initializationCleanups.length = 0;

    const renderer: JellyRenderer = {
      device,
      stats,
      lost: device.lost,

      resize(cssWidth: number, cssHeight: number, dpr: number): boolean {
        assertAlive('resize');
        const nextWidth = backingDimension(cssWidth, dpr, MAX_BACKING_WIDTH);
        const nextHeight = backingDimension(cssHeight, dpr, MAX_BACKING_HEIGHT);
        if (nextWidth === width && nextHeight === height) return false;
        let nextColors: ReturnType<typeof createColorTextures> | undefined;
        let nextDiagnostics: ReturnType<typeof createDiagnosticTextures> | undefined;
        let taaResize: ReturnType<TaaResolver['prepareResize']> | undefined;
        try {
          nextColors = createColorTextures(root, nextWidth, nextHeight, accounting);
          nextDiagnostics = mode === 'diagnostic'
            ? createDiagnosticTextures(root, nextWidth, nextHeight, accounting)
            : undefined;
          taaResize = taa.prepareResize(nextWidth, nextHeight);
          camera.updateProjection(CAMERA_FOV, nextWidth, nextHeight);
        } catch (cause) {
          taaResize?.rollback();
          if (nextDiagnostics) destroyTextureEntries(nextDiagnostics, accounting);
          if (nextColors) destroyTextureEntries(nextColors, accounting);
          throw rendererError('resize', 'Failed to resize jelly renderer resources', cause);
        }

        const previousColors = colors;
        const previousDiagnostics = diagnostics;
        colors = nextColors;
        diagnostics = nextDiagnostics;
        taaResize.commit();
        width = nextWidth;
        height = nextHeight;
        resourceGeneration += 1;
        canvas.width = width;
        canvas.height = height;
        destroyTextureEntries(previousColors, accounting);
        if (previousDiagnostics) destroyTextureEntries(previousDiagnostics, accounting);
        return true;
      },

      setPose(points: readonly Point2[], discontinuous: boolean): void {
        assertAlive('upload');
        try {
          slider.setPose(points);
          if (discontinuous) {
            taa.resetHistory();
          }
        } catch (cause) {
          throw rendererError('upload', 'Failed to upload the jelly pose', cause);
        }
      },

      draw(options): void {
        assertAlive('draw');
        try {
          drawFrame(options.jitterIndex, options.historyValid);
        } catch (cause) {
          throw rendererError('draw', 'Failed to draw the jelly renderer', cause);
        }
      },

      resetHistory(): void {
        assertAlive('draw');
        try {
          taa.resetHistory();
        } catch (cause) {
          throw rendererError('draw', 'Failed to reset TAA histories', cause);
        }
      },

      async readDiagnostics(): Promise<JellyDiagnosticReadback> {
        assertAlive('readback');
        if (!diagnostics) {
          throw new JellyRendererError(
            'readback',
            'Diagnostic readback requires a diagnostic renderer',
          );
        }
        if (readbackInFlight) {
          throw new JellyRendererError('readback', 'A diagnostic readback is already in flight');
        }
        readbackInFlight = true;
        const readbackGeneration = resourceGeneration;
        const readbackWidth = width;
        const readbackHeight = height;
        const bytesPerRow = alignedBytesPerRow(readbackWidth);
        const size = bytesPerRow * readbackHeight;
        const staging: GPUBuffer[] = [];

        const release = (buffer: GPUBuffer): void => {
          if (!readbackBuffers.delete(buffer)) return;
          try {
            if (buffer.mapState === 'mapped') buffer.unmap();
          } finally {
            buffer.destroy();
            accounting.bufferDestroyed();
          }
        };

        try {
          for (let index = 0; index < 2; index += 1) {
            const buffer = device.createBuffer({
              label: `jelly diagnostic ${index === 0 ? 'A' : 'B'} readback`,
              size,
              usage: GPU_BUFFER_USAGE_COPY_DST | GPU_BUFFER_USAGE_MAP_READ,
            });
            accounting.bufferCreated();
            readbackBuffers.add(buffer);
            staging.push(buffer);
          }

          const encoder = device.createCommandEncoder({ label: 'jelly diagnostic readback' });
          for (let index = 0; index < 2; index += 1) {
            encoder.copyTextureToBuffer(
              { texture: root.unwrap(diagnostics[index]!.texture) },
              { buffer: staging[index]!, bytesPerRow, rowsPerImage: readbackHeight },
              { width: readbackWidth, height: readbackHeight, depthOrArrayLayers: 1 },
            );
          }
          device.queue.submit([encoder.finish()]);
          accounting.submission();
          await Promise.all(staging.map((buffer) => buffer.mapAsync(GPU_MAP_MODE_READ)));
          if (
            destroyed
            || readbackGeneration !== resourceGeneration
            || diagnostics === undefined
          ) {
            throw new JellyRendererError('readback', 'Diagnostic readback became stale');
          }
          const attachmentABytes = new Uint8Array(staging[0]!.getMappedRange()).slice();
          const attachmentBBytes = new Uint8Array(staging[1]!.getMappedRange()).slice();
          return {
            width: readbackWidth,
            height: readbackHeight,
            attachmentA: unpackRgba16FloatRows(
              attachmentABytes,
              readbackWidth,
              readbackHeight,
              bytesPerRow,
            ),
            attachmentB: unpackRgba16FloatRows(
              attachmentBBytes,
              readbackWidth,
              readbackHeight,
              bytesPerRow,
            ),
          };
        } catch (cause) {
          throw rendererError('readback', 'Failed to read diagnostic fields', cause);
        } finally {
          for (const buffer of staging) release(buffer);
          readbackInFlight = false;
        }
      },

      destroy(): void {
        if (destroyed) return;
        destroyed = true;
        resourceGeneration += 1;
        device.removeEventListener('uncapturederror', onUncapturedError);
        for (const buffer of [...readbackBuffers]) {
          try {
            if (buffer.mapState === 'mapped') buffer.unmap();
          } finally {
            buffer.destroy();
            readbackBuffers.delete(buffer);
            accounting.bufferDestroyed();
          }
        }
        destroyTextureEntries(colors, accounting);
        if (diagnostics) destroyTextureEntries(diagnostics, accounting);
        taa.destroy();
        shaders.destroy();
        camera.destroy();
        slider.destroy();
        context.unconfigure();
        root.destroy();
        device.destroy();
      },
    };

    return renderer;
  } catch (cause) {
    device.removeEventListener('uncapturederror', onUncapturedError);
    rollbackCleanups(initializationCleanups);
    try {
      initializedRoot?.destroy();
    } catch {
      // Keep unwinding the failed device generation.
    }
    try {
      device.destroy();
    } catch {
      // Preserve the original initialization error.
    }
    throw rendererError('initialization', 'Failed to initialize the jelly renderer', cause);
  }
}
