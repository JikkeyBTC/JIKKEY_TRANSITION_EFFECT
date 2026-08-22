import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export const JELLY_FIXTURE_STATES = ['off', 'arch', 'on'] as const;
export type JellyFixtureState = typeof JELLY_FIXTURE_STATES[number];

export const EXPECTED_JELLY_FIXTURE_ENVIRONMENT = Object.freeze({
  platform: 'win32',
  arch: 'x64',
  electron: '43.4.0',
  chromium: '150.0.7871.224',
  angleBackend: 'D3D11',
  gpu: 'NVIDIA GeForce RTX 4070 SUPER',
  colorSpace: 'sRGB',
  viewport: { width: 800, height: 600 },
  devicePixelRatio: 2,
  backing: { width: 176, height: 88 },
} as const);

export interface JellyFixtureFrameMetadata {
  readonly tick: number;
  readonly width: 176;
  readonly height: 88;
  readonly diagnosticJitterIndex: 15;
}

export interface JellyFixtureMetadata {
  readonly schemaVersion: 1;
  readonly thresholdVersion: 1;
  readonly environment: typeof EXPECTED_JELLY_FIXTURE_ENVIRONMENT;
  readonly upstreamRevision: 'd4433e329697c4341a9f915f75dbd9608f3939fa';
  readonly seed: '0x4A454C4C';
  readonly prng: Readonly<{ algorithm: 'xorshift32'; version: 1 }>;
  readonly taaSamples: 16;
  readonly diagnosticJitterIndex: 15;
  readonly rawAttachments: Readonly<{
    format: 'rgba16float';
    componentType: 'IEEE-754 binary16';
    byteOrder: 'little-endian';
    packing: 'tightly-packed RGBA with no row padding';
  }>;
  readonly frames: Readonly<Record<JellyFixtureState, JellyFixtureFrameMetadata>>;
}

export const EXPECTED_JELLY_FIXTURE_FILES = Object.freeze([
  'arch-a.rgba16f',
  'arch-b.rgba16f',
  'arch.png',
  'metadata.json',
  'off-a.rgba16f',
  'off-b.rgba16f',
  'off.png',
  'on-a.rgba16f',
  'on-b.rgba16f',
  'on.png',
]);

function immutableContract(metadata: JellyFixtureMetadata): unknown {
  return {
    ...metadata,
    frames: {
      ...metadata.frames,
      arch: { ...metadata.frames.arch, tick: '<peak-derived>' },
    },
  };
}

export function assertJellyFixtureMetadataContract(
  metadata: JellyFixtureMetadata,
): void {
  assert.deepStrictEqual(metadata.environment, EXPECTED_JELLY_FIXTURE_ENVIRONMENT);
  assert.strictEqual(metadata.schemaVersion, 1);
  assert.strictEqual(metadata.thresholdVersion, 1);
  assert.strictEqual(metadata.upstreamRevision, 'd4433e329697c4341a9f915f75dbd9608f3939fa');
  assert.strictEqual(metadata.seed, '0x4A454C4C');
  assert.deepStrictEqual(metadata.prng, { algorithm: 'xorshift32', version: 1 });
  assert.strictEqual(metadata.taaSamples, 16);
  assert.strictEqual(metadata.diagnosticJitterIndex, 15);
  assert.deepStrictEqual(metadata.rawAttachments, {
    format: 'rgba16float',
    componentType: 'IEEE-754 binary16',
    byteOrder: 'little-endian',
    packing: 'tightly-packed RGBA with no row padding',
  });
  assert.deepStrictEqual(Object.keys(metadata.frames).sort(), [...JELLY_FIXTURE_STATES].sort());
  for (const state of JELLY_FIXTURE_STATES) {
    const frame = metadata.frames[state];
    assert.strictEqual(frame.width, 176, `${state} width`);
    assert.strictEqual(frame.height, 88, `${state} height`);
    assert.strictEqual(frame.diagnosticJitterIndex, 15, `${state} diagnostic jitter`);
    assert.ok(Number.isSafeInteger(frame.tick), `${state} tick must be an integer`);
  }
  assert.strictEqual(metadata.frames.off.tick, 0);
  assert.strictEqual(metadata.frames.on.tick, 0);
  assert.ok(metadata.frames.arch.tick > 0 && metadata.frames.arch.tick < 120);
}

export function assertJellyFixtureOverwriteContract(
  existing: JellyFixtureMetadata,
  next: JellyFixtureMetadata,
): void {
  assertJellyFixtureMetadataContract(existing);
  assertJellyFixtureMetadataContract(next);
  assert.deepStrictEqual(immutableContract(existing), immutableContract(next));
}

export function writeJellyFixtureDirectoryAtomically(options: Readonly<{
  parentDirectory: string;
  metadata: JellyFixtureMetadata;
  validateCaptures(): void;
  writePayload(stagingDirectory: string): void;
  validateStaging(stagingDirectory: string): void;
}>): void {
  options.validateCaptures();
  assertJellyFixtureMetadataContract(options.metadata);

  const target = path.join(options.parentDirectory, 'jelly-toggle');
  const existingMetadataPath = path.join(target, 'metadata.json');
  if (existsSync(target)) {
    assert.deepStrictEqual(
      readdirSync(target).sort(),
      [...EXPECTED_JELLY_FIXTURE_FILES].sort(),
      'Existing jelly fixture file set mismatch',
    );
    if (!existsSync(existingMetadataPath)) {
      throw new Error('Existing jelly fixture directory has no metadata contract');
    }
    const existing = JSON.parse(readFileSync(existingMetadataPath, 'utf8')) as JellyFixtureMetadata;
    assertJellyFixtureOverwriteContract(existing, options.metadata);
  }

  const staging = mkdtempSync(path.join(options.parentDirectory, '.jelly-toggle-staging-'));
  try {
    options.writePayload(staging);
    writeFileSync(path.join(staging, 'metadata.json'), `${JSON.stringify(options.metadata, null, 2)}\n`);
    assert.deepStrictEqual(readdirSync(staging).sort(), [...EXPECTED_JELLY_FIXTURE_FILES].sort());
    options.validateStaging(staging);
    if (!existsSync(target)) {
      renameSync(staging, target);
      return;
    }

    const backup = path.join(
      options.parentDirectory,
      `.jelly-toggle-backup-${process.pid}-${Date.now()}`,
    );
    renameSync(target, backup);
    try {
      renameSync(staging, target);
    } catch (error) {
      renameSync(backup, target);
      throw error;
    }
    rmSync(backup, { recursive: true, force: true });
  } finally {
    if (existsSync(staging)) rmSync(staging, { recursive: true, force: true });
  }
}
