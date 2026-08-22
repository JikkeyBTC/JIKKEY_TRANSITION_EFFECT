import { defineConfig } from 'vitest/config';
import { moduleProvenancePlugin } from './build/module-provenance-plugin';

export default defineConfig(async () => {
  const { default: typegpuPlugin } = await import('unplugin-typegpu/vite');
  return {
    base: './',
    input: {
      burn: 'index.html',
      jelly: 'jelly-toggle.html',
    },
    html: {
      cspNonce: 'jelly-toggle-vite',
    },
    plugins: [
      typegpuPlugin({ include: /src[\\/]jelly-toggle-3d[\\/].*\.ts$/ }),
      moduleProvenancePlugin(),
    ],
    build: {
      outDir: 'dist-renderer',
      emptyOutDir: true,
      manifest: true,
    },
    test: {
      environment: 'happy-dom',
      include: ['tests/unit/**/*.test.ts'],
      restoreMocks: true,
    },
  };
});
