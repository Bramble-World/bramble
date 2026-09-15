import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server';
import type { NextFetchEvent, NextRequest } from 'next/server';

// Next 16 renamed `middleware` to `proxy`. The runtime is always `nodejs` here
// and cannot be configured.

const isProtectedRoute = createRouteMatcher(['/dashboard(.*)', '/settings(.*)', '/profile(.*)']);

const clerkEnabled = Boolean(
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY
);

const withClerk = clerkMiddleware(async (auth, req) => {
  if (isProtectedRoute(req)) {
    await auth.protect();
  }
});

export function proxy(req: NextRequest, event: NextFetchEvent) {
  // Until Clerk keys are set, every request passes straight through, so the
  // landing page and the venture demo run on a bare checkout.
  if (!clerkEnabled) return;
  return withClerk(req, event);
}

export const config = {
  matcher: [
    // Skip Next.js internals and all static files, unless found in search params
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API routes
    '/(api|trpc)(.*)',
  ],
};
