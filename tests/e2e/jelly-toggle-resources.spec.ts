import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import path from 'node:path';

const electronPath = require('electron') as string;
const mainPath = path.join(process.cwd(), 'dist-electron', 'main.js');

async function launchJelly(): Promise<{ readonly app: ElectronApplication; readonly page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [mainPath, '--jelly-toggle', '--test-mode'],
  });
  try {
    const page = await app.firstWindow();
    await page.locator('html[data-jelly-ready="webgpu"]').waitFor();
    return { app, page };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

async function flush(page: Page): Promise<void> {
  await page.evaluate(() => window.__jellyTest!.flush());
  expect(await page.evaluate(() => window.__jellyTest!.hasPendingFrame())).toBe(false);
}

test('balances four component lifetimes without idle work or pipeline recreation', async () => {
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchJelly();
    app = launched.app;
    const page = launched.page;

    for (let mount = 0; mount < 4; mount += 1) {
      if (mount > 0) {
        expect(await page.evaluate(
          (checked) => window.__jellyTest!.remount(checked),
          mount % 2 === 1,
        )).toBe('webgpu');
      }
      await flush(page);

      const pipelinesBefore = await page.evaluate(() => window.__jellyTest!.stats()!.pipelinesCreated);
      expect(pipelinesBefore).toBeGreaterThan(0);
      await page.evaluate(() => window.__jellyTest!.setChecked(true));
      await flush(page);
      await page.evaluate(() => window.__jellyTest!.setChecked(false));
      await flush(page);
      expect(await page.evaluate(() => window.__jellyTest!.stats()!.pipelinesCreated))
        .toBe(pipelinesBefore);

      await page.evaluate(() => window.__jellyTest!.waitForQueue());
      const idleSubmissions = await page.evaluate(() => window.__jellyTest!.cumulativeStats().submissions);
      await page.evaluate(() => window.__jellyTest!.waitForQueue());
      expect(await page.evaluate(() => window.__jellyTest!.cumulativeStats().submissions))
        .toBe(idleSubmissions);

      if (mount === 0) {
        const attemptsBeforeLoss = await page.evaluate(() => window.__jellyTest!.lifecycle().rendererAttempts);
        const sequence = await page.evaluate(() => window.__jellyTest!.destroyTwoDeviceGenerations());
        expect(sequence).toEqual({
          attemptsBefore: attemptsBeforeLoss,
          attemptsAfterFirstLoss: attemptsBeforeLoss + 1,
          attemptsAfterSecondLoss: attemptsBeforeLoss + 1,
        });
        expect(await page.evaluate(() => window.__jellyTest!.lifecycle().rendererAttempts))
          .toBe(attemptsBeforeLoss + 1);
      }

      await page.evaluate(() => window.__jellyTest!.destroy());
      const disposed = await page.evaluate(() => window.__jellyTest!.lifecycle());
      expect(disposed.mounts).toBe(0);
      expect(disposed.listeners).toBe(0);
      expect(disposed.resizeObservers).toBe(0);
      expect(disposed.pendingAnimationFrames).toBe(0);
      expect(disposed.manualPendingFrames).toBe(0);
      expect(disposed.cumulativeStats.buffersDestroyed).toBe(disposed.cumulativeStats.buffersCreated);
      expect(disposed.cumulativeStats.texturesDestroyed).toBe(disposed.cumulativeStats.texturesCreated);
      expect(disposed.cumulativeStats.uncapturedErrors).toBe(0);
    }

    const final = await page.evaluate(() => window.__jellyTest!.lifecycle());
    expect(final.renderersCreated).toBe(5);
    expect(final.rendererAttempts).toBe(5);
  } finally {
    await app?.close();
  }
});
