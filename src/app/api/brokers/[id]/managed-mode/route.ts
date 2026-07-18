import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { managedModeOptInSchema } from '@/lib/validations/broker';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/brokers/:id/managed-mode
 * Opts an already trade-execution-enabled connection into Managed Mode
 * (autonomous execution — see
 * supabase/migrations/20260718000002_add_managed_mode.sql). This is the
 * one route in the app that sets managed_mode_consented_at, and it only
 * does so after this request's own validation passes — the timestamp is
 * never client-supplied.
 *
 * Gated to Elite tier here, in the API route, not just left to the UI —
 * a Pro user hitting this endpoint directly gets a clear error, not a
 * raw DB constraint violation (the CHECK constraint doesn't know about
 * subscription tier at all; that check only lives here and in
 * managed_mode.py's scheduler, which also re-verifies tier every cycle).
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data: profile } = await supabase
    .from('users')
    .select('subscription_tier')
    .eq('id', authData.user.id)
    .single();

  if (profile?.subscription_tier !== 'elite') {
    return apiError('FORBIDDEN', 'Managed Mode is available on the Elite plan only.');
  }

  const { data: connection, error: fetchError } = await supabase
    .from('broker_connections')
    .select('id, trade_execution_enabled')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (fetchError || !connection) {
    return apiError('NOT_FOUND', 'Broker connection not found or you do not have access to it.');
  }

  if (!connection.trade_execution_enabled) {
    return apiError(
      'VALIDATION_ERROR',
      'This connection must be authorized for trade execution before enabling Managed Mode.'
    );
  }

  const body = await request.json();
  const parsed = managedModeOptInSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid Managed Mode configuration.', parsed.error.flatten());
  }

  const { data, error } = await supabase
    .from('broker_connections')
    .update({
      managed_mode_enabled: true,
      managed_mode_risk_pct: parsed.data.riskPct,
      managed_mode_daily_loss_limit_pct: parsed.data.dailyLossLimitPct,
      managed_mode_consented_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .select(
      'id, broker, label, is_read_only, trade_execution_enabled, managed_mode_enabled, managed_mode_risk_pct, managed_mode_daily_loss_limit_pct, sync_status, last_synced_at, last_error, created_at'
    )
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not enable Managed Mode for this connection.');
  }

  return apiSuccess({ connection: data });
}

/**
 * DELETE /api/brokers/:id/managed-mode
 * Disables Managed Mode. This is the kill-switch's manual counterpart —
 * managed_mode.py's scheduler also flips this off automatically on a
 * daily-loss breach or a tier downgrade, but a user must always be able
 * to stop autonomous trading immediately themselves, without needing to
 * reconstruct why the scheduler might not have caught something yet.
 * Deliberately does not clear managed_mode_risk_pct/
 * managed_mode_daily_loss_limit_pct/managed_mode_consented_at — those
 * stay on the row so re-enabling doesn't require re-entering the same
 * numbers (though it does re-run this same POST route, which always
 * refreshes managed_mode_consented_at to a new timestamp).
 */
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { error } = await supabase
    .from('broker_connections')
    .update({ managed_mode_enabled: false })
    .eq('id', params.id)
    .eq('user_id', authData.user.id);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not disable Managed Mode for this connection.');
  }

  return apiSuccess({ disabled: true });
}
