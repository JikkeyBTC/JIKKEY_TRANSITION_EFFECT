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
  }
}

export {};
