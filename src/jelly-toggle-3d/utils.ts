// Derived from WICG/html-in-canvas Examples/webgpu-jelly-slider/src/utils.ts
// at d4433e329697c4341a9f915f75dbd9608f3939fa (MIT).
import type { TgpuRoot, TgpuTexture } from 'typegpu';
import { d, std } from 'typegpu';

import { BoxIntersection } from './data-types';

export interface TextureResourceAccounting {
  textureCreated(): void;
  textureDestroyed(): void;
}

export interface RendererResourceAccounting extends TextureResourceAccounting {
  submission(): void;
  bufferCreated(): void;
  bufferDestroyed(): void;
}

export function rollbackCleanups(cleanups: Array<() => void>): void {
  while (cleanups.length > 0) {
    try {
      cleanups.pop()!();
    } catch {
      // Preserve the construction error and continue releasing earlier owners.
    }
  }
}

export function createTextureBundle<
  TTexture extends TgpuTexture,
  TEntry extends { texture: TTexture },
>(
  root: TgpuRoot,
  count: number,
  accounting: TextureResourceAccounting,
  createTexture: (index: number) => TTexture,
  createEntry: (texture: TTexture, index: number) => TEntry,
): TEntry[] {
  const entries: TEntry[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const texture = createTexture(index);
      accounting.textureCreated();
      try {
        // TypeGPU textures are lazy. Materializing here makes allocation part
        // of the transaction instead of deferring failure until the next draw.
        root.unwrap(texture);
        entries.push(createEntry(texture, index));
      } catch (cause) {
        texture.destroy();
        accounting.textureDestroyed();
        throw cause;
      }
    }
    return entries;
  } catch (cause) {
    destroyTextureEntries(entries, accounting);
    throw cause;
  }
}

export const fresnelSchlick = (cosTheta: number, ior1: number, ior2: number) => {
  'use gpu';
  const r0 = std.pow((ior1 - ior2) / (ior1 + ior2), 2.0);
  return r0 + (1.0 - r0) * std.pow(1.0 - cosTheta, 5.0);
};

export const beerLambert = (sigma: d.v3f, dist: number) => {
  'use gpu';
  return std.exp(std.mul(sigma, -dist));
};

export const intersectBox = (
  rayOrigin: d.v3f,
  rayDirection: d.v3f,
  boxMin: d.v3f,
  boxMax: d.v3f,
) => {
  'use gpu';
  const invDir = d.vec3f(1.0).div(rayDirection);
  const t1 = std.sub(boxMin, rayOrigin).mul(invDir);
  const t2 = std.sub(boxMax, rayOrigin).mul(invDir);
  const tMinVec = std.min(t1, t2);
  const tMaxVec = std.max(t1, t2);
  const tMin = std.max(tMinVec.x, tMinVec.y, tMinVec.z);
  const tMax = std.min(tMaxVec.x, tMaxVec.y, tMaxVec.z);
  const result = BoxIntersection();
  result.hit = tMax >= tMin && tMax >= 0.0;
  result.tMin = tMin;
  result.tMax = tMax;
  return result;
};

export function createColorTextures(
  root: TgpuRoot,
  width: number,
  height: number,
  accounting: RendererResourceAccounting,
) {
  return createTextureBundle(
    root,
    2,
    accounting,
    () => root['~unstable']
      .createTexture({ size: [width, height], format: 'rgba8unorm' })
      .$usage('storage', 'sampled', 'render'),
    (texture) => ({
      texture,
      write: texture.createView(d.textureStorage2d('rgba8unorm', 'write-only')),
      sampled: texture.createView(),
    }),
  );
}

export function createDiagnosticTextures(
  root: TgpuRoot,
  width: number,
  height: number,
  accounting: RendererResourceAccounting,
) {
  return createTextureBundle(
    root,
    2,
    accounting,
    () => root['~unstable']
      .createTexture({ size: [width, height], format: 'rgba16float' })
      .$usage('render'),
    (texture) => ({
      texture,
      render: texture.createView('render'),
    }),
  );
}

export function destroyTextureEntries(
  entries: readonly { texture: { destroy(): void } }[],
  accounting: TextureResourceAccounting,
): void {
  for (const entry of entries) {
    entry.texture.destroy();
    accounting.textureDestroyed();
  }
}
