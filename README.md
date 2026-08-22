# Electron Burn Transition

This Electron + TypeScript package contains two deliberately separate renderer demos:

- The default burn page implements the Light/Dark transition demonstrated at <https://mattrothenberg.com/demos/burn-transition>. It also includes a compact, clean-room Canvas 2D theme switch.
- The standalone jelly page recreates the anchored-bridge material and deterministic physics of the [WICG jelly slider](https://wicg.github.io/html-in-canvas/Examples/webgpu-jelly-slider/) as an accessible On/Off control.

The default burn page uses WebGL2 for the transition and Canvas 2D for its compact switch; it does not initialize WebGPU. It captures the current renderer viewport once, commits the target theme underneath, and burns the old screenshot to transparency over 2.5 seconds.

The standalone jelly page uses standard WebGPU through TypeGPU. It runs at `/jelly-toggle.html`, has no capture preload, and does not use `layoutsubtree`, `requestPaint()`, `copyElementImageToTexture()`, or experimental Chromium flags. WebGPU unavailability and device loss retain the native switch behavior through a CSS fallback.

## Run

```powershell
pnpm install
pnpm dev
```

Run the separate WebGPU jelly page:

```powershell
pnpm dev:jelly
```

Build and launch the production bundle:

```powershell
pnpm build
pnpm exec electron dist-electron/main.js
```

Launch the built standalone page with its explicit route flag:

```powershell
pnpm exec electron dist-electron/main.js --jelly-toggle
```

## Integrate

See the [burn-transition integration guide](docs/integration.md) for the default page and the [standalone WebGPU jelly toggle](docs/jelly-toggle-integration.md) guide for the copyable TypeGPU component. The reusable implementations are in `src/burn-transition/`, `src/jelly-toggle/` (Canvas 2D), and `src/jelly-toggle-3d/` (WebGPU); the narrow burn-only Electron capture bridge is in `electron/`.

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

The default burn demo's Canvas 2D `role="switch"` keeps a fixed accessible name (`Dark mode`) and reflects the committed theme through `aria-checked`. Its 52 × 30 Canvas is decorative and pointer-transparent; the real button retains a 60 × 44 hit target. The animator runs `requestAnimationFrame` only while settling and snaps immediately for reduced motion. The standalone WebGPU control owns a separate 96 × 52 native button contract documented in its guide.

## Verify

```powershell
pnpm verify
```

The routine gate covers strict TypeScript checks, unit tests, both production HTML entries, built burn-module provenance, the existing burn E2E, and portable jelly behavior, renderer, resource-lifetime, and burn/jelly isolation checks. It does not benchmark either renderer or author jelly fixtures.

Hardware-specific smoothness benchmarks are deliberately separate:

```powershell
pnpm benchmark
pnpm benchmark:jelly
```

## Security

- `contextIsolation: true`
- `nodeIntegration: false`
- `sandbox: true`
- capture preload and explicitly authorized IPC on the burn window only
- no preload or capture bridge on the standalone jelly window
- denied unexpected navigation and window creation

## Rendering details

- one full-screen WebGL2 quad
- one screenshot texture upload per transition
- aspect-preserving pixel and `MAX_TEXTURE_SIZE` caps
- aspect-correct radial signed distance
- procedural char, ember, heat, glow, smoke, firelight, and sparse sparks
- texture cleanup on completion and every fallback path

The standalone page instead uses a standard WebGPU canvas, TypeGPU compute/render pipelines, SDF raymarching, temporal antialiasing, bounded DPR, and idle-on-settle scheduling. Its guide documents fallback and resource ownership.

## Optional reference observation

`pnpm capture:reference` feature-detects the reference site's experimental path and writes local diagnostic observations. Reference PNGs are intentionally ignored by Git and are never required by production or `pnpm verify`.

## References

- [Original transition demo](https://mattrothenberg.com/demos/burn-transition)
- [HTML-in-Canvas proposal](https://github.com/WICG/html-in-canvas)
- [WICG WebGPU jelly slider example at pinned revision](https://github.com/WICG/html-in-canvas/tree/d4433e329697c4341a9f915f75dbd9608f3939fa/Examples/webgpu-jelly-slider)
- [Third-party notices](THIRD_PARTY_NOTICES.md)
- [Electron `webContents.capturePage()`](https://www.electronjs.org/docs/latest/api/web-contents#contentscapturepagerect-opts)
- [WebGL 2.0 specification](https://registry.khronos.org/webgl/specs/latest/2.0/)
