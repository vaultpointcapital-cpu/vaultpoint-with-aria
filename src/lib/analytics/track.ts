'use client';

import { createClient } from '@/lib/supabase/client';

/**
 * Fire-and-forget feature-engagement event logging (public.usage_events —
 * see that migration's header for why this is first-party rather than a
 * vendor SDK). Never throws or blocks the caller: a failed analytics
 * write must never break the actual user-facing action it's attached to,
 * same principle as alert_delivery.py's delivery functions returning
 * false instead of raising.
 */
export function trackEvent(eventName: string, properties: Record<string, unknown> = {}): void {
  void (async () => {
    try {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData.user) return;

      await supabase.from('usage_events').insert({
        user_id: authData.user.id,
        event_name: eventName,
        properties,
      });
    } catch {
      // Analytics is never allowed to surface an error to the user.
    }
  })();
}
