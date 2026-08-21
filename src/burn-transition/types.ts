import type { CapturedViewport } from '../../electron/capture-types';

export type { CapturedViewport };

export interface BurnOrigin { x: number; y: number }
export interface ViewportSize { width: number; height: number }
export interface NormalizedOrigin { x: number; y: number }
export interface BackingSize extends ViewportSize { scale: number }

export interface BurnClock {
  now(): number;
  requestFrame(callback: FrameRequestCallback): number;
  cancelFrame(handle: number): void;
}

export interface BurnToggleRequest {
  origin: BurnOrigin;
  applyTheme: () => void | Promise<void>;
}

export type BurnToggleResult =
  | { status: 'completed' }
  | { status: 'ignored'; reason: 'busy' | 'destroyed' }
  | { status: 'fallback'; reason: 'capture' | 'webgl' | 'resize' | 'context-lost' };

export interface BurnTransitionOptions {
  capture?: () => Promise<CapturedViewport>;
  clock?: BurnClock;
  maxBackingPixels?: number;
  respectReducedMotion?: boolean;
  zIndex?: number;
}
