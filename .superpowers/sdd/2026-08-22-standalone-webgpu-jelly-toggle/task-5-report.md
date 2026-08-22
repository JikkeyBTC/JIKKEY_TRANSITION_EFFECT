# Task 5 implementation report

## What I implemented

- Added a diagnostic MRT renderer mode that writes the production color plus two unblended `rgba16float` attachments from one shared scene evaluation. Attachment A is `(hit, Fresnel, transmission luma, reflection/specular luma)` and B is `(shadow attenuation, actual additive caustic luma, 0, 0)`.
- Added aligned GPU readback with 256-byte row pitch, tightly packed public `Float32Array` output, binary16 fixture serialization, overlap/generation guards, and exception-safe staging-buffer cleanup.
- Kept production shading free of diagnostic luma/output work and retained the upstream two-`Math.random()` distribution per draw. Fixture mode alone uses resettable xorshift32 v1 with seed `0x4A454C4C`.
- Added deterministic OFF, first-arch, and ON capture through a fresh real component instance. The first arch peak is fixed tick 10. The component's interpolated `snapshot.display` upload is verified first, then the same live `snapshot.current` is frozen discontinuously for exactly 16 stationary TAA draws; diagnostics identify jitter index 15.
- Added portable committed-fixture loading and structural validation, fixed-machine actual-vs-golden metrics, immutable metadata/file-set overwrite guards, staged-payload validation, and atomic replacement.
- Added visual gates for silhouette, bbox, bridge/head geometry, CIEDE2000, rim, reflection highlight, transmission, shadow, caustic, and settled-crop SSIM. The globally calibrated caustic mask threshold is `Math.fround(0.001)`; raw B.G and production shading are unchanged.
- Added component-owned lifecycle/resource telemetry, four-mount resource E2E, bounded device-loss recovery checks, idle submission checks, and created/destroyed resource balance.
- Added a pre-product-navigation Electron WebGPU probe. Test mode loads a hidden `about:blank` bootstrap to materialize the Page domain, installs `Page.addScriptToEvaluateOnNewDocument`, installs navigation guards, and only then loads the product document. Ordinary launches do not enter this path.
- Added build-time module provenance and a burn import-closure verifier. The burn closure rejects jelly, TypeGPU, `@typegpu`, and `wgpu-matrix` modules.
- Added the opt-in jelly performance benchmark file/script without running it.

## TDD evidence

### RED

- Literal visual analysis initially failed because the module did not exist. Independent channel fixtures then caught removed and both-empty silhouette/rim/transmission/highlight/shadow/caustic layers.
- Diagnostic tests initially failed before MRT outputs/readback existed. Additional REDs covered HDR contribution luma, 256-byte row padding, reserved B.zw, overlapping readback, resize/destroy during map, and map rejection cleanup.
- Fixture authoring tests failed before immutable-contract preflight, validate-before-rename, staged-payload decoding, rollback, deterministic PRNG consumption, committed-golden loading, and live component pose verification existed.
- The first live arch attempt exposed the intended fixed-step interpolation contract: the renderer held `snapshot.display`, not `snapshot.current`. The regression now proves the live tick/current/display identities before the explicit stationary freeze.
- The first exact-surface attempt measured Windows forced-DPR content height 603 instead of 600. A pure measured-delta test failed before the bounded correction helper existed; both diagnostic and production-parity launch paths now share that helper.
- Fixed-device diagnostics showed ON caustic max `0.0014066696`, 33 pixels at or above `0.001`, and zero at or above `0.005`. A boundary test failed at the prior uncalibrated `0.02`; it now accepts `0.001` and rejects `0.000999`, while all six missing-layer gates remain active.
- The first combined isolation run timed out inside `electron.launch()` before `firstWindow`. The Page debugger was being awaited on a never-materialized WebContents. A focused test failed before the hidden bootstrap helper existed and now pins `about:blank -> attach -> Page.enable -> addScript` ordering.

### GREEN

- Full unit suite with headless WebGL permission: **27 files, 258/258 tests passed**. The initial sandboxed run had 26 files/255 tests pass and only the Chromium spawn fail with `EPERM`; the identical permitted rerun was fully green.
- Renderer and Electron TypeScript checks: **both clean**.
- Direct Electron build: **clean**.
- Direct Vite build: **182 modules transformed**; both HTML entries, manifest, and module-provenance map emitted.
- Burn provenance verification: **2 chunks, 13 modules**, no forbidden dependency in the burn closure.
- Fixed-machine authoring: **1/1 passed**; three PNGs, six raw attachments, and metadata were atomically written. The production OFF and diagnostic OFF decoded pixel buffers were exactly equal before the writer ran.
- Single combined Task 5 E2E: committed visual **passed** and resource lifecycle **passed**. The isolation test exposed the bootstrap issue above; after the focused RED/GREEN and review, the single authorized targeted isolation rerun **passed 1/1 in 3.0s**.
- No fixture capture was repeated after the successful authoring run. No benchmark was run.

## Authored fixture contract

- Environment: Windows x64, Electron `43.4.0`, Chromium `150.0.7871.224`, ANGLE D3D11, NVIDIA GeForce RTX 4070 SUPER, sRGB.
- Surface: viewport `800x600`, DPR `2`, backing `176x88`.
- Upstream revision: `d4433e329697c4341a9f915f75dbd9608f3939fa`.
- PRNG: seed `0x4A454C4C`, xorshift32 version 1.
- TAA: 16 samples. Diagnostic attachment identity: jitter index 15, last jittered sample rather than a separately resolved TAA image.
- Raw format: little-endian IEEE-754 binary16, tightly packed RGBA, no row padding.
- Frame ticks: OFF 0, arch 10, ON 0.

| State | silhouette | rim | transmission | highlight | shadow | caustic |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| OFF | 365 | 26 | 362 | 69 | 1720 | 54 |
| arch | 505 | 19 | 503 | 36 | 2029 | 243 |
| ON | 616 | 3 | 615 | 2 | 968 | 33 |

Authoring actual-vs-committed results were exact for all states: every IoU, area/luma ratio, and crop SSIM was 1; bbox, DeltaE, and centroid errors were 0.

The fixture directory contains exactly 10 files. Every raw attachment is 123,904 bytes (`176 * 88 * 4 * 2`). PNG sizes are OFF 8,097 bytes, arch 8,580 bytes, and ON 6,508 bytes; metadata is 1,178 bytes.

## Resource and isolation results

- Four component lifetimes returned mounts/listeners/observers/pending RAF/manual RAF to zero after each disposal.
- Normal toggles created no additional pipelines and idle queue waits produced zero submission delta.
- Two forced device losses produced exactly one automatic replacement; final renderer attempts/created count was 5.
- Final buffer and texture created/destroyed counts balanced and uncaptured GPU errors remained zero.
- First-script probe assertions were exact zero for burn `requestAdapter`, WebGPU canvas context, and queue submit; all three were positive for jelly.
- The normal production path has no probe symbol or debugger attachment, and the burn preload is unchanged.

## Files changed

- Renderer/component: `src/jelly-toggle-3d/{JellyToggle3D,renderer,shaders,slider-gpu,taa,utils,fixture-environment,fixture-pose,random,test-renderer-owner}.ts`, `src/jelly-toggle-demo.ts`, `src/global.d.ts`.
- Electron/build: `electron/main.ts`, `electron/renderer-route.ts`, `electron/webgpu-test-probe.ts`, `build/module-provenance-plugin.ts`, `vite.config.ts`.
- Fixture tooling: `scripts/generate-jelly-fixtures.cjs`, `scripts/verify-burn-isolation.cjs`, `tests/support/{electron-content-size,jelly-fixture-authoring,jelly-fixture-reader,jelly-visual-analysis}.ts`.
- Tests: Task 5 visual/resource/isolation/performance E2E files and the focused unit files for renderer/lifecycle/visual analysis, fixtures, random source, ownership, provenance, probe, routing, and isolation script.
- Artifacts/spec: `tests/fixtures/jelly-toggle/*`, the standalone design's calibrated threshold note, this report, and the current approved `package.json` script wiring.

## Self-review and concerns

- Production WGSL keeps one ordered raymarch/background/RNG evaluation and contains no diagnostic identifiers or Rec.709 luma work. Diagnostic mode consumes the same shared core instead of re-running scene logic.
- Diagnostic A contribution luma and B.G caustic remain unclamped, preserving HDR values; only B.R shadow attenuation is saturated.
- B.zw are zero in the shader, readback, serialized fixtures, portable reader, and corruption tests.
- Every readback staging buffer is destroyed in `finally`, including resize, destroy, overlap, and map rejection paths.
- Fixture writes validate every capture before staging, decode staged payloads before the first rename, and reject any immutable metadata or exact file-set mismatch before overwrite.
- The fixed authoring machine's Electron installation had to be restored after an interrupted dependency relink left Chromium resource files/DXIL support incomplete. The restored Electron `43.4.0` runtime was checksum-validated before the successful capture; no dependency installation was performed by Task 5 verification commands.
- Direct commands used the bundled Node and installed binaries to avoid the stale pnpm auto-install wrapper. This is an environment/tooling concern, not a product workaround.
- `git diff --check` reports only repository CRLF conversion warnings and no whitespace errors.
- The performance benchmark remains intentionally unexecuted; its output is informational and has no portable pass/fail frame-time threshold.
