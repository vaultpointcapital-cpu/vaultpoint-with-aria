import * as Sentry from '@sentry/nextjs';

/**
 * Server + edge runtime Sentry init, via Next.js's instrumentation hook
 * (stable since 14.1, no experimental flag needed on 14.2). Replaces the
 * older sentry.server.config.ts/sentry.edge.config.ts pair — see
 * src/instrumentation-client.ts for the browser-side counterpart.
 *
 * NEXT_PUBLIC_SENTRY_DSN is currently unset in every environment (no
 * Sentry project has been created yet) — Sentry.init() with an empty/
 * undefined dsn is a documented, safe no-op: every capture call below
 * (and everywhere else in the app) silently does nothing rather than
 * throwing. Real error monitoring activates the moment a real DSN is
 * set, with no code change required.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: 0.1,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      release: process.env.VERCEL_GIT_COMMIT_SHA,
    });
  }

  if (process.env.NEXT_RUNTIME === 'edge') {
    Sentry.init({
      dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
      tracesSampleRate: 0.1,
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
      release: process.env.VERCEL_GIT_COMMIT_SHA,
    });
  }
}

export const onRequestError = Sentry.captureRequestError;
