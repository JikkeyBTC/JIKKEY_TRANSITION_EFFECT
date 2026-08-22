# Standalone WebGPU Jelly On/Off Toggle Design

- Date: 2026-08-22
- Status: 구현 및 검증 완료
- Reference: [WICG WebGPU jelly slider example](https://wicg.github.io/html-in-canvas/Examples/webgpu-jelly-slider/)
- Pinned upstream revision: `d4433e329697c4341a9f915f75dbd9608f3939fa`
- Immutable upstream source: [WICG/html-in-canvas — webgpu-jelly-slider at the pinned revision](https://github.com/WICG/html-in-canvas/tree/d4433e329697c4341a9f915f75dbd9608f3939fa/Examples/webgpu-jelly-slider)

## 1. 배경과 결정

현재 저장소의 기본 Electron 화면은 Light/Dark burn transition과 작은 Canvas 2D 테마 스위치를 함께 보여준다. 새 작업은 그 스위치를 다시 교체하는 작업이 아니다. WICG 예제의 WebGPU 젤리 재질과 물리를 충실히 이식한 **독립 실행 페이지와 재사용 가능한 컴포넌트**를 추가한다.

최종 형태는 연속 값을 선택하는 range slider가 아니라 두 상태만 갖는 On/Off 토글이다. 시각 구조는 승인된 **A안, Anchored Bridge**를 사용한다.

- OFF: 왼쪽에 고정된 젤리가 원본 slider의 최소 위치까지 압축되어 둥글게 솟는다.
- ON: 왼쪽 anchor에서 오른쪽 head까지 반투명 오렌지 젤리가 길게 연결된다.
- 전환 중: 17개 점의 원본 Verlet/PBD 체인이 압축, arch, stretch, overshoot를 만든다.
- 입력은 click, Space, Enter뿐이며 drag와 중간 값은 제공하지 않는다.

이 페이지는 결과물로 단독 실행할 수 있어야 하고, `src/jelly-toggle-3d/` 모듈은 기존 Electron + TypeScript 앱에 복사해 붙일 수 있어야 한다.

## 2. 목표

1. WICG 예제의 WebGPU renderer, SDF, raymarch 재질, 조명, 그림자, caustic, TAA, 물리 상수를 직접 기반으로 동일한 시각 언어를 재현한다.
2. 표시 크기 88 × 44 CSS px의 작은 On/Off 토글로 재구성한다.
3. 실제 입력 표면은 96 × 52 CSS px의 native `<button>`으로 유지한다.
4. 실험적인 HTML-in-Canvas API 없이 Electron의 표준 WebGPU canvas에서 실행한다.
5. WebGPU가 없거나 device가 손실돼도 접근 가능한 On/Off 동작은 CSS fallback으로 유지한다.
6. 기존 burn transition 페이지, 테스트 계약, 캡처 preload, 기본 실행 경로를 변경하지 않는다.
7. 움직일 때만 렌더링하고 수렴 뒤에는 RAF와 GPU 제출을 0으로 만든다.

## 3. 비목표

- 기존 burn 페이지의 Canvas 2D 젤리 스위치를 WebGPU 버전으로 교체하지 않는다.
- drag, scrub, 0–100 값, 퍼센트 텍스트를 제공하지 않는다.
- `layoutsubtree`, canvas `paint`, `requestPaint()`, `copyElementImageToTexture()`를 사용하지 않는다.
- Chromium 실험 기능 플래그나 `enableBlinkFeatures`를 켜지 않는다.
- WebGL2나 Canvas 2D로 WebGPU 재질을 비슷하게 다시 그리는 근사 구현을 만들지 않는다.
- GPU/driver가 다른 컴퓨터 사이의 byte-for-byte 동일 이미지를 약속하지 않는다. 동일한 원본 수식, 상수, 장면과 고정된 대상 환경의 지각적 회귀 기준을 약속한다.

## 4. 참조 코드와 라이선스

이 작업은 clean-room 재해석이 아니라, 사용자가 요구한 참조 충실도를 위해 공식 예제의 MIT 허용 범위 안에서 renderer/physics 코드를 직접 이식하고 필요한 부분만 변경한다.

- 가져오는 upstream revision은 이 명세에 고정한 `d4433e329697c4341a9f915f75dbd9608f3939fa`이며, 정확한 SHA와 immutable URL을 `THIRD_PARTY_NOTICES.md`에도 기록한다.
- 직접 이식하거나 상당 부분 파생된 파일에는 upstream 유래를 표시한다.
- 예제의 전체 MIT 고지를 저장소에 포함한다.
- 보존할 고지는 `Copyright (c) 2025 Software Mansion <swmansion.com>`이다.
- WICG 데모 페이지가 밝히는 Software Mansion Jelly Slider 및 Voicu Apostol 영감 표기도 README와 notices에 유지한다.
- upstream revision을 바꾸려면 이 명세와 notices의 SHA를 함께 바꾸고 시각 회귀 기준을 다시 승인한다.
- TypeGPU를 포함해 새로 배포되는 직접 의존성의 라이선스도 lockfile 기준으로 notices에 기록한다.

HTML-in-Canvas 관련 코드는 이식하지 않는다. 이식 범위는 젤리 장면 자체의 WebGPU renderer, 물리, SDF, 재질, 조명, TAA에 한정한다.

## 5. 사용자 경험과 형상

### 5.1 크기와 배치

- native button hit target: 96 × 52 CSS px
- WebGPU canvas가 차지하는 보이는 영역: 88 × 44 CSS px
- canvas는 button의 정중앙에 놓고 `pointer-events: none`, `aria-hidden="true"`로 둔다.
- 내부 backing scale은 `clamp(devicePixelRatio, 1, 3)`을 적용해 최대 264 × 132 px로 제한한다.
- DPR, zoom, monitor 이동을 `ResizeObserver`와 해상도 재검사로 반영한다.
- 페이지는 중립적인 밝은 ground 위 중앙에 토글 하나를 배치한다. 주변 설명 UI는 renderer crop과 겹치지 않는다.

### 5.2 원본 slider의 binary 매핑

원본 기하를 유지한다.

- anchor: `(-1.0, 0.0)`
- 원본 full endpoint: `(0.9, 0.0)`
- point count: `17`
- y offset: `-0.03`
- ON target X: `+0.90`
- OFF target X: `-0.30`

OFF의 `-0.30`은 임의 조정값이 아니라 원본 `Slider.setDragX()`가 0% 입력에 적용하는 실질적인 최소 clamp다. 따라서 OFF와 ON은 각각 원본 데모의 최소/최대 움직임을 그대로 사용한다.

### 5.3 상태 전환

- click, Space, Enter가 상태를 즉시 반전한다.
- `aria-checked`와 외부 상태 callback은 입력이 승인된 같은 task에서 먼저 갱신한다.
- GPU 형상은 현재 물리 상태에서 새 endpoint를 향해 움직인다.
- 전환 중 재입력은 위치와 velocity를 초기화하지 않고 목표만 반대로 바꿔 자연스럽게 되감는다.
- OFF/ON 어느 쪽에서도 head, bridge, highlight, shadow가 canvas 경계를 침범해 잘리지 않아야 한다.
- 초기 mount에서는 요청 상태의 완전히 수렴된 형상을 그린 뒤 TAA만 수렴시키며, 불필요한 입장 애니메이션은 하지 않는다.

초기와 reduced-motion의 canonical 형상은 임의 좌표가 아니다. 원본 full-length 직선 pose, 원본 rest length `1.9 / 16`, zero velocity에서 시작해 target만 OFF 또는 ON으로 설정하고, 60 Hz fixed-step solver를 아래 settle 기준까지 CPU에서 선실행한다. OFF와 ON의 canonical point 배열은 고정 fixture로도 저장한다. rest length는 압축된 길이에 맞춰 다시 계산하지 않는다. reduced-motion 전환은 해당 canonical 배열을 복사하고 previous position도 같은 배열로 설정해 velocity를 0으로 만든 뒤 GPU에 한 번 upload한다.

## 6. 접근성 계약

실제 컨트롤은 다음 의미를 갖는 native button이다.

```html
<button type="button" role="switch" aria-label="Jelly toggle" aria-checked="false"></button>
```

factory가 이 button 안에 `aria-hidden` canvas와 CSS fallback span을 한 번만 생성한다. 호출자는 두 시각 child를 직접 만들지 않는다.

- accessible name은 상태가 변해도 `Jelly toggle`로 고정한다.
- `options.label`이 있으면 그 값을 고정 accessible name으로 사용하고, 없으면 기존 `aria-label`, 그것도 없으면 `Jelly toggle` 순으로 결정한다.
- 상태는 `aria-checked="false|true"`로만 표현하며 `aria-pressed`를 섞지 않는다.
- native click 동작을 사용해 Space와 Enter를 별도 key handler로 재구현하지 않는다.
- `:focus-visible` 외곽선은 canvas 바깥에서 명확히 보인다.
- `disabled`가 설정되면 입력과 상태 callback을 막고 native 의미를 그대로 노출한다.
- `prefers-reduced-motion: reduce`에서는 물리 전환을 생략하고 endpoint와 TAA 완료 상태로 즉시 snap한다.
- `forced-colors: active`에서는 canvas를 숨기고 system colors를 사용하는 CSS fallback을 표시한다.
- reduced-motion이 animation 중 켜지면 현재 목표 endpoint로 snap하고 loop를 끝낸다. 다시 꺼져도 다음 입력 전에는 animation을 시작하지 않는다.
- forced-colors가 해제되면 WebGPU mode는 현재 상태를 redraw하고, fallback mode는 CSS fallback을 계속 사용한다.

## 7. 모듈 API

재사용 모듈은 DOM framework에 종속되지 않는다.

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

계약은 다음과 같다.

- factory는 canvas와 fallback layer를 element 내부에 소유한다.
- 초기 `checked`는 `options.checked`, 기존 `aria-checked`, `false` 순으로 결정한다.
- WebGPU 초기화 중에는 CSS fallback을 보여 주며, 이 동안 발생한 입력도 최종 checked target에 반영한다.
- `onChange`는 사용자 입력으로 상태가 바뀔 때 한 번 호출한다.
- `setChecked()`는 programmatic sync이며 callback을 다시 호출하지 않는다.
- `ready`는 최초 초기화가 WebGPU 또는 fallback 중 하나로 정착하면 resolve하며 reject하지 않는다. 초기화 도중 destroy되면 `destroyed`로 resolve한다.
- `redraw()`는 DPR/스타일 변화 뒤 현재 정착 상태를 다시 그린다.
- `retryWebGPU()`는 fallback에서 명시적으로 재초기화할 때 사용한다.
- `destroy()`는 멱등이며 event listener, observer, RAF, GPU buffer/texture/pipeline/context 소유권을 정리한다.
- `destroy()`는 factory가 만든 canvas와 fallback layer를 제거하되 최종 `aria-checked`와 호출자가 소유한 button 자체는 보존한다.
- destroy 뒤 `retryWebGPU()`와 아직 pending인 `ready`는 `destroyed`로 resolve하고, 나머지 메서드는 no-op이며 callback을 호출하지 않는다.

## 8. 물리 설계

원본 `Slider`의 구조와 상수를 유지한다.

| 항목 | 값 |
| --- | ---: |
| points | 17 |
| constraint iterations | 16 |
| substeps | 6 |
| damping | 0.01 |
| bending strength | 0.1 |
| arch strength | 2.0 |
| end flat count | 1 |
| end flat stiffness | 0.05 |
| bending exponent | 1.2 |
| arch edge deadzone | 0.01 |
| segment constraint stiffness | 0.1 |
| moving endpoint Y | 0.05 (`0.08 + yOffset`) |
| full rest length per segment | 0.11875 (`1.9 / 16`) |

추가 원칙:

- endpoint는 원본처럼 pin한다.
- segment distance, bending, end flatten 제약 순서를 유지한다.
- quadratic Bézier control point와 normal 계산 순서를 유지한다.
- display refresh와 physics clock을 분리한다. elapsed time accumulator를 정확한 `1/60s` simulation tick으로 소비하고, 각 tick은 원본 `Slider.update(1/60)`의 6 substeps × 16 constraint iterations를 실행한다.
- target smoothing은 각 고정 tick에서 원본 그대로 `current += (target - current) * 0.08`을 적용한다. 60 Hz에서는 원본 궤적과 같고 90/120/144 Hz display에서도 같은 simulation tick 결과를 사용한다.
- 고주사율의 display frame은 직전/현재 simulation point 배열을 accumulator fraction으로 보간해 그리며, solver state와 fixture는 보간값으로 다시 쓰지 않는다.
- 큰 renderer stall은 한 frame에 그대로 적분하지 않는다. accumulator 입력을 원본 상한 `0.1s`로 clamp하고 display frame당 최대 6개의 60 Hz tick만 소비하며 그보다 오래된 backlog는 버린다.
- background tab에서 복귀하면 누락 frame을 재현하지 않고 현재 목표로부터 안정된 시간 범위만 이어간다.
- 수렴 판정은 `abs(currentTargetX - targetX) <= 0.0005`, 고정 60 Hz simulation tick 사이 모든 point의 최대 이동 거리 `<= 0.001`, 모든 segment의 최대 rest-length residual `<= 0.0075`를 동시에 사용한다. 세 조건을 연속 4 simulation tick, 즉 66.67ms 동안 만족해야 한다. 고정된 upstream 계산 순서의 480 tick 평형에서 OFF residual은 `0.007410221861037181`, ON residual은 `0.004441286393921176`이므로 이 상한은 17-point pose의 모든 16개 final-pose segment를 포함하면서 두 canonical 상태를 수용한다.
- 최신 target change부터 120 simulation tick, 즉 2초에 도달하면 목표 상태의 canonical point 배열과 zero velocity로 snap한 뒤 TAA 수렴만 완료한다. 이는 비정상 상태의 무한 RAF 방지 장치다.
- canonical OFF → ON과 ON → OFF는 각각 110 tick 안에 정상 settle해야 한다. 독립 reference에서 ON → OFF의 첫 qualifying tick은 106이고 4-tick settle은 109에서 완료된다. 15 tick 간격으로 반전하는 모든 fixture는 마지막 target change부터 120 tick 안에 settle해야 한다. 이 조건을 넘으면 테스트를 실패시키므로 정상 모션이 2초 safety snap에 의해 잘리는 구현은 허용하지 않는다.
- canonical OFF/ON fixture를 생성할 때도 같은 세 settle 조건을 쓰되 최대 480개의 60 Hz tick까지만 실행한다. 상한에서 미수렴이면 fixture 생성과 테스트를 실패시킨다.

## 9. WebGPU renderer 설계

### 9.1 보존할 원본 파이프라인

- TypeGPU 기반 compute/render 구조
- 256 × 128 `rgba16float` quadratic Bézier SDF texture
- point, control-point, normal storage buffers
- SDF 기반 3D jelly body와 end cap
- 최대 64-step raymarch
- maximum distance `10`
- surface distance `0.001`
- 원본 line radius `0.024`
- 원본 half thickness `0.17`
- jelly IOR `1.42`
- scatter strength `3`
- Beer–Lambert absorption, Fresnel reflection/refraction
- ambient color/intensity `0.6 / 0.6`
- AO steps/radius/intensity/bias `3 / 0.1 / 0.5 / 0.005`
- specular power/intensity `10 / 0.6`
- directional light `normalize(0.19, -0.24, 0.75)`
- 오렌지 jelly color `(1.0, 0.45, 0.075, 1.0)`
- camera position/target/up/FOV `(0, 2.7, 1.9) / (0, 0, 0) / +Y / π/4`
- premultiplied-alpha presentation
- ground plane, soft shadow, caustic
- temporal anti-aliasing의 2-texture ping-pong, history blend `0.9`, 원본 jitter 방식

컴포넌트 크기에 맞추기 위해 camera framing과 viewport aspect만 조정한다. 물체의 world-space 두께, 재질, 광학 상수와 조명 방향은 임의로 단순화하지 않는다.

### 9.2 제거할 원본 파이프라인

- `<input type="range">`의 DOM snapshot
- 퍼센트 text DOM snapshot과 texture
- `layoutsubtree`
- canvas `paint` event와 `requestPaint()`
- `GPUQueue.copyElementImageToTexture()`
- DOM-to-draw transform helper

ON/OFF 의미는 HTML button과 ARIA가 담당하므로 DOM 내용을 GPU texture로 복사할 이유가 없다.

### 9.3 frame scheduling

렌더 루프는 다음 경우에만 활성화한다.

1. 물리 endpoint가 움직이는 동안
2. resize/DPR/device 복구 직후
3. TAA history를 무효화한 뒤 16개의 stationary sample이 쌓일 때까지

물리가 정지한 뒤 16개의 stationary TAA sample을 쌓는다. 그 뒤 pending RAF는 없어야 하고 command submission도 중단한다. 동일 목표를 반복 설정해도 deadline이나 RAF가 새로 생기지 않는다.

production에서는 원본 jitter 분포를 사용한다. test mode는 clock과 random seed를 주입해 같은 simulation tick과 TAA jitter sequence를 재현한다. 시각 검증용 offscreen diagnostic attachments는 허용하지만 production color attachment, shader 수식과 상수는 바꾸지 않는다.

canvas backing size, camera projection, material/light uniform, device generation이 바뀌면 두 TAA history texture를 clear하고 stationary sample count를 0으로 만든다. point가 움직이는 frame에서는 history를 원본 방식으로 사용하되 stationary sample count만 0으로 되돌린다. 초기 canonical pose, reduced-motion snap, 2초 안전 상한 snap처럼 point 배열이 불연속으로 바뀌면 history를 invalid로 표시하고 첫 stationary sample은 history blend 없이 현재 frame으로 두 texture를 seed한다. 그 뒤 15개를 원본 blend `0.9`로 누적해 총 16개의 bounded stationary submission을 완료한 뒤 idle로 들어간다.

### 9.4 리소스 수명

- canvas 크기가 변할 때 size-dependent texture와 TAA history만 교체한다.
- 교체된 GPU resource는 즉시 destroy한다.
- pipeline과 immutable sampler는 정상 toggle 사이에 재생성하지 않는다.
- mount/destroy 반복 뒤 listener, observer, RAF, texture, buffer가 남지 않는다.
- uncaptured GPU error는 console에 구조화해 남기고 fallback 전환 사유를 instance 상태로 보존한다.

## 10. WebGPU 부재와 device loss

WebGPU는 주 시각 경로지만 버튼 기능의 전제 조건은 아니다.

- `navigator.gpu` 부재, adapter/device 요청 실패, shader/pipeline 실패 시 CSS fallback을 즉시 표시한다.
- fallback도 동일한 96 × 52 hit target, `role="switch"`, `aria-checked`, click/Space/Enter 동작을 유지한다.
- device loss가 발생하면 현재 semantic state는 유지하고 canvas를 숨긴 뒤 fallback을 표시한다.
- instance lifetime 동안 첫 device loss에 대해서만 한 번의 bounded automatic retry를 수행한다.
- automatic retry가 실패하면 추가 loop를 만들지 않고 fallback에 머문다.
- 사용자는 `retryWebGPU()`로 다시 시도할 수 있다.
- 복구 성공 시 과거 animation을 재생하지 않고 현재 checked endpoint에서 다시 시작한다.

## 11. Electron과 Vite의 별도 페이지 구조

기본 burn 페이지는 `/index.html`로 유지한다. 새 페이지는 `/jelly-toggle.html`이다.

- Vite는 두 HTML을 하나의 multi-page build input으로 빌드한다.
- 기본 `pnpm dev`와 기본 Electron 실행은 기존 burn 페이지를 연다.
- `pnpm dev:jelly`는 같은 Vite server의 `/jelly-toggle.html`을 별도 Electron 실행 모드로 연다.
- packaged mode에서도 명시적 `--jelly-toggle` 인수가 `dist-renderer/jelly-toggle.html`을 연다.
- jelly window는 burn screenshot IPC가 필요 없으므로 capture preload를 로드하지 않는다.
- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`와 navigation/window-open 차단은 그대로 적용한다.
- 허용 URL은 dev의 정확한 localhost jelly 경로 또는 packaged jelly file 하나로 제한한다.
- renderer CSP는 `default-src 'self'`, 필요한 local script/style만 허용하며 remote asset을 쓰지 않는다.
- 별도 `src/jelly-toggle-demo.css`를 사용해 기존 `src/style.css`의 burn 전역 규칙과 격리한다.

README의 기존 “production path에는 WebGPU가 없다”는 설명은 burn path에 한정됨을 명시하고, standalone jelly page가 표준 WebGPU를 사용하는 별도 데모임을 구분한다.

## 12. 의존성과 빌드

이식은 upstream 예제의 TypeGPU 계열을 기준으로 시작한다.

- `typegpu` 0.10.2
- `unplugin-typegpu` 0.10.2
- `@typegpu/sdf` 0.10.0
- `@typegpu/noise` 0.10.0
- `wgpu-matrix` 3.4.2
- `@webgpu/types` 0.1.69
- transitive `tinyest` 0.3.1 (`pnpm-workspace.yaml` override)

위 버전은 pinned upstream revision의 `package-lock.json` 실제 해상도이며 caret 없이 현재 저장소 lockfile에 고정한다. pnpm 11에서는 `tinyest`를 root workspace override로 고정한다. `0.3.2`는 `unplugin-typegpu` 0.10.2가 metadata를 만들 때 import하는 `FORMAT_VERSION`을 노출하지 않으므로 사용할 수 없다. retained source가 실제로 import하지 않는 upstream demo 의존성은 추가하지 않는다. 현재 저장소의 Vite와 TypeScript 버전은 유지하고, Vite config에는 TypeGPU plugin과 두 HTML input을 함께 구성한다. 기존 renderer와 Electron TypeScript typecheck를 모두 통과해야 한다.

## 13. 오류 처리와 상태 흐름

상태는 `semantic checked`, `visual target`, `render mode`, `lifecycle` 네 축으로 분리한다.

```text
native activation
  -> semantic checked 반전 + aria-checked 갱신
  -> onChange 1회
  -> visual target 갱신
  -> WebGPU면 현재 물리 상태에서 animate
  -> fallback이면 CSS 상태를 즉시 갱신
```

- renderer 오류가 semantic 상태를 rollback하지 않는다.
- rapid input은 마지막 checked 값이 최종 target을 소유한다.
- async adapter/device 초기화가 늦게 끝나도 destroy나 더 최신 retry 결과를 덮어쓰지 않는다.
- resize와 device loss가 같은 frame에 발생하면 device loss/fallback이 우선한다.
- callback 예외는 renderer 소유 resource 정리를 방해하지 않으며 사용자 event task 밖으로 재던지지 않는다.
- 초기화, retry, destroy는 generation token으로 stale continuation을 차단한다.

## 14. 테스트와 검증

### 14.1 단위 테스트

- OFF endpoint `-0.30`, ON endpoint `+0.90`
- 17 point 초기화와 pinning
- 6 substeps × 16 constraint iteration 호출 계약
- distance/bending/end-flat constraint의 고정 fixture
- 60/90/120/144 Hz display schedule에서 같은 60 Hz simulation tick의 point 배열 일치와 보간된 draw pose 허용 오차
- 중간 reversal이 position/velocity를 reset하지 않는지
- long-frame cap과 background resume 안정성
- settle 4 fixed tick, direct transition 110-tick 상한, reversal 120-tick 상한, 2초 안전 snap, 동일 target no-op
- TAA invalidation/수렴 뒤 idle RAF 0
- init/retry/destroy generation race와 멱등 cleanup
- device loss fallback 및 현재 checked 상태 복구

### 14.2 실제 Electron WebGPU 테스트

- adapter/device 생성
- compute/render pipeline compile 성공과 uncaptured error 0
- OFF → ON → OFF mouse 흐름
- Space와 Enter 각각 1회 toggle
- animation 중 반전과 최종 `aria-checked` 일치
- WebGPU 초기화가 끝나기 전 입력과 최종 checked endpoint 일치
- reduced motion 즉시 endpoint
- runtime reduced-motion/forced-colors media 변경
- forced-colors fallback
- DPR 1/2/3 backing size와 monitor/zoom resize
- WebGPU 강제 부재 시 CSS fallback 동작
- 반복 toggle/destroy 뒤 pending RAF, listener, observer, GPU resource 증가 없음

### 14.3 시각 회귀

기준 fixture 환경은 Windows x64, Electron `43.4.0`, Chromium `150.0.7871.224`, ANGLE D3D11, NVIDIA GeForce RTX 4070 SUPER, sRGB, 800 × 600 renderer viewport, DPR 2, 176 × 88 canvas backing으로 고정한다. test PRNG seed는 `0x4A454C4C`이고 manual physics clock은 0에서 시작해 정확히 `1/60s` tick으로 진행한다. 다른 GPU는 functional/structural gate를 실행하되 fixture 갱신 권한을 갖지 않는다.

이 환경에서 다음 세 frame을 보존한다.

1. OFF 정착 상태
2. OFF → ON 전환 중 첫 arch peak 상태
3. ON 정착 상태

검사는 단순 전체 pixel mismatch 하나에 의존하지 않고 아래 정량 gate를 모두 사용한다.

- silhouette IoU `>= 0.97`, bounding-box 각 edge 오차 `<= 2` physical px
- bridge 두께와 head/end-cap 측정값 각각 fixture 대비 `±5%`
- jelly mask 안의 CIEDE2000 평균 `<= 3.0`, p95 `<= 8.0`
- highlight와 Fresnel rim mask IoU 각각 `>= 0.85`, 면적 각각 fixture 대비 `±10%`
- refraction/absorption interior mask IoU `>= 0.85`, 평균 luma fixture 대비 `±8%`
- ground contact shadow와 caustic mask IoU 각각 `>= 0.82`, centroid 오차 `<= 3` physical px
- 정착 frame의 jelly bounding crop SSIM `>= 0.985`

GPU/driver 양자화 차이를 위한 좁은 tolerance는 허용하지만, shader layer가 사라지거나 camera/두께/endpoint가 달라지는 회귀는 통과시키지 않는다. golden은 `tests/fixtures/jelly-toggle/` 아래 추적한다.

mask는 최종 sRGB 이미지에서 휴리스틱하게 분류하지 않는다. 시각 test에서만 production render와 같은 ray hit, Fresnel, transmission, specular, shadow, caustic 계산값을 두 개의 offscreen `rgba16float` diagnostic attachment에 동시에 기록한다. attachment 계약은 다음과 같다.

| attachment/channel | 값 | 비교 mask |
| --- | --- | --- |
| A.R | jelly ray hit: `0` 또는 `1` | `>= 0.5` silhouette |
| A.G | Fresnel coefficient | `>= 0.20` rim |
| A.B | transmitted/refraction luminance | silhouette 중 `>= 0.02` interior |
| A.A | specular contribution luminance | `>= 0.05` highlight |
| B.R | ground shadow attenuation | `>= 0.02` shadow |
| B.G | caustic additive luminance | `>= 0.001` caustic |
| B.BA | reserved, 항상 `0` | 값이 0인지 검증 |

diagnostic pass는 production color attachment와 같은 draw에서 같은 수식을 사용하고 blending 없이 저장한다. fixture는 composite PNG와 두 attachment의 raw float data 및 mask threshold version `1`을 함께 보존한다. 따라서 IoU와 centroid는 고정된 source field에서 재현 가능하며 test 전용 색상 segmentation에 의존하지 않는다.

caustic threshold는 고정 authoring 환경에서 캘리브레이션한다. canonical ON의 실제 additive caustic은 최대 `0.0014067`이고 `0.001` 이상인 physical pixel이 33개인 반면 `0.005` 이상은 0개였다. 따라서 threshold version 1은 전 state에 `Math.fround(0.001)`을 적용해 ON 회귀 mask를 보존한다. raw `B.G` 값이나 production shading은 변경하지 않는다.

중간 golden의 capture time은 임의 wall clock wait로 정하지 않는다. fixed-step offline physics에서 OFF canonical pose부터 ON target을 향해 진행하며 각 tick의 point `maxY - minY`를 측정한다. 첫 arch peak를 `extent[n-1] < extent[n] && extent[n] >= extent[n+1]`로 선택하고, 동률이면 더 이른 tick을 택한다. 선택된 tick, seed, TAA sample count, renderer/GPU 환경과 upstream revision을 fixture metadata에 기록해 실제 Electron manual clock을 같은 tick으로 구동한다. local maximum이 2초 안에 없으면 fixture 생성을 실패시킨다.

### 14.4 기존 기능 회귀

- 기존 burn unit, WebGL compile, Electron E2E를 유지한다.
- `/`, `?test=1`, `data-burn-ready`, `window.__burnTest` 계약을 그대로 검증한다.
- 기존 burn reference capture와 benchmark는 jelly page와 분리한다.
- Vite manifest에서 burn `index.html` entry의 static/dynamic import closure에 TypeGPU package나 `jelly-toggle-3d` chunk가 없는지 검증한다.
- 기본 burn Electron page에서 `navigator.gpu.requestAdapter` 호출, WebGPU canvas context 생성, GPU command submission이 모두 0인지 계측한다.
- 기본 burn page만 capture preload를 받고 jelly page에는 capture bridge가 노출되지 않는지 양방향으로 검증한다.

### 14.5 실행 정책

- 구현 중에는 가장 가까운 focused unit/test를 사용한다.
- Electron 앱을 반복해서 장시간 띄우지 않는다.
- 완료 gate에서 unit, typecheck, build, burn E2E, jelly E2E를 각각 한 번 실행한다.
- OFF/first-arch-peak/ON 시각 회귀는 완료 gate에서 한 번 실행한다.
- frame-time benchmark는 `pnpm benchmark:jelly` opt-in으로 두고 일반 `pnpm verify`에서 제외한다.
- benchmark report에는 Electron/Chromium, OS, adapter, GPU/ANGLE, DPR, canvas backing size, raw frame intervals를 기록한다.

## 15. 제안 파일 경계

```text
jelly-toggle.html
src/
  jelly-toggle-demo.ts
  jelly-toggle-demo.css
  jelly-toggle-3d/
    index.ts
    JellyToggle3D.ts
    renderer.ts
    slider.ts
    camera.ts
    constants.ts
    dataTypes.ts
    taa.ts
    utils.ts
third_party/
  webgpu-jelly-slider/
    LICENSE
THIRD_PARTY_NOTICES.md
tests/
  unit/
    jelly-toggle-3d-physics.test.ts
    jelly-toggle-3d-lifecycle.test.ts
  e2e/
    jelly-toggle.spec.ts
    jelly-toggle-visual.spec.ts
  fixtures/
    jelly-toggle/
```

구현 계획에서 파일은 upstream dependency closure에 따라 합치거나 더 나눌 수 있지만, public API, renderer, physics, demo entry, third-party notice, 테스트의 책임 경계는 유지한다.

## 16. 수용 기준

완료로 판단하려면 다음 조건을 모두 충족해야 한다.

1. `pnpm dev:jelly`가 기존 burn 화면과 별개의 Electron 창에서 jelly page를 연다.
2. 88 × 44 canvas 안에서 OFF는 원본 최소 압축 형상, ON은 원본 최대 Anchored Bridge 형상으로 보인다.
3. 원본 17-point PBD/SDF/raymarch/TAA/material 계수와 MIT 고지가 코드와 문서에 보존된다.
4. click, Space, Enter, rapid reversal, reduced motion, forced-colors, WebGPU fallback이 의미상 올바르다.
5. 수렴 뒤 RAF와 GPU command submission이 0이다.
6. WebGPU가 가능한 Electron에서 OFF/first-arch-peak/ON visual gate가 통과한다.
7. 기존 burn 페이지의 DOM, default launch, capture bridge, theme behavior, test mode와 회귀 테스트가 유지된다.
8. typecheck, unit tests, build, 기존 burn E2E, jelly E2E가 완료 gate에서 통과한다.
9. 성능 benchmark는 사용자가 요청할 때만 실행하며 일반 검증을 느리게 만들지 않는다.
10. 저장소에 upstream source URL, exact revision SHA, 전체 MIT license와 attribution이 포함된다.

이 기준은 이전의 단순 Canvas 2D 모사본이 아니라, 참조 renderer와 physics를 허용된 라이선스 아래 직접 이식한 작은 binary component를 요구한다.
