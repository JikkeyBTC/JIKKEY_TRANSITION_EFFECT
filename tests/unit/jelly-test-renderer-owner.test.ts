import { describe, expect, it, vi } from 'vitest';

import { createTestRendererOwner } from '../../src/jelly-toggle-3d/test-renderer-owner';
import type { JellyRenderer } from '../../src/jelly-toggle-3d/renderer';

function renderer(options: { readonly resizeError?: Error } = {}): JellyRenderer {
  const stats = {
    rafRequests: 0,
    submissions: 0,
    pipelinesCreated: 1,
    buffersCreated: 1,
    buffersDestroyed: 0,
    texturesCreated: 1,
    texturesDestroyed: 0,
    uncapturedErrors: 0,
  };
  return {
    device: { queue: {} } as GPUDevice,
    stats,
    lost: new Promise<GPUDeviceLostInfo>(() => undefined),
    resize: vi.fn(() => {
      if (options.resizeError) throw options.resizeError;
      return true;
    }),
    setPose: vi.fn(),
    draw: vi.fn(),
    resetHistory: vi.fn(),
    readDiagnostics: vi.fn(),
    destroy: vi.fn(() => {
      stats.buffersDestroyed = stats.buffersCreated;
      stats.texturesDestroyed = stats.texturesCreated;
    }),
  };
}

describe('test renderer ownership', () => {
  it('publishes only an accepted renderer and ignores stale candidate teardown', () => {
    const owner = createTestRendererOwner();
    const firstRaw = renderer();
    const first = owner.wrap(firstRaw);
    expect(owner.active).toBeUndefined();
    first.resize(88, 44, 2);
    expect(owner.active).toBe(first);

    const staleRaw = renderer();
    const stale = owner.wrap(staleRaw);
    stale.destroy();
    expect(owner.active).toBe(first);
    expect(staleRaw.destroy).toHaveBeenCalledOnce();

    first.destroy();
    expect(owner.active).toBeUndefined();
    expect(firstRaw.destroy).toHaveBeenCalledOnce();
  });

  it('never publishes a renderer whose controller acceptance resize fails', () => {
    const owner = createTestRendererOwner();
    const resizeError = new Error('stale resize failure');
    const failedRaw = renderer({ resizeError });
    const failed = owner.wrap(failedRaw);

    expect(() => failed.resize(88, 44, 2)).toThrow(resizeError);
    expect(owner.active).toBeUndefined();
    failed.destroy();
    expect(owner.active).toBeUndefined();
  });

  it('records only the latest pose uploaded through each accepted wrapper', () => {
    const owner = createTestRendererOwner();
    const first = owner.wrap(renderer());
    const stale = owner.wrap(renderer());
    first.resize(88, 44, 2);
    const firstPose = [{ x: -1, y: 2 }, { x: 3, y: 4 }];
    first.setPose(firstPose, false);
    firstPose[0]!.x = 99;
    expect(owner.poseFor(first)).toEqual([{ x: -1, y: 2 }, { x: 3, y: 4 }]);

    stale.setPose([{ x: 8, y: 9 }], true);
    expect(owner.poseFor(first)).toEqual([{ x: -1, y: 2 }, { x: 3, y: 4 }]);
    expect(owner.poseFor(stale)).toEqual([{ x: 8, y: 9 }]);
    stale.destroy();
    expect(owner.poseFor(stale)).toBeUndefined();
  });
});
