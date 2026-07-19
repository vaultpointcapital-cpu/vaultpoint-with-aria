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

// No Sentry (or any other) wrapper exists in this config yet — withSerwist
// is the only wrapper here, so there's no composition-order question to
// resolve. If Sentry's withSentryConfig is added later, it should wrap
// the OUTSIDE (module.exports = withSentryConfig(withSerwist(nextConfig), ...)),
// matching Sentry's own documented convention of being the outermost wrapper
// so its build-time instrumentation sees the final compiled output.
module.exports = withSerwist(nextConfig);
