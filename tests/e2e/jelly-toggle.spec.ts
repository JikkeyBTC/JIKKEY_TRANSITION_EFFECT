import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import path from 'node:path';

const electronPath = require('electron') as string;

async function launchJelly(
  extraArguments: readonly string[] = [],
): Promise<{ app: ElectronApplication; page: Page }> {
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.join(process.cwd(), 'dist-electron', 'main.js'),
        '--jelly-toggle',
        '--test-mode',
        ...extraArguments,
      ],
    });
    const page = await app.firstWindow();
    await page.locator('html[data-jelly-ready]').waitFor();
    if (extraArguments.includes('--hide-webgpu')) {
      await page.locator('html[data-jelly-ready="fallback"]').waitFor();
    } else if (!extraArguments.includes('--defer-webgpu')) {
      await page.locator('html[data-jelly-ready="webgpu"]').waitFor();
    }
    return { app, page };
  } catch (error) {
    await app?.close().catch(() => undefined);
    throw error;
  }
}

async function drain(page: Page, limit = 160): Promise<void> {
  for (let frame = 0; frame < limit; frame += 1) {
    if (!await page.evaluate(() => window.__jellyTest!.hasPendingFrame())) return;
    await page.evaluate(() => window.__jellyTest!.step(1000 / 60));
  }
  throw new Error('Jelly animation did not reach idle');
}

test('launches an isolated semantic jelly switch and handles native input', async () => {
  const { app, page } = await launchJelly();
  try {
    const toggle = page.getByRole('switch', { name: 'Jelly toggle' });
    const canvas = toggle.locator('canvas');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(toggle).toHaveCSS('width', '192px');
    await expect(toggle).toHaveCSS('height', '104px');
    await expect(canvas).toHaveCSS('width', '176px');
    await expect(canvas).toHaveCSS('height', '88px');
    expect(await page.evaluate(() => window.burnCapture)).toBeUndefined();
    expect(await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0]!.webContents as unknown as {
        getLastWebPreferences(): { preload?: string };
      };
      return contents.getLastWebPreferences().preload;
    })).toBeUndefined();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await drain(page);
    await toggle.press('Space');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await drain(page);
    await toggle.press('Enter');
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await drain(page);
  } finally {
    await app.close();
  }
});

test('preserves velocity through rapid reversal and ends at the latest target', async () => {
  const { app, page } = await launchJelly();
  try {
    const toggle = page.getByRole('switch', { name: 'Jelly toggle' });
    await toggle.click();
    for (let tick = 0; tick < 15; tick += 1) {
      await page.evaluate(() => window.__jellyTest!.step(1000 / 60));
    }
    const before = await page.evaluate(() => window.__jellyTest!.pose());
    expect(before?.ticksSinceTargetChange).toBe(15);
    await toggle.click();
    const after = await page.evaluate(() => window.__jellyTest!.pose());
    if (!before || !after) throw new Error('Missing test physics snapshot');
    expect(after.current).toEqual(before.current);
    expect(after.previous).toEqual(before.previous);
    await drain(page);
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(await page.evaluate(() => window.__jellyTest!.target())).toBe('off');
  } finally {
    await app.close();
  }
});

test('accepts input before WebGPU readiness without losing semantic state', async () => {
  const { app, page } = await launchJelly(['--defer-webgpu']);
  try {
    const toggle = page.getByRole('switch', { name: 'Jelly toggle' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(await page.evaluate(() => window.__jellyTest!.readyState())).toBe('pending');
    await page.evaluate(() => window.__jellyTest!.releaseInitialization());
    await expect.poll(() => page.evaluate(() => window.__jellyTest!.readyState())).toBe('webgpu');
    expect(await page.evaluate(() => window.__jellyTest!.target())).toBe('on');
  } finally {
    await app.close();
  }
});

test('reacts to reduced motion and forced colors at runtime', async () => {
  const { app, page } = await launchJelly();
  try {
    const toggle = page.getByRole('switch', { name: 'Jelly toggle' });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await toggle.click();
    await drain(page, 20);
    expect(await page.evaluate(() => window.__jellyTest!.pose()!.settled)).toBe(true);

    await page.emulateMedia({ forcedColors: 'active' });
    await expect(toggle.locator('canvas')).toBeHidden();
    await expect(toggle.locator('.jelly-toggle-3d__fallback')).toBeVisible();
    await page.emulateMedia({ forcedColors: 'none', reducedMotion: 'no-preference' });
    await drain(page, 20);
    await expect(toggle.locator('canvas')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('clamps DPR backing dimensions at 1, 2, and 3', async () => {
  const { app, page } = await launchJelly();
  try {
    const canvas = page.getByRole('switch').locator('canvas');
    for (const [dpr, expected] of [[1, [176, 88]], [2, [264, 132]], [3, [264, 132]]] as const) {
      await page.evaluate((next) => window.__jellyTest!.setDevicePixelRatio(next), dpr);
      await drain(page, 20);
      expect(await canvas.evaluate((node) => [
        (node as HTMLCanvasElement).width,
        (node as HTMLCanvasElement).height,
      ])).toEqual(expected);
    }
  } finally {
    await app.close();
  }
});

test('keeps the approved fixture surface at its original fixed dimensions', async () => {
  const { app, page } = await launchJelly(['--fixture-capture']);
  try {
    const toggle = page.getByRole('switch', { name: 'Jelly toggle' });
    const canvas = toggle.locator('canvas');
    await expect(toggle).toHaveCSS('width', '96px');
    await expect(toggle).toHaveCSS('height', '52px');
    await expect(canvas).toHaveCSS('width', '88px');
    await expect(canvas).toHaveCSS('height', '44px');
    expect(await canvas.evaluate((node) => [
      (node as HTMLCanvasElement).width,
      (node as HTMLCanvasElement).height,
    ])).toEqual([176, 88]);
  } finally {
    await app.close();
  }
});

test('keeps a functional CSS switch when navigator.gpu is hidden', async () => {
  const { app, page } = await launchJelly(['--hide-webgpu']);
  try {
    expect(await page.evaluate(() => navigator.gpu)).toBeUndefined();
    expect(await page.evaluate(() => window.__jellyTest!.readyState())).toBe('fallback');
    const toggle = page.getByRole('switch', { name: 'Jelly toggle' });
    const fallback = toggle.locator('.jelly-toggle-3d__fallback');
    await expect(fallback).toBeVisible();
    await expect(toggle).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(fallback).toHaveCSS('color', 'rgb(34, 197, 94)');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(fallback).not.toHaveCSS('color', 'rgb(34, 197, 94)');
  } finally {
    await app.close();
  }
});

test('allows only the exact renderer URL and denies popups and frame navigation', async () => {
  const { app, page } = await launchJelly();
  try {
    const expectedUrl = page.url();
    expect(new URL(expectedUrl).pathname).toMatch(/\/jelly-toggle\.html$/);
    expect(await page.evaluate(() => window.open('https://example.com'))).toBeNull();
    await page.evaluate(() => { location.href = 'https://example.com/denied'; });
    await page.waitForTimeout(100);
    expect(page.url()).toBe(expectedUrl);
    await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.src = 'https://example.com/frame';
      document.body.append(frame);
    });
    await page.waitForTimeout(100);
    expect(page.frames()).toHaveLength(2);
    expect(page.frames()[1]!.url()).toBe('chrome-error://chromewebdata/');
    await page.reload();
    await page.locator('html[data-jelly-ready]').waitFor();
    expect(page.url()).toBe(expectedUrl);
  } finally {
    await app.close();
  }
});
