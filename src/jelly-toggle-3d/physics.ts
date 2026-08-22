// Derived from WICG/html-in-canvas Examples/webgpu-jelly-slider/src/slider.ts
// at d4433e329697c4341a9f915f75dbd9608f3939fa (MIT).
import { JELLY } from './constants';
import { CANONICAL_POSES } from './physics-fixtures';

export type JellyTarget = 'off' | 'on';
export type Point2 = Readonly<{ x: number; y: number }>;

export interface PhysicsSnapshot {
  readonly previous: readonly Point2[];
  readonly current: readonly Point2[];
  readonly display: readonly Point2[];
  readonly target: JellyTarget;
  readonly settled: boolean;
  readonly snapped: boolean;
  readonly ticksSinceTargetChange: number;
}

export interface JellyPhysics {
  readonly snapshot: PhysicsSnapshot;
  setTarget(target: JellyTarget): boolean;
  advance(elapsedSeconds: number): number;
  snap(target: JellyTarget): void;
}

export type ConstraintKind = 'distance' | 'bending' | 'end-flat';

export interface SettleMetrics {
  readonly targetError: number;
  readonly maxPointMove: number;
  readonly maxSegmentResidual: number;
  readonly ticksSinceTargetChange: number;
}

export interface PhysicsObserver {
  onConstraintPass?(event: Readonly<{
    kind: ConstraintKind;
    substep: number;
    iteration: number;
    points: readonly Point2[];
  }>): void;
  evaluateSettle?(metrics: SettleMetrics): boolean;
}

interface SolverState {
  points: Point2[];
  verletPrevious: Point2[];
  movingTargetX: number;
}

const inverseMass = Float32Array.from(
  { length: JELLY.pointCount },
  (_, index) => index === 0 || index === JELLY.pointCount - 1 ? 0 : 1,
);

function clonePoints(points: readonly Point2[]): Point2[] {
  return points.map(({ x, y }) => ({ x, y }));
}

function targetX(target: JellyTarget): number {
  return target === 'on' ? JELLY.onX : JELLY.offX;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const x = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return x * x * (3 - 2 * x);
}

function projectDistance(
  points: Point2[],
  i: number,
  j: number,
  rest: number,
  stiffness: number,
): void {
  const a = points[i]!;
  const b = points[j]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-8) return;

  const w1 = inverseMass[i]!;
  const w2 = inverseMass[j]!;
  const weightSum = w1 + w2;
  if (weightSum <= 0) return;

  const difference = (length - rest) / length;
  const c1 = (w1 / weightSum) * stiffness;
  const c2 = (w2 / weightSum) * stiffness;
  points[i] = {
    x: a.x + dx * difference * c1,
    y: a.y + dy * difference * c1,
  };
  points[j] = {
    x: b.x - dx * difference * c2,
    y: b.y - dy * difference * c2,
  };
}

function notifyConstraint(
  observer: PhysicsObserver | undefined,
  kind: ConstraintKind,
  substep: number,
  iteration: number,
  points: readonly Point2[],
): void {
  observer?.onConstraintPass?.({ kind, substep, iteration, points: clonePoints(points) });
}

function simulateTick(state: SolverState, target: JellyTarget, observer?: PhysicsObserver): void {
  const requestedX = targetX(target);
  state.movingTargetX += (requestedX - state.movingTargetX) * JELLY.targetSmoothing;
  const compression = Math.max(
    0,
    1 - Math.abs(state.movingTargetX - JELLY.anchorX) / 1.9,
  );
  const h = JELLY.tickSeconds / JELLY.substeps;
  const damp = Math.min(0.999, Math.max(0, JELLY.damping));

  for (let substep = 0; substep < JELLY.substeps; substep += 1) {
    for (let i = 0; i < JELLY.pointCount; i += 1) {
      const point = state.points[i]!;
      if (i === 0) {
        state.points[i] = { x: JELLY.anchorX, y: JELLY.yOffset };
        state.verletPrevious[i] = { x: JELLY.anchorX, y: JELLY.yOffset };
        continue;
      }
      if (i === JELLY.pointCount - 1) {
        state.points[i] = { x: state.movingTargetX, y: JELLY.endpointY };
        state.verletPrevious[i] = { x: state.movingTargetX, y: JELLY.endpointY };
        continue;
      }

      const previous = state.verletPrevious[i]!;
      const velocityX = (point.x - previous.x) * (1 - damp);
      const velocityY = (point.y - previous.y) * (1 - damp);
      const t = i / (JELLY.pointCount - 1);
      const window = smoothstep(JELLY.archEdgeDeadzone, 1 - JELLY.archEdgeDeadzone, t)
        * smoothstep(JELLY.archEdgeDeadzone, 1 - JELLY.archEdgeDeadzone, 1 - t);
      const profile = Math.sin(Math.PI * t) * window;
      const accelerationY = JELLY.archStrength * profile * compression;

      state.verletPrevious[i] = point;
      state.points[i] = {
        x: point.x + velocityX,
        y: Math.max(JELLY.yOffset, point.y + velocityY + accelerationY * h * h),
      };
    }

    for (let iteration = 0; iteration < JELLY.constraintIterations; iteration += 1) {
      for (let i = 0; i < JELLY.pointCount - 1; i += 1) {
        projectDistance(state.points, i, i + 1, JELLY.restLength, JELLY.segmentStiffness);
      }
      notifyConstraint(observer, 'distance', substep, iteration, state.points);

      for (let i = 1; i < JELLY.pointCount - 1; i += 1) {
        const t = i / (JELLY.pointCount - 1);
        const distanceFromCenter = Math.abs(t - 0.5) * 2;
        const strength = distanceFromCenter ** JELLY.bendingExponent;
        const stiffness = JELLY.bendingStrength * (0.05 + 0.95 * strength);
        projectDistance(state.points, i - 1, i + 1, 2 * JELLY.restLength, stiffness);
      }
      notifyConstraint(observer, 'bending', substep, iteration, state.points);

      const count = Math.min(JELLY.endFlatCount, JELLY.pointCount - 2);
      for (let i = 1; i <= count; i += 1) {
        const point = state.points[i]!;
        state.points[i] = {
          x: point.x,
          y: point.y + (JELLY.yOffset - point.y) * JELLY.endFlatStiffness,
        };
      }
      for (let i = JELLY.pointCount - 1 - count; i < JELLY.pointCount - 1; i += 1) {
        const point = state.points[i]!;
        state.points[i] = {
          x: point.x,
          y: point.y + (JELLY.yOffset - point.y) * JELLY.endFlatStiffness,
        };
      }
      notifyConstraint(observer, 'end-flat', substep, iteration, state.points);

      state.points[0] = { x: JELLY.anchorX, y: JELLY.yOffset };
      state.points[JELLY.pointCount - 1] = { x: state.movingTargetX, y: JELLY.endpointY };
    }
  }
}

function settleMetrics(
  pointsBeforeTick: readonly Point2[],
  state: SolverState,
  target: JellyTarget,
  ticksSinceTargetChange: number,
): SettleMetrics {
  let maxPointMove = 0;
  let maxSegmentResidual = 0;
  for (let i = 0; i < state.points.length; i += 1) {
    const point = state.points[i]!;
    const before = pointsBeforeTick[i]!;
    maxPointMove = Math.max(maxPointMove, Math.hypot(point.x - before.x, point.y - before.y));
    if (i > 0) {
      const previous = state.points[i - 1]!;
      maxSegmentResidual = Math.max(
        maxSegmentResidual,
        Math.abs(Math.hypot(point.x - previous.x, point.y - previous.y) - JELLY.restLength),
      );
    }
  }
  return {
    targetError: Math.abs(state.movingTargetX - targetX(target)),
    maxPointMove,
    maxSegmentResidual,
    ticksSinceTargetChange,
  };
}

function defaultSettleEvaluation(metrics: SettleMetrics): boolean {
  return metrics.targetError <= JELLY.settleTargetError
    && metrics.maxPointMove <= JELLY.settleMaxPointMove
    && metrics.maxSegmentResidual <= JELLY.settleMaxSegmentResidual;
}

function canonicalize(points: readonly Point2[], target: JellyTarget): readonly Point2[] {
  const result = clonePoints(points);
  result[0] = { x: JELLY.anchorX, y: JELLY.yOffset };
  result[JELLY.pointCount - 1] = { x: targetX(target), y: JELLY.endpointY };
  return result;
}

function initialReferenceState(): SolverState {
  const points = Array.from({ length: JELLY.pointCount }, (_, index) => ({
    x: JELLY.anchorX + (1.9 * index) / (JELLY.pointCount - 1),
    y: JELLY.yOffset,
  }));
  return { points, verletPrevious: clonePoints(points), movingTargetX: JELLY.onX };
}

export function generateCanonicalPose(target: JellyTarget): readonly Point2[] {
  const state = initialReferenceState();
  let consecutiveSettleTicks = 0;
  for (let tick = 1; tick <= JELLY.canonicalLimitTicks; tick += 1) {
    const before = clonePoints(state.points);
    simulateTick(state, target);
    consecutiveSettleTicks = defaultSettleEvaluation(settleMetrics(before, state, target, tick))
      ? consecutiveSettleTicks + 1
      : 0;
    if (consecutiveSettleTicks >= JELLY.settleTicks) return canonicalize(state.points, target);
  }
  throw new Error(`Canonical ${target} pose did not settle within ${JELLY.canonicalLimitTicks} ticks`);
}

export function interpolatePoints(
  previous: readonly Point2[],
  current: readonly Point2[],
  alpha: number,
): readonly Point2[] {
  if (previous.length !== current.length) throw new Error('Point arrays must have equal lengths');
  const amount = Math.min(1, Math.max(0, Number.isFinite(alpha) ? alpha : 0));
  return previous.map((point, index) => {
    const next = current[index]!;
    return {
      x: point.x + (next.x - point.x) * amount,
      y: point.y + (next.y - point.y) * amount,
    };
  });
}

export function createJellyPhysics(initial: JellyTarget, observer?: PhysicsObserver): JellyPhysics {
  let target = initial;
  let current = clonePoints(CANONICAL_POSES[initial]);
  let previous = clonePoints(current);
  const state: SolverState = {
    points: current,
    verletPrevious: clonePoints(current),
    movingTargetX: targetX(initial),
  };
  let accumulatorSeconds = 0;
  let settled = true;
  let snapped = false;
  let ticksSinceTargetChange = 0;
  let consecutiveSettleTicks: number = JELLY.settleTicks;

  const replaceWithCanonical = (nextTarget: JellyTarget, safetySnap: boolean): void => {
    current = clonePoints(CANONICAL_POSES[nextTarget]);
    previous = clonePoints(current);
    state.points = current;
    state.verletPrevious = clonePoints(current);
    state.movingTargetX = targetX(nextTarget);
    accumulatorSeconds = 0;
    consecutiveSettleTicks = JELLY.settleTicks;
    settled = true;
    snapped = safetySnap;
  };

  return {
    get snapshot(): PhysicsSnapshot {
      const currentCopy = clonePoints(current);
      const previousCopy = clonePoints(previous);
      return {
        previous: previousCopy,
        current: currentCopy,
        display: settled
          ? clonePoints(currentCopy)
          : interpolatePoints(previousCopy, currentCopy, accumulatorSeconds / JELLY.tickSeconds),
        target,
        settled,
        snapped,
        ticksSinceTargetChange,
      };
    },

    setTarget(nextTarget: JellyTarget): boolean {
      if (nextTarget === target) return false;
      target = nextTarget;
      settled = false;
      snapped = false;
      ticksSinceTargetChange = 0;
      consecutiveSettleTicks = 0;
      return true;
    },

    advance(elapsedSeconds: number): number {
      if (settled) return 0;
      const finiteElapsed = Number.isFinite(elapsedSeconds) ? elapsedSeconds : 0;
      accumulatorSeconds += Math.min(Math.max(finiteElapsed, 0), JELLY.maxElapsedSeconds);
      const availableTicks = Math.floor((accumulatorSeconds + 1e-12) / JELLY.tickSeconds);
      const ticksToRun = Math.min(availableTicks, JELLY.maxTicksPerFrame);
      accumulatorSeconds -= ticksToRun * JELLY.tickSeconds;
      if (availableTicks > JELLY.maxTicksPerFrame) {
        accumulatorSeconds %= JELLY.tickSeconds;
      }
      if (Math.abs(accumulatorSeconds) < 1e-12) accumulatorSeconds = 0;

      let executed = 0;
      for (; executed < ticksToRun && !settled; executed += 1) {
        previous = clonePoints(current);
        simulateTick(state, target, observer);
        current = state.points;
        ticksSinceTargetChange += 1;
        const metrics = settleMetrics(previous, state, target, ticksSinceTargetChange);
        const qualifies = observer?.evaluateSettle
          ? observer.evaluateSettle(metrics)
          : defaultSettleEvaluation(metrics);
        consecutiveSettleTicks = qualifies ? consecutiveSettleTicks + 1 : 0;
        if (consecutiveSettleTicks >= JELLY.settleTicks) {
          replaceWithCanonical(target, false);
        } else if (ticksSinceTargetChange >= JELLY.safetyTicks) {
          replaceWithCanonical(target, true);
        }
      }
      return executed;
    },

    snap(nextTarget: JellyTarget): void {
      target = nextTarget;
      ticksSinceTargetChange = 0;
      replaceWithCanonical(nextTarget, false);
    },
  };
}
