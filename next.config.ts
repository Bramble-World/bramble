import type { NextConfig } from 'next';
import { withSentryConfig } from '@sentry/nextjs';

const nextConfig: NextConfig = {
  experimental: {
    serverActions: {
      // A Server Action body is capped at 1MB by default, which a real message
      // export clears easily. Raised so the file reaches the action and can be
      // rejected with a message that says what is wrong, rather than failing at
      // the framework boundary with one that does not.
      bodySizeLimit: '20mb',
    },
  },
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
