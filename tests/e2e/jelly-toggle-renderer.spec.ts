import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import path from 'node:path';
import { PNG } from 'pngjs';

const electronPath = require('electron') as string;

function colorDominance(buffer: Buffer): { green: number; orange: number } {
  const image = PNG.sync.read(buffer);
  let green = 0;
  let orange = 0;
  for (let offset = 0; offset < image.data.length; offset += 4) {
    const red = image.data[offset] ?? 0;
    const channelGreen = image.data[offset + 1] ?? 0;
    const blue = image.data[offset + 2] ?? 0;
    const alpha = image.data[offset + 3] ?? 0;
    if (alpha < 64 || Math.max(red, channelGreen, blue) - Math.min(red, channelGreen, blue) < 24) {
      continue;
    }
    if (channelGreen > red + 12 && channelGreen > blue + 12) green += 1;
    if (red > channelGreen + 12 && channelGreen > blue + 4) orange += 1;
  }
  return { green, orange };
}

function expectTransparentCorners(buffer: Buffer, expected: readonly [number, number, number]): void {
  const image = PNG.sync.read(buffer);
  const corners = [
    0,
    (image.width - 1) * 4,
    (image.height - 1) * image.width * 4,
    (image.width * image.height - 1) * 4,
  ];
  for (const offset of corners) {
    expected.forEach((channel, index) => {
      expect(image.data[offset + index]).toBeGreaterThanOrEqual(channel - 3);
      expect(image.data[offset + index]).toBeLessThanOrEqual(channel + 3);
    });
  }
}

test('production page compiles and submits the real WebGPU renderer to idle', async () => {
  let app: ElectronApplication | undefined;
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const observedPages = new WeakSet<Page>();
  const observePage = (page: Page): void => {
    if (observedPages.has(page)) return;
    observedPages.add(page);
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    page.on('pageerror', (error) => pageErrors.push(error.message));
  };
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(process.cwd(), 'dist-electron', 'main.js'), '--jelly-toggle'],
    });
    app.on('window', observePage);
    const page = await app.firstWindow();
    observePage(page);
    const toggle = page.getByRole('switch', { name: 'Jelly toggle' });
    await expect(toggle).toHaveAttribute('data-jelly-toggle-mode', 'webgpu');
    const canvas = toggle.locator('canvas');
    await expect(toggle).toHaveCSS('width', '192px');
    await expect(toggle).toHaveCSS('height', '104px');
    await expect(canvas).toHaveCSS('width', '176px');
    await expect(canvas).toHaveCSS('height', '88px');
    await page.evaluate(() => { document.body.style.background = 'rgb(17, 34, 51)'; });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await page.waitForTimeout(2_500);
    const onPixels = await canvas.screenshot();
    expectTransparentCorners(onPixels, [17, 34, 51]);
    const onColors = colorDominance(onPixels);
    expect(onColors.green).toBeGreaterThan(onColors.orange);
    await toggle.click();
    await page.waitForTimeout(2_500);
    await page.evaluate(() => { document.body.style.background = 'rgb(226, 232, 240)'; });
    const offPixels = await canvas.screenshot();
    expectTransparentCorners(offPixels, [226, 232, 240]);
    const offColors = colorDominance(offPixels);
    expect(offColors.orange).toBeGreaterThan(offColors.green);
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
