import { app, BrowserWindow, ipcMain, type WebContents } from 'electron';
import path from 'node:path';
import { CAPTURE_VIEWPORT_CHANNEL } from './capture-types';
import { createCaptureViewportHandler } from './capture-handler';

const DEV_URL = 'http://127.0.0.1:5173';
const trustedWebContentsIds = new Set<number>();

function requestedDevUrl(): string | undefined {
  const value = process.argv.find((argument) => argument.startsWith('--dev-server-url='))
    ?.slice('--dev-server-url='.length);
  if (value === undefined) return undefined;
  if (value !== DEV_URL) throw new Error(`Rejected dev server URL: ${value}`);
  return value;
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1_280,
    height: 720,
    minWidth: 800,
    minHeight: 560,
    useContentSize: true,
    show: false,
    backgroundColor: '#0c0c0c',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webgl: true,
    },
  });

  const trustedId = window.webContents.id;
  trustedWebContentsIds.add(trustedId);
  window.webContents.once('destroyed', () => {
    trustedWebContentsIds.delete(trustedId);
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-frame-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());

  const devUrl = requestedDevUrl();
  void (devUrl
    ? window.loadURL(`${devUrl}${process.argv.includes('--test-mode') ? '/?test=1' : ''}`)
    : window.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'), {
        query: process.argv.includes('--test-mode') ? { test: '1' } : {},
      }));
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
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
