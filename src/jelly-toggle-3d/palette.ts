import { JELLY } from './constants';

export type JellyColor = readonly [number, number, number, number];

export const JELLY_OFF_COLOR = [1, 0.45, 0.075, 1] as const satisfies JellyColor;
export const JELLY_ON_COLOR = [34 / 255, 197 / 255, 94 / 255, 1] as const satisfies JellyColor;

export function jellyColorForEndpoint(
  endpointX: number,
  activeColor: JellyColor = JELLY_ON_COLOR,
): JellyColor {
  const progress = Math.min(1, Math.max(0, (endpointX - JELLY.offX) / (JELLY.onX - JELLY.offX)));
  return [
    JELLY_OFF_COLOR[0] + (activeColor[0] - JELLY_OFF_COLOR[0]) * progress,
    JELLY_OFF_COLOR[1] + (activeColor[1] - JELLY_OFF_COLOR[1]) * progress,
    JELLY_OFF_COLOR[2] + (activeColor[2] - JELLY_OFF_COLOR[2]) * progress,
    JELLY_OFF_COLOR[3] + (activeColor[3] - JELLY_OFF_COLOR[3]) * progress,
  ];
}
