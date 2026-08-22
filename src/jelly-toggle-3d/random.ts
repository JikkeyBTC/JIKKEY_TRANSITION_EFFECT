export const JELLY_FIXTURE_RANDOM_SEED = 0x4A454C4C;

export interface ResettableJellyRandomSource {
  (): number;
  readonly algorithm: 'xorshift32';
  readonly version: 1;
  readonly seed: number;
  reset(): void;
}

/** Stable unsigned xorshift32, normalized to the same [0, 1) range as Math.random. */
export function createXorshift32(seed: number): ResettableJellyRandomSource {
  const normalizedSeed = seed >>> 0;
  if (normalizedSeed === 0) throw new Error('xorshift32 requires a non-zero seed');
  let state = normalizedSeed;
  const random = (() => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  }) as ResettableJellyRandomSource;
  Object.defineProperties(random, {
    algorithm: { value: 'xorshift32', enumerable: true },
    version: { value: 1, enumerable: true },
    seed: { value: normalizedSeed, enumerable: true },
    reset: {
      value: (): void => { state = normalizedSeed; },
      enumerable: true,
    },
  });
  return random;
}
