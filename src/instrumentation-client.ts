import posthog from 'posthog-js';
import * as Sentry from '@sentry/nextjs';

// PostHog throws on an undefined key, so only start it once one is configured.
// Production builds have no key, and the privacy policy (src/app/privacy) says
// the website runs no analytics. Setting one means updating that page first.
if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    capture_pageview: false, // Handled manually so SPA navigations are counted once
    capture_pageleave: true,
    defaults: '2025-11-30',
  });
}

// With no DSN set, `init` is a no-op and Sentry stays disabled.
// No session replay and no IP: the privacy policy promises website visitors
// errors only, with nothing that identifies them.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: false,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  enableLogs: true,
});

// This export will instrument router navigations
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
