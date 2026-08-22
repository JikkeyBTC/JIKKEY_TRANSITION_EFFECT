import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly scripts: Readonly<Record<string, string>>;
}

const packageManifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest;

function scriptClosure(entry: string): string {
  const visited = new Set<string>();
  const commands: string[] = [];

  const visit = (name: string): void => {
    if (visited.has(name)) return;
    visited.add(name);
    const command = packageManifest.scripts[name];
    if (command === undefined) throw new Error(`Missing package script: ${name}`);
    commands.push(command);

    for (const candidate of Object.keys(packageManifest.scripts)) {
      const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`\\bpnpm(?:\\s+run)?\\s+${escaped}(?:\\s|$)`).test(command)) {
        visit(candidate);
      }
    }
  };

  visit(entry);
  return commands.join('\n');
}

describe('standalone WebGPU jelly toggle integration contract', () => {
  it('documents the copyable public API, fallback, security, build, and attribution contract', () => {
    const guidePath = 'docs/jelly-toggle-integration.md';
    expect(existsSync(guidePath), `${guidePath} must be published`).toBe(true);
    const guide = readFileSync(guidePath, 'utf8');

    expect(guide).toContain("import { createJellyToggle3D } from './jelly-toggle-3d';");
    expect(guide).toContain("import './jelly-toggle-3d/component.css';");
    expect(guide).toContain(
      'declare function createJellyToggle3D(options: JellyToggle3DOptions): JellyToggle3D;',
    );
    expect(guide).toContain('window.addEventListener(\'beforeunload\', () => toggle.destroy(), { once: true });');
    expect(guide).toContain('retryWebGPU(): Promise<JellyToggleReadyState>');
    expect(guide).toContain("type JellyToggleReadyState = 'webgpu' | 'fallback' | 'destroyed';");

    expect(guide).toContain('pnpm dev:jelly');
    expect(guide).toContain('--jelly-toggle');
    expect(guide).toContain("canvas.getContext('webgpu')");
    expect(guide).toContain('navigator.gpu');
    expect(guide).toContain('layoutsubtree');
    expect(guide).toContain('requestPaint()');
    expect(guide).toContain('copyElementImageToTexture()');
    expect(guide).toContain('contextIsolation: true');
    expect(guide).toContain('sandbox: true');
    expect(guide).toContain('nodeIntegration: false');
    expect(guide).toMatch(/TypeGPU plugin[^\n]+jelly-toggle-3d/i);
    expect(guide).toContain('tinyest: 0.3.1');

    expect(guide).toMatch(/CSS fallback/i);
    expect(guide).toMatch(/device loss/i);
    expect(guide).toContain('prefers-reduced-motion');
    expect(guide).toContain('forced-colors');
    expect(guide).toContain('burn page alone loads the capture preload');
    expect(guide).toContain('jelly page has no preload');

    const pinnedSha = 'd4433e329697c4341a9f915f75dbd9608f3939fa';
    expect(guide).toContain(
      `https://github.com/WICG/html-in-canvas/tree/${pinnedSha}/Examples/webgpu-jelly-slider`,
    );
    expect(guide).toContain(`Pinned revision: \`${pinnedSha}\``);
    expect(guide).toContain('third_party/webgpu-jelly-slider/LICENSE');
    expect(guide).toContain('Copyright (c) 2025 Software Mansion <swmansion.com>');
    expect(guide).toContain('Voicu Apostol');
  });

  it('keeps the default burn page distinct from both jelly implementations', () => {
    const readme = readFileSync('README.md', 'utf8');
    const burnGuide = readFileSync('docs/integration.md', 'utf8');

    expect(readme).toContain('The default burn page uses WebGL2 for the transition');
    expect(readme).toContain('does not initialize WebGPU');
    expect(readme).toContain('The standalone jelly page uses standard WebGPU through TypeGPU');
    expect(readme).toContain('[standalone WebGPU jelly toggle](docs/jelly-toggle-integration.md)');
    expect(readme).not.toMatch(/(?:default )?burn page (?:itself )?uses WebGPU/i);

    expect(burnGuide).toContain('Optional compact Canvas 2D jelly switch');
    expect(burnGuide).toContain('[standalone WebGPU jelly toggle](jelly-toggle-integration.md)');
  });

  it('runs portable jelly behavior, resource, isolation, and built-provenance gates routinely', () => {
    const verify = scriptClosure('verify');

    expect(verify).toContain('tsc -p tsconfig.json --noEmit');
    expect(verify).toContain('vitest run');
    expect(verify).toContain('vite build');
    expect(verify).toContain('node scripts/verify-burn-isolation.cjs');
    expect(verify).toContain('tests/e2e/jelly-toggle.spec.ts');
    expect(verify).toContain('tests/e2e/jelly-toggle-renderer.spec.ts');
    expect(verify).toContain('tests/e2e/jelly-toggle-resources.spec.ts');
    expect(verify).toContain('tests/e2e/burn-isolation.spec.ts');

    expect(verify).not.toContain('benchmark:jelly');
    expect(verify).not.toContain('jelly-toggle-performance.spec.ts');
    expect(verify).not.toContain('capture:jelly');
    expect(verify).not.toContain('generate-jelly-fixtures.cjs');
  });
});
