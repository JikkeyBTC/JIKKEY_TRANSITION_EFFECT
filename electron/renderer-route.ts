export const DEV_SERVER_URL = 'http://127.0.0.1:5173' as const;

export type RendererKind = 'burn' | 'jelly';

export interface PreventableNavigation {
  readonly url: string;
  readonly isMainFrame: boolean;
  preventDefault(): void;
}

export function blockUnexpectedNavigation(
  navigation: PreventableNavigation,
  expectedUrl: string,
): boolean {
  const allowed = navigation.isMainFrame && navigation.url === expectedUrl;
  if (!allowed) navigation.preventDefault();
  return allowed;
}

export function rendererKind(argv: readonly string[]): RendererKind {
  return argv.includes('--jelly-toggle') ? 'jelly' : 'burn';
}

export function rendererHtml(kind: RendererKind): 'index.html' | 'jelly-toggle.html' {
  return kind === 'jelly' ? 'jelly-toggle.html' : 'index.html';
}

export function rendererDevPath(kind: RendererKind): '/' | '/jelly-toggle.html' {
  return kind === 'jelly' ? '/jelly-toggle.html' : '/';
}

export function rendererQuery(
  kind: RendererKind,
  argv: readonly string[],
): Readonly<Record<string, string>> {
  if (!argv.includes('--test-mode')) return {};
  if (kind === 'burn') return { test: '1' };
  return {
    test: '1',
    ...(argv.includes('--hide-webgpu') ? { gpu: 'hidden' } : {}),
    ...(argv.includes('--defer-webgpu') ? { init: 'manual' } : {}),
    ...(argv.includes('--diagnostic-webgpu') ? { diagnostic: '1' } : {}),
    ...(argv.includes('--fixture-capture') ? { fixture: '1' } : {}),
  };
}

export function requestedDevServerUrl(argv: readonly string[]): typeof DEV_SERVER_URL | undefined {
  const prefix = '--dev-server-url=';
  const arguments_ = argv.filter((argument) => argument.startsWith(prefix));
  if (arguments_.length > 1) throw new Error('Expected at most one dev server URL');
  const value = arguments_[0]?.slice(prefix.length);
  if (value === undefined) return undefined;
  if (value !== DEV_SERVER_URL) throw new Error(`Rejected dev server URL: ${value}`);
  return value;
}
