const withSerwist = require('@serwist/next').default({
  swSrc: 'src/app/sw.ts',
  swDest: 'public/sw.js',
  // Disabled entirely in development, per instruction — a stale SW
  // intercepting requests during local dev is a worse experience than no
  // SW at all, and Serwist's own Turbopack support is still incomplete.
  disable: process.env.NODE_ENV === 'development',
  // Replaces @serwist/next's default behavior of auto-precaching every
  // file under public/ (which would include public/icons/*, contradicting
  // "precache only build assets plus /offline" — those icons are meant to
  // be StaleWhileRevalidate RUNTIME-cached instead, see src/app/sw.ts).
  // The webpack-compiled JS/CSS build assets are still precached
  // automatically regardless of this option — only the public/ folder
  // auto-scan is what gets replaced.
  //
  // revision is a hand-set string, not a content hash, because /offline
  // is a plain Next.js page, not a webpack-fingerprinted asset — bump it
  // whenever /offline's content changes materially, or Serwist will keep
  // serving an already-cached copy across deploys.
  additionalPrecacheEntries: [{ url: '/offline', revision: 'v1' }],
});

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

const { withSentryConfig } = require('@sentry/nextjs');

// Sentry wraps the OUTSIDE of withSerwist, per Sentry's own documented
// convention — its build-time instrumentation needs to see the final
// compiled output, not have Serwist wrap around it afterward.
//
// org/project/authToken are all read from env and every one of them is
// currently unset (no Sentry project exists yet — see
// src/instrumentation.ts's own comment). withSentryConfig degrades
// gracefully without them: source-map upload is silently skipped, the
// rest of the build proceeds normally. silent:true keeps that skip quiet
// instead of a wall of "not configured" warnings on every build.
module.exports = withSentryConfig(withSerwist(nextConfig), {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: true,
  widenClientFileUpload: true,
  treeshake: { removeDebugLogging: true },
});
