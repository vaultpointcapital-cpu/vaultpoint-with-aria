import * as Sentry from '@sentry/nextjs';

/**
 * Browser-side Sentry init — see src/instrumentation.ts for the server/
 * edge counterpart and the note on why an unset DSN is a safe no-op.
 * NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA is auto-injected by Vercel for
 * Next.js projects specifically (no manual wiring needed) — this is what
 * gives Sentry release tagging without a separate release-creation step.
 */
Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.1,
  environment: process.env.NEXT_PUBLIC_VERCEL_ENV ?? process.env.NODE_ENV,
  release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA,
});

// Required export for Sentry to instrument App Router client-side
// navigations (route changes) as part of its performance tracing.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
