'use client';

import { useEffect } from 'react';
import * as Sentry from '@sentry/nextjs';

/**
 * Next.js App Router's special file for errors that escape the root
 * layout itself — the only error boundary that can't rely on the normal
 * (dashboard)/(auth) layouts still being mounted, so it renders its own
 * complete <html>/<body>. Also closes the Sentry setup gap flagged by
 * `next build` ("It seems like you don't have a global error handler set
 * up") — without this file, React render errors above the layout tree
 * never reach Sentry at all, regardless of instrumentation.ts.
 */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="en" className="dark">
      <body>
        <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10">
            <span className="font-display text-2xl font-bold text-accent">V</span>
          </div>
          <div>
            <h1 className="font-display text-xl font-semibold text-text-primary">Something went wrong</h1>
            <p className="mx-auto mt-2 max-w-sm text-sm text-text-secondary">
              An unexpected error occurred. Try reloading the page — if it keeps happening, contact
              support@vaultpoint.name.ng.
            </p>
          </div>
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent/90"
          >
            Reload
          </button>
        </div>
      </body>
    </html>
  );
}
