import '@testing-library/jest-dom/vitest';

// Keep unit tests independent of a real `.env` — `@/env` is validated at import
// time, so anything importing it would otherwise depend on the local machine.
vi.mock('@/env', () => ({
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://localhost:5432/bramble_test',
    NEXT_PUBLIC_POSTHOG_KEY: undefined,
    NEXT_PUBLIC_POSTHOG_HOST: 'https://posthog.test',
    NEXT_PUBLIC_SENTRY_DSN: undefined,
    NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
  },
}));
