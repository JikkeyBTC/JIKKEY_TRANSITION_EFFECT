import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';

const electronPath = require('electron') as string;

type DemoReadiness = (app: ElectronApplication, page: Page) => Promise<void>;

const waitForDemoReady: DemoReadiness = async (_app, page) => {
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-burn-ready')
    && Boolean(window.__burnTest));
  await page.evaluate(() => document.documentElement.removeAttribute('data-test-mode'));
  await page.locator('[data-theme-toggle]').waitFor();
};

async function launchDemo(
  waitUntilReady: DemoReadiness = waitForDemoReady,
): Promise<{ app: ElectronApplication; page: Page }> {
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(process.cwd(), 'dist-electron', 'main.js'), '--test-mode'],
    });
    const page = await app.firstWindow();
    await waitUntilReady(app, page);
    return { app, page };
  } catch (error) {
    try {
      await app?.close();
    } catch (cleanupError) {
      console.error('Electron cleanup after launch failure failed', cleanupError);
    }
    throw error;
  }
}

async function launchProductionDemo(): Promise<{ app: ElectronApplication; page: Page }> {
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [path.join(process.cwd(), 'dist-electron', 'main.js')],
    });
    const page = await app.firstWindow();
    await page.locator('html[data-burn-ready]').waitFor();
    return { app, page };
  } catch (error) {
    await app?.close().catch(() => undefined);
    throw error;
  }
}

test('closes the launched application when renderer readiness fails', async () => {
  let launchedApp: ElectronApplication | undefined;
  let launchedProcess: ChildProcess | undefined;
  try {
    await expect(launchDemo(async (app) => {
      launchedApp = app;
      launchedProcess = app.process();
      throw new Error('forced readiness failure');
    })).rejects.toThrow('forced readiness failure');

    expect(launchedProcess).toBeDefined();
    await expect.poll(() => launchedProcess!.exitCode, { timeout: 1_000 }).not.toBeNull();
  } finally {
    if (launchedProcess?.exitCode === null) await launchedApp?.close();
  }
});

test('preserves the readiness error when launch cleanup also fails', async () => {
  const readinessError = new Error('original readiness failure');
  const cleanupError = new Error('forced cleanup failure');
  let launchedProcess: ChildProcess | undefined;
  let forceClose: (() => Promise<void>) | undefined;
  let cleanupLog: unknown[] | undefined;
  const originalConsoleError = console.error;
  try {
    console.error = (...values: unknown[]) => { cleanupLog = values; };
    await expect(launchDemo(async (app) => {
      launchedProcess = app.process();
      forceClose = app.close.bind(app);
      app.close = async () => { throw cleanupError; };
      throw readinessError;
    })).rejects.toBe(readinessError);
    expect(cleanupLog).toEqual([
      'Electron cleanup after launch failure failed',
      cleanupError,
    ]);
  } finally {
    console.error = originalConsoleError;
    if (launchedProcess?.exitCode === null) await forceClose?.();
  }
});

test('exposes a compact semantic switch backed by a decorative canvas', async () => {
  const { app, page } = await launchDemo();
  try {
    const toggle = page.getByRole('switch', { name: 'Dark mode' });
    const canvas = toggle.locator('canvas[data-jelly-toggle]');

    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(canvas).toHaveAttribute('aria-hidden', 'true');
    const backingSize = await canvas.evaluate((element) => ({
      width: (element as HTMLCanvasElement).width,
      height: (element as HTMLCanvasElement).height,
      pixelRatio: Math.min(Math.max(devicePixelRatio || 1, 1), 3),
    }));
    expect(backingSize.width).toBe(Math.round(52 * backingSize.pixelRatio));
    expect(backingSize.height).toBe(Math.round(30 * backingSize.pixelRatio));

    const resizedBacking = await canvas.evaluate((element) => {
      Object.defineProperty(window, 'devicePixelRatio', { configurable: true, value: 2 });
      window.dispatchEvent(new Event('resize'));
      const canvasElement = element as HTMLCanvasElement;
      return { width: canvasElement.width, height: canvasElement.height };
    });
    expect(resizedBacking).toEqual({ width: 104, height: 60 });

    const geometry = await toggle.evaluate((element) => {
      const control = element.getBoundingClientRect();
      const visual = element.querySelector('canvas')!.getBoundingClientRect();
      return {
        control: { width: control.width, height: control.height },
        visual: { width: visual.width, height: visual.height },
        pointerEvents: getComputedStyle(element.querySelector('canvas')!).pointerEvents,
      };
    });
    expect(geometry.control.width).toBeGreaterThanOrEqual(44);
    expect(geometry.control.height).toBeGreaterThanOrEqual(44);
    expect(geometry.visual).toEqual({ width: 52, height: 30 });
    expect(geometry.pointerEvents).toBe('none');

    const paintedPixels = await canvas.evaluate((element) => {
      const canvasElement = element as HTMLCanvasElement;
      const context = canvasElement.getContext('2d')!;
      const pixels = context.getImageData(
        0,
        0,
        canvasElement.width,
        canvasElement.height,
      ).data;
      let count = 0;
      for (let alpha = 3; alpha < pixels.length; alpha += 4) {
        if ((pixels[alpha] ?? 0) > 0) count += 1;
      }
      return count;
    });
    expect(paintedPixels).toBeGreaterThan(400);
  } finally {
    await app.close();
  }
});

test('uses a system-color fallback when forced colors are active', async () => {
  const { app, page } = await launchDemo();
  try {
    await page.emulateMedia({ forcedColors: 'active' });
    const toggle = page.getByRole('switch', { name: 'Dark mode' });
    const styles = await toggle.evaluate((element) => ({
      borderStyle: getComputedStyle(element).borderStyle,
      canvasDisplay: getComputedStyle(element.querySelector('canvas')!).display,
    }));

    expect(styles).toEqual({ borderStyle: 'solid', canvasDisplay: 'none' });
  } finally {
    await app.close();
  }
});

test('animates and settles the jelly canvas in production mode', async () => {
  const { app, page } = await launchProductionDemo();
  try {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const toggle = page.getByRole('switch', { name: 'Dark mode' });
    const canvas = toggle.locator('canvas[data-jelly-toggle]');

    await toggle.click();
    await expect(canvas).toHaveAttribute('data-jelly-animating', 'true');
    await expect(canvas).not.toHaveAttribute('data-jelly-animating', 'true', {
      timeout: 1_500,
    });
    await page.waitForTimeout(100);
    await expect(canvas).not.toHaveAttribute('data-jelly-animating', 'true');
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
  } finally {
    await app.close();
  }
});

test('burns from dark to light without exposing an intermediate blank frame', async () => {
  const { app, page } = await launchDemo();
  try {
    const button = page.getByRole('switch', { name: 'Dark mode' });
    const overlay = page.locator('canvas[data-burn-overlay]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(button).toHaveAttribute('aria-checked', 'true');
    const initialToggleBox = await button.boundingBox();
    expect(initialToggleBox).not.toBeNull();

    await button.press('Space');
    await expect(overlay).toBeVisible();
    await expect(button).toBeDisabled();

    await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());
    await page.evaluate(() => window.__burnTest!.step(16));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());
    await page.evaluate(() => window.__burnTest!.step(16));
    await page.evaluate(() => Promise.resolve());
    await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());
    await page.evaluate(() => window.__burnTest!.step(2_500));

    await expect(overlay).toBeHidden();
    await expect(button).toBeEnabled();
    await expect(button).toHaveAttribute('aria-checked', 'false');
    await expect(page.locator('[data-theme-word]')).toHaveText('LIGHT');
    expect(await button.boundingBox()).toEqual(initialToggleBox);
  } finally {
    await app.close();
  }
});

test('keeps test-mode animation deterministic when the host prefers reduced motion', async () => {
  const { app, page } = await launchDemo();
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const button = page.getByRole('switch', { name: 'Dark mode' });
    const jellyCanvas = button.locator('canvas[data-jelly-toggle]');
    await page.evaluate(() => {
      let requests = 0;
      const requestFrame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => {
        requests += 1;
        return requestFrame(callback);
      };
      (window as typeof window & { __jellyFrameRequests: () => number })
        .__jellyFrameRequests = () => requests;
    });
    await button.click();

    await expect(page.locator('canvas[data-burn-overlay]')).toBeVisible();
    await expect(button).toBeDisabled();
    await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());
    await page.evaluate(() => window.__burnTest!.step(16));
    await expect(button).toHaveAttribute('aria-checked', 'false');
    await expect(jellyCanvas).not.toHaveAttribute('data-jelly-animating', 'true');
    expect(await page.evaluate(() => (
      window as typeof window & { __jellyFrameRequests: () => number }
    ).__jellyFrameRequests())).toBe(0);
  } finally {
    await app.close();
  }
});

test('keeps disabled ownership with the first toggle when a concurrent call is busy', async () => {
  const { app, page } = await launchDemo();
  try {
    const button = page.getByRole('switch', { name: 'Dark mode' });
    await button.click();
    await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());

    const concurrentResult = await page.evaluate(() => window.__burnTest!.toggleAt(20, 20));
    expect(concurrentResult).toEqual({ status: 'ignored', reason: 'busy' });
    await expect(button).toBeDisabled();

    await page.evaluate(() => window.__burnTest!.step(16));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());
    await page.evaluate(() => window.__burnTest!.step(16));
    await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());
    await page.evaluate(() => window.__burnTest!.step(2_500));

    await expect(button).toBeEnabled();
  } finally {
    await app.close();
  }
});

test('keeps muted text at WCAG AA contrast in both themes', async () => {
  const { app, page } = await launchDemo();
  try {
    const ratios = await page.evaluate(() => {
      document.documentElement.removeAttribute('data-test-mode');
      const contrastRatio = (foreground: string, background: string): number => {
        const luminance = (color: string): number => {
          const channels = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
          const linear = channels.map((channel) => {
            const value = channel / 255;
            return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
          });
          return 0.2126 * (linear[0] ?? 0)
            + 0.7152 * (linear[1] ?? 0)
            + 0.0722 * (linear[2] ?? 0);
        };
        const foregroundLuminance = luminance(foreground);
        const backgroundLuminance = luminance(background);
        const lighter = Math.max(foregroundLuminance, backgroundLuminance);
        const darker = Math.min(foregroundLuminance, backgroundLuminance);
        return (lighter + 0.05) / (darker + 0.05);
      };
      const stageForCurrentTheme = () => {
        const stageStyle = getComputedStyle(document.querySelector<HTMLElement>('.theme-stage')!);
        return {
          backgroundColor: stageStyle.backgroundColor,
          backgroundImage: stageStyle.backgroundImage,
          ratio: contrastRatio(
            getComputedStyle(document.querySelector<HTMLElement>('.hint')!).color,
            stageStyle.backgroundColor,
          ),
        };
      };

      const dark = stageForCurrentTheme();
      document.documentElement.dataset.theme = 'light';
      const light = stageForCurrentTheme();
      return { dark, light };
    });

    expect(ratios.dark).toEqual({
      backgroundColor: 'rgb(12, 12, 12)',
      backgroundImage: 'none',
      ratio: expect.any(Number),
    });
    expect(ratios.light).toEqual({
      backgroundColor: 'rgb(245, 245, 240)',
      backgroundImage: 'none',
      ratio: expect.any(Number),
    });
    expect(ratios.dark.ratio).toBeGreaterThanOrEqual(4.5);
    expect(ratios.light.ratio).toBeGreaterThanOrEqual(4.5);
  } finally {
    await app.close();
  }
});

test('completes safely when the window resizes during the effect', async () => {
  const { app, page } = await launchDemo();
  try {
    await page.getByRole('switch', { name: 'Dark mode' }).click();
    await expect(page.locator('canvas[data-burn-overlay]')).toBeVisible();
    await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(1_100, 700);
    });
    await page.waitForFunction(() => window.innerWidth === 1_100 && window.innerHeight === 700);
    await page.evaluate(() => window.__burnTest!.step(16));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('canvas[data-burn-overlay]')).toBeHidden();
  } finally {
    await app.close();
  }
});

test('reuses renderer resources across repeated alternating round trips', async () => {
  const { app, page } = await launchDemo();
  try {
    await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas[data-burn-overlay]')!;
      const gl = canvas.getContext('webgl2');
      if (!gl) throw new Error('WebGL2 unavailable in lifecycle probe');
      const counts = {
        texturesCreated: 0,
        texturesDeleted: 0,
        programsCreated: 0,
        programsDeleted: 0,
        animationFramesRequested: 0,
        listenersAdded: 0,
      };
      const createTexture = gl.createTexture.bind(gl);
      const deleteTexture = gl.deleteTexture.bind(gl);
      const createProgram = gl.createProgram.bind(gl);
      const deleteProgram = gl.deleteProgram.bind(gl);
      Object.defineProperty(gl, 'createTexture', {
        configurable: true,
        value: () => {
          counts.texturesCreated += 1;
          return createTexture();
        },
      });
      Object.defineProperty(gl, 'deleteTexture', {
        configurable: true,
        value: (texture: WebGLTexture | null) => {
          if (texture) counts.texturesDeleted += 1;
          deleteTexture(texture);
        },
      });
      Object.defineProperty(gl, 'createProgram', {
        configurable: true,
        value: () => {
          counts.programsCreated += 1;
          return createProgram();
        },
      });
      Object.defineProperty(gl, 'deleteProgram', {
        configurable: true,
        value: (program: WebGLProgram | null) => {
          if (program) counts.programsDeleted += 1;
          deleteProgram(program);
        },
      });
      const requestFrame = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => {
        counts.animationFramesRequested += 1;
        return requestFrame(callback);
      };
      const windowAddEventListener = window.addEventListener.bind(window);
      window.addEventListener = ((...arguments_: Parameters<typeof window.addEventListener>) => {
        counts.listenersAdded += 1;
        windowAddEventListener(...arguments_);
      }) as typeof window.addEventListener;
      const canvasAddEventListener = canvas.addEventListener.bind(canvas);
      canvas.addEventListener = ((...arguments_: Parameters<typeof canvas.addEventListener>) => {
        counts.listenersAdded += 1;
        canvasAddEventListener(...arguments_);
      }) as typeof canvas.addEventListener;
      (window as typeof window & { __burnResourceProbe: typeof counts }).__burnResourceProbe = counts;
    });

    for (let index = 0; index < 4; index += 1) {
      await page.evaluate(() => window.__burnTest!.setTime(10_000));
      await page.evaluate(() => { void window.__burnTest!.toggleAt(640, 360); });
      await expect(page.locator('canvas[data-burn-overlay]')).toBeVisible();
      await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());
      await page.evaluate(() => window.__burnTest!.step(0));
      await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());
      await page.evaluate(() => window.__burnTest!.step(0));
      await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());
      await page.evaluate(() => window.__burnTest!.step(2_500));
      await expect(page.locator('canvas[data-burn-overlay]')).toBeHidden();
      expect(await page.evaluate(() => window.__burnTest!.hasPendingFrame())).toBe(false);
    }

    await expect(page.locator('canvas[data-burn-overlay]')).toHaveCount(1);
    const counts = await page.evaluate(() => (
      window as typeof window & {
        __burnResourceProbe: {
          texturesCreated: number;
          texturesDeleted: number;
          programsCreated: number;
          programsDeleted: number;
          animationFramesRequested: number;
          listenersAdded: number;
        };
      }
    ).__burnResourceProbe);
    expect(counts).toEqual({
      texturesCreated: 4,
      texturesDeleted: 4,
      programsCreated: 0,
      programsDeleted: 0,
      animationFramesRequested: 0,
      listenersAdded: 0,
    });
  } finally {
    await app.close();
  }
});
