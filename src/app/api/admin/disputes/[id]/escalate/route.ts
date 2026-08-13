import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { escalateDisputeSchema } from '@/lib/validations/disputes';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import type { DisputeTier } from '@/types/database';

/**
 * POST /api/admin/disputes/:id/escalate
 *
 * "Every tier change is a new row state, not an overwrite — full history
 * preserved per dispute" (spec section 3). Inserts a new row at tier+1
 * linked via parent_dispute_id, and flips the current row to
 * status='escalated' — never mutates tier in place.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const body = await request.json().catch(() => null);
  const parsed = escalateDisputeSchema.safeParse(body);
  if (!parsed.success) return apiError('VALIDATION_ERROR', 'Invalid escalation request.', parsed.error.flatten());

  const admin = createServiceClient();

  const { data: current } = await admin.from('disputes').select('*').eq('id', params.id).maybeSingle();
  if (!current) return apiError('NOT_FOUND', 'Dispute not found.');
  if (current.status !== 'open') {
    return apiError('VALIDATION_ERROR', `Cannot escalate a dispute with status "${current.status}".`);
  }
  if (current.tier >= 4) {
    return apiError('VALIDATION_ERROR', 'This dispute is already at Tier 4 — no further escalation tier exists.');
  }

  const nextTier = (current.tier + 1) as DisputeTier;
  const { data: settings } = await admin
    .from('dispute_settings')
    .select('tier2_support_owner_name, tier4_legal_contact')
    .eq('id', 1)
    .single();

  const REVIEWER_BY_TIER: Record<DisputeTier, string> = {
    1: 'Self-service',
    2: settings?.tier2_support_owner_name ?? 'Support (unassigned)',
    3: 'Founder/Compliance',
    4: settings?.tier4_legal_contact ?? 'Legal counsel (unassigned)',
  };

  const { data: escalated, error: insertError } = await admin
    .from('disputes')
    .insert({
      parent_dispute_id: current.id,
      user_id: current.user_id,
      managed_account_id: current.managed_account_id,
      managed_sub_account_id: current.managed_sub_account_id,
      tier: nextTier,
      status: 'open',
      category: current.category,
      linked_event_ids: current.linked_event_ids,
      opened_at: new Date().toISOString(),
      acknowledged_at: null,
      resolved_at: null,
      resolution_summary: null,
      resolution_amount_ngn: null,
      reviewer: REVIEWER_BY_TIER[nextTier],
      escalated_from_tier: current.tier,
      escalation_reason: parsed.data.escalationReason,
      sla_alert_sent_at: null,
    })
    .select('*')
    .single();

  if (insertError || !escalated) {
    return apiError('INTERNAL_ERROR', 'Could not escalate this dispute.');
  }

  const { error: updateError } = await admin.from('disputes').update({ status: 'escalated' }).eq('id', current.id);
  if (updateError) {
    return apiError('INTERNAL_ERROR', 'Escalated dispute was created, but the prior tier could not be marked escalated.');
  }

  return apiSuccess({ dispute: escalated }, 201);
}
