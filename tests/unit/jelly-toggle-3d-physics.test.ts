import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';

import { CANONICAL_POSES } from '../../src/jelly-toggle-3d/physics-fixtures';

type Target = 'off' | 'on';
type Point = Readonly<{ x: number; y: number }>;
type PhysicsModule = typeof import('../../src/jelly-toggle-3d/physics');

const C = {
  anchorX: -1,
  offX: -0.3,
  onX: 0.9,
  pointCount: 17,
  restLength: 1.9 / 16,
  yOffset: -0.03,
  endpointY: 0.05,
  substeps: 6,
  iterations: 16,
  damping: 0.01,
  bendingStrength: 0.1,
  archStrength: 2,
  endFlatStiffness: 0.05,
  bendingExponent: 1.2,
  archEdgeDeadzone: 0.01,
  segmentStiffness: 0.1,
  targetSmoothing: 0.08,
  tickSeconds: 1 / 60,
  settleTargetError: 0.0005,
  settleMaxPointMove: 0.001,
  settleMaxSegmentResidual: 0.0075,
  settleTicks: 4,
} as const;

function clone(points: readonly Point[]): Point[] {
  return points.map(({ x, y }) => ({ x, y }));
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const x = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

function projectDistance(points: Point[], inverseMass: Float32Array, i: number, j: number, rest: number, k: number): void {
  const a = points[i]!;
  const b = points[j]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-8) return;
  const w1 = inverseMass[i]!;
  const w2 = inverseMass[j]!;
  const sum = w1 + w2;
  if (sum <= 0) return;
  const difference = (length - rest) / length;
  const c1 = (w1 / sum) * k;
  const c2 = (w2 / sum) * k;
  points[i] = { x: a.x + dx * difference * c1, y: a.y + dy * difference * c1 };
  points[j] = { x: b.x - dx * difference * c2, y: b.y - dy * difference * c2 };
}

function maximumSegmentResidual(points: readonly Point[], excluded: readonly number[] = []): number {
  return Math.max(...points.slice(1).map((point, index) => excluded.includes(index)
    ? 0
    : Math.abs(Math.hypot(point.x - points[index]!.x, point.y - points[index]!.y) - C.restLength)));
}

function referenceTick(
  state: { points: Point[]; previous: Point[]; movingX: number },
  target: Target,
  onConstraintPass?: (kind: string, points: readonly Point[]) => void,
): number {
  const targetX = target === 'on' ? C.onX : C.offX;
  state.movingX += (targetX - state.movingX) * C.targetSmoothing;
  const compression = Math.max(0, 1 - Math.abs(state.movingX - C.anchorX) / 1.9);
  const h = C.tickSeconds / C.substeps;
  let finalDistancePassResidual = Number.POSITIVE_INFINITY;

  for (let substep = 0; substep < C.substeps; substep += 1) {
    for (let i = 0; i < C.pointCount; i += 1) {
      const point = state.points[i]!;
      if (i === 0) {
        state.points[i] = { x: C.anchorX, y: C.yOffset };
        state.previous[i] = { x: C.anchorX, y: C.yOffset };
      } else if (i === C.pointCount - 1) {
        state.points[i] = { x: state.movingX, y: C.endpointY };
        state.previous[i] = { x: state.movingX, y: C.endpointY };
      } else {
        const old = state.previous[i]!;
        const velocityX = (point.x - old.x) * (1 - C.damping);
        const velocityY = (point.y - old.y) * (1 - C.damping);
        const t = i / (C.pointCount - 1);
        const window = smoothstep(C.archEdgeDeadzone, 1 - C.archEdgeDeadzone, t)
          * smoothstep(C.archEdgeDeadzone, 1 - C.archEdgeDeadzone, 1 - t);
        const accelerationY = C.archStrength * Math.sin(Math.PI * t) * window * compression;
        state.previous[i] = point;
        state.points[i] = {
          x: point.x + velocityX,
          y: Math.max(C.yOffset, point.y + velocityY + accelerationY * h * h),
        };
      }
    }

    for (let iteration = 0; iteration < C.iterations; iteration += 1) {
      for (let i = 0; i < C.pointCount - 1; i += 1) {
        projectDistance(state.points, REFERENCE_INVERSE_MASS, i, i + 1, C.restLength, C.segmentStiffness);
      }
      if (substep === C.substeps - 1 && iteration === C.iterations - 1) {
        finalDistancePassResidual = maximumSegmentResidual(state.points);
      }
      onConstraintPass?.('distance', clone(state.points));
      for (let i = 1; i < C.pointCount - 1; i += 1) {
        const t = i / (C.pointCount - 1);
        const strength = (Math.abs(t - 0.5) * 2) ** C.bendingExponent;
        const k = C.bendingStrength * (0.05 + 0.95 * strength);
        projectDistance(state.points, REFERENCE_INVERSE_MASS, i - 1, i + 1, 2 * C.restLength, k);
      }
      onConstraintPass?.('bending', clone(state.points));
      state.points[1] = {
        x: state.points[1]!.x,
        y: state.points[1]!.y + (C.yOffset - state.points[1]!.y) * C.endFlatStiffness,
      };
      state.points[C.pointCount - 2] = {
        x: state.points[C.pointCount - 2]!.x,
        y: state.points[C.pointCount - 2]!.y + (C.yOffset - state.points[C.pointCount - 2]!.y) * C.endFlatStiffness,
      };
      onConstraintPass?.('end-flat', clone(state.points));
      state.points[0] = { x: C.anchorX, y: C.yOffset };
      state.points[C.pointCount - 1] = { x: state.movingX, y: C.endpointY };
    }
  }
  return finalDistancePassResidual;
}

const REFERENCE_INVERSE_MASS = Float32Array.from(
  { length: C.pointCount },
  (_, index) => index === 0 || index === C.pointCount - 1 ? 0 : 1,
);

function createReferenceState(): { points: Point[]; previous: Point[]; movingX: number } {
  const points = Array.from({ length: C.pointCount }, (_, index) => ({
    x: C.anchorX + (1.9 * index) / (C.pointCount - 1),
    y: C.yOffset,
  }));
  return { points, previous: clone(points), movingX: C.onX };
}

function referenceCanonical(target: Target): { points: readonly Point[]; ticks: number } {
  const state = createReferenceState();
  let consecutive = 0;
  for (let ticks = 1; ticks <= 480; ticks += 1) {
    const before = clone(state.points);
    referenceTick(state, target);
    const targetX = target === 'on' ? C.onX : C.offX;
    const maximumMove = Math.max(...state.points.map((point, index) =>
      Math.hypot(point.x - before[index]!.x, point.y - before[index]!.y)));
    const maximumResidual = maximumSegmentResidual(state.points);
    consecutive = Math.abs(state.movingX - targetX) <= C.settleTargetError
      && maximumMove <= C.settleMaxPointMove
      && maximumResidual <= C.settleMaxSegmentResidual
      ? consecutive + 1
      : 0;
    if (consecutive >= C.settleTicks) {
      const canonical = clone(state.points);
      canonical[0] = { x: C.anchorX, y: C.yOffset };
      canonical[C.pointCount - 1] = { x: targetX, y: C.endpointY };
      return { points: canonical, ticks };
    }
  }
  throw new Error(`Pinned reference did not settle for ${target} within 480 ticks`);
}

const REFERENCE_CANONICAL = {
  off: referenceCanonical('off'),
  on: referenceCanonical('on'),
} as const;

function referenceEquilibriumResidual(target: Target): number {
  const state = createReferenceState();
  for (let tick = 0; tick < 480; tick += 1) referenceTick(state, target);
  return maximumSegmentResidual(state.points);
}

function referenceFirstConstraintPasses(): readonly Point[] {
  const points = clone(REFERENCE_CANONICAL.off.points);
  const state = { points, previous: clone(points), movingX: C.offX };
  const phases: Point[] = [];
  referenceTick(state, 'on', (_kind, phasePoints) => {
    if (phases.length < 3) phases.push({ ...phasePoints[1]! });
  });
  return phases;
}

function referenceTransitionSettleTicks(from: Target, to: Target): { firstQualified: number; settled: number } {
  const points = clone(REFERENCE_CANONICAL[from].points);
  const state = { points, previous: clone(points), movingX: from === 'on' ? C.onX : C.offX };
  let consecutive = 0;
  let firstQualified = 0;
  for (let tick = 1; tick <= 120; tick += 1) {
    const before = clone(state.points);
    referenceTick(state, to);
    const qualifies = Math.abs(state.movingX - (to === 'on' ? C.onX : C.offX)) <= C.settleTargetError
      && Math.max(...state.points.map((point, index) => Math.hypot(
        point.x - before[index]!.x,
        point.y - before[index]!.y,
      ))) <= C.settleMaxPointMove
      && maximumSegmentResidual(state.points) <= C.settleMaxSegmentResidual;
    if (qualifies && firstQualified === 0) firstQualified = tick;
    consecutive = qualifies ? consecutive + 1 : 0;
    if (consecutive >= C.settleTicks) return { firstQualified, settled: tick };
  }
  throw new Error(`Reference transition ${from}->${to} did not settle`);
}

const REFERENCE_PHASE_FIXTURES = referenceFirstConstraintPasses();

let physicsModule: PhysicsModule;

beforeAll(async () => {
  physicsModule = await import('../../src/jelly-toggle-3d/physics');
});

describe('pinned jelly physics', () => {
  it('preserves provenance and exact dependency resolutions', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    expect(pkg.dependencies).toMatchObject({
      typegpu: '0.10.2',
      '@typegpu/sdf': '0.10.0',
      '@typegpu/noise': '0.10.0',
      'wgpu-matrix': '3.4.2',
    });
    expect(pkg.devDependencies).toMatchObject({
      'unplugin-typegpu': '0.10.2',
      '@webgpu/types': '0.1.69',
    });
    expect(readFileSync('THIRD_PARTY_NOTICES.md', 'utf8')).toContain('d4433e329697c4341a9f915f75dbd9608f3939fa');
  });

  it('locks 17-point canonical poses to an independent pinned reference', () => {
    expect(REFERENCE_CANONICAL.off.ticks).toBeLessThanOrEqual(480);
    expect(REFERENCE_CANONICAL.on.ticks).toBeLessThanOrEqual(480);
    expect(CANONICAL_POSES.off).toHaveLength(17);
    expect(CANONICAL_POSES.on).toHaveLength(17);
    for (const target of ['off', 'on'] as const) {
      CANONICAL_POSES[target].forEach((point, index) => {
        expect(point.x).toBeCloseTo(REFERENCE_CANONICAL[target].points[index]!.x, 12);
        expect(point.y).toBeCloseTo(REFERENCE_CANONICAL[target].points[index]!.y, 12);
      });
      const generated = physicsModule.generateCanonicalPose(target);
      generated.forEach((point, index) => {
        expect(point.x).toBeCloseTo(CANONICAL_POSES[target][index]!.x, 6);
        expect(point.y).toBeCloseTo(CANONICAL_POSES[target][index]!.y, 6);
      });
    }
    expect(CANONICAL_POSES.off[0]).toEqual({ x: -1, y: -0.03 });
    expect(CANONICAL_POSES.off[16]).toEqual({ x: -0.3, y: 0.05 });
    expect(CANONICAL_POSES.on[0]).toEqual({ x: -1, y: -0.03 });
    expect(CANONICAL_POSES.on[16]).toEqual({ x: 0.9, y: 0.05 });
  });

  it('documents the full final-pose equilibrium residual behind the 0.0075 ruling', () => {
    expect(referenceEquilibriumResidual('off')).toBe(0.007410221861037181);
    expect(referenceEquilibriumResidual('on')).toBe(0.004441286393921176);
  });

  it('documents the ON-to-OFF direct-settle cap ruling independently', () => {
    expect(referenceTransitionSettleTicks('on', 'off')).toEqual({ firstQualified: 106, settled: 109 });
  });

  it('runs distance, bending, and end-flat constraints in 6 x 16 ordered passes', () => {
    const calls: Array<{ kind: string; substep: number; iteration: number; points: readonly Point[] }> = [];
    const physics = physicsModule.createJellyPhysics('off', {
      onConstraintPass(event) {
        calls.push({ ...event, points: clone(event.points) });
      },
    });
    physics.setTarget('on');
    physics.advance(1 / 60);
    expect(calls).toHaveLength(6 * 16 * 3);
    expect(calls.map(({ kind }) => kind)).toEqual(Array.from({ length: 6 * 16 }, () => ['distance', 'bending', 'end-flat']).flat());
    expect(calls.filter(({ kind }) => kind === 'distance')).toHaveLength(96);
    expect(calls.filter(({ kind }) => kind === 'bending')).toHaveLength(96);
    expect(calls.filter(({ kind }) => kind === 'end-flat')).toHaveLength(96);
    expect(REFERENCE_PHASE_FIXTURES).toEqual([
      { x: -0.8797091692293368, y: -0.02898904171718879 },
      { x: -0.8797849822075344, y: -0.029072359638354594 },
      { x: -0.8797849822075344, y: -0.029118741656436863 },
    ]);
    expect(calls.slice(0, 3).map((call) => call.points[1])).toEqual(REFERENCE_PHASE_FIXTURES);
  });

  it('keeps identical fixed-tick state at 60/90/120/144 Hz', () => {
    const results = [60, 90, 120, 144].map((hz) => {
      const physics = physicsModule.createJellyPhysics('off');
      physics.setTarget('on');
      for (let frame = 0; frame < hz; frame += 1) physics.advance(1 / hz);
      return physics.snapshot.current;
    });
    expect(results.slice(1)).toEqual([results[0], results[0], results[0]]);
  });

  it('reverses without resetting position or velocity and same-target changes are no-ops', () => {
    const physics = physicsModule.createJellyPhysics('off');
    expect(physics.setTarget('off')).toBe(false);
    const idle = physics.snapshot;
    expect(physics.snapshot).toEqual(idle);
    expect(physics.setTarget('on')).toBe(true);
    physics.advance(15 / 60);
    const before = physics.snapshot;
    expect(physics.setTarget('off')).toBe(true);
    expect(physics.snapshot.current).toEqual(before.current);
    expect(physics.snapshot.previous).toEqual(before.previous);
  });

  it('interpolates display without mutating solver arrays', () => {
    const physics = physicsModule.createJellyPhysics('off');
    physics.setTarget('on');
    physics.advance(1.5 / 60);
    const snapshot = physics.snapshot;
    const expectedDisplay = physicsModule.interpolatePoints(snapshot.previous, snapshot.current, 0.5);
    snapshot.display.forEach((point, index) => {
      expect(point.x).toBeCloseTo(expectedDisplay[index]!.x, 12);
      expect(point.y).toBeCloseTo(expectedDisplay[index]!.y, 12);
    });
    expect(snapshot.current).not.toEqual(snapshot.display);
    const current = clone(snapshot.current);
    const previous = clone(snapshot.previous);
    physicsModule.interpolatePoints(snapshot.previous, snapshot.current, 0.25);
    expect(snapshot.current).toEqual(current);
    expect(snapshot.previous).toEqual(previous);
  });

  it('caps a long frame at 0.1 seconds and six fixed ticks', () => {
    const physics = physicsModule.createJellyPhysics('off');
    physics.setTarget('on');
    expect(physics.advance(10)).toBe(6);
    expect(physics.snapshot.ticksSinceTargetChange).toBe(6);
    expect(physics.advance(0)).toBe(0);
  });

  it('requires four consecutive settle-qualified ticks', () => {
    let qualified = 0;
    const physics = physicsModule.createJellyPhysics('off', {
      evaluateSettle(metrics) {
        qualified += 1;
        return metrics.ticksSinceTargetChange >= 2 && metrics.ticksSinceTargetChange <= 5;
      },
    });
    physics.setTarget('on');
    physics.advance(4 / 60);
    expect(physics.snapshot.settled).toBe(false);
    physics.advance(1 / 60);
    expect(qualified).toBe(5);
    expect(physics.snapshot.settled).toBe(true);
    expect(physics.snapshot.snapped).toBe(false);
  });

  it('settles direct moves normally and bounds every 15-tick reversal permutation', () => {
    for (const [from, to] of [['off', 'on'], ['on', 'off']] as const) {
      const direct = physicsModule.createJellyPhysics(from);
      direct.setTarget(to);
      let directTicks = 0;
      while (!direct.snapshot.settled && directTicks < 121) {
        direct.advance(1 / 60);
        directTicks += 1;
      }
      expect(directTicks, `${from}->${to}`).toBeLessThanOrEqual(110);
      expect(direct.snapshot.snapped).toBe(false);

      for (let reversalCount = 1; reversalCount <= 7; reversalCount += 1) {
        const physics = physicsModule.createJellyPhysics(from);
        let target: Target = to;
        physics.setTarget(target);
        for (let reversal = 0; reversal < reversalCount; reversal += 1) {
          for (let tick = 0; tick < 15; tick += 1) physics.advance(1 / 60);
          target = target === 'on' ? 'off' : 'on';
          physics.setTarget(target);
        }
        let ticks = 0;
        while (!physics.snapshot.settled && ticks < 121) {
          physics.advance(1 / 60);
          ticks += 1;
        }
        expect(ticks).toBeLessThanOrEqual(120);
        expect(physics.snapshot.current).toEqual(CANONICAL_POSES[target]);
      }
    }
  });

  it('uses the exact canonical pose at the 120-tick safety cap', () => {
    const physics = physicsModule.createJellyPhysics('off', { evaluateSettle: () => false });
    physics.setTarget('on');
    for (let tick = 0; tick < 120; tick += 1) physics.advance(1 / 60);
    expect(physics.snapshot).toMatchObject({
      current: CANONICAL_POSES.on,
      previous: CANONICAL_POSES.on,
      target: 'on',
      settled: true,
      snapped: true,
      ticksSinceTargetChange: 120,
    });
  });
});
