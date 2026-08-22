import { describe, expect, it } from 'vitest';
import {
  blockUnexpectedNavigation,
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
    expect(rendererQuery('jelly', [
      '--jelly-toggle',
      '--test-mode',
      '--diagnostic-webgpu',
      '--fixture-capture',
    ])).toEqual({ test: '1', diagnostic: '1', fixture: '1' });
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

  it('allows only the exact expected main-frame navigation or redirect', () => {
    const expected = 'https://renderer.invalid/jelly-toggle.html?test=1';
    const attempt = (url: string, isMainFrame: boolean) => {
      let prevented = false;
      const allowed = blockUnexpectedNavigation({
        url,
        isMainFrame,
        preventDefault: () => { prevented = true; },
      }, expected);
      return { allowed, prevented };
    };

    expect(attempt(expected, true)).toEqual({ allowed: true, prevented: false });
    expect(attempt(`${expected}#redirected`, true)).toEqual({ allowed: false, prevented: true });
    expect(attempt('https://renderer.invalid/other', true)).toEqual({ allowed: false, prevented: true });
    expect(attempt(expected, false)).toEqual({ allowed: false, prevented: true });
  });
});
