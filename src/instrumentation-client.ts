import posthog from 'posthog-js';
import * as Sentry from '@sentry/nextjs';

// PostHog throws on an undefined key, so only start it once one is configured.
//
// Pageviews and the events we name, nothing more. Each setting below is a promise
// the privacy policy's "Our website" section makes, so change them together:
// `persistence: 'memory'` is what makes it cookieless (and is why a visitor is new
// on every page load), and autocapture and recording stay off so that nothing a
// visitor reads or types is ever sent.
if (process.env.NEXT_PUBLIC_POSTHOG_KEY) {
  posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
    api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST,
    defaults: '2025-11-30',
    persistence: 'memory',
    autocapture: false,
    disable_session_recording: true,
    disable_surveys: true,
    capture_pageview: 'history_change',
    capture_pageleave: true,
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
