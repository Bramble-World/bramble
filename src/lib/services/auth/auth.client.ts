import { createClerkClient } from '@clerk/nextjs/server';
import { env } from '@/env';

/**
 * Our own Clerk backend client rather than `clerkClient()` from the SDK.
 *
 * Two reasons. `clerkClient()` reads request-scoped headers set by the proxy,
 * which makes it unusable outside a request and awkward to test. And it never
 * forwards `jwtKey`, so it cannot verify a token without a JWKS round trip —
 * passing CLERK_JWT_KEY here makes session verification networkless.
 *
 * Constructing this with empty keys is safe: createClerkClient validates
 * nothing. The assertion happens inside authenticateRequest, which is why
 * auth.service guards on `clerkEnabled` before ever calling it.
 */
export const clerkBackend = createClerkClient({
  secretKey: env.CLERK_SECRET_KEY,
  publishableKey: env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY,
  jwtKey: env.CLERK_JWT_KEY,
});
