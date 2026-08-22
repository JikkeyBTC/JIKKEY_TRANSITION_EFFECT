import type { ElectronApplication, Page } from 'playwright';

interface Size {
  readonly width: number;
  readonly height: number;
}

function assertSize(size: Size, label: string): void {
  if (!Number.isSafeInteger(size.width) || size.width <= 0) {
    throw new Error(`${label} width must be a positive integer`);
  }
  if (!Number.isSafeInteger(size.height) || size.height <= 0) {
    throw new Error(`${label} height must be a positive integer`);
  }
}

export function correctedContentSizeRequest(
  previousRequest: Size,
  measured: Size,
  target: Size,
): Size {
  assertSize(previousRequest, 'Previous content-size request');
  assertSize(measured, 'Measured viewport');
  assertSize(target, 'Target viewport');
  return {
    width: previousRequest.width + target.width - measured.width,
    height: previousRequest.height + target.height - measured.height,
  };
}

/** Bounded measured correction for Windows forced-DPR content-size rounding. */
export async function setElectronContentSizeAndWait(
  app: ElectronApplication,
  page: Page,
  target: Size,
): Promise<void> {
  assertSize(target, 'Target viewport');
  let requested: Size = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (before.width === target.width && before.height === target.height) return;
    requested = correctedContentSizeRequest(requested, before, target);
    await app.evaluate(({ BrowserWindow }, next) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(next.width, next.height);
    }, requested);
    await page.waitForFunction(
      (previous) => innerWidth !== previous.width || innerHeight !== previous.height,
      before,
      { timeout: 5_000 },
    );
    const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (actual.width === target.width && actual.height === target.height) return;
  }
  const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  throw new Error(
    `Unable to correct Electron content viewport: expected ${target.width}x${target.height}, `
    + `received ${actual.width}x${actual.height}`,
  );
}

/** Opens a test-owned fixture window only after its WebGPU route and exact viewport are ready. */
export async function launchPreparedJellyFixtureWindow(
  launch: () => Promise<ElectronApplication>,
): Promise<{ readonly app: ElectronApplication; readonly page: Page }> {
  const app = await launch();
  try {
    const page = await app.firstWindow();
    await page.locator('html[data-jelly-ready="webgpu"]').waitFor();
    await setElectronContentSizeAndWait(app, page, { width: 800, height: 600 });
    return { app, page };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}
