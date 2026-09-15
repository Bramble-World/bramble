import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// `.mts` so Vite loads this as real ESM — a plain `.ts` config gets treated as
// CommonJS and warns under the native config loader.
const srcPath = fileURLToPath(new URL('./src', import.meta.url));

export default defineConfig({
  plugins: [react()],
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'jsdom',
          globals: true,
          setupFiles: ['./src/test/setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
          // src/e2e belongs to Playwright — Vitest must not claim those files.
          exclude: ['node_modules', '**/*.integration.test.ts', 'src/e2e/**'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          globals: true,
          include: ['src/**/*.integration.test.ts'],
          pool: 'forks',
          fileParallelism: false,
          testTimeout: 15000,
        },
        resolve: {
          alias: {
            '@': srcPath,
          },
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/test/'],
    },
  },
  resolve: {
    alias: {
      '@': srcPath,
    },
  },
});
