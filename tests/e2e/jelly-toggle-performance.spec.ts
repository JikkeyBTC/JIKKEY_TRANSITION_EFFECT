import { expect, test } from '@playwright/test';
import { _electron as electron } from 'playwright';
import path from 'node:path';

const electronPath = require('electron') as string;
const mainPath = path.join(process.cwd(), 'dist-electron', 'main.js');

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  return sorted[Math.ceil((sorted.length - 1) * quantile)]!;
}

test('reports opt-in real-clock jelly frame intervals without a portable threshold', async ({}, testInfo) => {
  const app = await electron.launch({
    executablePath: electronPath,
    args: [mainPath, '--jelly-toggle'],
  });
  try {
    const page = await app.firstWindow();
    await page.locator('html[data-jelly-ready="webgpu"]').waitFor();
    const environment = await page.evaluate(() => {
      const probe = document.createElement('canvas');
      const gl = probe.getContext('webgl2');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      const renderer = gl && debug
        ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
        : gl ? String(gl.getParameter(gl.RENDERER)) : 'WebGL2 unavailable';
      const canvas = document.querySelector<HTMLCanvasElement>('.jelly-toggle-3d__canvas');
      return {
        viewport: { width: innerWidth, height: innerHeight },
        devicePixelRatio,
        backing: { width: canvas?.width ?? 0, height: canvas?.height ?? 0 },
        renderer,
        angle: renderer.includes('ANGLE') ? renderer : 'ANGLE not reported',
      };
    });
    const host = await app.evaluate(async ({ app: electronApp }) => ({
      os: { platform: process.platform, arch: process.arch, release: process.getSystemVersion() },
      electron: process.versions.electron,
      chromium: process.versions.chrome,
      gpuInfo: await electronApp.getGPUInfo('basic'),
    }));

    await page.getByRole('switch', { name: 'Jelly toggle' }).click();
    const intervals = await page.evaluate(() => new Promise<number[]>((resolve) => {
      const result: number[] = [];
      const started = performance.now();
      let previous = started;
      const collect = (now: number): void => {
        result.push(now - previous);
        previous = now;
        if (now - started >= 2_200) resolve(result);
        else requestAnimationFrame(collect);
      };
      requestAnimationFrame(collect);
    }));
    expect(intervals.length).toBeGreaterThan(0);
    expect(intervals.every(Number.isFinite)).toBe(true);
    const report = {
      machineSpecific: true,
      measuredAt: new Date().toISOString(),
      rawIntervalsMs: intervals,
      p95Ms: percentile(intervals, 0.95),
      intervalsOver34Ms: intervals.filter((interval) => interval > 34).length,
      ...host,
      ...environment,
    };
    console.log(`JELLY_BENCHMARK ${JSON.stringify(report)}`);
    await testInfo.attach('jelly-benchmark.json', {
      body: Buffer.from(JSON.stringify(report, null, 2)),
      contentType: 'application/json',
    });
  } finally {
    await app.close();
  }
});
