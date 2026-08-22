import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

import {
  assertJellyFixtureMetadataContract,
  EXPECTED_JELLY_FIXTURE_FILES,
  JELLY_FIXTURE_STATES,
  type JellyFixtureMetadata,
  type JellyFixtureState,
} from './jelly-fixture-authoring';
import {
  analyzeJellyFrame,
  assertJellyVisualRanges,
  type JellyFrameFixture,
} from './jelly-visual-analysis';

export interface LoadedJellyFixtures {
  readonly metadata: JellyFixtureMetadata;
  readonly frames: Readonly<Record<JellyFixtureState, JellyFrameFixture>>;
}

function halfToFloat(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return fraction === 0 ? sign * 0 : sign * 2 ** -14 * fraction / 1024;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * 2 ** (exponent - 15) * (1 + fraction / 1024);
}

export function decodeJellyRgba16Float(
  bytes: Buffer,
  width: number,
  height: number,
): Float32Array {
  const components = width * height * 4;
  assert.strictEqual(
    bytes.byteLength,
    components * Uint16Array.BYTES_PER_ELEMENT,
    'Raw diagnostic fixture size mismatch',
  );
  return Float32Array.from(
    { length: components },
    (_, index) => halfToFloat(bytes.readUInt16LE(index * Uint16Array.BYTES_PER_ELEMENT)),
  );
}

export function loadAndValidateCommittedJellyFixtures(
  fixtureDirectory: string,
): LoadedJellyFixtures {
  assert.deepStrictEqual(
    readdirSync(fixtureDirectory).sort(),
    [...EXPECTED_JELLY_FIXTURE_FILES].sort(),
    'Committed jelly fixture file set mismatch',
  );
  const metadata = JSON.parse(
    readFileSync(path.join(fixtureDirectory, 'metadata.json'), 'utf8'),
  ) as JellyFixtureMetadata;
  assertJellyFixtureMetadataContract(metadata);

  const frames = {} as Record<JellyFixtureState, JellyFrameFixture>;
  for (const state of JELLY_FIXTURE_STATES) {
    const frameMetadata = metadata.frames[state];
    const png = PNG.sync.read(readFileSync(path.join(fixtureDirectory, `${state}.png`)));
    assert.strictEqual(png.width, frameMetadata.width, `${state} PNG width mismatch`);
    assert.strictEqual(png.height, frameMetadata.height, `${state} PNG height mismatch`);
    const fixture: JellyFrameFixture = {
      width: frameMetadata.width,
      height: frameMetadata.height,
      srgb: new Uint8Array(png.data),
      diagnostics: {
        width: frameMetadata.width,
        height: frameMetadata.height,
        attachmentA: decodeJellyRgba16Float(
          readFileSync(path.join(fixtureDirectory, `${state}-a.rgba16f`)),
          frameMetadata.width,
          frameMetadata.height,
        ),
        attachmentB: decodeJellyRgba16Float(
          readFileSync(path.join(fixtureDirectory, `${state}-b.rgba16f`)),
          frameMetadata.width,
          frameMetadata.height,
        ),
      },
      metadata: {
        state,
        tick: frameMetadata.tick,
        thresholdVersion: metadata.thresholdVersion,
      },
    };
    assertJellyVisualRanges(analyzeJellyFrame(fixture, fixture));
    frames[state] = fixture;
  }
  return { metadata, frames };
}
