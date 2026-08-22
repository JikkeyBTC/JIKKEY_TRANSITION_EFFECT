import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import path from 'node:path';

const electronPath = require('electron') as string;
const mainPath = path.join(process.cwd(), 'dist-electron', 'main.js');

interface ProbeSnapshot {
  readonly requestAdapter: number;
  readonly canvasContext: number;
  readonly queueSubmit: number;
}

async function launch(
  renderer: 'burn' | 'jelly',
): Promise<{ readonly app: ElectronApplication; readonly page: Page }> {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [
      mainPath,
      ...(renderer === 'jelly' ? ['--jelly-toggle'] : []),
      '--test-mode',
      '--webgpu-probe',
    ],
  });
  try {
    const page = await app.firstWindow();
    if (renderer === 'burn') await page.locator('html[data-burn-ready]').waitFor();
    else await page.locator('html[data-jelly-ready="webgpu"]').waitFor();
    return { app, page };
  } catch (error) {
    await app.close().catch(() => undefined);
    throw error;
  }
}

async function snapshot(page: Page): Promise<ProbeSnapshot> {
  const result = await page.evaluate(() => {
    const probe = (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for('jikkey.webgpu-test-probe')
    ] as { snapshot?(): ProbeSnapshot } | undefined;
    return typeof probe?.snapshot === 'function' ? probe.snapshot() : undefined;
  });
  if (!result) throw new Error('The pre-navigation WebGPU probe was not installed');
  return result;
}

test('keeps the burn entry WebGPU-free and proves the same first-script probe on jelly', async () => {
  const burn = await launch('burn');
  try {
    await expect.poll(() => snapshot(burn.page)).toEqual({
      requestAdapter: 0,
      canvasContext: 0,
      queueSubmit: 0,
    });
  } finally {
    await burn.app.close();
  }

  const jelly = await launch('jelly');
  try {
    await jelly.page.evaluate(() => window.__jellyTest!.flush());
    const jellySnapshot = await snapshot(jelly.page);
    expect(jellySnapshot.requestAdapter).toBeGreaterThan(0);
    expect(jellySnapshot.canvasContext).toBeGreaterThan(0);
    expect(jellySnapshot.queueSubmit).toBeGreaterThan(0);
  } finally {
    await jelly.app.close();
  }
});
