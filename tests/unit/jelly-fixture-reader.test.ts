import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { afterEach, describe, expect, it } from 'vitest';

import { loadAndValidateCommittedJellyFixtures } from '../support/jelly-fixture-reader';
import type { JellyFixtureMetadata } from '../support/jelly-fixture-authoring';

const temporaryDirectories: string[] = [];
const WIDTH = 176;
const HEIGHT = 88;
const PIXELS = WIDTH * HEIGHT;

function fixtureMetadata(): JellyFixtureMetadata {
  return {
    schemaVersion: 1,
    thresholdVersion: 1,
    environment: {
      platform: 'win32', arch: 'x64', electron: '43.4.0', chromium: '150.0.7871.224',
      angleBackend: 'D3D11', gpu: 'NVIDIA GeForce RTX 4070 SUPER', colorSpace: 'sRGB',
      viewport: { width: 800, height: 600 }, devicePixelRatio: 2,
      backing: { width: WIDTH, height: HEIGHT },
    },
    upstreamRevision: 'd4433e329697c4341a9f915f75dbd9608f3939fa',
    seed: '0x4A454C4C',
    prng: { algorithm: 'xorshift32', version: 1 },
    taaSamples: 16,
    diagnosticJitterIndex: 15,
    rawAttachments: {
      format: 'rgba16float', componentType: 'IEEE-754 binary16',
      byteOrder: 'little-endian', packing: 'tightly-packed RGBA with no row padding',
    },
    frames: {
      off: { tick: 0, width: WIDTH, height: HEIGHT, diagnosticJitterIndex: 15 },
      arch: { tick: 23, width: WIDTH, height: HEIGHT, diagnosticJitterIndex: 15 },
      on: { tick: 0, width: WIDTH, height: HEIGHT, diagnosticJitterIndex: 15 },
    },
  };
}

function rawFixture(kind: 'a' | 'b'): Buffer {
  const result = Buffer.alloc(PIXELS * 4 * 2);
  const components = kind === 'a'
    ? [0x3c00, 0x3800, 0x3000, 0x3000]
    : [0x3000, 0x3000, 0, 0];
  for (let pixel = 0; pixel < PIXELS; pixel += 1) {
    for (let channel = 0; channel < 4; channel += 1) {
      result.writeUInt16LE(components[channel]!, (pixel * 4 + channel) * 2);
    }
  }
  return result;
}

function validFixtureDirectory(): string {
  const parent = mkdtempSync(path.join(tmpdir(), 'jelly-reader-'));
  temporaryDirectories.push(parent);
  const directory = path.join(parent, 'jelly-toggle');
  mkdirSync(directory);
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = 96;
    png.data[offset + 1] = 144;
    png.data[offset + 2] = 192;
    png.data[offset + 3] = 255;
  }
  const encodedPng = PNG.sync.write(png);
  for (const state of ['off', 'arch', 'on']) {
    writeFileSync(path.join(directory, `${state}.png`), encodedPng);
    writeFileSync(path.join(directory, `${state}-a.rgba16f`), rawFixture('a'));
    writeFileSync(path.join(directory, `${state}-b.rgba16f`), rawFixture('b'));
  }
  writeFileSync(path.join(directory, 'metadata.json'), JSON.stringify(fixtureMetadata()));
  return directory;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('committed jelly fixture reader', () => {
  it('loads and structurally validates all three committed frames', () => {
    const loaded = loadAndValidateCommittedJellyFixtures(validFixtureDirectory());
    expect(Object.keys(loaded.frames).sort()).toEqual(['arch', 'off', 'on']);
    expect(loaded.frames.arch.width).toBe(WIDTH);
    expect(loaded.frames.arch.diagnostics.attachmentB.at(-1)).toBe(0);
  });

  it.each([
    ['missing file', (directory: string) => rmSync(path.join(directory, 'on-b.rgba16f'))],
    ['corrupt PNG', (directory: string) => writeFileSync(path.join(directory, 'arch.png'), 'not a PNG')],
    ['truncated raw', (directory: string) => {
      const file = path.join(directory, 'off-a.rgba16f');
      writeFileSync(file, readFileSync(file).subarray(0, 12));
    }],
    ['nonzero reserved channel', (directory: string) => {
      const file = path.join(directory, 'on-b.rgba16f');
      const raw = readFileSync(file);
      raw.writeUInt16LE(0x3c00, 4);
      writeFileSync(file, raw);
    }],
    ['empty diagnostic masks', (directory: string) => {
      const empty = Buffer.alloc(PIXELS * 4 * 2);
      writeFileSync(path.join(directory, 'arch-a.rgba16f'), empty);
      writeFileSync(path.join(directory, 'arch-b.rgba16f'), empty);
    }],
  ] as const)('rejects a %s golden on every machine', (_name, mutate) => {
    const directory = validFixtureDirectory();
    mutate(directory);
    expect(() => loadAndValidateCommittedJellyFixtures(directory)).toThrow();
  });
});
