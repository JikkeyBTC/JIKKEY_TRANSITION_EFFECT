import { defineConfig } from 'vitest/config';

export default defineConfig(async () => {
  const { default: typegpuPlugin } = await import('unplugin-typegpu/vite');
  return {
    base: './',
    plugins: [typegpuPlugin({ include: /src[\\/]jelly-toggle-3d[\\/].*\.ts$/ })],
    build: {
      outDir: 'dist-renderer',
      emptyOutDir: true,
    },
    test: {
      environment: 'happy-dom',
      include: ['tests/unit/**/*.test.ts'],
      restoreMocks: true,
    },
  };
});
