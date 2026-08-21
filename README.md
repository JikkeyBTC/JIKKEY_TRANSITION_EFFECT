# Electron Burn Transition

A framework-neutral Electron + TypeScript implementation of the Light/Dark burn transition demonstrated at <https://mattrothenberg.com/demos/burn-transition>, paired with a compact jelly theme switch inspired by the [WICG jelly slider](https://wicg.github.io/html-in-canvas/Examples/webgpu-jelly-slider/).

The production path uses only stable Electron, WebGL2, DOM, and Canvas 2D APIs: it captures the current renderer viewport once, commits the target theme underneath, and burns the old screenshot to transparency over 2.5 seconds. The jelly switch is a clean-room two-spring Canvas 2D implementation; it does not use `layoutsubtree`, `requestPaint()`, WebGPU, or other experimental HTML-in-Canvas APIs.

## Run

```powershell
pnpm install
pnpm dev
```

Build and launch the production bundle:

```powershell
pnpm build
pnpm exec electron dist-electron/main.js
```

## Integrate

See [docs/integration.md](docs/integration.md). The reusable renderer implementations are in `src/burn-transition/` and `src/jelly-toggle/`; the narrow Electron capture bridge is in `electron/`.

```ts
const burn = new BurnTransition({
  maxBackingPixels: 1920 * 1080,
  respectReducedMotion: true,
});

await burn.prepare();

await burn.toggle({
  origin: { x: event.clientX, y: event.clientY },
  applyTheme: () => setTheme(nextTheme),
});
```

Light and Dark modes must retain identical DOM geometry during the overlay animation.

The demo's `role="switch"` keeps a fixed accessible name (`Dark mode`) and reflects the committed theme through `aria-checked`. Its 52 × 30 Canvas is decorative and pointer-transparent; the real button retains a 60 × 44 hit target. The jelly animator runs `requestAnimationFrame` only while settling and snaps immediately for reduced motion.

## Verify

```powershell
pnpm verify
```

The deterministic gate covers strict TypeScript checks, unit tests, production builds, both theme directions, center and edge origins, resize handling, WebGL resource cleanup, and DPR-2 structural visual analysis.

The hardware-specific smoothness benchmark is deliberately separate:

```powershell
pnpm benchmark
```

## Security

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- explicitly authorized, main-frame-only capture IPC
- denied unexpected navigation and window creation

## Rendering details

- one full-screen WebGL2 quad
- one screenshot texture upload per transition
- aspect-preserving pixel and `MAX_TEXTURE_SIZE` caps
- aspect-correct radial signed distance
- procedural char, ember, heat, glow, smoke, firelight, and sparse sparks
- texture cleanup on completion and every fallback path

## Optional reference observation

`pnpm capture:reference` feature-detects the reference site's experimental path and writes local diagnostic observations. Reference PNGs are intentionally ignored by Git and are never required by production or `pnpm verify`.

## References

- [Original transition demo](https://mattrothenberg.com/demos/burn-transition)
- [HTML-in-Canvas proposal](https://github.com/WICG/html-in-canvas)
- [WICG WebGPU jelly slider example](https://github.com/WICG/html-in-canvas/tree/main/Examples/webgpu-jelly-slider)
- [Electron `webContents.capturePage()`](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts)
- [WebGL 2.0 specification](https://registry.khronos.org/webgl/specs/latest/2.0/)
