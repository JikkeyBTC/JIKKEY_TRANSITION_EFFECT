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
  await page.getByRole('button', { name: /switch to light/i }).waitFor();
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

test('burns from dark to light without exposing an intermediate blank frame', async () => {
  const { app, page } = await launchDemo();
  try {
    const button = page.locator('[data-theme-toggle]');
    const overlay = page.locator('canvas[data-burn-overlay]');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(button).toHaveAccessibleName(/switch to light/i);
    const initialToggleBox = await button.boundingBox();
    expect(initialToggleBox).not.toBeNull();

    await button.click({ position: { x: 18, y: 18 } });
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
    await expect(button).toHaveAccessibleName(/switch to dark/i);
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
    const button = page.locator('[data-theme-toggle]');
    await button.click();

    await expect(page.locator('canvas[data-burn-overlay]')).toBeVisible();
    await expect(button).toBeDisabled();
    await page.waitForFunction(() => window.__burnTest!.hasPendingFrame());
  } finally {
    await app.close();
  }
});

test('keeps disabled ownership with the first toggle when a concurrent call is busy', async () => {
  const { app, page } = await launchDemo();
  try {
    const button = page.locator('[data-theme-toggle]');
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
    await page.getByRole('button', { name: /switch to light/i }).click();
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
