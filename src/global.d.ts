/// <reference types="vite/client" />

import type { CapturedViewport } from '../electron/capture-types';

declare global {
  interface Window {
    burnCapture: Readonly<{
      captureViewport(): Promise<CapturedViewport>;
    }>;
    __burnTest?: Readonly<{
      hasPendingFrame(): boolean;
      step(milliseconds: number): void;
      setTime(milliseconds: number): void;
      toggleAt(
        x: number,
        y: number,
      ): Promise<import('./burn-transition').BurnToggleResult>;
    }>;
    __jellyTest?: Readonly<{
      hasPendingFrame(): boolean;
      step(milliseconds: number): void;
      readyState(): import('./jelly-toggle-3d').JellyToggleReadyState | 'pending';
      releaseInitialization(): void;
      setDevicePixelRatio(value: number): void;
      checked(): boolean;
      target(): import('./jelly-toggle-3d/physics').JellyTarget | undefined;
      pose(): import('./jelly-toggle-3d/physics').PhysicsSnapshot | undefined;
      stats(): import('./jelly-toggle-3d/renderer').JellyRendererStats | undefined;
      destroy(): void;
    }>;
  }
}

export {};
