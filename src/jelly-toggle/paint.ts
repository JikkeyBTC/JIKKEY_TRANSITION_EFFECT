import { createJellyGeometry, type JellyState } from './physics';

const LOGICAL_WIDTH = 52;
const LOGICAL_HEIGHT = 30;

export interface JellyPalette {
  readonly track: string;
  readonly trackBorder: string;
  readonly fill: string;
  readonly shadow: string;
  readonly highlight: string;
}

export function resolveJellyPalette(
  canvas: HTMLCanvasElement,
  checked: boolean,
): JellyPalette {
  const style = getComputedStyle(canvas);
  const color = (name: string, fallback: string): string =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    track: color(
      checked ? '--jelly-track-active' : '--jelly-track',
      checked ? 'rgba(255, 115, 19, 0.25)' : 'rgba(125, 125, 119, 0.28)',
    ),
    trackBorder: color('--jelly-track-border', 'rgba(255, 255, 255, 0.18)'),
    fill: color('--jelly-fill', '#ff7313'),
    shadow: color('--jelly-shadow', 'rgba(255, 94, 0, 0.38)'),
    highlight: color('--jelly-highlight', 'rgba(255, 255, 255, 0.62)'),
  };
}

export function paintJellyToggle(
  canvas: HTMLCanvasElement,
  state: JellyState,
  palette: JellyPalette,
): void {
  const context = canvas.getContext('2d');
  if (!context) return;
  const pixelRatio = Math.min(Math.max(window.devicePixelRatio || 1, 1), 3);
  const pixelWidth = Math.round(LOGICAL_WIDTH * pixelRatio);
  const pixelHeight = Math.round(LOGICAL_HEIGHT * pixelRatio);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  context.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
  context.fillStyle = palette.track;
  context.strokeStyle = palette.trackBorder;
  context.lineWidth = 1;
  context.beginPath();
  context.roundRect(1.5, 2.5, 49, 25, 12.5);
  context.fill();
  context.stroke();

  const geometry = createJellyGeometry(state);
  context.save();
  context.strokeStyle = palette.fill;
  context.fillStyle = palette.fill;
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = geometry.trailWidth;
  context.shadowColor = palette.shadow;
  context.shadowBlur = 4;
  context.beginPath();
  context.moveTo(geometry.trailStartX, 15);
  context.quadraticCurveTo(
    geometry.controlX,
    geometry.controlY,
    geometry.headCenterX,
    15,
  );
  context.stroke();
  context.beginPath();
  context.ellipse(
    geometry.headCenterX,
    15,
    geometry.headRadiusX,
    geometry.headRadiusY,
    0,
    0,
    Math.PI * 2,
  );
  context.fill();
  context.restore();

  context.fillStyle = palette.highlight;
  context.beginPath();
  context.ellipse(
    geometry.headCenterX - geometry.headRadiusX * 0.24,
    11.7,
    Math.max(1.3, geometry.headRadiusX * 0.22),
    1.3,
    -0.2,
    0,
    Math.PI * 2,
  );
  context.fill();
}
