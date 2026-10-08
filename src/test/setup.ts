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
    // Present so the common hashing path works; the test that covers the
    // missing-secret branch overrides this module locally.
    CONTACT_HASH_SECRET: 'test-contact-hash-secret-at-least-32-chars',
    // No key in unit tests, so getGenerator() resolves to the fake.
    OPENAI_API_KEY: undefined,
    BRAMBLE_AI_MODE: undefined,
    // No Redis in unit tests; the store throws without it, which is what the
    // test covering that branch asserts.
    REDIS_URL: undefined,
    // Present so the crypto tests have a key to work under. Exactly 32 bytes,
    // because the module refuses anything else rather than silently using a
    // weaker cipher.
    IMPORT_MASTER_KEY: Buffer.from('unit-test-import-master-key-32by', 'utf8').toString('base64'),
  },
}));
