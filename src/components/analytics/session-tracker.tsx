'use client';

import { useEffect } from 'react';
import { trackEvent } from '@/lib/analytics/track';

const SESSION_FLAG_KEY = 'vp_session_tracked';

/**
 * Fires exactly one `session_started` event per browser session (guarded
 * by sessionStorage, which clears when the tab/browser closes — a page
 * refresh or internal navigation does NOT re-fire this). Mounted once in
 * the dashboard layout so every authenticated area of the app is covered
 * without instrumenting each page individually.
 */
export function SessionTracker() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.sessionStorage.getItem(SESSION_FLAG_KEY)) return;

    window.sessionStorage.setItem(SESSION_FLAG_KEY, '1');
    trackEvent('session_started');
  }, []);

  return null;
}
