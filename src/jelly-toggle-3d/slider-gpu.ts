// Derived from WICG/html-in-canvas Examples/webgpu-jelly-slider/src/slider.ts
// at d4433e329697c4341a9f915f75dbd9608f3939fa (MIT).
import { sdBezier } from '@typegpu/sdf';
import type {
  SampledFlag,
  StorageFlag,
  TgpuBuffer,
  TgpuGuardedComputePipeline,
  TgpuRoot,
  TgpuTexture,
  TgpuUniform,
} from 'typegpu';
import { d, std } from 'typegpu';

import { JELLY } from './constants';
import type { Point2 } from './physics';
import type { RendererResourceAccounting } from './utils';

export const BEZIER_TEXTURE_SIZE = [256, 128] as const;

export class SliderGpu {
  readonly pointsBuffer: TgpuBuffer<d.WgslArray<d.Vec2f>> & StorageFlag;
  readonly controlPointsBuffer: TgpuBuffer<d.WgslArray<d.Vec2f>> & StorageFlag;
  readonly normalsBuffer: TgpuBuffer<d.WgslArray<d.Vec2f>> & StorageFlag;
  readonly bezierTexture: TgpuTexture<{
    size: typeof BEZIER_TEXTURE_SIZE;
    format: 'rgba16float';
  }> & SampledFlag & StorageFlag;
  readonly endCapUniform: TgpuUniform<d.Vec4f>;
  readonly bbox: readonly [top: number, right: number, bottom: number, left: number];

  readonly #accounting: RendererResourceAccounting;
  readonly #computeBezierPipeline: TgpuGuardedComputePipeline<[number, number]>;
  #points: d.v2f[];
  #controlPoints: d.v2f[];
  #normals: d.v2f[];
  #destroyed = false;

  constructor(
    root: TgpuRoot,
    accounting: RendererResourceAccounting,
    initialPoints: readonly Point2[],
  ) {
    if (initialPoints.length !== JELLY.pointCount) {
      throw new Error(`Expected ${JELLY.pointCount} jelly points, received ${initialPoints.length}`);
    }
    this.#accounting = accounting;
    this.#points = initialPoints.map(({ x, y }) => d.vec2f(x, y));
    this.#normals = Array.from({ length: JELLY.pointCount }, () => d.vec2f(0, 1));
    this.#controlPoints = Array.from(
      { length: JELLY.pointCount - 1 },
      (_, index) => {
        const a = this.#points[index]!;
        const b = this.#points[index + 1]!;
        return d.vec2f((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
      },
    );
    this.#computeNormals();
    this.#computeControlPoints();

    this.pointsBuffer = root
      .createBuffer(d.arrayOf(d.vec2f, JELLY.pointCount), this.#points)
      .$usage('storage')
      .$name('jelly points');
    this.controlPointsBuffer = root
      .createBuffer(d.arrayOf(d.vec2f, JELLY.pointCount - 1), this.#controlPoints)
      .$usage('storage')
      .$name('jelly control points');
    this.normalsBuffer = root
      .createBuffer(d.arrayOf(d.vec2f, JELLY.pointCount), this.#normals)
      .$usage('storage')
      .$name('jelly normals');
    accounting.bufferCreated();
    accounting.bufferCreated();
    accounting.bufferCreated();

    this.bezierTexture = root['~unstable']
      .createTexture({ size: BEZIER_TEXTURE_SIZE, format: 'rgba16float' })
      .$usage('sampled', 'storage', 'render')
      .$name('jelly quadratic bezier sdf');
    accounting.textureCreated();

    const secondLast = this.#points[JELLY.pointCount - 2]!;
    const last = this.#points[JELLY.pointCount - 1]!;
    this.endCapUniform = root.createUniform(
      d.vec4f,
      d.vec4f(secondLast.x, secondLast.y, last.x, last.y),
    );
    this.endCapUniform.$name('jelly end cap');
    accounting.bufferCreated();

    const bezierWriteView = this.bezierTexture.createView(
      d.textureStorage2d('rgba16float', 'write-only'),
    );
    const pointsView = this.pointsBuffer.as('readonly');
    const controlPointsView = this.controlPointsBuffer.as('readonly');
    const totalLength = JELLY.onX - JELLY.anchorX;
    const left = JELLY.anchorX - totalLength * 0.01;
    const right = JELLY.onX + totalLength * 0.1;
    const bottom = -0.3;
    const top = 0.65;
    this.bbox = [top, right, bottom, left];

    this.#computeBezierPipeline = root.createGuardedComputePipeline((x, y) => {
      'use gpu';
      const size = std.textureDimensions(bezierWriteView.$);
      const pixelUV = d.vec2f(x, y).add(0.5).div(d.vec2f(size));
      const sliderPos = d.vec2f(
        left + pixelUV.x * (right - left),
        top - pixelUV.y * (top - bottom),
      );
      let minDist = d.f32(1e10);
      let closestSegment = d.i32(0);
      let closestT = d.f32(0);
      const epsilon = d.f32(0.03);
      const xOffset = d.vec2f(epsilon, 0.0);
      const yOffset = d.vec2f(0.0, epsilon);
      let xPlusDist = d.f32(1e10);
      let xMinusDist = d.f32(1e10);
      let yPlusDist = d.f32(1e10);
      let yMinusDist = d.f32(1e10);

      for (let i = 0; i < pointsView.$.length - 1; i++) {
        const a = pointsView.$[i]!;
        const b = pointsView.$[i + 1]!;
        const control = controlPointsView.$[i]!;
        const dist = sdBezier(sliderPos, a, control, b);
        if (dist < minDist) {
          minDist = dist;
          closestSegment = i;
          const ab = b.sub(a);
          const ap = sliderPos.sub(a);
          const abLength = std.length(ab);
          if (abLength > 0.0) {
            closestT = std.clamp(std.dot(ap, ab) / (abLength * abLength), 0.0, 1.0);
          } else {
            closestT = 0.0;
          }
        }
        xPlusDist = std.min(xPlusDist, sdBezier(sliderPos.add(xOffset), a, control, b));
        xMinusDist = std.min(xMinusDist, sdBezier(sliderPos.sub(xOffset), a, control, b));
        yPlusDist = std.min(yPlusDist, sdBezier(sliderPos.add(yOffset), a, control, b));
        yMinusDist = std.min(yMinusDist, sdBezier(sliderPos.sub(yOffset), a, control, b));
      }

      const overallProgress = (d.f32(closestSegment) + closestT)
        / d.f32(pointsView.$.length - 1);
      const normalX = (xPlusDist - xMinusDist) / (2.0 * epsilon);
      const normalY = (yPlusDist - yMinusDist) / (2.0 * epsilon);
      std.textureStore(
        bezierWriteView.$,
        d.vec2u(x, y),
        d.vec4f(minDist, overallProgress, normalX, normalY),
      );
    });
    accounting.bufferCreated();

    this.setPose(initialPoints);
  }

  setPose(points: readonly Point2[]): void {
    if (this.#destroyed) throw new Error('Cannot upload a pose to a destroyed renderer');
    if (points.length !== JELLY.pointCount) {
      throw new Error(`Expected ${JELLY.pointCount} jelly points, received ${points.length}`);
    }
    this.#points = points.map(({ x, y }) => d.vec2f(x, y));
    this.#computeNormals();
    this.#computeControlPoints();
    this.pointsBuffer.write(this.#points);
    this.controlPointsBuffer.write(this.#controlPoints);
    this.normalsBuffer.write(this.#normals);
    const secondLast = this.#points[JELLY.pointCount - 2]!;
    const last = this.#points[JELLY.pointCount - 1]!;
    this.endCapUniform.write(d.vec4f(secondLast.x, secondLast.y, last.x, last.y));
    this.#computeBezierPipeline.dispatchThreads(...BEZIER_TEXTURE_SIZE);
  }

  destroy(): void {
    if (this.#destroyed) return;
    this.#destroyed = true;
    this.pointsBuffer.destroy();
    this.controlPointsBuffer.destroy();
    this.normalsBuffer.destroy();
    this.endCapUniform.buffer.destroy();
    this.#computeBezierPipeline.sizeUniform.buffer.destroy();
    for (let index = 0; index < 5; index += 1) this.#accounting.bufferDestroyed();
    this.bezierTexture.destroy();
    this.#accounting.textureDestroyed();
  }

  #computeNormals(): void {
    const epsilon = 1e-6;
    for (let i = 0; i < this.#points.length; i += 1) {
      let dx: number;
      let dy: number;
      if (i === 0) {
        dx = this.#points[1]!.x - this.#points[0]!.x;
        dy = this.#points[1]!.y - this.#points[0]!.y;
      } else if (i === this.#points.length - 1) {
        dx = this.#points[i]!.x - this.#points[i - 1]!.x;
        dy = this.#points[i]!.y - this.#points[i - 1]!.y;
      } else {
        dx = this.#points[i + 1]!.x - this.#points[i - 1]!.x;
        dy = this.#points[i + 1]!.y - this.#points[i - 1]!.y;
      }
      let length = Math.hypot(dx, dy);
      if (length < epsilon && i > 0) {
        dx = this.#points[i]!.x - this.#points[i - 1]!.x;
        dy = this.#points[i]!.y - this.#points[i - 1]!.y;
        length = Math.hypot(dx, dy);
      }
      if (length < epsilon && i < this.#points.length - 1) {
        dx = this.#points[i + 1]!.x - this.#points[i]!.x;
        dy = this.#points[i + 1]!.y - this.#points[i]!.y;
        length = Math.hypot(dx, dy);
      }
      this.#normals[i] = length < epsilon
        ? (i > 0 ? this.#normals[i - 1]! : d.vec2f(0, 1))
        : d.vec2f(-dy / length, dx / length);
    }
  }

  #computeControlPoints(): void {
    for (let i = 0; i < this.#points.length - 1; i += 1) {
      const a = this.#points[i]!;
      const b = this.#points[i + 1]!;
      const normalA = this.#normals[i]!;
      const normalB = this.#normals[i + 1]!;
      const midpoint = d.vec2f((a.x + b.x) * 0.5, (a.y + b.y) * 0.5);
      if (i === 0 || i === this.#points.length - 2) {
        this.#controlPoints[i] = midpoint;
        continue;
      }
      const dot = normalA.x * normalB.x + normalA.y * normalB.y;
      if (dot > 0.99) {
        this.#controlPoints[i] = midpoint;
        continue;
      }
      const tangentA = d.vec2f(normalA.y, -normalA.x);
      const tangentB = d.vec2f(normalB.y, -normalB.x);
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const denominator = tangentA.x * tangentB.y - tangentA.y * tangentB.x;
      if (Math.abs(denominator) <= 1e-6) {
        this.#controlPoints[i] = midpoint;
        continue;
      }
      const t = (dx * tangentB.y - dy * tangentB.x) / denominator;
      this.#controlPoints[i] = d.vec2f(a.x + t * tangentA.x, a.y + t * tangentA.y);
    }
  }
}
