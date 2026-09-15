import { clerkMiddleware } from '@clerk/nextjs/server';
import type { NextFetchEvent, NextRequest } from 'next/server';
import { clerkEnabled } from '@/lib/services/auth/auth.config';

// Next 16 renamed `middleware` to `proxy`. The runtime is always nodejs here and
// cannot be configured.
//
// The API is deliberately NOT proxied — see the matcher. Every route handler
// authenticates itself through src/lib/services/auth/auth.service.ts, which is
// what Next's own proxy docs ask for: "Always verify authentication and
// authorization inside each Server Function rather than relying on Proxy alone."
// It also guarantees a bearer client can never be handed a redirect or a Clerk
// handshake where it expects a 401.
//
// clerkMiddleware still runs for page routes so Clerk's server context exists
// once a ClerkProvider and signed-in pages appear. Page protection belongs in
// the callback below; there is nothing to protect yet.
const withClerk = clerkMiddleware(async () => {});

export function proxy(req: NextRequest, event: NextFetchEvent) {
  if (!clerkEnabled) return;
  return withClerk(req, event);
}

export const config = {
  matcher: [
    // Page routes only: skip Next internals, static files, and the API.
    '/((?!api|trpc|_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
  ],
};
