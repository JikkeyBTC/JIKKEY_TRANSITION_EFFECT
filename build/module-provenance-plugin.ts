import type { Plugin } from 'vite';

export interface ModuleProvenanceChunk {
  readonly modules: readonly string[];
  readonly imports: readonly string[];
  readonly dynamicImports: readonly string[];
}

export type ModuleProvenanceMap = Readonly<Record<string, ModuleProvenanceChunk>>;

export interface ModuleProvenancePluginOptions {
  readonly fileName?: string;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/');
}

export function moduleProvenancePlugin(
  options: ModuleProvenancePluginOptions = {},
): Plugin {
  const fileName = options.fileName ?? '.vite/module-provenance.json';

  return {
    name: 'module-provenance',
    apply: 'build',
    generateBundle(_outputOptions, bundle) {
      const provenance: Record<string, ModuleProvenanceChunk> = {};

      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        provenance[normalizePath(output.fileName)] = {
          modules: Object.keys(output.modules).map(normalizePath),
          imports: output.imports.map(normalizePath),
          dynamicImports: output.dynamicImports.map(normalizePath),
        };
      }

      this.emitFile({
        type: 'asset',
        fileName,
        source: `${JSON.stringify(provenance, null, 2)}\n`,
      });
    },
  };
}
