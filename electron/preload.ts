import { contextBridge, ipcRenderer } from 'electron';
import type { CapturedViewport, CaptureViewportChannel } from './capture-types';

// Sandboxed preload scripts cannot require local CommonJS modules. Keep this
// runtime self-contained while checking the literal against the shared type.
const CAPTURE_VIEWPORT_CHANNEL: CaptureViewportChannel = 'burn:capture-viewport';

contextBridge.exposeInMainWorld('burnCapture', Object.freeze({
  captureViewport: (): Promise<CapturedViewport> => ipcRenderer.invoke(CAPTURE_VIEWPORT_CHANNEL),
}));
