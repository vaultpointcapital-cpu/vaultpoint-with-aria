import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/types/database';

/**
 * Thin wrapper around the value_ledger_apply_event RPC
 * (20260815000000_add_value_ledger.sql). Callers pass a service-role
 * client (value_ledger_events has no client insert policy) and should
 * treat a failed emit as non-fatal — logged here, never thrown, so a
 * ledger-write failure never fails the caller's own primary action.
 */
export async function applyValueLedgerEvent(
  supabase: SupabaseClient<Database>,
  params: {
    userId: string;
    eventName: string;
    idempotencyKey: string;
    properties?: Record<string, unknown>;
    source?: string;
  }
): Promise<void> {
  const { error } = await supabase.rpc('value_ledger_apply_event', {
    p_user_id: params.userId,
    p_event_name: params.eventName,
    p_idempotency_key: params.idempotencyKey,
    p_properties: params.properties ?? {},
    p_source: params.source ?? 'app',
  });

  if (error) {
    console.error(`value_ledger: ${params.eventName} emit failed:`, error);
  }
}
