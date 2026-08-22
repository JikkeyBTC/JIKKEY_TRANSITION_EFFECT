import { app, BrowserWindow, ipcMain, type WebContents } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CAPTURE_VIEWPORT_CHANNEL } from './capture-types';
import { createCaptureViewportHandler } from './capture-handler';
import {
  blockUnexpectedNavigation,
  rendererHtml,
  rendererDevPath,
  rendererKind,
  rendererQuery,
  requestedDevServerUrl,
  type RendererKind,
} from './renderer-route';

const trustedWebContentsIds = new Set<number>();
const selectedRenderer = rendererKind(process.argv);
const selectedDevUrl = requestedDevServerUrl(process.argv);

function createWindow(kind: RendererKind): BrowserWindow {
  const html = rendererHtml(kind);
  const query = rendererQuery(kind, process.argv);
  const packagedPath = path.join(__dirname, '..', 'dist-renderer', html);
  const expectedUrl = selectedDevUrl
    ? new URL(rendererDevPath(kind), selectedDevUrl)
    : pathToFileURL(packagedPath);
  for (const [key, value] of Object.entries(query)) expectedUrl.searchParams.set(key, value);

  const window = new BrowserWindow({
    width: 1_280,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    useContentSize: true,
    show: false,
    backgroundColor: '#0c0c0c',
    webPreferences: {
      ...(kind === 'burn' ? { preload: path.join(__dirname, 'preload.js') } : {}),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
    },
  });

  if (kind === 'burn') {
    const trustedId = window.webContents.id;
    trustedWebContentsIds.add(trustedId);
    window.webContents.once('destroyed', () => {
      trustedWebContentsIds.delete(trustedId);
    });
  }
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-frame-navigate', (event) => {
    blockUnexpectedNavigation(event, expectedUrl.href);
  });
  window.webContents.on('will-redirect', (event) => {
    blockUnexpectedNavigation(event, expectedUrl.href);
  });
  window.once('ready-to-show', () => window.show());

  const load = window.loadURL(expectedUrl.href);
  void load.catch((error: unknown) => {
    console.error(`Failed to load ${kind} renderer`, error);
    if (!window.isDestroyed()) window.destroy();
    if (BrowserWindow.getAllWindows().length === 0 && process.platform !== 'darwin') app.quit();
  });
  return window;
}

ipcMain.removeHandler(CAPTURE_VIEWPORT_CHANNEL);
ipcMain.handle(
  CAPTURE_VIEWPORT_CHANNEL,
  createCaptureViewportHandler({
    isAuthorized: (sender) => trustedWebContentsIds.has(sender.id),
    fromWebContents: (sender) =>
      BrowserWindow.fromWebContents(sender as unknown as WebContents),
  }),
);

void app.whenReady().then(() => {
  createWindow(selectedRenderer);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(selectedRenderer);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
