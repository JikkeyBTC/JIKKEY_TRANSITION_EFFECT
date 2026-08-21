import { BurnTransition, type BurnOrigin, type BurnToggleResult } from './burn-transition';
import { ManualBurnClock } from './demo-clock';
import { JellyAnimator, paintJellyToggle, resolveJellyPalette } from './jelly-toggle';
import './style.css';

type Theme = 'light' | 'dark';

const button = document.querySelector<HTMLButtonElement>('[data-theme-toggle]')!;
const jellyCanvas = document.querySelector<HTMLCanvasElement>('[data-jelly-toggle]')!;
const word = document.querySelector<HTMLElement>('[data-theme-word]')!;
const testMode = new URLSearchParams(location.search).get('test') === '1';
const manualClock = testMode ? new ManualBurnClock() : null;
const transition = new BurnTransition(
  manualClock
    ? { clock: manualClock, respectReducedMotion: false }
    : { respectReducedMotion: true },
);
let theme: Theme = 'dark';
let activeToggle = false;
let jellyPalette = resolveJellyPalette(jellyCanvas, true);
const jelly = new JellyAnimator({
  initialChecked: true,
  motion: testMode ? 'never' : 'respect-preference',
  onFrame: (state) => paintJellyToggle(jellyCanvas, state, jellyPalette),
  onAnimatingChange: (animating) => {
    if (animating) jellyCanvas.dataset.jellyAnimating = 'true';
    else delete jellyCanvas.dataset.jellyAnimating;
  },
});
const jellyLifecycle = new AbortController();
window.addEventListener('resize', () => {
  jellyPalette = resolveJellyPalette(jellyCanvas, theme === 'dark');
  jelly.redraw();
}, { signal: jellyLifecycle.signal });

function syncTheme(next: Theme): void {
  theme = next;
  document.documentElement.dataset.theme = next;
  const dark = next === 'dark';
  word.textContent = dark ? 'DARK' : 'LIGHT';
  button.setAttribute('aria-checked', String(dark));
  jellyPalette = resolveJellyPalette(jellyCanvas, dark);
  jelly.setChecked(dark);
}

function buttonOrigin(event?: MouseEvent): BurnOrigin {
  if (event && (event.clientX !== 0 || event.clientY !== 0)) {
    return { x: event.clientX, y: event.clientY };
  }
  const bounds = button.getBoundingClientRect();
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}

async function toggleAt(origin: BurnOrigin): Promise<BurnToggleResult> {
  if (activeToggle) return { status: 'ignored', reason: 'busy' };
  activeToggle = true;
  const next: Theme = theme === 'dark' ? 'light' : 'dark';
  button.disabled = true;
  button.setAttribute('aria-disabled', 'true');
  try {
    return await transition.toggle({ origin, applyTheme: () => syncTheme(next) });
  } finally {
    activeToggle = false;
    button.disabled = false;
    button.setAttribute('aria-disabled', 'false');
  }
}

button.addEventListener('click', (event) => {
  void toggleAt(buttonOrigin(event));
});

window.addEventListener('beforeunload', () => {
  jellyLifecycle.abort();
  jelly.destroy();
  transition.destroy();
}, { once: true });

if (testMode) document.documentElement.dataset.testMode = 'true';
await transition.prepare();
syncTheme('dark');
button.disabled = false;
button.setAttribute('aria-disabled', 'false');
document.documentElement.setAttribute('data-burn-ready', '');

if (manualClock) {
  window.__burnTest = {
    hasPendingFrame: () => manualClock.hasPendingFrame(),
    step: (milliseconds) => manualClock.step(milliseconds),
    setTime: (milliseconds) => manualClock.set(milliseconds),
    toggleAt: (x, y) => toggleAt({ x, y }),
  };
}
