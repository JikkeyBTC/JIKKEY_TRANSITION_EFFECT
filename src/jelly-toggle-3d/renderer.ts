// Direct TypeGPU renderer adaptation of WICG/html-in-canvas
// Examples/webgpu-jelly-slider at d4433e329697c4341a9f915f75dbd9608f3939fa (MIT).
import tgpu, { d } from 'typegpu';

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
  type RendererResourceAccounting,
} from './utils';

const MAX_BACKING_WIDTH = 264;
const MAX_BACKING_HEIGHT = 132;
const MIN_DPR = 1;
const MAX_DPR = 3;
const CAMERA_FOV = Math.PI / 4;

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
): Promise<JellyRenderer> {
  const gpu = navigator.gpu;
  if (!gpu) throw new JellyRendererError('initialization', 'WebGPU is unavailable');
  const adapter = await gpu.requestAdapter();
  if (!adapter) throw new JellyRendererError('initialization', 'No WebGPU adapter is available');
  const device = await adapter.requestDevice();

  const stats: MutableStats = {
    rafRequests: 0,
    submissions: 0,
    buffersCreated: 0,
    buffersDestroyed: 0,
    texturesCreated: 0,
    texturesDestroyed: 0,
    uncapturedErrors: 0,
  };
  const accounting: RendererResourceAccounting = {
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

  try {
    const root = tgpu.initFromDevice({ device });
    const presentationFormat = gpu.getPreferredCanvasFormat();
    const context = root.configureContext({
      canvas,
      format: presentationFormat,
      alphaMode: 'premultiplied',
    });
    let width = Math.min(MAX_BACKING_WIDTH, Math.max(1, canvas.width));
    let height = Math.min(MAX_BACKING_HEIGHT, Math.max(1, canvas.height));
    canvas.width = width;
    canvas.height = height;

    const slider = new SliderGpu(root, accounting, CANONICAL_POSES.off);
    stats.submissions += 1;
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
    const shaders = createJellyShaders(
      root,
      slider,
      camera,
      presentationFormat,
      mode,
      accounting,
    );
    let colors = createColorTextures(root, width, height, accounting);
    const taa = new TaaResolver(root, width, height, accounting);
    let diagnostics = mode === 'diagnostic'
      ? createDiagnosticTextures(root, width, height, accounting)
      : undefined;
    let destroyed = false;

    const assertAlive = (stage: JellyRendererErrorStage): void => {
      if (destroyed) throw new JellyRendererError(stage, 'The jelly renderer has been destroyed');
    };

    const drawFrame = (jitterIndex: number, historyValid: boolean): void => {
      const currentFrame = Math.abs(Math.floor(jitterIndex)) % 2;
      camera.jitter(jitterIndex);
      shaders.setRandomSeed(jitterIndex);
      const diagnosticViews: DiagnosticRenderViews | undefined = diagnostics
        ? {
            attachmentA: diagnostics[0]!.render,
            attachmentB: diagnostics[1]!.render,
          }
        : undefined;
      shaders.drawRaymarch(colors[currentFrame]!.sampled, diagnosticViews);
      const resolved = taa.resolve(colors[currentFrame]!.sampled, currentFrame, historyValid);
      shaders.present(resolved, context);
      stats.submissions += 3;
    };

    // TypeGPU pipelines compile lazily. A bounded seed frame makes this the sole
    // pipeline generation for the device lifetime and initializes both histories.
    drawFrame(0, false);

    const renderer: JellyRenderer = {
      device,
      stats,
      lost: device.lost,

      resize(cssWidth: number, cssHeight: number, dpr: number): boolean {
        assertAlive('resize');
        const nextWidth = backingDimension(cssWidth, dpr, MAX_BACKING_WIDTH);
        const nextHeight = backingDimension(cssHeight, dpr, MAX_BACKING_HEIGHT);
        if (nextWidth === width && nextHeight === height) return false;
        try {
          destroyTextureEntries(colors, accounting);
          if (diagnostics) destroyTextureEntries(diagnostics, accounting);
          width = nextWidth;
          height = nextHeight;
          canvas.width = width;
          canvas.height = height;
          camera.updateProjection(CAMERA_FOV, width, height);
          colors = createColorTextures(root, width, height, accounting);
          taa.resize(width, height);
          diagnostics = mode === 'diagnostic'
            ? createDiagnosticTextures(root, width, height, accounting)
            : undefined;
          return true;
        } catch (cause) {
          throw rendererError('resize', 'Failed to resize jelly renderer resources', cause);
        }
      },

      setPose(points: readonly Point2[], discontinuous: boolean): void {
        assertAlive('upload');
        try {
          slider.setPose(points);
          stats.submissions += 1;
          if (discontinuous) {
            taa.resetHistory();
            stats.submissions += 2;
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
          stats.submissions += 2;
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
        throw new JellyRendererError(
          'readback',
          'Diagnostic field readback is not implemented until Task 5',
        );
      },

      destroy(): void {
        if (destroyed) return;
        destroyed = true;
        device.removeEventListener('uncapturederror', onUncapturedError);
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
    device.destroy();
    throw rendererError('initialization', 'Failed to initialize the jelly renderer', cause);
  }
}
