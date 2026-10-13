import * as Sentry from '@sentry/nextjs';

// With no DSN set, `init` is a no-op and Sentry stays disabled.
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Off: the privacy policy says error reports carry no IP address, cookies or
  // request headers, and import requests carry conversations.
  sendDefaultPii: false,
  // Capture 100% in dev, 10% in production
  // Adjust based on your traffic volume
  tracesSampleRate: process.env.NODE_ENV === 'development' ? 1.0 : 0.1,
  // Enable logs to be sent to Sentry
  enableLogs: true,
});
