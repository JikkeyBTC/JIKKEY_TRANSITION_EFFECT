import { createJellyPhysics, type PhysicsSnapshot, type Point2 } from './physics';
import { CANONICAL_POSES } from './physics-fixtures';
import type { JellyRenderer } from './renderer';

export type JellyFixtureState = 'off' | 'arch' | 'on';

export interface JellyFixturePose {
  readonly tick: number;
  readonly pose: readonly Point2[];
}

function clonePose(points: readonly Point2[]): readonly Point2[] {
  return points.map(({ x, y }) => ({ x, y }));
}

function verticalExtent(points: readonly Point2[]): number {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const point of points) {
    minimum = Math.min(minimum, point.y);
    maximum = Math.max(maximum, point.y);
  }
  return maximum - minimum;
}

function assertExactPose(
  label: string,
  actual: readonly Point2[] | undefined,
  expected: readonly Point2[],
): void {
  if (!actual || actual.length !== expected.length) {
    throw new Error(`${label} pose point count does not match the fixture contract`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const actualPoint = actual[index]!;
    const expectedPoint = expected[index]!;
    if (actualPoint.x !== expectedPoint.x || actualPoint.y !== expectedPoint.y) {
      throw new Error(
        `${label} pose diverged at point ${index}: `
        + `actual (${actualPoint.x}, ${actualPoint.y}), `
        + `expected (${expectedPoint.x}, ${expectedPoint.y})`,
      );
    }
  }
}

export function selectJellyFixturePose(state: JellyFixtureState): JellyFixturePose {
  if (state !== 'arch') return { tick: 0, pose: clonePose(CANONICAL_POSES[state]) };
  const physics = createJellyPhysics('off');
  physics.setTarget('on');
  const samples: Array<{
    readonly tick: number;
    readonly extent: number;
    readonly pose: readonly Point2[];
  }> = [{
    tick: 0,
    extent: verticalExtent(physics.snapshot.current),
    pose: clonePose(physics.snapshot.current),
  }];
  for (let tick = 1; tick <= 120; tick += 1) {
    const advanced = physics.advance(1 / 60);
    if (advanced !== 1) throw new Error(`Fixture physics advanced ${advanced} ticks at tick ${tick}`);
    const pose = clonePose(physics.snapshot.current);
    samples.push({ tick, extent: verticalExtent(pose), pose });
    if (samples.length < 3) continue;
    const before = samples.at(-3)!;
    const candidate = samples.at(-2)!;
    const after = samples.at(-1)!;
    if (before.extent < candidate.extent && candidate.extent >= after.extent) {
      return { tick: candidate.tick, pose: candidate.pose };
    }
  }
  throw new Error('No first arch peak was found within 120 fixed ticks');
}

export function verifyAndFreezeJellyFixturePose(options: {
  readonly state: JellyFixtureState;
  readonly fixture: JellyFixturePose;
  readonly snapshot: PhysicsSnapshot;
  readonly renderer: Pick<JellyRenderer, 'setPose'>;
  readonly uploadedPose: () => readonly Point2[] | undefined;
}): void {
  const { state, fixture, snapshot, renderer, uploadedPose } = options;
  if (snapshot.ticksSinceTargetChange !== fixture.tick) {
    throw new Error(
      `Live ${state} tick ${snapshot.ticksSinceTargetChange} does not match offline tick ${fixture.tick}`,
    );
  }
  assertExactPose(`Live ${state} physics`, snapshot.current, fixture.pose);
  assertExactPose(`Uploaded ${state} display`, uploadedPose(), snapshot.display);

  renderer.setPose(snapshot.current, true);
  assertExactPose(`Frozen ${state} renderer`, uploadedPose(), fixture.pose);
}
