import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication } from 'playwright';
import path from 'node:path';
import { PNG } from 'pngjs';

const electronPath = require('electron') as string;

test('production page compiles and submits the real WebGPU renderer to idle', async () => {
  let app: ElectronApplication | undefined;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(process.cwd(), 'dist-electron', 'main.js'), '--jelly-toggle'],
    });
    const page = await app.firstWindow();
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.locator('html[data-jelly-ready="webgpu"]').waitFor();
    const toggle = page.getByRole('switch', { name: 'Jelly toggle' });
    const canvas = toggle.locator('canvas');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(2_500);
    await toggle.click();
    await page.waitForTimeout(2_500);
    const adapterResult = await page.evaluate(async () => {
      const adapter = await navigator.gpu?.requestAdapter();
      if (!adapter) return false;
      const device = await adapter.requestDevice();
      await device.queue.onSubmittedWorkDone();
      device.destroy();
      return true;
    });
    if (!adapterResult) {
      const diagnostics = await app.evaluate(({ app: electronApp }) => (
        electronApp.getGPUInfo('complete')
      ));
      throw new Error(`WebGPU adapter unavailable: ${JSON.stringify(diagnostics)}`);
    }
    const pixels = await canvas.screenshot();
    expect(pixels.byteLength).toBeGreaterThan(500);
    const image = PNG.sync.read(pixels);
    const background = image.data.subarray(0, 4);
    let nonBackground = 0;
    const colors = new Set<string>();
    for (let offset = 0; offset < image.data.length; offset += 4) {
      const rgba = image.data.subarray(offset, offset + 4);
      colors.add([...rgba].join(','));
      if (rgba.some((channel, index) => Math.abs(channel - (background[index] ?? 0)) > 5)) {
        nonBackground += 1;
      }
    }
    expect(colors.size).toBeGreaterThan(20);
    expect(nonBackground).toBeGreaterThan(image.width * image.height * 0.05);
    await expect(toggle).toHaveAttribute('data-jelly-toggle-mode', 'webgpu');
    expect(await page.evaluate(() => window.__jellyTest)).toBeUndefined();
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  } finally {
    await app?.close();
  }
});
