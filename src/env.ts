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
    /**
     * Defaults to `production`, which is the only safe default rather than the
     * obvious one.
     *
     * `next dev` sets `development` itself and the test setup forces `test`, so
     * this default applies to exactly one case: a process started with NODE_ENV
     * unset — which is a standalone `node server.js` in a container. Defaulting
     * to `development` there would open `/lab`, whose only guard is this value,
     * as an unauthenticated and billed write surface. The Dockerfile pins
     * `production` as well; the default should not depend on it remembering to.
     */
    NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
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
    // HMAC key for persons.source_contact_ref. Optional like the rest so a bare
    // checkout builds, but hashing throws without it rather than silently
    // falling back to an unkeyed digest — see persons.contact.ts.
    CONTACT_HASH_SECRET: z.string().min(32).optional(),
    // OpenAI. Optional like the rest, so a bare checkout builds and CI runs with
    // no key at all — the generator falls back to a deterministic fake rather
    // than failing, which is what keeps the pipeline testable without spend.
    OPENAI_API_KEY: z.string().startsWith('sk-').optional(),
    // Forces the fake even when a key is present. For playing the loop end to
    // end without paying for it.
    BRAMBLE_AI_MODE: z.enum(['live', 'fake']).optional(),
    // Where transcripts wait, encrypted, between the import request and the
    // worker that reads them. Optional like the rest so a bare checkout builds;
    // the store throws a clear error rather than silently degrading, because the
    // degraded version of "hold this privately" is "hold this".
    REDIS_URL: z.string().optional(),
    /**
     * The master key that wraps every per-import data key, base64, 32 bytes.
     *
     * Deliberately a different secret from `REDIS_URL`: the whole point of
     * envelope encryption here is that Redis access alone reveals nothing, so a
     * key stored beside the credentials that reach it would buy nothing at all.
     */
    IMPORT_MASTER_KEY: z.string().optional(),
    /**
     * How many imports one worker process extracts at once.
     *
     * Each one is mostly waiting on a model call, so the ceiling is upstream
     * rate limits and the connection pool rather than CPU. Two is deliberately
     * timid: the account limit is three conversations ever, so queue depth comes
     * from many accounts arriving together, and that is answered better by
     * another replica than by one process holding more work it could lose.
     */
    IMPORT_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
    /**
     * The oldest macOS build this server will serve, or 0 to serve any.
     *
     * A number rather than a version string: builds are monotonic and directly
     * comparable, where "1.10" against "1.9" needs a parser and an argument
     * about semantics.
     *
     * Defaults to 0, so the gate is off everywhere that has not set it. A
     * misconfiguration here locks out every client at once, so the failure mode
     * has to be "serve everyone" rather than "serve nobody".
     */
    MIN_MACOS_BUILD: z.coerce.number().int().min(0).default(0),
    /**
     * The shared code beta testers type to reach the macOS download.
     *
     * Optional so a checkout builds without it, and the page says the beta is
     * not open yet rather than 500ing. Compared server-side only: a code the
     * browser could see is not a gate.
     *
     * One code for everyone, which bounds what it can be worth — see
     * `src/app/download/actions.ts` for what this does and does not protect.
     */
    BETA_ACCESS_CODE: z.string().min(6).optional(),
    /**
     * Where the signed macOS build lives.
     *
     * Deliberately server-side (no `NEXT_PUBLIC_`), so it is never inlined into
     * the client bundle. It reaches the browser only after a correct code, which
     * is the only reason the code means anything.
     */
    MACOS_DOWNLOAD_URL: z.url().optional(),
    /** Shown beside the download, e.g. "0.3.1 (beta)". Cosmetic. */
    MACOS_BUILD_LABEL: z.string().optional(),
    /**
     * PostHog, for server-side product events.
     *
     * Optional, and absent is the normal case: local development, the test
     * suites and CI all run without it and send nothing, because the analytics
     * module picks a no-op sink when there is no token. Nothing anywhere has to
     * remember to disable it.
     *
     * Deliberately not `NEXT_PUBLIC_` — this is the server's own client, separate
     * from the browser's `NEXT_PUBLIC_POSTHOG_KEY`. Server events exist because
     * they cannot be blocked by an ad blocker or a firewall and they happen at
     * the moment the thing happens.
     */
    POSTHOG_PROJECT_TOKEN: z.string().optional(),
    POSTHOG_HOST: z.url().optional(),
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
    CONTACT_HASH_SECRET: process.env.CONTACT_HASH_SECRET,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    BRAMBLE_AI_MODE: process.env.BRAMBLE_AI_MODE,
    REDIS_URL: process.env.REDIS_URL,
    IMPORT_MASTER_KEY: process.env.IMPORT_MASTER_KEY,
    IMPORT_WORKER_CONCURRENCY: process.env.IMPORT_WORKER_CONCURRENCY,
    MIN_MACOS_BUILD: process.env.MIN_MACOS_BUILD,
    BETA_ACCESS_CODE: process.env.BETA_ACCESS_CODE,
    MACOS_DOWNLOAD_URL: process.env.MACOS_DOWNLOAD_URL,
    MACOS_BUILD_LABEL: process.env.MACOS_BUILD_LABEL,
    POSTHOG_PROJECT_TOKEN: process.env.POSTHOG_PROJECT_TOKEN,
    POSTHOG_HOST: process.env.POSTHOG_HOST,
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
