import { createEnv } from '@t3-oss/env-nextjs';
import { z } from 'zod';

/**
 * Every integration is optional so the marketing site and the venture demo keep
 * building and running with no `.env` at all. Tighten a field to `.min(1)` (or
 * drop the `.optional()`) as soon as a surface actually depends on it — that
 * turns a runtime 500 into a build-time error.
 */
export const env = createEnv({
  /**
   * Server-side environment variables schema.
   * These are not exposed to the client.
   */
  server: {
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().optional(),
  },

  /**
   * Client-side environment variables schema.
   * Must be prefixed with NEXT_PUBLIC_.
   */
  client: {
    NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
  },

  /**
   * Runtime environment variables.
   * These are validated at runtime on the client.
   */
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
  },

  /**
   * Skip validation in certain environments.
   */
  skipValidation: !!process.env.SKIP_ENV_VALIDATION,

  /**
   * Treat empty strings as undefined.
   */
  emptyStringAsUndefined: true,
});
