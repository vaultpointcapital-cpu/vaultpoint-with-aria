import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * DELETE /api/brokers/:id
 * Disconnects a broker connection.
 *
 * signal_actions.broker_connection_id has no ON DELETE clause (Postgres
 * default: NO ACTION) — a hard delete on a connection with any trade
 * history throws a foreign-key violation, and that history must never
 * be allowed to disappear anyway: it's the audit trail profit-share
 * billing and dispute resolution depend on (see
 * src/lib/billing/profit-share.ts). So this only hard-deletes a
 * connection with zero signal_actions rows (the common case — most
 * connections never execute a trade). One that DOES have history is
 * soft-disconnected instead: sync_status flips to 'disconnected' (a
 * value the Python poller and GET /api/brokers already filter out —
 * see scheduler.py's poll_all_connections and this route's sibling GET
 * handler — it just had no writer before this), every execution
 * capability flag is revoked, and stored credentials are wiped (no
 * longer needed once syncing and trading are both off, and there's no
 * reason to keep a decryptable API key around for a connection the user
 * asked to disconnect). Either path returns 200 with `deleted: true` —
 * the caller-facing contract ("this connection no longer appears in
 * your list") is identical either way; which one happened is an
 * internal detail, not something the UI needs to branch on.
 *
 * Known gap: a soft-disconnected MetaTrader connection's MetaApi cloud
 * terminal (metaapi_account_id/region) is not deprovisioned here — that
 * needs a real MetaApi API call this codebase doesn't make anywhere
 * yet. It stops being synced or traded (sync_status alone guarantees
 * that), but the cloud terminal itself keeps existing on MetaApi's
 * side. Flagged as a real follow-up, not silently assumed handled.
 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data: connection, error: fetchError } = await supabase
    .from('broker_connections')
    .select('id')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (fetchError || !connection) {
    return apiError('NOT_FOUND', 'Broker connection not found or you do not have access to it.');
  }

  const { data: history } = await supabase
    .from('signal_actions')
    .select('id')
    .eq('broker_connection_id', params.id)
    .limit(1)
    .maybeSingle();

  if (!history) {
    const { error } = await supabase.from('broker_connections').delete().eq('id', params.id).eq('user_id', authData.user.id);

    if (error) {
      return apiError('INTERNAL_ERROR', 'Could not disconnect broker.');
    }

    return apiSuccess({ deleted: true });
  }

  const { error } = await supabase
    .from('broker_connections')
    .update({
      sync_status: 'disconnected',
      is_read_only: true,
      trade_execution_enabled: false,
      managed_mode_enabled: false,
      encrypted_api_key: null,
      api_key_iv: null,
      encrypted_api_secret: null,
      api_secret_iv: null,
      encrypted_api_passphrase: null,
      api_passphrase_iv: null,
      encrypted_mt_password: null,
      mt_password_iv: null,
    })
    .eq('id', params.id)
    .eq('user_id', authData.user.id);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not disconnect broker.');
  }

  return apiSuccess({ deleted: true });
}
