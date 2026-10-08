import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './src/e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    // Browserless. Specs here use only the `request` fixture, so Playwright
    // never launches a browser — no binary needed, and it runs on every branch.
    {
      name: 'api',
      testMatch: '**/*.api.test.ts',
      use: { baseURL },
    },
    // One engine is enough: this only smoke-tests the two public pages.
    {
      name: 'chromium',
      testMatch: '**/*.e2e.test.ts',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Reuses a dev server you already have running; starts one otherwise.
  webServer: {
    // Locally, Doppler injects secrets. CI has no Doppler and needs none —
    // every integration in src/env.ts is optional, so the app boots without.
    command: process.env.CI ? 'pnpm dev' : 'doppler run -- pnpm dev',
    /**
     * The fake generator, always.
     *
     * These specs assert that the loop works — a turn is offered, a choice is
     * recorded, canon grows — not that the model writes well. A real model call
     * makes them slow enough to blow the 30s test timeout, which is exactly what
     * happened locally: CI has no `OPENAI_API_KEY` and so was quietly already
     * running the fake, while anyone with Doppler's dev config saw a failure CI
     * could never reproduce.
     *
     * It also stops a browser smoke test spending real money every time someone
     * runs it.
     */
    env: { BRAMBLE_AI_MODE: 'fake' },
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
