import { env } from '@/env';

/**
 * Clerk is only usable when both halves of the key pair are present. Everything
 * else asks this rather than re-reading process.env, so "is auth configured" is
 * one decision made in one place.
 */
export const clerkEnabled = Boolean(env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && env.CLERK_SECRET_KEY);
