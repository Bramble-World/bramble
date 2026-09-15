import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './src/e2e',
  testMatch: '**/*.e2e.test.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  // One engine is enough: the browser suite only smoke-tests the two public
  // pages. API coverage belongs in a browserless project, not a second engine.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Reuses a dev server you already have running; starts one otherwise.
  webServer: {
    // Locally, Doppler injects secrets. CI has no Doppler and needs none —
    // every integration in src/env.ts is optional, so the app boots without.
    command: process.env.CI ? 'pnpm dev' : 'doppler run -- pnpm dev',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
