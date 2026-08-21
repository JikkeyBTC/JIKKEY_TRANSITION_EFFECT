# Integrating BurnTransition

## 1. Main process

Copy `electron/capture-types.ts` and `electron/capture-handler.ts`. Register the handler once and bind it to the trusted app window; main-frame validation alone is not an authorization boundary:

```ts
const trustedCaptureId = mainWindow.webContents.id;
ipcMain.removeHandler(CAPTURE_VIEWPORT_CHANNEL);
ipcMain.handle(
  CAPTURE_VIEWPORT_CHANNEL,
  createCaptureViewportHandler({
    isAuthorized: (sender) => sender.id === trustedCaptureId,
    fromWebContents: (sender) =>
      BrowserWindow.fromWebContents(sender as unknown as WebContents),
  }),
);
```

Keep the existing window secure:

```ts
webPreferences: {
  preload: preloadPath,
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webgl: true,
}
```

Allow only the exact local renderer entry through Electron's programmatic load APIs, then deny page-driven navigation and all new windows. `will-frame-navigate` does not fire for `loadURL()` / `loadFile()`, so the exact dev URL check and packaged path are the allow boundary while the event handler denies every renderer-initiated navigation:

```ts
const DEV_URL = 'http://127.0.0.1:5173';
const rendererEntry = path.join(__dirname, '..', 'dist-renderer', 'index.html');
const requestedDevUrl = process.argv.find((argument) =>
  argument.startsWith('--dev-server-url='),
)?.slice('--dev-server-url='.length);

if (requestedDevUrl !== undefined && requestedDevUrl !== DEV_URL) {
  throw new Error(`Rejected dev server URL: ${requestedDevUrl}`);
}

mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
mainWindow.webContents.on('will-frame-navigate', (event) => {
  event.preventDefault();
});

if (requestedDevUrl === DEV_URL) {
  await mainWindow.loadURL(DEV_URL);
} else {
  await mainWindow.loadFile(rendererEntry);
}
```

If the host app intentionally loads remote or user-controlled content, do not expose this capture bridge to that WebContents.

## 2. Preload

The preload must remain self-contained at runtime when `sandbox: true`. Export a shared channel type next to the main-process constant:

```ts
// electron/capture-types.ts
export const CAPTURE_VIEWPORT_CHANNEL = 'burn:capture-viewport' as const;
export type CaptureViewportChannel = typeof CAPTURE_VIEWPORT_CHANNEL;

export interface CapturedViewport {
  png: Uint8Array;
  scaleFactor: number;
}
```

Then copy this complete preload. Its local import is type-only and is erased by TypeScript; the exact typed literal is intentionally repeated so the emitted sandbox preload has no `require('./capture-types')`:

```ts
// electron/preload.ts
import { contextBridge, ipcRenderer } from 'electron';
import type { CapturedViewport, CaptureViewportChannel } from './capture-types';

const CAPTURE_VIEWPORT_CHANNEL: CaptureViewportChannel = 'burn:capture-viewport';

contextBridge.exposeInMainWorld('burnCapture', Object.freeze({
  captureViewport: (): Promise<CapturedViewport> =>
    ipcRenderer.invoke(CAPTURE_VIEWPORT_CHANNEL),
}));
```

After compiling, inspect the emitted preload once: it may require `electron`, but it must not contain a local runtime `require('./capture-types')`. Keep the exposed object frozen and limited to this one method.

## 3. Renderer

Prepare one long-lived instance after the root DOM is mounted:

```ts
const burn = new BurnTransition({ respectReducedMotion: true });
await burn.prepare();
```

Call it from the existing theme button. `toggle()` captures the old viewport first, makes that frame opaque above the live DOM, and only then invokes `applyTheme`. Do not commit the next theme before calling `toggle()`:

```ts
let busy = false;

async function onThemeToggle(event: MouseEvent): Promise<void> {
  if (busy) return;
  busy = true;
  themeButton.disabled = true;
  const nextTheme = currentTheme === 'dark' ? 'light' : 'dark';

  try {
    const result = await burn.toggle({
      origin: event.clientX || event.clientY
        ? { x: event.clientX, y: event.clientY }
        : centerOf(themeButton),
      applyTheme: () => setTheme(nextTheme),
    });

    switch (result.status) {
      case 'completed':
        break;
      case 'fallback':
        // Theme was still committed; resize, capture, WebGL, and context-loss
        // fallbacks only skip or stop the decoration.
        console.info(`Burn effect skipped: ${result.reason}`);
        break;
      case 'ignored':
        if (result.reason === 'destroyed') return;
        // A busy result leaves the current theme untouched.
        break;
    }
  } finally {
    busy = false;
    themeButton.disabled = false;
  }
}
```

For React state, commit synchronously so the target theme is ready below the opaque overlay:

```ts
applyTheme: () => flushSync(() => setTheme(nextTheme)),
```

Keep the light and dark states on the same route with the same DOM and layout geometry. Swap theme classes, data attributes, or CSS custom properties only: the captured old pixels must stay aligned with the live target DOM underneath.

Call `burn.destroy()` when the renderer root is permanently unmounted. This removes the resize and WebGL lifecycle listeners, releases the GPU frame, and removes the overlay canvas:

```ts
const dispose = () => burn.destroy();
window.addEventListener('beforeunload', dispose, { once: true });
```

### Optional compact jelly switch

Use a real button for input and accessibility; the Canvas is decorative only:

```html
<button
  class="theme-toggle"
  data-theme-toggle
  type="button"
  role="switch"
  aria-label="Dark mode"
  aria-checked="true"
>
  <canvas
    class="jelly-toggle-canvas"
    data-jelly-toggle
    width="52"
    height="30"
    aria-hidden="true"
  ></canvas>
</button>
```

Create one `JellyAnimator`, paint its initial state without animation, and update it inside the same synchronous theme commit passed to `BurnTransition`:

```ts
import {
  JellyAnimator,
  paintJellyToggle,
  resolveJellyPalette,
} from './jelly-toggle';

let jellyPalette = resolveJellyPalette(jellyCanvas, currentTheme === 'dark');
const jelly = new JellyAnimator({
  initialChecked: currentTheme === 'dark',
  motion: 'respect-preference',
  onFrame: (state) => paintJellyToggle(jellyCanvas, state, jellyPalette),
});

function setTheme(next: Theme): void {
  const dark = next === 'dark';
  currentTheme = next;
  document.documentElement.dataset.theme = next;
  themeButton.setAttribute('aria-checked', String(dark));
  jellyPalette = resolveJellyPalette(jellyCanvas, dark);
  jelly.setChecked(dark);
}

const jellyLifecycle = new AbortController();
window.addEventListener('resize', () => {
  jellyPalette = resolveJellyPalette(jellyCanvas, currentTheme === 'dark');
  jelly.redraw();
}, { signal: jellyLifecycle.signal });
```

Keep the Canvas at 52 × 30 CSS pixels with `pointer-events: none`, but keep the actual button at least 44 × 44 CSS pixels. On teardown call `jellyLifecycle.abort()` before `jelly.destroy()` and `burn.destroy()`. The resize redraw keeps the backing store sharp after zoom or monitor-DPR changes; the included CSS also supplies `:focus-visible` and `forced-colors` fallbacks.

## 4. Layering and limits

The overlay defaults to z-index 2147483646 and blocks pointer interactions only while capture or animation is active. Lower `zIndex` only if the app intentionally keeps native controls above the transition. The bridge encodes the highest available `NativeImage` scale representation; the renderer derives the backing store from the decoded PNG dimensions and validates its aspect ratio against the CSS viewport. `maxBackingPixels` may resample that texture on very large or high-DPI displays. `capturePage()` captures the renderer WebContents; separately stacked `WebContentsView`, video overlay, and OS-native child surfaces are not part of this texture and must be hidden or coordinated by the host app.

Set `respectReducedMotion: true` when the host app should skip the effect for `(prefers-reduced-motion: reduce)`. The requested theme is still committed, so completed, reduced-motion, and typed fallback paths all leave the UI and theme state coherent.
