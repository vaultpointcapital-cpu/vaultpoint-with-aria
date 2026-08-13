import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { createDisputeSchema, requiresImmediateAlert } from '@/lib/validations/disputes';
import { sendDisputeAlert } from '@/lib/disputes/alerts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/disputes
 *
 * Files a Tier 2 dispute (Tier 1 is self-service/informational and needs
 * no row — see the escalation spec section 2). `reviewer` defaults from
 * dispute_settings.tier2_support_owner_name, one of the spec's own "Open
 * Items for Pells to Fill In Before Build" — until that's set, disputes
 * still file correctly, just with a placeholder reviewer name, rather
 * than blocking dispute filing on that policy decision.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const body = await request.json().catch(() => null);
  const parsed = createDisputeSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid dispute request.', parsed.error.flatten());
  }
  const { managedAccountId, managedSubAccountId, category, escalationReason } = parsed.data;

  if (managedAccountId) {
    const { data: account } = await supabase
      .from('managed_accounts')
      .select('id')
      .eq('id', managedAccountId)
      .eq('user_id', authData.user.id)
      .maybeSingle();
    if (!account) return apiError('NOT_FOUND', 'Managed account not found or you do not have access to it.');
  }
  if (managedSubAccountId) {
    const { data: subAccount } = await supabase
      .from('managed_sub_accounts')
      .select('id')
      .eq('id', managedSubAccountId)
      .eq('client_user_id', authData.user.id)
      .maybeSingle();
    if (!subAccount) return apiError('NOT_FOUND', 'Managed sub-account not found or you do not have access to it.');
  }

  const admin = createServiceClient();

  const { data: settings } = await admin.from('dispute_settings').select('tier2_support_owner_name').eq('id', 1).single();

  const { data: dispute, error: insertError } = await admin
    .from('disputes')
    .insert({
      parent_dispute_id: null,
      user_id: authData.user.id,
      managed_account_id: managedAccountId ?? null,
      managed_sub_account_id: managedSubAccountId ?? null,
      tier: 2,
      status: 'open',
      category,
      linked_event_ids: [],
      opened_at: new Date().toISOString(),
      acknowledged_at: null,
      resolved_at: null,
      resolution_summary: null,
      resolution_amount_ngn: null,
      reviewer: settings?.tier2_support_owner_name ?? 'Support (unassigned)',
      escalated_from_tier: null,
      escalation_reason: escalationReason,
      sla_alert_sent_at: null,
    })
    .select('*')
    .single();

  if (insertError || !dispute) {
    return apiError('INTERNAL_ERROR', 'Could not file your dispute.');
  }

  if (requiresImmediateAlert(category, Boolean(managedAccountId || managedSubAccountId))) {
    await sendDisputeAlert({
      disputeId: dispute.id,
      reason: 'performance_category',
      summary: `Performance dispute opened by a managed account holder: "${escalationReason.slice(0, 200)}"`,
    });
  }

  return apiSuccess({ dispute }, 201);
}

/**
 * GET /api/disputes — the caller's own disputes, RLS-scoped (no
 * service-role needed — disputes has a "select own" policy).
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');

  const { data: disputes, error } = await supabase
    .from('disputes')
    .select('*')
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false });

  if (error) return apiError('INTERNAL_ERROR', 'Could not load your disputes.');

  return apiSuccess({ disputes: disputes ?? [] });
}
