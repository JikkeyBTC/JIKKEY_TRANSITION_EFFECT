import { describe, expect, it } from 'vitest';
import type { TgpuRoot, TgpuTextureView } from 'typegpu';
import { d } from 'typegpu';

import { createTaaState, TaaResolver } from '../../src/jelly-toggle-3d/taa';

interface FakeHistoryTexture {
  readonly id: number;
  destroyed: boolean;
  $usage(...usages: string[]): FakeHistoryTexture;
  createView(schema?: unknown): TgpuTextureView<d.WgslTexture2d<d.F32>>;
  clear(): void;
  destroy(): void;
}

function createTaaRoot() {
  const textures: FakeHistoryTexture[] = [];
  const writtenHistoryIds: number[] = [];
  const root = {
    '~unstable': {
      createTexture: () => {
        const texture: FakeHistoryTexture = {
          id: textures.length,
          destroyed: false,
          $usage: () => texture,
          createView: () => ({ texture }) as unknown as TgpuTextureView<d.WgslTexture2d<d.F32>>,
          clear: () => undefined,
          destroy: () => { texture.destroyed = true; },
        };
        textures.push(texture);
        return texture;
      },
    },
    createComputePipeline: () => ({
      with: (resources: { outputTexture: { texture: FakeHistoryTexture } }) => ({
        dispatchWorkgroups: () => {
          writtenHistoryIds.push(resources.outputTexture.texture.id);
        },
      }),
    }),
    createBindGroup: (_layout: unknown, resources: unknown) => resources,
    unwrap: () => ({}),
  } as unknown as TgpuRoot;
  return { root, writtenHistoryIds };
}

describe('jelly toggle TAA state', () => {
  it('seeds once, blends fifteen times, then becomes idle', () => {
    const taa = createTaaState();
    taa.invalidate();

    const samples = Array.from({ length: 16 }, () => taa.consumeStationarySample());

    expect(samples[0]).toMatchObject({ historyValid: false, blend: 0 });
    expect(samples.slice(1)).toEqual(Array(15).fill({ historyValid: true, blend: 0.9 }));
    expect(taa.needsSample).toBe(false);
  });

  it('restarts stationary convergence after motion without discarding valid history', () => {
    const taa = createTaaState();
    taa.invalidate();
    taa.consumeStationarySample();
    taa.consumeStationarySample();

    taa.noteMotion();

    expect(taa.needsSample).toBe(true);
    expect(taa.consumeStationarySample()).toEqual({ historyValid: true, blend: 0.9 });
  });

  it('invalidates both histories after a discontinuity', () => {
    const taa = createTaaState();
    taa.invalidate();
    taa.consumeStationarySample();
    taa.noteMotion();
    taa.consumeStationarySample();

    taa.invalidate();

    expect(taa.consumeStationarySample()).toEqual({ historyValid: false, blend: 0 });
  });

  it('seeds both physical histories from the current frame without relying on alternation', () => {
    for (const currentFrame of [0, 1]) {
      const fake = createTaaRoot();
      const resolver = new TaaResolver(fake.root, 8, 8, {
        submission: () => undefined,
        textureCreated: () => undefined,
        textureDestroyed: () => undefined,
      });
      const currentTexture = {
        texture: { id: 99 },
      } as unknown as TgpuTextureView<d.WgslTexture2d<d.F32>>;

      resolver.resolve(currentTexture, currentFrame, false);

      expect(fake.writtenHistoryIds).toHaveLength(2);
      expect([...fake.writtenHistoryIds].sort()).toEqual([0, 1]);
      resolver.destroy();
    }
  });
});
