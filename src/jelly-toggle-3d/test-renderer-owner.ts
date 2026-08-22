import type { JellyRenderer } from './renderer';
import type { Point2 } from './physics';

/** Test-route-only ownership shim; it is not exported from the public component entry. */
export interface TestRendererOwner {
  readonly active: JellyRenderer | undefined;
  wrap(renderer: JellyRenderer): JellyRenderer;
  poseFor(renderer: JellyRenderer): readonly Point2[] | undefined;
}

export function createTestRendererOwner(): TestRendererOwner {
  let active: JellyRenderer | undefined;
  const uploadedPoses = new WeakMap<JellyRenderer, readonly Point2[]>();

  return {
    get active() {
      return active;
    },

    poseFor(renderer) {
      const pose = uploadedPoses.get(renderer);
      return pose?.map(({ x, y }) => ({ x, y }));
    },

    wrap(renderer) {
      let destroyed = false;
      let wrapper!: JellyRenderer;
      wrapper = {
        device: renderer.device,
        stats: renderer.stats,
        lost: renderer.lost,
        resize(width, height, dpr) {
          const changed = renderer.resize(width, height, dpr);
          if (!destroyed) active = wrapper;
          return changed;
        },
        setPose(points, discontinuous) {
          renderer.setPose(points, discontinuous);
          uploadedPoses.set(wrapper, points.map(({ x, y }) => ({ x, y })));
        },
        draw: (options) => renderer.draw(options),
        resetHistory: () => renderer.resetHistory(),
        readDiagnostics: () => renderer.readDiagnostics(),
        destroy() {
          if (destroyed) return;
          destroyed = true;
          try {
            renderer.destroy();
          } finally {
            uploadedPoses.delete(wrapper);
            if (active === wrapper) active = undefined;
          }
        },
      };
      return wrapper;
    },
  };
}
