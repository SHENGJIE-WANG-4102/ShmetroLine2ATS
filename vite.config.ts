import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  server: {port:5173,strictPort:true,watch:{ignored:['**/src-tauri/**']}},
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    // The simulation tests are long synchronous loops: each file runs in its
    // own process, and the shared warm-ups are made once up front.
    pool: 'forks',
    globalSetup: ['tests/globalSetup.ts'],
    setupFiles: ['tests/setup.ts'],
  },
} as any);
