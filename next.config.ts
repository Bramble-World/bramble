import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  /* config options here */
};

// Only run the Sentry build plugin once a DSN is configured, so a keyless
// checkout still builds without source-map upload warnings.
export default process.env.NEXT_PUBLIC_SENTRY_DSN
  ? withSentryConfig(nextConfig, {
      org: 'okonkwo-industries',
      project: 'bramble',
      // Only print logs for uploading source maps in CI
      silent: !process.env.CI,
    })
  : nextConfig;
