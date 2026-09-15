import posthog from 'posthog-js';
import * as Sentry from '@sentry/nextjs';
import { replayIntegration } from '@sentry/nextjs';

// PostHog throws on an undefined key, so only start it once one is configured.
if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    capture_pageview: false, // Handled manually so SPA navigations are counted once
    capture_pageleave: true,
    defaults: '2025-11-30',
  });
}

// With no DSN set, `init` is a no-op and Sentry stays disabled.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  sendDefaultPii: true,
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  enableLogs: true,
  integrations: [
    replayIntegration({
      maskAllText: true,
      blockAllMedia: true,
    }),
  ],
  // Record 10% of all sessions, 100% of sessions with errors
  replaysSessionSampleRate: 0.1,
  replaysOnErrorSampleRate: 1.0,
});

// This export will instrument router navigations
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
