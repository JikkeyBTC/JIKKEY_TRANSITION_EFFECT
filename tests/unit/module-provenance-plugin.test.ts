import { describe, expect, it, vi } from 'vitest';
import { moduleProvenancePlugin } from '../../build/module-provenance-plugin';

describe('moduleProvenancePlugin', () => {
  it('emits normalized modules and both import edge kinds for every output chunk', async () => {
    const plugin = moduleProvenancePlugin();
    const emitFile = vi.fn();
    const generateBundle = plugin.generateBundle;
    if (typeof generateBundle !== 'function') throw new Error('generateBundle hook is not callable');

    await generateBundle.call({ emitFile } as never, {} as never, {
      'assets/burn.js': {
        type: 'chunk',
        fileName: 'assets/burn.js',
        modules: {
          'C:\\workspace\\src\\demo.ts': {},
          '\\0virtual:burn': {},
        },
        imports: ['assets/shared.js'],
        dynamicImports: ['assets/lazy.js'],
      },
      'assets/logo.svg': {
        type: 'asset',
        fileName: 'assets/logo.svg',
        source: '<svg />',
      },
    } as never, false);

    expect(emitFile).toHaveBeenCalledOnce();
    const emitted = emitFile.mock.calls[0]?.[0] as {
      type: string;
      fileName: string;
      source: string;
    };
    expect(emitted.type).toBe('asset');
    expect(emitted.fileName).toBe('.vite/module-provenance.json');
    expect(JSON.parse(emitted.source)).toEqual({
      'assets/burn.js': {
        modules: ['C:/workspace/src/demo.ts', '/0virtual:burn'],
        imports: ['assets/shared.js'],
        dynamicImports: ['assets/lazy.js'],
      },
    });
  });
});
