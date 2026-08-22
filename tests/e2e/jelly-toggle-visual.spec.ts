import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';
import { PNG } from 'pngjs';

import type { JellyRendererStats } from '../../src/jelly-toggle-3d/renderer';
import { launchPreparedJellyFixtureWindow } from '../support/electron-content-size';
import {
  EXPECTED_JELLY_FIXTURE_ENVIRONMENT,
  JELLY_FIXTURE_STATES,
  writeJellyFixtureDirectoryAtomically,
  type JellyFixtureMetadata,
  type JellyFixtureState,
} from '../support/jelly-fixture-authoring';
import { loadAndValidateCommittedJellyFixtures } from '../support/jelly-fixture-reader';
import {
  analyzeJellyFrame,
  assertJellyVisualRanges,
  emitJellyDiagnosticSummaries,
  type JellyFrameFixture,
  type JellyVisualMetrics,
} from '../support/jelly-visual-analysis';

const electronPath = require('electron') as string;
const mainPath = path.join(process.cwd(), 'dist-electron', 'main.js');
const fixtureParent = path.join(process.cwd(), 'tests', 'fixtures');
const fixtureDirectory = path.join(fixtureParent, 'jelly-toggle');
const updateFixtures = process.env.UPDATE_JELLY_FIXTURES === '1';
const diagnosticSummaryOnly = process.env.JELLY_DIAGNOSTIC_SUMMARY_ONLY === '1';
const states = JELLY_FIXTURE_STATES;
type State = JellyFixtureState;
const expectedEnvironment = EXPECTED_JELLY_FIXTURE_ENVIRONMENT;

interface SerializedCapture {
  readonly state: State;
  readonly tick: number;
  readonly jitterIndex: number;
  readonly width: number;
  readonly height: number;
  readonly attachmentA: readonly number[];
  readonly attachmentB: readonly number[];
  readonly png: Buffer;
}

async function launchDiagnostic(): Promise<{ readonly app: ElectronApplication; readonly page: Page }> {
  return launchPreparedJellyFixtureWindow(() => electron.launch({
    executablePath: electronPath,
    args: [
      mainPath,
      '--jelly-toggle',
      '--test-mode',
      '--diagnostic-webgpu',
      '--fixture-capture',
    ],
  }));
}

async function authoringEnvironment(app: ElectronApplication, page: Page) {
  const renderer = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const debug = gl?.getExtension('WEBGL_debug_renderer_info');
    return gl && debug
      ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : gl ? String(gl.getParameter(gl.RENDERER)) : 'WebGL2 unavailable';
  });
  const surface = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.jelly-toggle-3d__canvas');
    return {
      viewport: { width: innerWidth, height: innerHeight },
      devicePixelRatio,
      backing: { width: canvas?.width ?? 0, height: canvas?.height ?? 0 },
      colorSpace: matchMedia('(color-gamut: p3)').matches
        ? 'Display P3'
        : matchMedia('(color-gamut: srgb)').matches ? 'sRGB' : 'unknown',
    };
  });
  const host = await app.evaluate(() => ({
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
  }));
  return {
    ...host,
    angleBackend: /Direct3D11|D3D11/.test(renderer) ? 'D3D11' : renderer,
    gpu: renderer.includes(expectedEnvironment.gpu) ? expectedEnvironment.gpu : renderer,
    ...surface,
  };
}

function assertExactEnvironment(actual: unknown): asserts actual is typeof expectedEnvironment {
  assert.deepStrictEqual(
    actual,
    expectedEnvironment,
    `Golden authoring environment mismatch:\n${JSON.stringify(actual, null, 2)}`,
  );
}

async function capture(page: Page, state: State): Promise<SerializedCapture> {
  const value = await page.evaluate(async (requestedState) => {
    const result = await window.__jellyTest!.captureFixture(requestedState);
    return {
      state: result.state,
      tick: result.tick,
      jitterIndex: result.jitterIndex,
      width: result.width,
      height: result.height,
      attachmentA: Array.from(result.diagnostics.attachmentA),
      attachmentB: Array.from(result.diagnostics.attachmentB),
      pngDataUrl: result.pngDataUrl,
    };
  }, state);
  expect(value.pngDataUrl).toMatch(/^data:image\/png;base64,/);
  const png = await page.locator('.jelly-toggle-3d__canvas').screenshot({ type: 'png' });
  const decoded = PNG.sync.read(png);
  expect({ width: decoded.width, height: decoded.height }).toEqual({ width: 176, height: 88 });
  return { ...value, png };
}

function floatToHalf(value: number): number {
  const float = new Float32Array(1);
  const integer = new Uint32Array(float.buffer);
  float[0] = value;
  const source = integer[0]!;
  let bits = (source >>> 16) & 0x8000;
  let mantissa = (source >>> 12) & 0x07ff;
  const exponent = (source >>> 23) & 0xff;
  if (exponent < 103) return bits;
  if (exponent > 142) {
    bits |= 0x7c00;
    if (exponent === 255 && (source & 0x007fffff) !== 0) bits |= 1;
    return bits;
  }
  if (exponent < 113) {
    mantissa |= 0x0800;
    bits |= (mantissa >>> (114 - exponent)) + ((mantissa >>> (113 - exponent)) & 1);
    return bits;
  }
  bits |= ((exponent - 112) << 10) | (mantissa >>> 1);
  return bits + (mantissa & 1);
}

function encodeHalf(values: readonly number[]): Buffer {
  const bytes = Buffer.allocUnsafe(values.length * 2);
  for (let index = 0; index < values.length; index += 1) {
    bytes.writeUInt16LE(floatToHalf(values[index]!), index * 2);
  }
  return bytes;
}

function metadata(captures: Readonly<Record<State, SerializedCapture>>): JellyFixtureMetadata {
  return {
    schemaVersion: 1,
    thresholdVersion: 1,
    environment: expectedEnvironment,
    upstreamRevision: 'd4433e329697c4341a9f915f75dbd9608f3939fa',
    seed: '0x4A454C4C',
    prng: { algorithm: 'xorshift32', version: 1 },
    taaSamples: 16,
    diagnosticJitterIndex: 15,
    rawAttachments: {
      format: 'rgba16float',
      componentType: 'IEEE-754 binary16',
      byteOrder: 'little-endian',
      packing: 'tightly-packed RGBA with no row padding',
    },
    frames: Object.fromEntries(
      states.map((state) => [state, {
        tick: captures[state].tick,
        width: 176,
        height: 88,
        diagnosticJitterIndex: 15,
      }]),
    ) as JellyFixtureMetadata['frames'],
  };
}

function frameFixture(
  captureValue: SerializedCapture,
  fixtureMetadata: JellyFixtureMetadata,
): JellyFrameFixture {
  const png = PNG.sync.read(captureValue.png);
  return {
    width: captureValue.width,
    height: captureValue.height,
    srgb: new Uint8Array(png.data),
    diagnostics: {
      width: captureValue.width,
      height: captureValue.height,
      attachmentA: Float32Array.from(captureValue.attachmentA),
      attachmentB: Float32Array.from(captureValue.attachmentB),
    },
    metadata: {
      state: captureValue.state,
      tick: captureValue.tick,
      thresholdVersion: fixtureMetadata.thresholdVersion,
    },
  };
}

function validateCaptures(
  captures: Readonly<Record<State, SerializedCapture>>,
  fixtureMetadata: JellyFixtureMetadata,
): Readonly<Record<State, JellyFrameFixture>> {
  const frames = {} as Record<State, JellyFrameFixture>;
  for (const state of states) {
    const captureValue = captures[state];
    assert.strictEqual(captureValue.state, state, `${state} capture state mismatch`);
    assert.strictEqual(captureValue.tick, fixtureMetadata.frames[state].tick, `${state} tick mismatch`);
    assert.strictEqual(captureValue.jitterIndex, 15, `${state} jitter mismatch`);
    assert.strictEqual(captureValue.width, 176, `${state} width mismatch`);
    assert.strictEqual(captureValue.height, 88, `${state} height mismatch`);
    const frame = frameFixture(captureValue, fixtureMetadata);
    try {
      assertJellyVisualRanges(analyzeJellyFrame(frame, frame));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${state} fixture visual validation failed: ${detail}`);
    }
    frames[state] = frame;
  }
  return frames;
}

function writeFixturePayload(
  stagingDirectory: string,
  captures: Readonly<Record<State, SerializedCapture>>,
): void {
  for (const state of states) {
    writeFileSync(path.join(stagingDirectory, `${state}.png`), captures[state].png);
    writeFileSync(
      path.join(stagingDirectory, `${state}-a.rgba16f`),
      encodeHalf(captures[state].attachmentA),
    );
    writeFileSync(
      path.join(stagingDirectory, `${state}-b.rgba16f`),
      encodeHalf(captures[state].attachmentB),
    );
  }
}

async function productionOffPng(): Promise<Buffer> {
  const { app, page } = await launchPreparedJellyFixtureWindow(() => electron.launch({
    executablePath: electronPath,
    args: [mainPath, '--jelly-toggle', '--test-mode', '--fixture-capture'],
  }));
  try {
    await page.evaluate(() => window.__jellyTest!.captureFixturePng('off'));
    return await page.locator('.jelly-toggle-3d__canvas').screenshot({ type: 'png' });
  } finally {
    await app.close();
  }
}

test('locks OFF, first-arch, and ON diagnostic visual fidelity', async () => {
  if (updateFixtures && diagnosticSummaryOnly) {
    throw new Error('Diagnostic summary-only mode cannot update jelly fixtures');
  }
  const committedBeforeCapture = (() => {
    if (diagnosticSummaryOnly) return undefined;
    if (updateFixtures) return undefined;
    if (!existsSync(fixtureDirectory)) {
      throw new Error('Jelly fixtures are missing; run the fixed-machine capture:jelly command');
    }
    return loadAndValidateCommittedJellyFixtures(fixtureDirectory);
  })();
  let app: ElectronApplication | undefined;
  try {
    const launched = await launchDiagnostic();
    app = launched.app;
    const runtimeEnvironment = await authoringEnvironment(app, launched.page);
    if (updateFixtures) assertExactEnvironment(runtimeEnvironment);
    const exactAuthoringMachine = (() => {
      try {
        assertExactEnvironment(runtimeEnvironment);
        return true;
      } catch {
        return false;
      }
    })();

    const captures = {} as Record<State, SerializedCapture>;
    for (const state of states) captures[state] = await capture(launched.page, state);
    const fixtureMetadata = metadata(captures);
    if (emitJellyDiagnosticSummaries({
      enabled: diagnosticSummaryOnly,
      frames: states.map((state) => ({
        state,
        fixture: frameFixture(captures[state], fixtureMetadata),
      })),
      log: console.log,
    })) return;
    const actualFrames = validateCaptures(captures, fixtureMetadata);
    if (exactAuthoringMachine) {
      const production = PNG.sync.read(await productionOffPng());
      const diagnostic = PNG.sync.read(captures.off.png);
      expect(Buffer.compare(production.data, diagnostic.data)).toBe(0);
    }
    if (updateFixtures) {
      mkdirSync(fixtureParent, { recursive: true });
      writeJellyFixtureDirectoryAtomically({
        parentDirectory: fixtureParent,
        metadata: fixtureMetadata,
        validateCaptures: () => { validateCaptures(captures, fixtureMetadata); },
        writePayload: (stagingDirectory) => writeFixturePayload(stagingDirectory, captures),
        validateStaging(stagingDirectory) {
          const staged = loadAndValidateCommittedJellyFixtures(stagingDirectory);
          assert.deepStrictEqual(staged.metadata, fixtureMetadata);
        },
      });
    }

    const committed = committedBeforeCapture
      ?? loadAndValidateCommittedJellyFixtures(fixtureDirectory);
    expect(committed.metadata).toEqual(fixtureMetadata);
    expect(committed.metadata.frames.arch.tick).toBeGreaterThan(0);
    expect(committed.metadata.frames.arch.tick).toBeLessThan(120);

    const metrics: Partial<Record<State, JellyVisualMetrics>> = {};
    for (const state of states) {
      if (exactAuthoringMachine) {
        metrics[state] = analyzeJellyFrame(actualFrames[state], committed.frames[state]);
        assertJellyVisualRanges(metrics[state]!);
      }
    }
    console.log(`JELLY_VISUAL_METRICS ${JSON.stringify(metrics)}`);

  } finally {
    await app?.close();
  }
});
