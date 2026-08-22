# Integrating the Standalone WebGPU Jelly Toggle

This guide covers the reusable `src/jelly-toggle-3d/` component and the standalone `/jelly-toggle.html` Electron page. It does not replace the default burn page's compact Canvas 2D theme switch. The default page remains a WebGL2 burn-transition demo; the standalone page renders the anchored-bridge jelly material with standard WebGPU through TypeGPU.

The gradient surrounding the standalone example belongs only to the demo page. The reusable control is the transparent native button plus the canvas and fallback span created inside it, so copying the component does not add a panel or background box to the host app.

## 1. Requirements and dependencies

The primary visual path requires a browser or Electron release with standard WebGPU enabled in a secure context. Feature detection starts at `navigator.gpu`; a standard canvas host exposes `canvas.getContext('webgpu')`. When either WebGPU or a usable adapter/device is unavailable, the component remains an accessible switch and displays its CSS fallback.

No experimental HTML-in-Canvas API is involved. Do not enable `layoutsubtree`, `requestPaint()`, `copyElementImageToTexture()`, `enableBlinkFeatures`, or any Chromium experimental feature flag. The component renders directly into the canvas it creates inside the button.

Copy `src/jelly-toggle-3d/` and preserve these exact package versions:

```json
{
  "dependencies": {
    "@typegpu/noise": "0.10.0",
    "@typegpu/sdf": "0.10.0",
    "typegpu": "0.10.2",
    "wgpu-matrix": "3.4.2"
  },
  "devDependencies": {
    "@webgpu/types": "0.1.69",
    "unplugin-typegpu": "0.10.2"
  }
}
```

For pnpm 11, keep the workspace override used by this repository:

```yaml
# pnpm-workspace.yaml
overrides:
  tinyest: 0.3.1
```

`tinyest: 0.3.1` matches the pinned upstream dependency resolution. `0.3.2` does not export the `FORMAT_VERSION` value that `unplugin-typegpu` 0.10.2 imports while generating shader metadata.

## 2. Scope the Vite transform

Keep the TypeGPU plugin scoped to `src/jelly-toggle-3d/`; applying it to the burn entry would weaken the bundle-isolation contract. The standalone and burn HTML files are separate multi-page inputs:

```ts
import typegpuPlugin from 'unplugin-typegpu/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  input: {
    burn: 'index.html',
    jelly: 'jelly-toggle.html',
  },
  plugins: [
    typegpuPlugin({ include: /src[\\/]jelly-toggle-3d[\\/].*\.ts$/ }),
  ],
});
```

The renderer entry must import the component CSS. This explicit import keeps the copyable dependency visible even though this repository's barrel also imports it:

```ts
import { createJellyToggle3D } from './jelly-toggle-3d';
import './jelly-toggle-3d/component.css';
```

## 3. Mount the switch

Provide one native button and no visual children. The factory owns and appends its `aria-hidden` WebGPU canvas and CSS fallback layer:

```html
<button
  data-jelly-toggle
  type="button"
  role="switch"
  aria-label="Jelly toggle"
  aria-checked="false"
></button>
```

Mount and dispose it with the renderer root:

```ts
import { createJellyToggle3D } from './jelly-toggle-3d';
import './jelly-toggle-3d/component.css';

const button = document.querySelector<HTMLButtonElement>('[data-jelly-toggle]');
if (!button) throw new Error('Missing [data-jelly-toggle]');

const toggle = createJellyToggle3D({
  element: button,
  checked: false,
  label: 'Jelly toggle',
  onChange: (checked) => document.documentElement.toggleAttribute('data-enabled', checked),
});

window.addEventListener('beforeunload', () => toggle.destroy(), { once: true });
```

The exported TypeScript contract is:

```ts
type JellyToggleReadyState = 'webgpu' | 'fallback' | 'destroyed';

interface JellyToggle3DOptions {
  element: HTMLButtonElement;
  checked?: boolean;
  label?: string;
  respectReducedMotion?: boolean;
  onChange?: (checked: boolean) => void;
}

interface JellyToggle3D {
  readonly ready: Promise<JellyToggleReadyState>;
  readonly checked: boolean;
  setChecked(checked: boolean, options?: { animate?: boolean }): void;
  redraw(): void;
  retryWebGPU(): Promise<JellyToggleReadyState>;
  destroy(): void;
}

declare function createJellyToggle3D(options: JellyToggle3DOptions): JellyToggle3D;
```

`ready` resolves to `webgpu`, `fallback`, or `destroyed`; it does not reject. Inputs received while WebGPU initializes update the semantic state immediately and become the eventual renderer target. Use `setChecked()` to synchronize programmatic state without invoking `onChange`; pass `{ animate: false }` for an immediate canonical pose. Call `redraw()` after a host-driven style change that needs an immediate repaint. The component already observes its canvas size, window resolution changes, zoom, and DPR, clamped to 1–3.

`destroy()` is idempotent. It removes the children it created, listeners, observer, pending animation frame, and owned GPU resources. It preserves the caller-owned button and its final `aria-checked` value. Calls after destruction are no-ops, and `retryWebGPU()` resolves to `destroyed`.

## 4. Accessibility

- The reusable component default remains 96 × 52 CSS pixels with an 88 × 44 canvas. The standalone demo scales that host to 192 × 104 and its visible canvas to 176 × 88, while retaining `pointer-events: none` on the canvas.
- The OFF material keeps the reference orange. As the endpoint moves toward ON, the material interpolates to `#22c55e`; the CSS fallback uses the same green ON state and defers to system colors in forced-colors mode.
- The factory sets `type="button"`, `role="switch"`, and `aria-checked`. It removes `aria-pressed` so the control exposes one state model.
- The accessible name stays fixed. `label` wins, followed by an existing `aria-label`, then `Jelly toggle`.
- Native button click activation supplies mouse, Space, and Enter behavior. Do not add a duplicate keyboard handler.
- Native `disabled` blocks input and `onChange`; the supplied CSS keeps a visible `:focus-visible` outline.
- With `prefers-reduced-motion: reduce`, state changes snap to the canonical endpoint and bounded TAA completion instead of running the spring motion.
- With `forced-colors: active`, the canvas is hidden and the system-color CSS fallback remains visible and functional.

## 5. WebGPU fallback and device loss

Initialization failure at `navigator.gpu`, adapter/device acquisition, shader creation, or pipeline creation resolves `ready` to `fallback`. The CSS fallback reads the same `aria-checked` state, so click, Space, Enter, disabled behavior, and `onChange` remain available without GPU rendering.

On device loss, the current checked state is preserved, the canvas is hidden, and fallback mode takes over immediately. The component makes at most one automatic recovery attempt during its lifetime. If that bounded attempt fails—or after a later loss—call `await toggle.retryWebGPU()` when the host decides another attempt is appropriate. Successful recovery starts at the current endpoint and does not replay stale motion.

Forced-colors mode intentionally continues to display the CSS fallback even when a WebGPU device is healthy. Turning forced colors off redraws the current WebGPU state. Enabling reduced motion during an animation snaps to the latest semantic target and stops the loop.

## 6. Electron isolation and security

Use the standard hardened window preferences; no experimental feature switches are needed:

```ts
webPreferences: {
  contextIsolation: true,
  sandbox: true,
  nodeIntegration: false,
  webgl: true,
}
```

In this repository, the burn page alone loads the capture preload; the jelly page has no preload and cannot access `window.burnCapture`. Keep screenshot IPC authorization tied only to the burn `webContents.id`. Do not share the burn preload merely because both pages live in the same package.

Allow only the exact development URL `http://127.0.0.1:5173/jelly-toggle.html` or the packaged `dist-renderer/jelly-toggle.html` file. Deny unexpected main-frame navigation, redirects, frames, and new windows. Keep the standalone CSP local-only (`default-src 'self'`) and do not add remote scripts, styles, textures, or network fallbacks.

## 7. Run and verify

Run the default burn app with `pnpm dev`. Run the standalone page with:

```powershell
pnpm dev:jelly
```

The packaged route is selected explicitly with `--jelly-toggle`:

```powershell
pnpm build
pnpm exec electron dist-electron/main.js --jelly-toggle
```

`pnpm verify` covers typechecking, unit tests, both built HTML entries, burn bundle provenance/isolation, the existing burn gates, and portable jelly behavior, renderer, resource-lifetime, and preload/WebGPU-isolation specs. It deliberately does not run `pnpm benchmark:jelly`, the fixed-device visual comparison, or fixture authoring. Those remain explicit commands because performance is hardware-sensitive and fixture creation rewrites approved goldens.

## 8. Attribution and license

The physics and WebGPU renderer are derived from the WICG HTML-in-Canvas WebGPU jelly slider example at this immutable source:

<https://github.com/WICG/html-in-canvas/tree/d4433e329697c4341a9f915f75dbd9608f3939fa/Examples/webgpu-jelly-slider>

Pinned revision: `d4433e329697c4341a9f915f75dbd9608f3939fa`.

The upstream example is based on Software Mansion's Jelly Slider and was inspired by the work of Voicu Apostol. Preserve `Copyright (c) 2025 Software Mansion <swmansion.com>` and the complete MIT permission notice when copying or redistributing derived sources. This repository keeps that notice in `THIRD_PARTY_NOTICES.md` and the full license at `third_party/webgpu-jelly-slider/LICENSE`. Preserve the exact direct-dependency license table in the notices as part of a redistributed standalone package.
