# Standalone WebGPU Jelly Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a separately launchable, reusable binary On/Off toggle that directly adapts the pinned WICG TypeGPU jelly-slider physics and renderer without changing the existing burn-transition page.

**Architecture:** A pure fixed-step CPU physics module owns the 17-point anchored bridge and canonical OFF/ON poses. A TypeGPU renderer uploads that pose, builds the original quadratic-Bezier SDF/raymarch/material/TAA pipeline on a standard WebGPU canvas, while a DOM controller owns native switch semantics, lifecycle, CSS fallback, and bounded scheduling. Vite builds `index.html` and `jelly-toggle.html` as isolated entries, and Electron selects one page before window creation so only the burn page receives the capture preload.

**Tech Stack:** Electron 43.4.0, Chromium 150, TypeScript 7.0.2, Vite 8.2.1, TypeGPU 0.10.2, `unplugin-typegpu` 0.10.2, `@typegpu/sdf` 0.10.0, `@typegpu/noise` 0.10.0, `wgpu-matrix` 3.4.2, Vitest 4.1.10, Playwright 1.62.1, standard WebGPU.

**Spec:** `docs/superpowers/specs/2026-08-22-standalone-webgpu-jelly-toggle-design.md`

## Global Constraints

- Preserve the existing burn page, its Canvas2D theme toggle, `/`, `?test=1`, `data-burn-ready`, `window.__burnTest`, capture preload, and default Electron launch behavior.
- Add only a standalone `/jelly-toggle.html` page and reusable `src/jelly-toggle-3d/` module; never import that module from the burn entry.
- Use pinned upstream revision `d4433e329697c4341a9f915f75dbd9608f3939fa` and preserve the full MIT notice with `Copyright (c) 2025 Software Mansion <swmansion.com>`.
- Pin exact resolved dependencies with no carets: `typegpu` 0.10.2, `unplugin-typegpu` 0.10.2, `@typegpu/sdf` 0.10.0, `@typegpu/noise` 0.10.0, `wgpu-matrix` 3.4.2, `@webgpu/types` 0.1.69.
- TypeScript 7 already supplies WebGPU DOM declarations; install `@webgpu/types` for pinned provenance but do not add it to `compilerOptions.types` unless a focused typecheck first proves a missing declaration.
- Do not use `layoutsubtree`, canvas `paint`, `requestPaint`, `copyElementImageToTexture`, `enableBlinkFeatures`, WebGL, or a Canvas2D approximation in the new component.
- Preserve the original 17-point PBD/SDF/raymarch/TAA scene constants and constraint ordering specified in the design; only binary input, DOM texture/text, experimental APIs, and viewport framing differ.
- Render inside an 88 × 44 CSS px canvas centered in a 96 × 52 CSS px native button; backing DPR is `clamp(devicePixelRatio, 1, 3)`.
- Native click/Space/Enter update `aria-checked` and `onChange` once; no drag and no custom keyboard handler.
- WebGPU absence, initialization failure, and device loss retain semantic operation through a CSS fallback; first device loss gets one automatic retry and later retry is explicit.
- Physics uses exact 1/60-second ticks, 6 substeps, 16 constraint iterations, display-only interpolation, a 0.1-second accumulator cap, and at most 6 ticks per display frame.
- Canonical OFF target is `-0.30`, ON target is `+0.90`, anchor is `-1.0`, moving endpoint Y is `0.05`, and full segment rest length is `1.9 / 16`.
- Direct canonical transitions settle within 110 ticks (the pinned ON → OFF reference first qualifies at tick 106 and completes its fourth consecutive settle tick at 109); reversal fixtures settle within 120 ticks; at tick 120 production snaps to the canonical target, invalidates TAA history, seeds the current frame, then accumulates 15 blends for 16 total stationary submissions.
- Once physics and TAA settle, pending RAF count and GPU command submissions are both exactly zero.
- Do not run the opt-in jelly benchmark during routine implementation or `pnpm verify`; run it only if the user later requests performance measurement.
- Use focused tests while implementing. Run unit, typecheck, build, burn E2E, jelly E2E, and the three-frame visual gate once each at the final completion gate.

## File Map

- `src/jelly-toggle-3d/constants.ts`: exact upstream scene, solver, endpoint, convergence, and viewport constants.
- `src/jelly-toggle-3d/physics.ts`: pure 17-point Verlet/PBD solver, fixed-step accumulator, interpolation, canonical-pose generation, reversal, settle, and safety snap.
- `src/jelly-toggle-3d/physics-fixtures.ts`: checked-in deterministic OFF/ON canonical point arrays generated from the pinned solver.
- `src/jelly-toggle-3d/data-types.ts`: TypeGPU data layouts shared by compute and render stages.
- `src/jelly-toggle-3d/slider-gpu.ts`: reusable GPU buffers plus control-point, normal, and Bézier-SDF compute dispatch.
- `src/jelly-toggle-3d/camera.ts`: original camera math with compact-canvas aspect framing.
- `src/jelly-toggle-3d/taa.ts`: two-history-texture ping-pong and bounded 16-sample state machine.
- `src/jelly-toggle-3d/utils.ts`: retained Fresnel, Beer–Lambert, box-intersection, and owning-texture helpers.
- `src/jelly-toggle-3d/shaders.ts`: directly adapted SDF compute, raymarch, material, ground, shadow, caustic, production color, and diagnostic MRT shader functions.
- `src/jelly-toggle-3d/renderer.ts`: TypeGPU/WebGPU device, resources, resize, uploads, draws, readback, device-loss, and disposal boundary.
- `src/jelly-toggle-3d/JellyToggle3D.ts`: public native-button controller, async generation guards, media/resize observers, fallback, scheduler, and cleanup.
- `src/jelly-toggle-3d/index.ts`: public types and factory exports only.
- `src/jelly-toggle-demo.ts` and `src/jelly-toggle-demo.css`: standalone demo entry and page-local styling.
- `jelly-toggle.html`: CSP-constrained standalone HTML document.
- `electron/main.ts`: explicit burn/jelly page selection and page-specific preload authorization.
- `vite.config.ts`: TypeGPU plugin and Vite 8 top-level multi-page `input`.
- `third_party/webgpu-jelly-slider/LICENSE` and `THIRD_PARTY_NOTICES.md`: upstream license, exact source, revision, dependency licenses, and attribution.
- `tests/unit/jelly-toggle-3d-physics.test.ts`: exact solver, cadence, fixture, reversal, convergence, and cap contracts.
- `tests/unit/jelly-toggle-3d-taa.test.ts`: TAA invalidation, sample count, resize, and idle contract.
- `tests/unit/jelly-toggle-3d-lifecycle.test.ts`: DOM semantics, fallback, async race, device loss, retry, scheduler, and cleanup.
- `tests/e2e/jelly-toggle.spec.ts`: actual Electron/WebGPU behavior, accessibility, media, DPI, fallback, and isolation.
- `tests/e2e/jelly-toggle-visual.spec.ts`: fixed-environment OFF/arch/ON diagnostics and perceptual gates.
- `tests/support/jelly-visual-analysis.ts`: deterministic float attachment parsing and IoU/DeltaE/SSIM measurements.
- `tests/fixtures/jelly-toggle/`: committed PNG, raw float attachment, canonical pose, and metadata goldens.
- `scripts/generate-jelly-fixtures.cjs`: fixed-device/manual-clock golden launcher guarded by environment metadata.
- `tests/e2e/jelly-toggle-performance.spec.ts`: opt-in benchmark retaining raw intervals and environment metadata.

---

### Task 1: Pin Provenance and Implement the Deterministic Physics Core

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `.gitignore`
- Create: `third_party/webgpu-jelly-slider/LICENSE`
- Create: `THIRD_PARTY_NOTICES.md`
- Create: `src/jelly-toggle-3d/constants.ts`
- Create: `src/jelly-toggle-3d/physics.ts`
- Create: `src/jelly-toggle-3d/physics-fixtures.ts`
- Create: `tests/unit/jelly-toggle-3d-physics.test.ts`

**Interfaces:**
- Consumes: pinned upstream `Examples/webgpu-jelly-slider/src/slider.ts` at revision `d4433e329697c4341a9f915f75dbd9608f3939fa`.
- Produces:

```ts
export type JellyTarget = 'off' | 'on';
export type Point2 = Readonly<{ x: number; y: number }>;
export interface PhysicsSnapshot {
  readonly previous: readonly Point2[];
  readonly current: readonly Point2[];
  readonly display: readonly Point2[];
  readonly target: JellyTarget;
  readonly settled: boolean;
  readonly snapped: boolean;
  readonly ticksSinceTargetChange: number;
}
export interface JellyPhysics {
  readonly snapshot: PhysicsSnapshot;
  setTarget(target: JellyTarget): boolean;
  advance(elapsedSeconds: number): number;
  snap(target: JellyTarget): void;
}
export function createJellyPhysics(initial: JellyTarget): JellyPhysics;
export function generateCanonicalPose(target: JellyTarget): readonly Point2[];
export function interpolatePoints(previous: readonly Point2[], current: readonly Point2[], alpha: number): readonly Point2[];
```

- [ ] **Step 1: Add a failing dependency/provenance test and physics behavior tests**

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createJellyPhysics, generateCanonicalPose } from '../../src/jelly-toggle-3d/physics';

describe('pinned jelly physics', () => {
  it('preserves provenance and exact dependency resolutions', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    expect(pkg.dependencies).toMatchObject({
      typegpu: '0.10.2',
      '@typegpu/sdf': '0.10.0',
      '@typegpu/noise': '0.10.0',
      'wgpu-matrix': '3.4.2',
    });
    expect(pkg.devDependencies).toMatchObject({
      'unplugin-typegpu': '0.10.2',
      '@webgpu/types': '0.1.69',
    });
    expect(readFileSync('THIRD_PARTY_NOTICES.md', 'utf8')).toContain('d4433e329697c4341a9f915f75dbd9608f3939fa');
  });

  it('keeps identical fixed-tick state at 60/90/120/144 Hz', () => {
    const results = [60, 90, 120, 144].map((hz) => {
      const physics = createJellyPhysics('off');
      physics.setTarget('on');
      for (let frame = 0; frame < hz; frame += 1) physics.advance(1 / hz);
      return physics.snapshot.current;
    });
    expect(results.slice(1)).toEqual([results[0], results[0], results[0]]);
  });

  it('reverses without resetting position or velocity', () => {
    const physics = createJellyPhysics('off');
    physics.setTarget('on');
    physics.advance(15 / 60);
    const before = physics.snapshot;
    physics.setTarget('off');
    expect(physics.snapshot.current).toEqual(before.current);
    expect(physics.snapshot.previous).toEqual(before.previous);
  });

  it('settles direct moves normally and bounds reversals', () => {
    for (const [from, to] of [['off', 'on'], ['on', 'off']] as const) {
      const physics = createJellyPhysics(from);
      physics.setTarget(to);
      let ticks = 0;
      while (!physics.snapshot.settled && ticks < 121) {
        physics.advance(1 / 60);
        ticks += 1;
      }
      expect(ticks).toBeLessThanOrEqual(110);
      expect(physics.snapshot.snapped).toBe(false);
    }
  });
});
```

The actual test file must also assert 17 points, pinned endpoints, 6 × 16 constraint-call counts through an injected observer, distance/bending/end-flat fixed fixtures, display interpolation without solver mutation, a 0.1-second/6-tick long-frame cap, four consecutive settle ticks, all 15-tick reversal permutations, same-target no-op, canonical generation within 480 ticks, exact checked-in fixture arrays, and the 120-tick canonical safety snap.

- [ ] **Step 2: Run the focused test and record the expected RED**

Run: `pnpm exec vitest run tests/unit/jelly-toggle-3d-physics.test.ts`

Expected: FAIL because `src/jelly-toggle-3d/physics.ts` and the pinned dependencies/notices do not exist.

- [ ] **Step 3: Pin packages and preserve the complete upstream license**

Run: `pnpm add typegpu@0.10.2 @typegpu/sdf@0.10.0 @typegpu/noise@0.10.0 wgpu-matrix@3.4.2 && pnpm add -D unplugin-typegpu@0.10.2 @webgpu/types@0.1.69`

Copy the pinned upstream `LICENSE` byte-for-byte into `third_party/webgpu-jelly-slider/LICENSE`. `THIRD_PARTY_NOTICES.md` must name the immutable source URL, revision, Software Mansion and Voicu Apostol attribution, full local license path, and lockfile-resolved direct-dependency licenses. Keep TypeScript's existing DOM WebGPU declarations active; do not add `@webgpu/types` to `tsconfig.json` yet.

- [ ] **Step 4: Implement the exact fixed-step solver**

```ts
export const JELLY = Object.freeze({
  anchorX: -1,
  offX: -0.3,
  onX: 0.9,
  pointCount: 17,
  restLength: 1.9 / 16,
  endpointY: 0.05,
  yOffset: -0.03,
  tickSeconds: 1 / 60,
  substeps: 6,
  constraintIterations: 16,
  damping: 0.01,
  bendingStrength: 0.1,
  archStrength: 2,
  endFlatCount: 1,
  endFlatStiffness: 0.05,
  bendingExponent: 1.2,
  archEdgeDeadzone: 0.01,
  segmentStiffness: 0.1,
  targetSmoothing: 0.08,
  maxElapsedSeconds: 0.1,
  maxTicksPerFrame: 6,
  settleTargetError: 0.0005,
  settleMaxPointMove: 0.001,
  settleMaxSegmentResidual: 0.0075,
  settleTicks: 4,
  safetyTicks: 120,
  canonicalLimitTicks: 480,
});
```

Adapt the pinned `Slider.update(1 / 60)` calculation order directly. `advance()` adds `min(max(elapsedSeconds, 0), 0.1)` to an accumulator, consumes at most six exact ticks, drops any excess whole-tick backlog, and computes `display` by interpolation only. When normal settling succeeds, replace solver arrays with the exact checked-in canonical target and zero velocity so settled images are repeatable; when 120 ticks expires, do the same with `snapped: true`.

- [ ] **Step 5: Generate and lock canonical fixtures from the independent pinned reference path**

Use a test-local reference implementation translated directly from the pinned `slider.ts` to generate OFF/ON arrays before importing the production solver. Record arrays as numeric literals in `physics-fixtures.ts`; assert the production generator matches them to `1e-6`. Do not generate expected arrays by calling production code inside the assertion.

- [ ] **Step 6: Run focused GREEN and renderer typecheck**

Run: `pnpm exec vitest run tests/unit/jelly-toggle-3d-physics.test.ts && pnpm exec tsc -p tsconfig.json --noEmit`

Expected: all physics tests PASS and TypeScript emits no diagnostics.

- [ ] **Step 7: Commit Task 1**

```bash
git add package.json pnpm-lock.yaml .gitignore third_party/webgpu-jelly-slider/LICENSE THIRD_PARTY_NOTICES.md src/jelly-toggle-3d/constants.ts src/jelly-toggle-3d/physics.ts src/jelly-toggle-3d/physics-fixtures.ts tests/unit/jelly-toggle-3d-physics.test.ts
git commit -m "feat: add pinned jelly physics core"
```

---

### Task 2: Directly Adapt the TypeGPU SDF/Raymarch/TAA Renderer

**Files:**
- Modify: `vite.config.ts`
- Create: `src/jelly-toggle-3d/data-types.ts`
- Create: `src/jelly-toggle-3d/slider-gpu.ts`
- Create: `src/jelly-toggle-3d/camera.ts`
- Create: `src/jelly-toggle-3d/taa.ts`
- Create: `src/jelly-toggle-3d/utils.ts`
- Create: `src/jelly-toggle-3d/shaders.ts`
- Create: `src/jelly-toggle-3d/renderer.ts`
- Create: `tests/unit/jelly-toggle-3d-taa.test.ts`
- Create: `tests/unit/jelly-toggle-3d-renderer.test.ts`

**Interfaces:**
- Consumes: `Point2`, `JELLY`, canonical fixture arrays, TypeGPU 0.10.2, `@typegpu/sdf`, `@typegpu/noise`, and `wgpu-matrix`.
- Produces:

```ts
export type JellyRendererMode = 'production' | 'diagnostic';
export interface JellyDiagnosticReadback {
  readonly width: number;
  readonly height: number;
  readonly attachmentA: Float32Array;
  readonly attachmentB: Float32Array;
}
export interface JellyRendererStats {
  readonly rafRequests: number;
  readonly submissions: number;
  readonly buffersCreated: number;
  readonly buffersDestroyed: number;
  readonly texturesCreated: number;
  readonly texturesDestroyed: number;
  readonly uncapturedErrors: number;
}
export interface JellyRenderer {
  readonly device: GPUDevice;
  readonly stats: JellyRendererStats;
  readonly lost: Promise<GPUDeviceLostInfo>;
  resize(cssWidth: number, cssHeight: number, dpr: number): boolean;
  setPose(points: readonly Point2[], discontinuous: boolean): void;
  draw(options: { jitterIndex: number; historyValid: boolean; diagnostic?: boolean }): void;
  resetHistory(): void;
  readDiagnostics(): Promise<JellyDiagnosticReadback>;
  destroy(): void;
}
export async function createJellyRenderer(canvas: HTMLCanvasElement, mode?: JellyRendererMode): Promise<JellyRenderer>;
```

- [ ] **Step 1: Write failing TAA state and renderer resource tests**

```ts
it('seeds once, blends fifteen times, then becomes idle', () => {
  const taa = createTaaState();
  taa.invalidate();
  const samples = Array.from({ length: 16 }, () => taa.consumeStationarySample());
  expect(samples[0]).toMatchObject({ historyValid: false, blend: 0 });
  expect(samples.slice(1)).toEqual(Array(15).fill({ historyValid: true, blend: 0.9 }));
  expect(taa.needsSample).toBe(false);
});
```

The renderer unit test uses a contract fake for `GPUDevice` and verifies one pipeline generation, retained immutable resources, upload sizes for 17 points/control points/normals, 256 × 128 `rgba16float` SDF creation, DPR-backed resizing, destruction of replaced textures, idempotent cleanup, and surfaced uncaptured errors. It asserts resource-balance outcomes rather than merely echoing individual mock calls.

- [ ] **Step 2: Run the focused tests and record RED**

Run: `pnpm exec vitest run tests/unit/jelly-toggle-3d-taa.test.ts`

Expected: FAIL because `createTaaState` does not exist.

Run: `pnpm exec vitest run tests/unit/jelly-toggle-3d-renderer.test.ts`

Expected: FAIL because `createJellyRenderer` does not exist.

- [ ] **Step 3: Configure TypeGPU and implement the bounded TAA state machine**

```ts
import { defineConfig } from 'vitest/config';
import typegpuPlugin from 'unplugin-typegpu/vite';

export default defineConfig({
  base: './',
  plugins: [typegpuPlugin({ include: /src[\\/]jelly-toggle-3d[\\/].*\.ts$/ })],
  build: { outDir: 'dist-renderer', emptyOutDir: true },
  test: { environment: 'happy-dom', include: ['tests/unit/**/*.test.ts'], restoreMocks: true },
});
```

Task 4 adds Vite 8's top-level multi-page `input` when `jelly-toggle.html` exists. Do not use deprecated `build.rollupOptions.input`. Limit the TypeGPU transform to the standalone module so Vitest and the burn renderer are not transformed. `createTaaState()` must expose `invalidate()`, `noteMotion()`, `consumeStationarySample()`, `needsSample`, and exact 16-sample semantics. Resize or discontinuity invalidates both histories; ordinary moving frames reset the stationary counter without discarding valid moving history.

- [ ] **Step 4: Port only the pinned renderer dependency closure**

Adapt only the retained closure `src/index.ts`, `slider.ts`, `camera.ts`, `dataTypes.ts`, `taa.ts`, `utils.ts`, and `constants.ts` from the pinned example. Do not copy root `index.ts`, `events.ts`, `numbers.ts`, `src/common/*`, Three.js, loaders, `@typegpu/color`, or `@typegpu/three`. Keep the original shader formulas and these literal values:

```ts
export const MATERIAL = Object.freeze({
  sdfWidth: 256,
  sdfHeight: 128,
  sdfFormat: 'rgba16float' as const,
  raySteps: 64,
  maxDistance: 10,
  surfaceDistance: 0.001,
  lineRadius: 0.024,
  halfThickness: 0.17,
  ior: 1.42,
  scatter: 3,
  ambientColor: 0.6,
  ambientIntensity: 0.6,
  aoSteps: 3,
  aoRadius: 0.1,
  aoIntensity: 0.5,
  aoBias: 0.005,
  specularPower: 10,
  specularIntensity: 0.6,
  jellyColor: [1, 0.45, 0.075, 1] as const,
  lightDirection: [0.19, -0.24, 0.75] as const,
});
```

Remove the unused `backgroundTexture` binding, `valueTexture`, percentage glyph branch, text-region TAA blend, canvas paint events, DOM transforms, and DOM image copy. Preserve compute order: points/control points/normals → 256 × 128 quadratic-Bezier SDF → raymarch color → TAA ping-pong → premultiplied-alpha presentation.

- [ ] **Step 5: Implement bounded resource ownership and error visibility**

`resize()` clamps DPR to 1–3, caps backing size at 264 × 132, destroys replaced size-dependent textures immediately, and clears TAA histories. Pipelines, immutable buffers, and samplers are created once per device generation. Add `uncapturederror` tracking before pipeline creation; on upload/draw failure, surface a typed error instead of swallowing it. `destroy()` is idempotent and balances every owned buffer/texture.

- [ ] **Step 6: Run focused GREEN**

Run: `pnpm exec vitest run tests/unit/jelly-toggle-3d-taa.test.ts tests/unit/jelly-toggle-3d-renderer.test.ts && pnpm exec tsc -p tsconfig.json --noEmit`

Expected: PASS with balanced fake-device resources and no TypeScript diagnostics. The first real adapter/device/pipeline gate belongs to Task 4 after the standalone page exists.

- [ ] **Step 7: Commit Task 2**

```bash
git add vite.config.ts src/jelly-toggle-3d/data-types.ts src/jelly-toggle-3d/slider-gpu.ts src/jelly-toggle-3d/camera.ts src/jelly-toggle-3d/taa.ts src/jelly-toggle-3d/utils.ts src/jelly-toggle-3d/shaders.ts src/jelly-toggle-3d/renderer.ts tests/unit/jelly-toggle-3d-taa.test.ts tests/unit/jelly-toggle-3d-renderer.test.ts
git commit -m "feat: port TypeGPU jelly renderer"
```

---

### Task 3: Build the Reusable Semantic Component and Fallback Lifecycle

**Files:**
- Create: `src/jelly-toggle-3d/JellyToggle3D.ts`
- Create: `src/jelly-toggle-3d/index.ts`
- Create: `src/jelly-toggle-3d/component.css`
- Create: `tests/unit/jelly-toggle-3d-lifecycle.test.ts`

**Interfaces:**
- Consumes: `createJellyPhysics`, canonical fixtures, `createTaaState`, and `createJellyRenderer`.
- Produces exactly the public API from the design:

```ts
export type JellyToggleReadyState = 'webgpu' | 'fallback' | 'destroyed';
export interface JellyToggle3DOptions {
  element: HTMLButtonElement;
  checked?: boolean;
  label?: string;
  respectReducedMotion?: boolean;
  onChange?: (checked: boolean) => void;
}
export interface JellyToggle3D {
  readonly ready: Promise<JellyToggleReadyState>;
  readonly checked: boolean;
  setChecked(checked: boolean, options?: { animate?: boolean }): void;
  redraw(): void;
  retryWebGPU(): Promise<JellyToggleReadyState>;
  destroy(): void;
}
export function createJellyToggle3D(options: JellyToggle3DOptions): JellyToggle3D;
```

- [ ] **Step 1: Write lifecycle tests against fakes before the controller exists**

```ts
it('owns native semantics and calls onChange once per activation', async () => {
  const button = document.createElement('button');
  const onChange = vi.fn();
  const toggle = createJellyToggle3D({ element: button, onChange });
  button.click();
  expect(button.getAttribute('role')).toBe('switch');
  expect(button.getAttribute('aria-label')).toBe('Jelly toggle');
  expect(button.getAttribute('aria-checked')).toBe('true');
  expect(onChange).toHaveBeenCalledExactlyOnceWith(true);
  toggle.setChecked(false);
  expect(onChange).toHaveBeenCalledTimes(1);
});

it('ignores stale initialization after destroy', async () => {
  const deferred = createDeferred<JellyRenderer>();
  const toggle = createHarness({ renderer: deferred.promise });
  toggle.destroy();
  deferred.resolve(rendererFake);
  await expect(toggle.ready).resolves.toBe('destroyed');
  expect(rendererFake.destroy).toHaveBeenCalledOnce();
});
```

The file must also test initial checked precedence, a single owned canvas/fallback span, input during initialization, disabled activation suppression, callback exceptions, same-target no-op, rapid reversal without reset, reduced-motion initial/runtime snap, forced-colors runtime changes, resize/DPR redraw, one automatic device-loss retry, manual retry, failed retry staying idle, generation-token races, resize/device-loss precedence, at-most-one RAF under callback reentrancy, exactly 16 post-snap draws, no idle RAF/submission, and idempotent exception-safe destroy.

- [ ] **Step 2: Run focused RED**

Run: `pnpm exec vitest run tests/unit/jelly-toggle-3d-lifecycle.test.ts`

Expected: FAIL because `createJellyToggle3D` does not exist.

- [ ] **Step 3: Implement native semantics and owned visual layers**

```ts
const label = options.label ?? element.getAttribute('aria-label') ?? 'Jelly toggle';
const checked = options.checked ?? element.getAttribute('aria-checked') === 'true';
element.type = 'button';
element.setAttribute('role', 'switch');
element.setAttribute('aria-label', label);
element.setAttribute('aria-checked', String(checked));
```

Create one `canvas.jelly-toggle-3d__canvas[aria-hidden=true]` and one `span.jelly-toggle-3d__fallback[aria-hidden=true]`. Use only the native `click` event. Check `element.disabled` before mutation. Commit semantic state, ARIA, and `onChange` in the same event task, catch and report callback errors without breaking rendering, then retarget the existing physics state.

- [ ] **Step 4: Implement the lifecycle state machine and bounded scheduler**

Maintain separate fields for semantic checked, visual target, render mode, lifecycle generation, device generation, physics accumulator, TAA count, one pending RAF ID, and an absolute 120-tick deadline that same-target calls never renew. A frame schedules another frame only if physics consumed work or TAA `needsSample`; set the owner RAF ID before invoking callbacks and guard every continuation with the current lifecycle revision.

Initialization and retry resolve to `webgpu`, `fallback`, or `destroyed`, never reject. Device loss hides the canvas before asynchronous retry, preserves current checked, auto-retries only the first loss, and seeds canonical current state on recovery. Resize and forced-colors events use one `AbortController`; destroy aborts listeners/observers, cancels RAF, destroys the latest renderer, removes only factory-owned children, and preserves final `aria-checked`.

- [ ] **Step 5: Implement accessible visual/fallback CSS**

```css
.jelly-toggle-3d { position: relative; inline-size: 96px; block-size: 52px; padding: 0; border: 0; background: transparent; }
.jelly-toggle-3d__canvas { position: absolute; inline-size: 88px; block-size: 44px; inset: 50% auto auto 50%; transform: translate(-50%, -50%); pointer-events: none; }
.jelly-toggle-3d__fallback { position: absolute; inline-size: 52px; block-size: 28px; inset: 50% auto auto 50%; transform: translate(-50%, -50%); border: 2px solid currentColor; border-radius: 999px; }
.jelly-toggle-3d:focus-visible { outline: 3px solid Highlight; outline-offset: 2px; }
@media (forced-colors: active) { .jelly-toggle-3d__canvas { display: none; } .jelly-toggle-3d__fallback { display: block; forced-color-adjust: auto; } }
```

Add a fallback thumb driven solely by `[aria-checked=true]`; ensure fallback remains the visible initial state until WebGPU readiness and in all failure modes.

- [ ] **Step 6: Run focused GREEN**

Run: `pnpm exec vitest run tests/unit/jelly-toggle-3d-lifecycle.test.ts`

Expected: all lifecycle tests PASS with no unhandled promise rejection, pending timer, or console noise.

- [ ] **Step 7: Commit Task 3**

```bash
git add src/jelly-toggle-3d/JellyToggle3D.ts src/jelly-toggle-3d/index.ts src/jelly-toggle-3d/component.css tests/unit/jelly-toggle-3d-lifecycle.test.ts
git commit -m "feat: add reusable WebGPU jelly toggle"
```

---

### Task 4: Add the Isolated Demo Page and Secure Electron Launch Mode

**Files:**
- Create: `jelly-toggle.html`
- Create: `src/jelly-toggle-demo.ts`
- Create: `src/jelly-toggle-demo.css`
- Create: `electron/renderer-route.ts`
- Modify: `electron/main.ts`
- Modify: `vite.config.ts`
- Modify: `package.json`
- Create: `tests/unit/electron-renderer-route.test.ts`
- Create: `tests/e2e/jelly-toggle.spec.ts`
- Create: `tests/e2e/jelly-toggle-renderer.spec.ts`
- Modify: `tests/e2e/electron.spec.ts`

**Interfaces:**
- Consumes: public `createJellyToggle3D()` factory and existing Electron security/capture setup.
- Produces: `/jelly-toggle.html`, `pnpm dev:jelly`, packaged `--jelly-toggle`, and test-only `window.__jellyTest` manual-clock/resource instrumentation gated by `?test=1`.

- [ ] **Step 1: Write page-isolation and behavior E2E tests before adding the entry**

```ts
test('launches an isolated semantic jelly switch', async () => {
  const app = await launchElectron(['--jelly-toggle', '--test-mode']);
  const page = await app.firstWindow();
  const toggle = page.getByRole('switch', { name: 'Jelly toggle' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(page.locator('canvas')).toHaveCSS('width', '88px');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => window.burnCapture)).toBeUndefined();
});
```

Add cases for mouse, Space, Enter, rapid reversal, input before readiness, reduced motion, runtime media changes, forced colors, DPR 1/2/3 backing dimensions, CSS fallback when `navigator.gpu` is hidden, exact allowed navigation, denied popup/frame navigation, production WebGPU animation-to-idle, and a regression launch proving the default burn page still exposes `burnCapture`/`__burnTest`. Task 5 adds the before-navigation probe that proves the stronger zero-WebGPU-call contract.

The renderer smoke file launches without `--test-mode`, creates the real adapter/device/pipelines, uploads OFF and ON, awaits `queue.onSubmittedWorkDone()`, and asserts nontransparent output, positive command submissions, `uncapturedErrors === 0`, no `pageerror`/`console.error`, and a clean Electron exit. It never skips on the fixed development machine when no adapter is returned; it fails with adapter and `app.getGPUInfo('complete')` diagnostics.

- [ ] **Step 2: Run the new E2E file and record RED**

Run: `pnpm build && pnpm exec playwright test tests/e2e/jelly-toggle.spec.ts --reporter=list`

Expected: FAIL because `jelly-toggle.html`, `--jelly-toggle`, and `dev:jelly` do not exist.

- [ ] **Step 3: Create the self-contained page**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:5173;" />
    <title>WebGPU Jelly Toggle</title>
    <script type="module" src="/src/jelly-toggle-demo.ts"></script>
  </head>
  <body><main><button id="jelly-toggle" type="button" aria-label="Jelly toggle" aria-checked="false"></button></main></body>
</html>
```

The demo imports only `jelly-toggle-demo.css`, `component.css`, and the 3D factory. It renders a neutral local-only page, stores no remote assets, and exposes deterministic hooks only when `new URLSearchParams(location.search).get('test') === '1'`.

Configure both HTML entries with Vite 8's top-level input:

```ts
input: {
  burn: 'index.html',
  jelly: 'jelly-toggle.html',
},
build: {
  outDir: 'dist-renderer',
  emptyOutDir: true,
  manifest: true,
},
```

- [ ] **Step 4: Select the page before creating the Electron window**

```ts
export type RendererKind = 'burn' | 'jelly';
export const rendererKind = (argv: readonly string[]): RendererKind =>
  argv.includes('--jelly-toggle') ? 'jelly' : 'burn';
export const rendererHtml = (kind: RendererKind): 'index.html' | 'jelly-toggle.html' =>
  kind === 'burn' ? 'index.html' : 'jelly-toggle.html';
```

Test these pure route functions first. In `main.ts`, conditionally spread `{ preload: path.join(__dirname, 'preload.js') }` only for burn rather than assigning `undefined`, authorize capture IPC only for burn WebContents IDs, and build an exact expected URL for `will-frame-navigate`. Keep `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webgl: true`, window-open denial, and show-on-ready. Dev loads exactly `${DEV_URL}/jelly-toggle.html`; package loads exactly the selected file. Do not enable Chromium experimental features.

- [ ] **Step 5: Add launch scripts without changing defaults**

```json
{
  "scripts": {
    "dev:jelly": "pnpm build:electron && concurrently -k -s first \"pnpm dev:renderer\" \"pnpm dev:jelly:app\"",
    "dev:jelly:app": "wait-on http://127.0.0.1:5173/jelly-toggle.html && electron dist-electron/main.js --jelly-toggle --dev-server-url=http://127.0.0.1:5173"
  }
}
```

- [ ] **Step 6: Run focused GREEN and burn regression**

Run: `pnpm exec vitest run tests/unit/electron-renderer-route.test.ts && pnpm build && pnpm exec playwright test tests/e2e/jelly-toggle.spec.ts tests/e2e/jelly-toggle-renderer.spec.ts tests/e2e/electron.spec.ts --reporter=list`

Expected: both pages PASS; jelly has no capture bridge, burn has no WebGPU calls, and both Electron processes exit cleanly.

- [ ] **Step 7: Commit Task 4**

```bash
git add jelly-toggle.html src/jelly-toggle-demo.ts src/jelly-toggle-demo.css electron/renderer-route.ts electron/main.ts vite.config.ts package.json tests/unit/electron-renderer-route.test.ts tests/e2e/jelly-toggle.spec.ts tests/e2e/jelly-toggle-renderer.spec.ts tests/e2e/electron.spec.ts
git commit -m "feat: add standalone jelly toggle page"
```

---

### Task 5: Add Deterministic Diagnostic MRT, Visual Goldens, and Resource Gates

**Files:**
- Modify: `src/jelly-toggle-3d/shaders.ts`
- Modify: `src/jelly-toggle-3d/renderer.ts`
- Modify: `src/jelly-toggle-3d/JellyToggle3D.ts`
- Modify: `src/jelly-toggle-demo.ts`
- Create: `tests/support/jelly-visual-analysis.ts`
- Create: `tests/unit/jelly-toggle-3d-visual-analysis.test.ts`
- Create: `tests/e2e/jelly-toggle-visual.spec.ts`
- Create: `tests/e2e/jelly-toggle-resources.spec.ts`
- Create: `tests/e2e/jelly-toggle-performance.spec.ts`
- Create: `tests/e2e/burn-isolation.spec.ts`
- Create: `build/module-provenance-plugin.ts`
- Create: `electron/webgpu-test-probe.ts`
- Create: `scripts/verify-burn-isolation.cjs`
- Create: `scripts/generate-jelly-fixtures.cjs`
- Create: `tests/fixtures/jelly-toggle/off.png`
- Create: `tests/fixtures/jelly-toggle/arch.png`
- Create: `tests/fixtures/jelly-toggle/on.png`
- Create: `tests/fixtures/jelly-toggle/off-a.rgba16f`
- Create: `tests/fixtures/jelly-toggle/off-b.rgba16f`
- Create: `tests/fixtures/jelly-toggle/arch-a.rgba16f`
- Create: `tests/fixtures/jelly-toggle/arch-b.rgba16f`
- Create: `tests/fixtures/jelly-toggle/on-a.rgba16f`
- Create: `tests/fixtures/jelly-toggle/on-b.rgba16f`
- Create: `tests/fixtures/jelly-toggle/metadata.json`
- Modify: `package.json`
- Modify: `vite.config.ts`
- Modify: `electron/main.ts`

**Interfaces:**
- Consumes: the production draw, manual 1/60 clock, seed `0x4A454C4C`, renderer stats, and canonical physics fixtures.
- Produces:

```ts
export interface JellyFrameFixture {
  readonly width: number;
  readonly height: number;
  readonly srgb: Uint8Array;
  readonly diagnostics: JellyDiagnosticReadback;
  readonly metadata: Readonly<Record<string, string | number>>;
}
export interface JellyVisualMetrics {
  readonly silhouetteIou: number;
  readonly edgeErrorPx: readonly [number, number, number, number];
  readonly jellyMeanDeltaE: number;
  readonly jellyP95DeltaE: number;
  readonly rimIou: number;
  readonly highlightIou: number;
  readonly transmissionIou: number;
  readonly shadowIou: number;
  readonly causticIou: number;
  readonly shadowCentroidErrorPx: number;
  readonly causticCentroidErrorPx: number;
  readonly cropSsim: number;
}
export function findFirstArchPeak(extents: readonly number[]): number;
export function analyzeJellyFrame(actual: JellyFrameFixture, expected: JellyFrameFixture): JellyVisualMetrics;
```

- [ ] **Step 1: Write literal synthetic tests that fail when any diagnostic layer disappears**

```ts
it('finds the first local arch maximum and chooses the earlier tie', () => {
  expect(findFirstArchPeak([0, 1, 3, 3, 2, 4, 1])).toBe(2);
});

it.each(['silhouette', 'rim', 'transmission', 'highlight', 'shadow', 'caustic'] as const)(
  'fails when %s is removed',
  (layer) => expect(() => assertJellyVisualRanges(withLayerRemoved(literalFixture, layer))).toThrow(layer),
);
```

The literal fixture must independently vary every channel so tests cannot pass through overlapping classifications. Add threshold-boundary cases, row-padding/readback cases, bbox/centroid, CIEDE2000, percentile, and SSIM checks.

- [ ] **Step 2: Run focused RED**

Run: `pnpm exec vitest run tests/unit/jelly-toggle-3d-visual-analysis.test.ts`

Expected: FAIL because the analysis module does not exist.

- [ ] **Step 3: Implement the production-identical diagnostic MRT path**

Use one fragment function with three named outputs and matching TypeGPU targets:

```ts
out: { color: d.vec4f, diagnosticA: d.vec4f, diagnosticB: d.vec4f }
// A = rayHit, Fresnel, transmissionLuma, specularLuma
// B = shadowAttenuation, causticLuma, 0, 0
```

The production color output and all shared calculations remain identical; only diagnostic mode binds two unblended `rgba16float` attachments. Assert B.B and B.A are zero. Read back with 256-byte row alignment and normalize into tightly packed Float32 arrays before comparison.

- [ ] **Step 4: Implement deterministic fixture capture and exact gates**

The generator refuses to overwrite goldens unless metadata exactly matches Windows x64, Electron 43.4.0, Chromium 150.0.7871.224, ANGLE D3D11, RTX 4070 SUPER, sRGB, 800 × 600 viewport, DPR 2, 176 × 88 backing, seed `0x4A454C4C`, upstream revision, and diagnostic threshold version 1. It finds the first arch peak with `extent[n-1] < extent[n] && extent[n] >= extent[n+1]`, drives that exact tick, renders 16 stationary TAA samples, and saves PNG plus both raw attachments.

The E2E test asserts silhouette IoU ≥ 0.97; each bbox edge ≤ 2 px; bridge thickness/head cap ±5%; mean/p95 CIEDE2000 ≤ 3/8; rim/highlight IoU ≥ 0.85 and area ±10%; transmission IoU ≥ 0.85 and luma ±8%; shadow/caustic IoU ≥ 0.82 and centroid ≤ 3 px; settled crop SSIM ≥ 0.985.

- [ ] **Step 5: Add resource and opt-in performance probes**

Resource E2E mounts/toggles/destroys four instances and asserts listener/observer/RAF balance, one auto-retry maximum, texture/buffer created equals destroyed after disposal, no pipeline recreation across normal toggles, and zero pending RAF/submissions after every settled state. Performance E2E retains every raw interval and reports versions, OS, adapter, GPU/ANGLE, DPR, backing size, raw intervals, p95, and intervals over 34 ms, but sets no portable pass/fail frame-time threshold.

Add a test-only `--webgpu-probe` path that attaches Electron's debugger before navigation and calls `Page.addScriptToEvaluateOnNewDocument` to count `navigator.gpu.requestAdapter`, `HTMLCanvasElement.getContext('webgpu')`, and `GPUQueue.submit` from the first renderer script onward. `burn-isolation.spec.ts` proves all three burn counts are zero and jelly counts are positive, so the probe proves both isolation and its own validity. Keep this path absent from ordinary production launches.

`module-provenance-plugin.ts` emits a JSON map from each output chunk to `chunk.modules`. `verify-burn-isolation.cjs` follows the burn entry's static and dynamic import closure and rejects module IDs containing `/src/jelly-toggle-3d/`, `/node_modules/typegpu/`, `/node_modules/@typegpu/`, or `/node_modules/wgpu-matrix/`; minified source-string search is not a substitute.

Add scripts:

```json
{
  "scripts": {
    "test:jelly:visual": "pnpm build && playwright test tests/e2e/jelly-toggle-visual.spec.ts --reporter=list",
    "capture:jelly": "pnpm build && node scripts/generate-jelly-fixtures.cjs",
    "verify:burn-isolation": "pnpm build && node scripts/verify-burn-isolation.cjs",
    "benchmark:jelly": "pnpm build && playwright test tests/e2e/jelly-toggle-performance.spec.ts --reporter=list"
  }
}
```

`generate-jelly-fixtures.cjs` uses Node built-ins to launch the single Playwright golden-authoring spec with `UPDATE_JELLY_FIXTURES=1`, propagates its exit code, and rejects nonmatching environment metadata before files are replaced. It adds no script-runner dependency.

- [ ] **Step 6: Run focused GREEN once**

Run: `pnpm exec vitest run tests/unit/jelly-toggle-3d-visual-analysis.test.ts`

Expected: PASS.

Run on the fixed golden-authoring machine: `pnpm run capture:jelly`

Expected: writes three PNGs, six raw attachment files, and metadata at the exact first-arch tick.

Run: `pnpm run verify:burn-isolation && pnpm exec playwright test tests/e2e/jelly-toggle-visual.spec.ts tests/e2e/jelly-toggle-resources.spec.ts tests/e2e/burn-isolation.spec.ts --reporter=list`

Expected: all three frame gates and resource lifecycle PASS with no GPU errors. Do not run `benchmark:jelly` in this task.

- [ ] **Step 7: Commit Task 5**

```bash
git add src/jelly-toggle-3d/shaders.ts src/jelly-toggle-3d/renderer.ts src/jelly-toggle-3d/JellyToggle3D.ts src/jelly-toggle-demo.ts tests/support/jelly-visual-analysis.ts tests/unit/jelly-toggle-3d-visual-analysis.test.ts tests/e2e/jelly-toggle-visual.spec.ts tests/e2e/jelly-toggle-resources.spec.ts tests/e2e/jelly-toggle-performance.spec.ts tests/e2e/burn-isolation.spec.ts build/module-provenance-plugin.ts electron/webgpu-test-probe.ts scripts/verify-burn-isolation.cjs scripts/generate-jelly-fixtures.cjs tests/fixtures/jelly-toggle package.json pnpm-lock.yaml THIRD_PARTY_NOTICES.md vite.config.ts electron/main.ts
git commit -m "test: lock jelly visual fidelity"
```

---

### Task 6: Document Integration, Verify Both Apps Once, and Publish

**Files:**
- Modify: `README.md`
- Modify: `docs/integration.md`
- Modify: `docs/superpowers/specs/2026-08-22-standalone-webgpu-jelly-toggle-design.md`
- Modify: `package.json`
- Create: `docs/jelly-toggle-integration.md`
- Create: `tests/unit/jelly-toggle-3d-docs.test.ts`
- Test: `tests/e2e/electron.spec.ts`
- Test: `tests/e2e/jelly-toggle.spec.ts`
- Test: `tests/e2e/jelly-toggle-visual.spec.ts`
- Test: `tests/e2e/jelly-toggle-resources.spec.ts`

**Interfaces:**
- Consumes: all completed component, page, Electron, provenance, fixtures, and tests.
- Produces: copyable setup documentation, an accurate verification command, a launched standalone Electron page for user inspection, and pushed `main` history.

- [ ] **Step 1: Write documentation assertions before editing prose**

Add a unit test that reads the docs and package manifest and asserts the exact public factory signature, `pnpm dev:jelly`, `--jelly-toggle`, immutable upstream URL/SHA, MIT license location, fallback behavior, CSS import, cleanup call, standard-WebGPU requirement, burn/jelly preload isolation, and no statement that the burn page itself uses WebGPU.

- [ ] **Step 2: Run documentation RED**

Run: `pnpm exec vitest run tests/unit/jelly-toggle-3d-docs.test.ts`

Expected: FAIL because `docs/jelly-toggle-integration.md` and final README distinctions do not exist.

- [ ] **Step 3: Write copy-paste integration documentation**

The guide must show:

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

Explain dependency pins, Vite TypeGPU plugin, standard WebGPU requirements, Electron security settings, CSS fallback, reduced/forced colors, programmatic sync, retry, DPR, resource ownership, license-copy obligations, and why no experimental HTML-in-Canvas flag is needed. Update the design status to implemented only after all gates pass.

- [ ] **Step 4: Make `verify` cover both functional apps without the opt-in benchmark**

Set `test:e2e` to include existing burn and new jelly functional/resource specs; keep visual as its own explicit completion gate if it is fixed-hardware-only. Ensure `verify` runs typecheck, unit, build, burn E2E, and portable jelly E2E once and never invokes `benchmark:jelly` or regenerates goldens.

- [ ] **Step 5: Run the final completion gates once from a clean build output**

Run in this order:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm run verify:burn-isolation
pnpm exec playwright test tests/e2e/electron.spec.ts tests/e2e/visual.spec.ts --reporter=list
pnpm exec playwright test tests/e2e/jelly-toggle.spec.ts tests/e2e/jelly-toggle-renderer.spec.ts tests/e2e/jelly-toggle-resources.spec.ts tests/e2e/burn-isolation.spec.ts --reporter=list
pnpm exec playwright test tests/e2e/jelly-toggle-visual.spec.ts --reporter=list
```

Expected: both TypeScript projects PASS; all unit tests PASS; both HTML entries build; existing burn E2E/visual PASS; jelly functional/renderer/resource/visual PASS; all Electron children exit; no uncaptured GPU errors. Do not run either benchmark.

- [ ] **Step 6: Verify the burn bundle is isolated and the tree is clean**

Run: `rg -n "layoutsubtree|requestPaint|copyElementImageToTexture|enableBlinkFeatures" src electron jelly-toggle.html index.html`

Expected: no matches in production sources.

Inspect the Vite manifest/module graph and assert the `index.html` entry closure contains neither `typegpu` nor `jelly-toggle-3d`. Run `git diff --check` and require no whitespace errors.

- [ ] **Step 7: Launch the standalone Electron page once for user inspection**

Run: `pnpm build && node_modules/.bin/electron.cmd dist-electron/main.js --jelly-toggle`

Expected: one visible standalone window with the small anchored-bridge OFF/ON toggle, no burn UI, no capture preload, and no startup console error. Leave this window running for the user instead of repeatedly reopening it.

- [ ] **Step 8: Commit and push the completed implementation**

```bash
git add README.md docs/integration.md docs/jelly-toggle-integration.md docs/superpowers/specs/2026-08-22-standalone-webgpu-jelly-toggle-design.md package.json tests/unit/jelly-toggle-3d-docs.test.ts
git commit -m "docs: document standalone jelly toggle"
git status --short --branch
git push origin main
```

Expected: `main` is clean and synchronized with `origin/main`; report the final commit SHA, verification totals, fixed-device visual result, and the intentionally unrun benchmarks.
