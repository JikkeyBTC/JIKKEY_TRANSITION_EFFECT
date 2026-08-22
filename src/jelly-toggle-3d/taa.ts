// Derived from WICG/html-in-canvas Examples/webgpu-jelly-slider/src/taa.ts
// at d4433e329697c4341a9f915f75dbd9608f3939fa (MIT).
import type { TgpuComputePipeline, TgpuRoot, TgpuTextureView } from 'typegpu';
import tgpu, { d, std } from 'typegpu';

import { taaResolveLayout } from './data-types';
import {
  createTextureBundle,
  destroyTextureEntries,
  type RendererResourceAccounting,
} from './utils';

const STATIONARY_SAMPLE_COUNT = 16;
const HISTORY_BLEND = 0.9;

export interface TaaSample {
  readonly historyValid: boolean;
  readonly blend: 0 | 0.9;
}

export interface TaaState {
  readonly needsSample: boolean;
  invalidate(): void;
  noteMotion(): void;
  consumeStationarySample(): TaaSample;
}

export function createTaaState(): TaaState {
  let historyValid = false;
  let stationarySamples = 0;

  return {
    get needsSample(): boolean {
      return stationarySamples < STATIONARY_SAMPLE_COUNT;
    },

    invalidate(): void {
      historyValid = false;
      stationarySamples = 0;
    },

    noteMotion(): void {
      stationarySamples = 0;
    },

    consumeStationarySample(): TaaSample {
      const sample = historyValid
        ? { historyValid: true, blend: HISTORY_BLEND } as const
        : { historyValid: false, blend: 0 } as const;
      historyValid = true;
      stationarySamples = Math.min(STATIONARY_SAMPLE_COUNT, stationarySamples + 1);
      return sample;
    },
  };
}

export type TaaResourceAccounting = Pick<
  RendererResourceAccounting,
  'submission' | 'textureCreated' | 'textureDestroyed'
>;

export const taaResolveFn = tgpu.computeFn({
  workgroupSize: [16, 16],
  in: {
    gid: d.builtin.globalInvocationId,
  },
})(({ gid }) => {
  const dimensions = std.textureDimensions(taaResolveLayout.$.currentTexture);
  if (gid.x >= dimensions.x || gid.y >= dimensions.y) return;

  const currentColor = std.textureLoad(taaResolveLayout.$.currentTexture, d.vec2u(gid.xy), 0);
  const historyColor = std.textureLoad(taaResolveLayout.$.historyTexture, d.vec2u(gid.xy), 0);
  let minColor = d.vec3f(9999.0);
  let maxColor = d.vec3f(-9999.0);

  for (const x of tgpu.unroll([-1, 0, 1])) {
    for (const y of tgpu.unroll([-1, 0, 1])) {
      const sampleCoord = d.vec2i(gid.xy).add(d.vec2i(x, y));
      const clampedCoord = std.clamp(
        sampleCoord,
        d.vec2i(0, 0),
        d.vec2i(dimensions.xy).sub(d.vec2i(1)),
      );
      const neighborColor = std.textureLoad(taaResolveLayout.$.currentTexture, clampedCoord, 0);
      minColor = std.min(minColor, neighborColor.rgb);
      maxColor = std.max(maxColor, neighborColor.rgb);
    }
  }

  const historyColorClamped = std.clamp(historyColor.rgb, minColor, maxColor);
  const resolvedColor = d.vec4f(
    std.mix(currentColor.rgb, historyColorClamped, HISTORY_BLEND),
    1.0,
  );
  std.textureStore(taaResolveLayout.$.outputTexture, d.vec2u(gid.xy), resolvedColor);
});

function createTaaTextures(
  root: TgpuRoot,
  width: number,
  height: number,
  accounting: TaaResourceAccounting,
) {
  return createTextureBundle(
    root,
    2,
    accounting,
    () => root['~unstable']
      .createTexture({ size: [width, height], format: 'rgba8unorm' })
      .$usage('storage', 'sampled'),
    (texture) => ({
      texture,
      write: texture.createView(d.textureStorage2d('rgba8unorm', 'write-only')),
      sampled: texture.createView(),
    }),
  );
}

export interface TaaResizeTransaction {
  commit(): void;
  rollback(): void;
}

export class TaaResolver {
  readonly #pipeline: TgpuComputePipeline;
  readonly #root: TgpuRoot;
  readonly #accounting: TaaResourceAccounting;
  #textures: ReturnType<typeof createTaaTextures>;
  #width: number;
  #height: number;
  #destroyed = false;

  constructor(
    root: TgpuRoot,
    width: number,
    height: number,
    accounting: TaaResourceAccounting,
  ) {
    this.#root = root;
    this.#width = width;
    this.#height = height;
    this.#accounting = accounting;
    this.#pipeline = root.createComputePipeline({ compute: taaResolveFn });
    this.#textures = createTaaTextures(root, width, height, accounting);
  }

  resolve(
    currentTexture: TgpuTextureView<d.WgslTexture2d<d.F32>>,
    currentFrame: number,
    historyValid: boolean,
  ): TgpuTextureView<d.WgslTexture2d<d.F32>> {
    const current = this.#textures[currentFrame]!;
    if (!historyValid) {
      for (const history of this.#textures) {
        this.#dispatch(currentTexture, currentTexture, history.write);
      }
      return current.sampled;
    }

    const previousFrame = 1 - currentFrame;
    const history = this.#textures[previousFrame]!;
    this.#dispatch(currentTexture, history.sampled, current.write);
    return current.sampled;
  }

  prepareResize(width: number, height: number): TaaResizeTransaction {
    if (this.#destroyed) throw new Error('Cannot resize a destroyed TAA resolver');
    const replacement = createTaaTextures(this.#root, width, height, this.#accounting);
    let pending = true;
    return {
      commit: (): void => {
        if (!pending) return;
        pending = false;
        const previous = this.#textures;
        this.#textures = replacement;
        this.#width = width;
        this.#height = height;
        this.#destroyTextures(previous);
      },
      rollback: (): void => {
        if (!pending) return;
        pending = false;
        this.#destroyTextures(replacement);
      },
    };
  }

  resize(width: number, height: number): void {
    this.prepareResize(width, height).commit();
  }

  #dispatch(
    currentTexture: TgpuTextureView<d.WgslTexture2d<d.F32>>,
    historyTexture: TgpuTextureView<d.WgslTexture2d<d.F32>>,
    outputTexture: TgpuTextureView<d.WgslStorageTexture2d<'rgba8unorm'>>,
  ): void {
    this.#pipeline
      .with(this.#root.createBindGroup(taaResolveLayout, {
        currentTexture,
        historyTexture,
        outputTexture,
      }))
      .dispatchWorkgroups(Math.ceil(this.#width / 16), Math.ceil(this.#height / 16));
    this.#accounting.submission();
  }

  getResolvedTexture(frame: number): TgpuTextureView<d.WgslTexture2d<d.F32>> {
    return this.#textures[frame]!.sampled;
  }

  resetHistory(): void {
    for (const entry of this.#textures) entry.texture.clear();
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#destroyTextures(this.#textures);
    this.#textures = [];
  }

  #destroyTextures(textures: ReturnType<typeof createTaaTextures>): void {
    destroyTextureEntries(
      textures,
      this.#accounting,
    );
  }
}
