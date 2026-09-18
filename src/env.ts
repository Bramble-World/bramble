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
    // Clerk. Optional so a bare checkout still builds; the auth service turns
    // "absent" into a 401 rather than letting Clerk throw a raw 500.
    CLERK_SECRET_KEY: z.string().startsWith('sk_').optional(),
    // PEM public key from the Clerk dashboard. When set, session JWTs are
    // verified in-process instead of fetching JWKS over the network per request.
    CLERK_JWT_KEY: z.string().optional(),
    // Svix signing secret for the Clerk webhook. Optional: without it the
    // webhook route rejects everything, which is the correct closed default.
    CLERK_WEBHOOK_SIGNING_SECRET: z.string().startsWith('whsec_').optional(),
  },

  /**
   * Client-side environment variables schema.
   * Must be prefixed with NEXT_PUBLIC_.
   */
  client: {
    NEXT_PUBLIC_APP_URL: z.url().default('http://localhost:3000'),
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().startsWith('pk_').optional(),
  },

  /**
   * Runtime environment variables.
   * These are validated at runtime on the client.
   */
  runtimeEnv: {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    CLERK_SECRET_KEY: process.env.CLERK_SECRET_KEY,
    CLERK_JWT_KEY: process.env.CLERK_JWT_KEY,
    CLERK_WEBHOOK_SIGNING_SECRET: process.env.CLERK_WEBHOOK_SIGNING_SECRET,
    NEXT_PUBLIC_APP_URL: process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
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
