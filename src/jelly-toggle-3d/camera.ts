// Derived from WICG/html-in-canvas Examples/webgpu-jelly-slider/src/camera.ts
// at d4433e329697c4341a9f915f75dbd9608f3939fa (MIT).
import type { TgpuRoot, TgpuUniform } from 'typegpu';
import { d } from 'typegpu';
import * as m from 'wgpu-matrix';

import {
  rollbackCleanups,
  type RendererResourceAccounting,
} from './utils';

const Camera = d.struct({
  view: d.mat4x4f,
  proj: d.mat4x4f,
  viewInv: d.mat4x4f,
  projInv: d.mat4x4f,
});

function halton(index: number, base: number): number {
  let result = 0;
  let fraction = 1 / base;
  let current = index;
  while (current > 0) {
    result += fraction * (current % base);
    current = Math.floor(current / base);
    fraction /= base;
  }
  return result;
}

export class CameraController {
  readonly #uniform: TgpuUniform<typeof Camera>;
  readonly #accounting: RendererResourceAccounting;
  #view: d.m4x4f;
  #viewInv: d.m4x4f;
  #baseProj: d.m4x4f;
  #width: number;
  #height: number;
  #destroyed = false;

  constructor(
    root: TgpuRoot,
    accounting: RendererResourceAccounting,
    position: d.v3f,
    target: d.v3f,
    up: d.v3f,
    fov: number,
    width: number,
    height: number,
    near = 0.1,
    far = 10,
  ) {
    this.#accounting = accounting;
    this.#width = width;
    this.#height = height;
    this.#view = m.mat4.lookAt(position, target, up, d.mat4x4f());
    this.#baseProj = m.mat4.perspective(fov, width / height, near, far, d.mat4x4f());
    this.#viewInv = m.mat4.invert(this.#view, d.mat4x4f());
    const projInv = m.mat4.invert(this.#baseProj, d.mat4x4f());
    const constructionCleanups: Array<() => void> = [];
    try {
      this.#uniform = root.createUniform(Camera, {
        view: this.#view,
        proj: this.#baseProj,
        viewInv: this.#viewInv,
        projInv,
      });
      this.#accounting.bufferCreated();
      constructionCleanups.push(() => {
        this.#uniform.buffer.destroy();
        this.#accounting.bufferDestroyed();
      });
      root.unwrap(this.#uniform.buffer);
      constructionCleanups.length = 0;
    } catch (cause) {
      rollbackCleanups(constructionCleanups);
      throw cause;
    }
  }

  jitter(index: number): void {
    const sample = Math.max(0, Math.floor(index)) + 1;
    const jitterX = ((halton(sample, 2) - 0.5) * 2) / this.#width;
    const jitterY = ((halton(sample, 3) - 0.5) * 2) / this.#height;
    const jitterMatrix = m.mat4.identity(d.mat4x4f());
    jitterMatrix[12] = jitterX;
    jitterMatrix[13] = jitterY;
    const jitteredProj = m.mat4.mul(jitterMatrix, this.#baseProj, d.mat4x4f());
    const jitteredProjInv = m.mat4.invert(jitteredProj, d.mat4x4f());
    this.#uniform.writePartial({ proj: jitteredProj, projInv: jitteredProjInv });
  }

  updateView(position: d.v3f, target: d.v3f, up: d.v3f): void {
    this.#view = m.mat4.lookAt(position, target, up, d.mat4x4f());
    this.#viewInv = m.mat4.invert(this.#view, d.mat4x4f());
    this.#uniform.writePartial({ view: this.#view, viewInv: this.#viewInv });
  }

  updateProjection(fov: number, width: number, height: number, near = 0.1, far = 100): void {
    const nextProjection = m.mat4.perspective(fov, width / height, near, far, d.mat4x4f());
    this.#uniform.writePartial({
      proj: nextProjection,
      projInv: m.mat4.invert(nextProjection, d.mat4x4f()),
    });
    this.#width = width;
    this.#height = height;
    this.#baseProj = nextProjection;
  }

  get cameraUniform(): TgpuUniform<typeof Camera> {
    return this.#uniform;
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.#uniform.buffer.destroy();
    this.#accounting.bufferDestroyed();
  }
}
