import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertJellyFixtureMetadataContract,
  assertJellyFixtureOverwriteContract,
  writeJellyFixtureDirectoryAtomically,
  type JellyFixtureMetadata,
} from '../support/jelly-fixture-authoring';

const temporaryDirectories: string[] = [];

function metadata(): JellyFixtureMetadata {
  return {
    schemaVersion: 1,
    thresholdVersion: 1,
    environment: {
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
    },
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
    frames: {
      off: { tick: 0, width: 176, height: 88, diagnosticJitterIndex: 15 },
      arch: { tick: 23, width: 176, height: 88, diagnosticJitterIndex: 15 },
      on: { tick: 0, width: 176, height: 88, diagnosticJitterIndex: 15 },
    },
  };
}

function snapshot(directory: string): Readonly<Record<string, string>> {
  return Object.fromEntries(readdirSync(directory).sort().map((name) => [
    name,
    readFileSync(path.join(directory, name)).toString('hex'),
  ]));
}

function payload(staging: string): void {
  for (const state of ['off', 'arch', 'on']) {
    writeFileSync(path.join(staging, `${state}.png`), `${state}-png`);
    writeFileSync(path.join(staging, `${state}-a.rgba16f`), `${state}-a`);
    writeFileSync(path.join(staging, `${state}-b.rgba16f`), `${state}-b`);
  }
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('jelly fixture authoring', () => {
  it('leaves every tracked fixture byte-identical when capture validation fails', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'jelly-authoring-'));
    temporaryDirectories.push(parent);
    const target = path.join(parent, 'jelly-toggle');
    mkdirSync(target);
    writeFileSync(path.join(target, 'metadata.json'), JSON.stringify(metadata()));
    writeFileSync(path.join(target, 'off.png'), 'tracked-off');
    const before = snapshot(target);
    const writePayload = vi.fn(payload);

    expect(() => writeJellyFixtureDirectoryAtomically({
      parentDirectory: parent,
      metadata: metadata(),
      validateCaptures: () => { throw new Error('missing caustic'); },
      writePayload,
      validateStaging: () => undefined,
    })).toThrow('missing caustic');

    expect(snapshot(target)).toEqual(before);
    expect(writePayload).not.toHaveBeenCalled();
  });

  it.each([
    ['missing payload', (target: string) => rmSync(path.join(target, 'on-b.rgba16f'))],
    ['unexpected payload', (target: string) => writeFileSync(path.join(target, 'untracked.bin'), 'x')],
  ] as const)('rejects an existing %s set before staging or overwrite', (_name, mutate) => {
    const parent = mkdtempSync(path.join(tmpdir(), 'jelly-authoring-'));
    temporaryDirectories.push(parent);
    const target = path.join(parent, 'jelly-toggle');
    mkdirSync(target);
    payload(target);
    writeFileSync(path.join(target, 'metadata.json'), JSON.stringify(metadata()));
    mutate(target);
    const before = snapshot(target);
    const writePayload = vi.fn(payload);

    expect(() => writeJellyFixtureDirectoryAtomically({
      parentDirectory: parent,
      metadata: metadata(),
      validateCaptures: () => undefined,
      writePayload,
      validateStaging: () => undefined,
    })).toThrow();
    expect(snapshot(target)).toEqual(before);
    expect(writePayload).not.toHaveBeenCalled();
  });

  it('leaves the existing fixture byte-identical when staged serialization is corrupt', () => {
    const parent = mkdtempSync(path.join(tmpdir(), 'jelly-authoring-'));
    temporaryDirectories.push(parent);
    const target = path.join(parent, 'jelly-toggle');
    mkdirSync(target);
    payload(target);
    writeFileSync(path.join(target, 'metadata.json'), JSON.stringify(metadata()));
    const before = snapshot(target);

    expect(() => writeJellyFixtureDirectoryAtomically({
      parentDirectory: parent,
      metadata: metadata(),
      validateCaptures: () => undefined,
      writePayload(staging) {
        payload(staging);
        writeFileSync(path.join(staging, 'off.png'), 'corrupt serialized PNG');
      },
      validateStaging(staging) {
        if (readFileSync(path.join(staging, 'off.png'), 'utf8').startsWith('corrupt')) {
          throw new Error('corrupt serialized PNG');
        }
      },
    })).toThrow('corrupt serialized PNG');
    expect(snapshot(target)).toEqual(before);
    expect(readdirSync(parent)).toEqual(['jelly-toggle']);
  });

  it.each([
    ['environment', (value: JellyFixtureMetadata) => ({ ...value, environment: { ...value.environment, gpu: 'other' } })],
    ['seed', (value: JellyFixtureMetadata) => ({ ...value, seed: 'other' })],
    ['prng algorithm', (value: JellyFixtureMetadata) => ({ ...value, prng: { ...value.prng, algorithm: 'other' } })],
    ['prng version', (value: JellyFixtureMetadata) => ({ ...value, prng: { ...value.prng, version: 2 } })],
    ['upstream', (value: JellyFixtureMetadata) => ({ ...value, upstreamRevision: 'other' })],
    ['threshold', (value: JellyFixtureMetadata) => ({ ...value, thresholdVersion: 2 })],
    ['samples', (value: JellyFixtureMetadata) => ({ ...value, taaSamples: 15 })],
    ['jitter', (value: JellyFixtureMetadata) => ({ ...value, diagnosticJitterIndex: 14 })],
    ['component', (value: JellyFixtureMetadata) => ({ ...value, rawAttachments: { ...value.rawAttachments, componentType: 'float32' } })],
    ['endianness', (value: JellyFixtureMetadata) => ({ ...value, rawAttachments: { ...value.rawAttachments, byteOrder: 'big-endian' } })],
    ['packing', (value: JellyFixtureMetadata) => ({ ...value, rawAttachments: { ...value.rawAttachments, packing: 'padded' } })],
    ['frame names', (value: JellyFixtureMetadata) => ({ ...value, frames: { off: value.frames.off, arch: value.frames.arch } })],
    ['frame dimensions', (value: JellyFixtureMetadata) => ({ ...value, frames: { ...value.frames, on: { ...value.frames.on, width: 175 } } })],
    ['frame jitter', (value: JellyFixtureMetadata) => ({ ...value, frames: { ...value.frames, off: { ...value.frames.off, diagnosticJitterIndex: 14 } } })],
    ['canonical tick', (value: JellyFixtureMetadata) => ({ ...value, frames: { ...value.frames, on: { ...value.frames.on, tick: 1 } } })],
  ] as const)('rejects an existing %s contract mismatch before overwrite', (_name, mutate) => {
    expect(() => assertJellyFixtureOverwriteContract(
      mutate(metadata()) as unknown as JellyFixtureMetadata,
      metadata(),
    )).toThrow();
  });

  it('allows only the peak-derived arch tick to change', () => {
    const existing = metadata();
    const next = {
      ...metadata(),
      frames: {
        ...metadata().frames,
        arch: { ...metadata().frames.arch, tick: 24 },
      },
    } as JellyFixtureMetadata;
    expect(() => assertJellyFixtureOverwriteContract(existing, next)).not.toThrow();
  });

  it('requires the deterministic PRNG identity even for a fresh fixture contract', () => {
    const { prng: _prng, ...missingPrng } = metadata();
    expect(() => assertJellyFixtureMetadataContract(
      missingPrng as unknown as JellyFixtureMetadata,
    )).toThrow();
  });
});
