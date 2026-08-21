export interface JellyBody {
  readonly position: number;
  readonly velocity: number;
}

export interface JellyState {
  readonly head: JellyBody;
  readonly tail: JellyBody;
  readonly settledFrames: number;
  readonly accumulatorSeconds: number;
}

export interface JellyGeometry {
  readonly trailStartX: number;
  readonly headCenterX: number;
  readonly controlX: number;
  readonly controlY: number;
  readonly trailWidth: number;
  readonly headRadiusX: number;
  readonly headRadiusY: number;
}

const LEFT_POSITION = 15;
const RIGHT_POSITION = 37;
const FIXED_STEP_SECONDS = 1 / 120;
const MAX_SUBSTEPS = 6;
const SETTLED_POSITION_EPSILON = 0.02;
const SETTLED_VELOCITY_EPSILON = 0.05;
const SETTLED_FRAME_COUNT = 3;

function stepBody(
  body: JellyBody,
  target: number,
  stiffness: number,
  damping: number,
  deltaSeconds: number,
): JellyBody {
  const acceleration = (target - body.position) * stiffness - body.velocity * damping;
  const velocity = body.velocity + acceleration * deltaSeconds;
  return {
    position: body.position + velocity * deltaSeconds,
    velocity,
  };
}

function bodyIsSettled(body: JellyBody, target: number): boolean {
  return Math.abs(body.position - target) < SETTLED_POSITION_EPSILON
    && Math.abs(body.velocity) < SETTLED_VELOCITY_EPSILON;
}

export function jellyTarget(checked: boolean): number {
  return checked ? RIGHT_POSITION : LEFT_POSITION;
}

export function createJellyState(checked: boolean): JellyState {
  const position = jellyTarget(checked);
  return {
    head: { position, velocity: 0 },
    tail: { position, velocity: 0 },
    settledFrames: SETTLED_FRAME_COUNT,
    accumulatorSeconds: 0,
  };
}

export function isJellySettled(state: JellyState, target: number): boolean {
  return state.settledFrames >= SETTLED_FRAME_COUNT
    && bodyIsSettled(state.head, target)
    && bodyIsSettled(state.tail, target);
}

export function stepJellyState(
  state: JellyState,
  target: number,
  deltaSeconds: number,
): JellyState {
  const finiteDelta = Number.isFinite(deltaSeconds) ? deltaSeconds : 0;
  const clampedDelta = Math.min(
    Math.max(finiteDelta, 0),
    FIXED_STEP_SECONDS * MAX_SUBSTEPS,
  );
  const availableSeconds = state.accumulatorSeconds + clampedDelta;
  const substeps = Math.min(
    MAX_SUBSTEPS,
    Math.floor((availableSeconds + 1e-12) / FIXED_STEP_SECONDS),
  );
  let accumulatorSeconds = availableSeconds - substeps * FIXED_STEP_SECONDS;
  if (Math.abs(accumulatorSeconds) < 1e-12) accumulatorSeconds = 0;
  let head = state.head;
  let tail = state.tail;
  let settledFrames = state.settledFrames;

  for (let step = 0; step < substeps; step += 1) {
    head = stepBody(head, target, 360, 24, FIXED_STEP_SECONDS);
    tail = stepBody(tail, target, 200, 18, FIXED_STEP_SECONDS);
    settledFrames = bodyIsSettled(head, target) && bodyIsSettled(tail, target)
      ? settledFrames + 1
      : 0;
    if (settledFrames >= SETTLED_FRAME_COUNT) return createJellyState(target === RIGHT_POSITION);
  }
  return { head, tail, settledFrames, accumulatorSeconds };
}

export function createJellyGeometry(state: JellyState): JellyGeometry {
  const separation = Math.abs(state.head.position - state.tail.position);
  const speed = Math.max(Math.abs(state.head.velocity), Math.abs(state.tail.velocity));
  const squeeze = Math.min(3, separation * 0.35 + speed * 0.004);
  return {
    trailStartX: state.tail.position,
    headCenterX: state.head.position,
    controlX: (state.head.position + state.tail.position) / 2,
    controlY: 15 - Math.min(2.4, separation * 0.48),
    trailWidth: Math.max(8, 10.5 - separation * 0.25),
    headRadiusX: 9.5 + squeeze,
    headRadiusY: 9.5 - squeeze * 0.45,
  };
}
