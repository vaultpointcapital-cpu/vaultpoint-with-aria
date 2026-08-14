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
/**
 * Logs which mode (test/live/unset) each payment processor's secret key is
 * in, derived only from the key's own prefix — never the key value itself.
 * Exists because there's no code-level guard against a test key ending up
 * in Production or a live key in Preview (see .env.example's payments
 * section); this makes the actual runtime state visible in deploy logs
 * instead of silently trusting whatever was pasted into Vercel.
 */
function logPaymentProcessorModes() {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const stripeMode = !stripeKey ? 'UNSET' : stripeKey.startsWith('sk_live_') ? 'LIVE' : stripeKey.startsWith('sk_test_') ? 'TEST' : 'UNKNOWN_PREFIX';

  const paystackKey = process.env.PAYSTACK_SECRET_KEY;
  const paystackMode = !paystackKey ? 'UNSET' : paystackKey.startsWith('sk_live_') ? 'LIVE' : paystackKey.startsWith('sk_test_') ? 'TEST' : 'UNKNOWN_PREFIX';

  console.log(
    `[payment-processor-mode] stripe=${stripeMode} paystack=${paystackMode} vercelEnv=${process.env.VERCEL_ENV ?? 'local'}`
  );
}

export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    logPaymentProcessorModes();

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
