import { describe, expect, it } from 'vitest';
import {
  createJellyGeometry,
  createJellyState,
  isJellySettled,
  stepJellyState,
} from '../../src/jelly-toggle/physics';

describe('jelly toggle physics', () => {
  it('starts at the requested side without residual motion', () => {
    const state = createJellyState(true);

    expect(state).toEqual({
      head: { position: 37, velocity: 0 },
      tail: { position: 37, velocity: 0 },
      settledFrames: 3,
      accumulatorSeconds: 0,
    });
    expect(isJellySettled(state, 37)).toBe(true);
  });

  it('stretches toward the target, overshoots, then settles exactly', () => {
    let state = createJellyState(false);
    const headPositions: number[] = [];

    for (let frame = 0; frame < 180; frame += 1) {
      state = stepJellyState(state, 37, 1 / 60);
      headPositions.push(state.head.position);
      if (isJellySettled(state, 37)) break;
    }

    expect(headPositions[0]).toBeGreaterThan(15);
    expect(state.head.position).toBeGreaterThan(state.tail.position - 0.001);
    expect(Math.max(...headPositions)).toBeGreaterThan(37);
    expect(state).toEqual({
      head: { position: 37, velocity: 0 },
      tail: { position: 37, velocity: 0 },
      settledFrames: 3,
      accumulatorSeconds: 0,
    });
  });

  it('caps long frame gaps before integrating the springs', () => {
    const state = stepJellyState(createJellyState(false), 37, 1);

    expect(Number.isFinite(state.head.position)).toBe(true);
    expect(Number.isFinite(state.tail.position)).toBe(true);
    expect(state.head.position).toBeGreaterThan(15);
    expect(state.head.position).toBeLessThan(40);
    expect(state.tail.position).toBeGreaterThan(15);
    expect(state.tail.position).toBeLessThan(40);
  });

  it('produces the same trajectory at common display cadences', () => {
    const simulate = (refreshRate: number) => {
      let state = createJellyState(false);
      for (let frame = 0; frame < refreshRate / 2; frame += 1) {
        state = stepJellyState(state, 37, 1 / refreshRate);
      }
      return state;
    };
    const reference = simulate(120);

    for (const refreshRate of [60, 90, 144]) {
      const state = simulate(refreshRate);
      expect(state.head.position).toBeCloseTo(reference.head.position, 10);
      expect(state.head.velocity).toBeCloseTo(reference.head.velocity, 10);
      expect(state.tail.position).toBeCloseTo(reference.tail.position, 10);
      expect(state.tail.velocity).toBeCloseTo(reference.tail.velocity, 10);
      expect(state.settledFrames).toBe(reference.settledFrames);
    }
  });

  it('turns spring separation into a squeezed head and curved trail', () => {
    const geometry = createJellyGeometry({
      head: { position: 29, velocity: 90 },
      tail: { position: 24, velocity: 45 },
      settledFrames: 0,
      accumulatorSeconds: 0,
    });

    expect(geometry.trailStartX).toBe(24);
    expect(geometry.headCenterX).toBe(29);
    expect(geometry.controlY).toBeLessThan(15);
    expect(geometry.headRadiusX).toBeGreaterThan(geometry.headRadiusY);
    expect(geometry.trailWidth).toBeGreaterThanOrEqual(8);
    expect(geometry.trailWidth).toBeLessThanOrEqual(10.5);
  });

  it('keeps an idle thumb circular without an arched trail', () => {
    const geometry = createJellyGeometry(createJellyState(true));

    expect(geometry.controlY).toBe(15);
    expect(geometry.headRadiusX).toBe(geometry.headRadiusY);
    expect(geometry.trailStartX).toBe(37);
    expect(geometry.headCenterX).toBe(37);
  });
});
