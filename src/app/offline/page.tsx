import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'You’re offline — VaultPoint',
};

/**
 * The service worker's fallback for any failed document request (see
 * src/app/sw.ts's `fallbacks` config) — precached at build time so it
 * renders even with zero network connectivity. Deliberately shows no
 * financial data of any kind, cached or otherwise: a stale balance or
 * position shown without a clear "this may be out of date" caveat would
 * be actively misleading for a finance app.
 */
export default function OfflinePage() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/10">
        <span className="font-display text-2xl font-bold text-accent">V</span>
      </div>
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">You&apos;re offline</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-text-secondary">
          VaultPoint needs a connection to show live data. Reconnect and try again.
        </p>
      </div>
    </div>
  );
}
