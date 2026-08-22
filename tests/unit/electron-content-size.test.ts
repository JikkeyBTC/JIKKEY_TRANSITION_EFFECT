import { describe, expect, it, vi } from 'vitest';
import type { ElectronApplication, Page } from 'playwright';

import {
  correctedContentSizeRequest,
  launchPreparedJellyFixtureWindow,
} from '../support/electron-content-size';

describe('measured Electron content-size correction', () => {
  it('subtracts the measured forced-DPR height excess instead of hardcoding an OS offset', () => {
    expect(correctedContentSizeRequest(
      { width: 800, height: 600 },
      { width: 800, height: 603 },
      { width: 800, height: 600 },
    )).toEqual({ width: 800, height: 597 });
  });

  it('carries the measured residual into the next bounded request on both axes', () => {
    expect(correctedContentSizeRequest(
      { width: 801, height: 598 },
      { width: 799, height: 601 },
      { width: 800, height: 600 },
    )).toEqual({ width: 802, height: 597 });
  });

  it('prepares both diagnostic and production parity launch paths before capture', async () => {
    const paths = ['diagnostic', 'production parity'] as const;
    for (const path of paths) {
      const waitFor = vi.fn(async () => undefined);
      const page = {
        locator: vi.fn(() => ({ waitFor })),
        evaluate: vi.fn()
          .mockResolvedValueOnce({ width: 800, height: 603 })
          .mockResolvedValueOnce({ width: 800, height: 600 }),
        waitForFunction: vi.fn(async () => undefined),
      } as unknown as Page;
      const app = {
        firstWindow: vi.fn(async () => page),
        evaluate: vi.fn(async () => undefined),
        close: vi.fn(async () => undefined),
      } as unknown as ElectronApplication;

      const prepared = await launchPreparedJellyFixtureWindow(async () => app);

      expect(prepared).toEqual({ app, page });
      expect(page.locator).toHaveBeenCalledWith('html[data-jelly-ready="webgpu"]');
      expect(waitFor).toHaveBeenCalledOnce();
      expect(app.evaluate, `${path} content correction`).toHaveBeenCalledOnce();
      expect(page.waitForFunction, `${path} resize wait`).toHaveBeenCalledOnce();
      expect(app.close, `${path} remains owned by caller`).not.toHaveBeenCalled();
    }
  });
});
