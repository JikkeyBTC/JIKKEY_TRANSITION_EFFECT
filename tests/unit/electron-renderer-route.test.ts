import { describe, expect, it } from 'vitest';
import {
  requestedDevServerUrl,
  rendererHtml,
  rendererDevPath,
  rendererKind,
  rendererQuery,
} from '../../electron/renderer-route';

describe('Electron renderer routing', () => {
  it('keeps the burn renderer as the default route', () => {
    expect(rendererKind(['electron', 'main.js'])).toBe('burn');
    expect(rendererHtml('burn')).toBe('index.html');
    expect(rendererDevPath('burn')).toBe('/');
    expect(rendererQuery('burn', ['--test-mode'])).toEqual({ test: '1' });
  });

  it('selects the isolated jelly page without inheriting burn-only flags', () => {
    const arguments_ = ['electron', 'main.js', '--jelly-toggle', '--test-mode'];
    expect(rendererKind(arguments_)).toBe('jelly');
    expect(rendererHtml('jelly')).toBe('jelly-toggle.html');
    expect(rendererDevPath('jelly')).toBe('/jelly-toggle.html');
    expect(rendererQuery('jelly', arguments_)).toEqual({ test: '1' });
  });

  it('only admits test fixture switches on the test-gated jelly route', () => {
    expect(rendererQuery('jelly', ['--jelly-toggle', '--hide-webgpu'])).toEqual({});
    expect(rendererQuery('jelly', [
      '--jelly-toggle',
      '--test-mode',
      '--hide-webgpu',
      '--defer-webgpu',
    ])).toEqual({ test: '1', gpu: 'hidden', init: 'manual' });
    expect(rendererQuery('burn', [
      '--test-mode',
      '--hide-webgpu',
      '--defer-webgpu',
    ])).toEqual({ test: '1' });
  });

  it('accepts only one exact local development server argument', () => {
    expect(requestedDevServerUrl([])).toBeUndefined();
    expect(requestedDevServerUrl([
      '--dev-server-url=http://127.0.0.1:5173',
    ])).toBe('http://127.0.0.1:5173');
    expect(() => requestedDevServerUrl([
      '--dev-server-url=http://localhost:5173',
    ])).toThrow('Rejected dev server URL');
    expect(() => requestedDevServerUrl([
      '--dev-server-url=http://127.0.0.1:5173',
      '--dev-server-url=http://127.0.0.1:5173',
    ])).toThrow('Expected at most one dev server URL');
  });
});
