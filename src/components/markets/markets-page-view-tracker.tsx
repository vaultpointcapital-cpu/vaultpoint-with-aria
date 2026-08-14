'use client';

import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics/track';

/**
 * markets/page.tsx is a server component, so page-view tracking needs a
 * tiny client child rather than an effect in the page itself. Fires once
 * per mount (i.e. once per navigation to this page) — not gated by
 * sessionStorage like SessionTracker, since a page view should count
 * every visit, not just the first one in a session.
 */
export function MarketsPageViewTracker({ hasPositions }: { hasPositions: boolean }) {
  useEffect(() => {
    trackEvent('markets_page_viewed', { hasPositions });
  }, [hasPositions]);

  return null;
}
