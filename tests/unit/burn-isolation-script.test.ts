import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const temporaryDirectories: string[] = [];
const scriptPath = path.resolve('scripts/verify-burn-isolation.cjs');

interface ProvenanceChunk {
  readonly modules: readonly string[];
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
}

function createBuild(provenance: Readonly<Record<string, ProvenanceChunk>>): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'burn-isolation-'));
  temporaryDirectories.push(directory);
  mkdirSync(path.join(directory, '.vite'), { recursive: true });
  writeFileSync(path.join(directory, '.vite', 'manifest.json'), JSON.stringify({
    'index.html': {
      file: 'assets/burn.js',
      isEntry: true,
      imports: ['_shared.js'],
      dynamicImports: ['src/burn-lazy.ts'],
    },
    '_shared.js': { file: 'assets/shared.js' },
    'src/burn-lazy.ts': { file: 'assets/lazy.js', isDynamicEntry: true },
    'jelly-toggle.html': { file: 'assets/jelly.js', isEntry: true },
  }));
  writeFileSync(
    path.join(directory, '.vite', 'module-provenance.json'),
    JSON.stringify(provenance),
  );
  return directory;
}

function runVerifier(directory: string) {
  return spawnSync(process.execPath, [scriptPath, directory], {
    encoding: 'utf8',
    windowsHide: true,
  });
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('verify-burn-isolation.cjs', () => {
  it('accepts a safe burn static and dynamic closure while ignoring the jelly entry', () => {
    const directory = createBuild({
      'assets/burn.js': {
        modules: ['C:\\repo\\src\\demo.ts'],
        imports: ['assets/shared.js'],
        dynamicImports: ['assets/lazy.js'],
      },
      'assets/shared.js': {
        modules: ['C:/repo/src/burn-transition/progress.ts'],
        imports: [],
        dynamicImports: [],
      },
      'assets/lazy.js': {
        modules: ['C:/repo/src/burn-transition/coordinates.ts'],
        imports: [],
        dynamicImports: [],
      },
      'assets/jelly.js': {
        modules: ['C:/repo/src/jelly-toggle-3d/renderer.ts'],
        imports: [],
        dynamicImports: [],
      },
    });

    const result = runVerifier(directory);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Burn bundle isolation verified');
  });

  it.each([
    ['static', 'C:/repo/node_modules/typegpu/dist/index.js', 'assets/shared.js'],
    ['dynamic', 'C:/repo/src/jelly-toggle-3d/renderer.ts', 'assets/lazy.js'],
    ['scoped TypeGPU', 'C:/repo/node_modules/@typegpu/sdf/index.js', 'assets/shared.js'],
    ['matrix', 'C:/repo/node_modules/wgpu-matrix/dist/3.x/wgpu-matrix.js', 'assets/lazy.js'],
  ])('rejects forbidden %s modules in the burn closure', (_label, forbiddenModule, chunk) => {
    const directory = createBuild({
      'assets/burn.js': {
        modules: ['C:/repo/src/demo.ts'],
        imports: ['assets/shared.js'],
        dynamicImports: ['assets/lazy.js'],
      },
      'assets/shared.js': {
        modules: chunk === 'assets/shared.js' ? [forbiddenModule] : ['C:/repo/src/shared.ts'],
        imports: [],
        dynamicImports: [],
      },
      'assets/lazy.js': {
        modules: chunk === 'assets/lazy.js' ? [forbiddenModule] : ['C:/repo/src/lazy.ts'],
        imports: [],
        dynamicImports: [],
      },
      'assets/jelly.js': {
        modules: [],
        imports: [],
        dynamicImports: [],
      },
    });

    const result = runVerifier(directory);

    expect(result.status).toBe(1);
    expect(result.stderr.replaceAll('\\', '/')).toContain(forbiddenModule);
    expect(result.stderr).toContain(chunk);
  });

  it('fails closed when a reachable chunk has no provenance record', () => {
    const directory = createBuild({
      'assets/burn.js': {
        modules: ['C:/repo/src/demo.ts'],
        imports: ['assets/missing.js'],
        dynamicImports: [],
      },
    });

    const result = runVerifier(directory);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('assets/missing.js');
    expect(result.stderr).toContain('provenance');
  });
});
