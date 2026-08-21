export const CAPTURE_VIEWPORT_CHANNEL = 'burn:capture-viewport' as const;
export type CaptureViewportChannel = typeof CAPTURE_VIEWPORT_CHANNEL;

export interface CapturedViewport {
  png: Uint8Array;
  scaleFactor: number;
}
