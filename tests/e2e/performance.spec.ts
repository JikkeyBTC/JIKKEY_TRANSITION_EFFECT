import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import path from 'node:path';
import { summarizeFrameIntervals } from '../support/performance-report';

const electronPath = require('electron') as string;
const root = process.cwd();
const MEASUREMENT_DURATION_MS = 2_550;
const MINIMUM_FRAME_INTERVALS = Math.floor(MEASUREMENT_DURATION_MS / 34);

async function setContentSizeAndWait(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  let requestedWidth = width;
  let requestedHeight = height;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (before.width === width && before.height === height) return;
    await app.evaluate(({ BrowserWindow }, requested) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(requested.width, requested.height);
    }, { width: requestedWidth, height: requestedHeight });
    await page.waitForFunction(
      (previous) => innerWidth !== previous.width || innerHeight !== previous.height,
      before,
      { timeout: 5_000 },
    );
    const actual = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    if (actual.width === width && actual.height === height) return;
    requestedWidth += width - actual.width;
    requestedHeight += height - actual.height;
  }
  expect(await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
    .toEqual({ width, height });
}

test('reports real-clock burn frame pacing at 1920x1080', async ({}, testInfo) => {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [path.join(root, 'dist-electron', 'main.js')],
  });
  try {
    const page = await app.firstWindow();
    await page.locator('html[data-burn-ready]').waitFor();
    await setContentSizeAndWait(app, page, 1_920, 1_080);

    const environment = await page.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = gl && debug
        ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
        : gl ? String(gl.getParameter(gl.RENDERER)) : 'WebGL2 unavailable';
      return {
        contentViewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio,
        userAgent: navigator.userAgent,
        navigatorPlatform: navigator.platform,
        renderer,
        angle: renderer.includes('ANGLE') ? renderer : 'ANGLE not reported by WebGL',
        webglVersion: gl ? String(gl.getParameter(gl.VERSION)) : 'WebGL2 unavailable',
      };
    });
    const host = await app.evaluate(async ({ app: electronApp }) => ({
      os: { platform: process.platform, arch: process.arch },
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      gpuFeatureStatus: electronApp.getGPUFeatureStatus(),
      gpuInfo: await electronApp.getGPUInfo('basic'),
    }));

    await page.getByRole('button', { name: /switch to light/i }).click();
    const overlay = page.locator('canvas[data-burn-overlay]');
    await expect(overlay).toBeVisible();
    const measurement = await page.evaluate((durationMs) => new Promise<{
      intervals: number[];
      measuredDurationMs: number;
    }>((resolve) => {
      const values: number[] = [];
      const started = performance.now();
      let previous = started;
      const sample = (now: number): void => {
        values.push(now - previous);
        previous = now;
        if (now - started >= durationMs) {
          resolve({ intervals: values, measuredDurationMs: now - started });
        }
        else requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }), MEASUREMENT_DURATION_MS);
    await expect(overlay).toBeHidden();

    expect(measurement.measuredDurationMs).toBeGreaterThanOrEqual(MEASUREMENT_DURATION_MS);
    expect(measurement.intervals.length).toBeGreaterThanOrEqual(MINIMUM_FRAME_INTERVALS);
    const intervalSummary = summarizeFrameIntervals(
      measurement.intervals,
      MINIMUM_FRAME_INTERVALS,
    );
    const { p95, over34ms } = intervalSummary;
    const target = { p95AtOrBelow20ms: p95 <= 20, atMostOneIntervalOver34ms: over34ms <= 1 };
    const report = {
      machineSpecific: true,
      measuredAt: new Date().toISOString(),
      measuredDurationMs: measurement.measuredDurationMs,
      minimumRequiredSamples: MINIMUM_FRAME_INTERVALS,
      warmupIntervalsTrimmed: 0,
      ...intervalSummary,
      target,
      ...host,
      ...environment,
    };
    console.log(`BURN_BENCHMARK ${JSON.stringify(report)}`);
    await testInfo.attach('burn-benchmark.json', {
      body: Buffer.from(JSON.stringify(report, null, 2)),
      contentType: 'application/json',
    });
    expect(p95).toBeLessThanOrEqual(20);
    expect(over34ms).toBeLessThanOrEqual(1);
  } finally {
    await app.close();
  }
});
