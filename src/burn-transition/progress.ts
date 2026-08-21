export const BURN_DURATION_MS = 2_500;

export function burnProgressAt(elapsedMs: number): number {
  const raw = Math.min(1, Math.max(0, elapsedMs / BURN_DURATION_MS));
  if (raw < 0.08) return (raw / 0.08) * 0.003;
  const t = (raw - 0.08) / 0.92;
  return 0.003 + t * t * 0.997;
}
