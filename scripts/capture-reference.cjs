const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { deadlineDelay, timingObservation } = require('./reference-timing.cjs');

app.commandLine.appendSwitch('enable-blink-features', 'CanvasDrawElement');
app.commandLine.appendSwitch('force-device-scale-factor', '1');

const source = 'https://mattrothenberg.com/demos/burn-transition';
const outputDirectory = path.join(process.cwd(), 'tests', 'fixtures', 'reference');
const metadataPath = path.join(outputDirectory, 'metadata.json');
const frameTimes = [0, 200, 1_350, 2_500];
const schedulingToleranceMs = 34;
const selectors = { canvas: '#canvas' };
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function commonMetadata() {
  return {
    source,
    viewport: { width: 1_280, height: 720 },
    origin: { x: 640, y: 360 },
    frameTimes,
    selectors,
    timingMode: 'absolute-click-time-deadlines',
    timingUncertainty: {
      schedulingToleranceMs,
      note: 'Timing error is measured when capturePage starts; remote animation start and compositor completion remain observational.',
    },
    electron: process.versions.electron,
    chromium: process.versions.chrome,
  };
}

function writeMetadata(value) {
  fs.mkdirSync(outputDirectory, { recursive: true });
  fs.writeFileSync(metadataPath, JSON.stringify({ ...commonMetadata(), ...value }, null, 2));
}

async function inspectSupport(window) {
  return window.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector(${JSON.stringify(selectors.canvas)});
    const gl = canvas instanceof HTMLCanvasElement ? canvas.getContext('webgl2') : null;
    return {
      canvasFound: canvas instanceof HTMLCanvasElement,
      requestPaint: typeof canvas?.requestPaint === 'function',
      webgl2: Boolean(gl),
      texElementImage2D: typeof gl?.texElementImage2D === 'function',
      location: location.href,
      title: document.title,
    };
  })()`);
}

async function clickCanvas(window) {
  return window.webContents.executeJavaScript(`(() => {
    const canvas = document.querySelector(${JSON.stringify(selectors.canvas)});
    if (!(canvas instanceof HTMLCanvasElement)) throw new Error('Reference canvas selector unavailable');
    const dispatchedAt = performance.now();
    canvas.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      clientX: 640,
      clientY: 360,
    }));
    return dispatchedAt;
  })()`);
}

async function captureSeries(window, direction) {
  const clickTime = await clickCanvas(window);
  const observations = [];
  for (const elapsed of frameTimes) {
    const schedulingStartedAt = await window.webContents.executeJavaScript('performance.now()');
    const scheduledWaitMs = deadlineDelay(clickTime, elapsed, schedulingStartedAt);
    await wait(scheduledWaitMs);
    const captureStartedAt = await window.webContents.executeJavaScript('performance.now()');
    const timing = timingObservation(
      elapsed,
      clickTime,
      captureStartedAt,
      schedulingToleranceMs,
    );
    const image = await window.webContents.capturePage();
    const captureCompletedAt = await window.webContents.executeJavaScript('performance.now()');
    const name = `${direction}-${String(elapsed).padStart(4, '0')}.png`;
    fs.writeFileSync(path.join(outputDirectory, name), image.toPNG());
    observations.push({
      elapsed,
      deadlineAt: clickTime + elapsed,
      schedulingStartedAt,
      scheduledWaitMs,
      captureStartedAt,
      captureCompletedAt,
      observedElapsed: captureStartedAt - clickTime,
      captureCompletedElapsed: captureCompletedAt - clickTime,
      ...timing,
      size: image.getSize(),
      file: name,
    });
  }
  return { clickTime, observations };
}

async function run() {
  fs.mkdirSync(outputDirectory, { recursive: true });
  const window = new BrowserWindow({
    width: 1_280,
    height: 720,
    useContentSize: true,
    show: false,
    webPreferences: {
      webgl: true,
      backgroundThrottling: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  try {
    await window.loadURL(source);
    const support = await inspectSupport(window);
    if (!support.canvasFound || !support.webgl2
      || !support.requestPaint || !support.texElementImage2D) {
      writeMetadata({
        supported: false,
        status: 'feature-unavailable',
        unavailableReason: 'CanvasDrawElement primitives or the expected canvas selector are unavailable.',
        support,
      });
      console.warn(`Optional CanvasDrawElement capture unavailable: ${JSON.stringify(support)}`);
      return;
    }

    const darkToLight = await captureSeries(window, 'dark-to-light');
    await window.loadURL(source);
    await clickCanvas(window);
    await wait(3_000);
    const lightToDark = await captureSeries(window, 'light-to-dark');
    writeMetadata({
      supported: true,
      status: 'captured',
      support,
      darkToLight,
      lightToDark,
    });
  } catch (error) {
    writeMetadata({
      supported: false,
      status: 'unavailable',
      unavailableReason: String(error?.message || error),
      error: String(error?.stack || error),
    });
    console.warn('Optional reference observation unavailable; diagnostic metadata was saved.');
  } finally {
    if (!window.isDestroyed()) window.destroy();
  }
}

app.whenReady()
  .then(run)
  .catch((error) => {
    writeMetadata({
      supported: false,
      status: 'startup-unavailable',
      unavailableReason: String(error?.message || error),
      error: String(error?.stack || error),
    });
    console.warn('Optional reference startup unavailable; diagnostic metadata was saved.');
  })
  .finally(() => app.exit(0));
