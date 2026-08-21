import { expect, test, type TestInfo } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  analyzeFrame,
  analyzeTransitionEffects,
  validateEarlyFrames,
  validateEffectDistributions,
  type EffectDistributionRange,
  type EffectLayer,
  type Theme,
} from '../support/visual-analysis';

const electronPath = require('electron') as string;
const root = process.cwd();
const VIEWPORT = { width: 1_280, height: 720 } as const;
const BASE_TIME = 10_000;

interface Origin { readonly x: number; readonly y: number }
type EffectRanges = Readonly<Record<EffectLayer, EffectDistributionRange>>;
type LayerRanges = Readonly<Record<EffectLayer, { readonly minimum: number; readonly maximum: number }>>;
type AngularReferences = Readonly<Record<EffectLayer, readonly number[]>>;
interface CapturedPng {
  readonly bytes: Buffer;
  readonly scaleFactor: number;
  readonly devicePixelRatio: number;
  readonly cssWidth: number;
  readonly cssHeight: number;
}

function effectRanges(
  bandFractions: LayerRanges,
  radialSpan: { readonly minimum: number; readonly maximum: number },
  angularBins: { readonly minimum: number; readonly maximum: number },
  radialCenters: LayerRanges,
  angularReferences: AngularReferences,
): EffectRanges {
  return Object.fromEntries(Object.entries(bandFractions).map(([layer, bandFraction]) => [
    layer,
    {
      bandFraction,
      radialSpan,
      angularBins,
      radialCenter: radialCenters[layer as EffectLayer],
      angularReference: angularReferences[layer as EffectLayer],
      angularTotalVariationMaximum: 0.18,
    },
  ])) as unknown as EffectRanges;
}

function angularReference(nonzeroBins: Readonly<Record<number, number>>): readonly number[] {
  return Array.from({ length: 24 }, (_, bin) => nonzeroBins[bin] ?? 0);
}
async function captureNative(page: Page): Promise<CapturedPng> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  const capture = await page.evaluate(async () => {
    const frame = await window.burnCapture.captureViewport();
    const copy = new Uint8Array(frame.png.byteLength);
    copy.set(frame.png);
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.addEventListener('load', () => resolve(String(reader.result)), { once: true });
      reader.addEventListener('error', () => reject(reader.error), { once: true });
      reader.readAsDataURL(new Blob([copy.buffer], { type: 'image/png' }));
    });
    return {
      base64: dataUrl.slice(dataUrl.indexOf(',') + 1),
      scaleFactor: frame.scaleFactor,
      devicePixelRatio: window.devicePixelRatio,
      cssWidth: window.innerWidth,
      cssHeight: window.innerHeight,
    };
  });
  return { ...capture, bytes: Buffer.from(capture.base64, 'base64') };
}

async function waitForPendingFrame(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__burnTest?.hasPendingFrame() === true);
}

async function alignAnimationStart(page: Page, targetTheme: Theme): Promise<void> {
  await waitForPendingFrame(page);
  await page.evaluate(() => window.__burnTest!.step(0));
  await expect(page.locator('html')).toHaveAttribute('data-theme', targetTheme);
  await waitForPendingFrame(page);
  await page.evaluate(() => window.__burnTest!.step(0));
  await waitForPendingFrame(page);
  await page.evaluate(() => window.__burnTest!.step(0));
  await waitForPendingFrame(page);
}

async function advanceAbsolute(
  page: Page,
  elapsed: number,
  state: { elapsed: number },
): Promise<void> {
  if (elapsed < state.elapsed) throw new Error('Manual burn elapsed time cannot move backwards');
  await waitForPendingFrame(page);
  await page.evaluate((delta) => window.__burnTest!.step(delta), elapsed - state.elapsed);
  state.elapsed = elapsed;
  if (elapsed < 2_500) await waitForPendingFrame(page);
}

async function runTransitionCase(
  page: Page,
  testInfo: TestInfo,
  specification: {
    readonly name: string;
    readonly from: Theme;
    readonly to: Theme;
    readonly origin: Origin;
    readonly effectRanges: EffectRanges;
  },
): Promise<Record<string, unknown>> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', specification.from);
  await page.evaluate((baseTime) => window.__burnTest!.setTime(baseTime), BASE_TIME);
  await page.evaluate((origin) => { void window.__burnTest!.toggleAt(origin.x, origin.y); }, specification.origin);
  const overlay = page.locator('canvas[data-burn-overlay]');
  await expect(overlay).toBeVisible();
  await alignAnimationStart(page, specification.to);

  const elapsedState = { elapsed: 0 };
  const zero = await captureNative(page);
  const zeroMetrics = analyzeFrame(
    zero.bytes,
    specification.from,
    specification.to,
    specification.origin,
    VIEWPORT,
  );
  expect(zeroMetrics.opaqueFraction).toBeGreaterThan(0.9999);
  expect(zeroMetrics.oldFraction).toBeGreaterThan(0.94);

  await advanceAbsolute(page, 200, elapsedState);
  const hold = await captureNative(page);
  const holdMetrics = analyzeFrame(
    hold.bytes,
    specification.from,
    specification.to,
    specification.origin,
    VIEWPORT,
  );
  expect(validateEarlyFrames(zeroMetrics, holdMetrics)).toEqual([]);

  await advanceAbsolute(page, 1_350, elapsedState);
  const middle = await captureNative(page);
  const middleMetrics = analyzeFrame(
    middle.bytes,
    specification.from,
    specification.to,
    specification.origin,
    VIEWPORT,
  );
  expect(middleMetrics.targetNearOrigin).toBeGreaterThan(0.72);
  expect(middleMetrics.oldFarFromOrigin).toBeGreaterThan(0.72);

  await advanceAbsolute(page, 2_500, elapsedState);
  await expect(overlay).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-theme', specification.to);
  const complete = await captureNative(page);
  const completeMetrics = analyzeFrame(
    complete.bytes,
    specification.from,
    specification.to,
    specification.origin,
    VIEWPORT,
  );
  expect(completeMetrics.targetFraction).toBeGreaterThan(0.94);
  expect(await page.evaluate(() => window.__burnTest!.hasPendingFrame())).toBe(false);
  const effectMetrics = analyzeTransitionEffects(
    zero.bytes,
    middle.bytes,
    complete.bytes,
    specification.origin,
    VIEWPORT,
  );
  console.log(`BURN_CASE_EFFECT ${specification.name} ${JSON.stringify(effectMetrics)}`);
  expect(validateEffectDistributions(effectMetrics, specification.effectRanges)).toEqual([]);

  for (const [elapsed, capture] of [
    [0, zero],
    [200, hold],
    [1_350, middle],
    [2_500, complete],
  ] as const) {
    await testInfo.attach(`${specification.name}-${elapsed}.png`, {
      body: capture.bytes,
      contentType: 'image/png',
    });
  }
  const metrics = { zeroMetrics, holdMetrics, middleMetrics, completeMetrics, effectMetrics };
  await testInfo.attach(`${specification.name}-metrics.json`, {
    body: Buffer.from(JSON.stringify(metrics, null, 2)),
    contentType: 'application/json',
  });
  return metrics;
}

async function launchVisualDemo(): Promise<{ app: ElectronApplication; page: Page }> {
  let app: ElectronApplication | undefined;
  try {
    app = await electron.launch({
      executablePath: electronPath,
      args: [
        path.join(root, 'dist-electron', 'main.js'),
        '--test-mode',
        '--force-device-scale-factor=2',
      ],
    });
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.documentElement.hasAttribute('data-burn-ready')
      && Boolean(window.__burnTest));
    return { app, page };
  } catch (error) {
    await app?.close().catch(() => undefined);
    throw error;
  }
}

async function setContentSizeAndWait(
  app: ElectronApplication,
  page: Page,
  width: number,
  height: number,
): Promise<void> {
  let requestedWidth = width;
  let requestedHeight = height;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (before.width === width && before.height === height) return;
    await app.evaluate(({ BrowserWindow }, requested) => {
      BrowserWindow.getAllWindows()[0]?.setContentSize(requested.width, requested.height);
    }, { width: requestedWidth, height: requestedHeight });
    await page.waitForFunction(
      (previous) => window.innerWidth !== previous.width || window.innerHeight !== previous.height,
      before,
      { timeout: 5_000 },
    );
    const actual = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    if (actual.width === width && actual.height === height) return;
    requestedWidth += width - actual.width;
    requestedHeight += height - actual.height;
  }
  const actual = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(actual).toEqual({ width, height });
}

test('preserves both burn directions at center and opposite edge origins', async ({}, testInfo) => {
  const { app, page } = await launchVisualDemo();
  try {
    await setContentSizeAndWait(app, page, 1_280, 720);
    await page.waitForFunction(() => window.devicePixelRatio === 2);

    const sizingCapture = await captureNative(page);
    const decodedSizing = PNG.sync.read(sizingCapture.bytes);
    expect(sizingCapture).toMatchObject({
      devicePixelRatio: 2,
      cssWidth: 1_280,
      cssHeight: 720,
    });
    expect(sizingCapture.scaleFactor).toBeGreaterThanOrEqual(1);
    expect({ width: decodedSizing.width, height: decodedSizing.height }).toEqual({
      width: 2_560,
      height: 1_440,
    });

    const cases = [
      {
        name: 'dark-light-center',
        from: 'dark',
        to: 'light',
        origin: { x: 640, y: 360 },
        effectRanges: effectRanges({
          char: { minimum: 0.06, maximum: 0.10 },
          smoke: { minimum: 0.018, maximum: 0.034 },
          ember: { minimum: 0.0075, maximum: 0.016 },
          fire: { minimum: 0.018, maximum: 0.035 },
          highChroma: { minimum: 0.015, maximum: 0.03 },
        }, { minimum: 0.04, maximum: 0.115 }, { minimum: 12, maximum: 22 }, {
          char: { minimum: 0.65, maximum: 0.72 },
          smoke: { minimum: 0.55, maximum: 0.62 },
          ember: { minimum: 0.56, maximum: 0.635 },
          fire: { minimum: 0.58, maximum: 0.655 },
          highChroma: { minimum: 0.59, maximum: 0.66 },
        }, {
          char: angularReference({ 0: 0.134, 1: 0.058, 2: 0.059, 3: 0.001, 9: 0.001, 10: 0.072, 11: 0.137, 12: 0.144, 13: 0.079, 14: 0.052, 20: 0.036, 21: 0.087, 22: 0.014, 23: 0.126 }),
          smoke: angularReference({ 0: 0.048, 1: 0.058, 2: 0.063, 3: 0.064, 8: 0.043, 9: 0.125, 10: 0.055, 11: 0.052, 12: 0.049, 13: 0.066, 14: 0.078, 15: 0.062, 19: 0.017, 20: 0.048, 21: 0.059, 22: 0.065, 23: 0.048 }),
          ember: angularReference({ 0: 0.054, 1: 0.057, 2: 0.075, 3: 0.05, 8: 0.03, 9: 0.116, 10: 0.073, 11: 0.053, 12: 0.045, 13: 0.062, 14: 0.082, 15: 0.063, 19: 0.009, 20: 0.053, 21: 0.065, 22: 0.066, 23: 0.047 }),
          fire: angularReference({ 0: 0.06, 1: 0.059, 2: 0.086, 3: 0.035, 8: 0.016, 9: 0.131, 10: 0.109, 11: 0.057, 12: 0.045, 13: 0.061, 14: 0.083, 15: 0.028, 19: 0.002, 20: 0.054, 21: 0.056, 22: 0.072, 23: 0.048 }),
          highChroma: angularReference({ 0: 0.058, 1: 0.058, 2: 0.077, 3: 0.034, 8: 0.016, 9: 0.119, 10: 0.108, 11: 0.06, 12: 0.049, 13: 0.065, 14: 0.088, 15: 0.03, 19: 0.003, 20: 0.051, 21: 0.059, 22: 0.074, 23: 0.05 }),
        }),
      },
      {
        name: 'light-dark-top-left',
        from: 'light',
        to: 'dark',
        origin: { x: 120, y: 90 },
        effectRanges: effectRanges({
          char: { minimum: 0.034, maximum: 0.063 },
          smoke: { minimum: 0.0105, maximum: 0.021 },
          ember: { minimum: 0.009, maximum: 0.019 },
          fire: { minimum: 0.0015, maximum: 0.0032 },
          highChroma: { minimum: 0.005, maximum: 0.011 },
        }, { minimum: 0.024, maximum: 0.065 }, { minimum: 6, maximum: 11 }, {
          char: { minimum: 0.57, maximum: 0.63 },
          smoke: { minimum: 0.58, maximum: 0.65 },
          ember: { minimum: 0.59, maximum: 0.65 },
          fire: { minimum: 0.60, maximum: 0.66 },
          highChroma: { minimum: 0.59, maximum: 0.655 },
        }, {
          char: angularReference({ 11: 0.101, 12: 0.087, 13: 0.112, 14: 0.119, 15: 0.155, 16: 0.15, 17: 0.117, 18: 0.121, 19: 0.038 }),
          smoke: angularReference({ 11: 0.087, 12: 0.092, 13: 0.114, 14: 0.164, 15: 0.138, 16: 0.191, 17: 0.129, 18: 0.084, 19: 0.001 }),
          ember: angularReference({ 11: 0.104, 12: 0.099, 13: 0.125, 14: 0.144, 15: 0.165, 16: 0.127, 17: 0.132, 18: 0.104 }),
          fire: angularReference({ 11: 0.125, 12: 0.065, 13: 0.067, 14: 0.287, 15: 0.172, 16: 0.059, 17: 0.121, 18: 0.104 }),
          highChroma: angularReference({ 11: 0.102, 12: 0.102, 13: 0.134, 14: 0.132, 15: 0.16, 16: 0.13, 17: 0.131, 18: 0.109 }),
        }),
      },
      {
        name: 'dark-light-bottom-right',
        from: 'dark',
        to: 'light',
        origin: { x: 1_160, y: 630 },
        effectRanges: effectRanges({
          char: { minimum: 0.068, maximum: 0.13 },
          smoke: { minimum: 0.024, maximum: 0.049 },
          ember: { minimum: 0.0155, maximum: 0.032 },
          fire: { minimum: 0.022, maximum: 0.045 },
          highChroma: { minimum: 0.018, maximum: 0.038 },
        }, { minimum: 0.038, maximum: 0.145 }, { minimum: 6, maximum: 12 }, {
          char: { minimum: 0.65, maximum: 0.72 },
          smoke: { minimum: 0.55, maximum: 0.62 },
          ember: { minimum: 0.59, maximum: 0.66 },
          fire: { minimum: 0.59, maximum: 0.66 },
          highChroma: { minimum: 0.59, maximum: 0.665 },
        }, {
          char: angularReference({ 0: 0.005, 1: 0.02, 2: 0.169, 3: 0.24, 4: 0.286, 5: 0.106, 6: 0.106, 23: 0.068 }),
          smoke: angularReference({ 0: 0.116, 1: 0.144, 2: 0.09, 3: 0.114, 4: 0.105, 5: 0.16, 6: 0.162, 7: 0.015, 23: 0.096 }),
          ember: angularReference({ 0: 0.075, 1: 0.199, 2: 0.278, 3: 0.078, 4: 0.088, 5: 0.09, 6: 0.125, 7: 0.005, 23: 0.063 }),
          fire: angularReference({ 0: 0.138, 1: 0.183, 2: 0.109, 3: 0.103, 4: 0.1, 5: 0.134, 6: 0.133, 7: 0.009, 23: 0.091 }),
          highChroma: angularReference({ 0: 0.136, 1: 0.176, 2: 0.111, 3: 0.106, 4: 0.107, 5: 0.121, 6: 0.147, 7: 0.004, 23: 0.093 }),
        }),
      },
      {
        name: 'light-dark-center',
        from: 'light',
        to: 'dark',
        origin: { x: 640, y: 360 },
        effectRanges: effectRanges({
          char: { minimum: 0.02, maximum: 0.041 },
          smoke: { minimum: 0.0068, maximum: 0.014 },
          ember: { minimum: 0.0065, maximum: 0.014 },
          fire: { minimum: 0.00085, maximum: 0.0019 },
          highChroma: { minimum: 0.0038, maximum: 0.0082 },
        }, { minimum: 0.048, maximum: 0.11 }, { minimum: 12, maximum: 24 }, {
          char: { minimum: 0.545, maximum: 0.61 },
          smoke: { minimum: 0.555, maximum: 0.62 },
          ember: { minimum: 0.56, maximum: 0.63 },
          fire: { minimum: 0.565, maximum: 0.63 },
          highChroma: { minimum: 0.565, maximum: 0.635 },
        }, {
          char: angularReference({ 0: 0.048, 1: 0.06, 2: 0.059, 3: 0.072, 4: 0.0002, 7: 0.0005, 8: 0.045, 9: 0.111, 10: 0.052, 11: 0.053, 12: 0.053, 13: 0.065, 14: 0.075, 15: 0.062, 19: 0.021, 20: 0.05, 21: 0.056, 22: 0.065, 23: 0.05 }),
          smoke: angularReference({ 0: 0.049, 1: 0.056, 2: 0.065, 3: 0.058, 8: 0.04, 9: 0.129, 10: 0.054, 11: 0.049, 12: 0.048, 13: 0.067, 14: 0.082, 15: 0.064, 19: 0.014, 20: 0.049, 21: 0.063, 22: 0.067, 23: 0.045 }),
          ember: angularReference({ 0: 0.053, 1: 0.056, 2: 0.078, 3: 0.054, 8: 0.033, 9: 0.112, 10: 0.071, 11: 0.055, 12: 0.043, 13: 0.058, 14: 0.081, 15: 0.069, 19: 0.01, 20: 0.053, 21: 0.062, 22: 0.063, 23: 0.048 }),
          fire: angularReference({ 0: 0.054, 1: 0.053, 2: 0.094, 3: 0.063, 8: 0.029, 9: 0.078, 10: 0.117, 11: 0.091, 12: 0.029, 13: 0.036, 14: 0.066, 15: 0.077, 19: 0.014, 20: 0.058, 21: 0.038, 22: 0.045, 23: 0.06 }),
          highChroma: angularReference({ 0: 0.054, 1: 0.059, 2: 0.079, 3: 0.045, 8: 0.028, 9: 0.131, 10: 0.072, 11: 0.051, 12: 0.045, 13: 0.061, 14: 0.08, 15: 0.054, 19: 0.006, 20: 0.058, 21: 0.065, 22: 0.069, 23: 0.046 }),
        }),
      },
    ] as const;
    const metrics: Record<string, unknown> = {};
    for (const specification of cases) {
      metrics[specification.name] = await runTransitionCase(page, testInfo, specification);
    }
    console.log(`BURN_VISUAL_METRICS ${JSON.stringify({
      viewport: VIEWPORT,
      encoded: { width: decodedSizing.width, height: decodedSizing.height },
      dpr: sizingCapture.devicePixelRatio,
      scaleFactor: sizingCapture.scaleFactor,
      metrics,
    })}`);
  } finally {
    await app.close();
  }
});
