export interface JellyFixtureSurface {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
  readonly backingWidth: number;
  readonly backingHeight: number;
}

const EXACT_SURFACE: JellyFixtureSurface = Object.freeze({
  innerWidth: 800,
  innerHeight: 600,
  devicePixelRatio: 2,
  backingWidth: 176,
  backingHeight: 88,
});

export function assertJellyFixtureSurface(actual: JellyFixtureSurface): void {
  for (const field of Object.keys(EXACT_SURFACE) as Array<keyof JellyFixtureSurface>) {
    if (actual[field] !== EXACT_SURFACE[field]) {
      throw new Error(
        `Fixture ${field} must be exactly ${EXACT_SURFACE[field]}, received ${actual[field]}`,
      );
    }
  }
}
