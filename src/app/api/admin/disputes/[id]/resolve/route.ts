import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { resolveDisputeSchema } from '@/lib/validations/disputes';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/admin/disputes/:id/resolve
 *
 * Sets status to 'resolved'/'closed' with a resolution summary and,
 * optionally, a refund/adjustment amount. For a Tier 3 dispute
 * authorizing a nonzero amount, this route IS the spec's Non-Negotiable
 * #2 gate ("Tier 3 refund authority threshold must be set as an explicit
 * number before launch — 'case by case' is not a policy SEC Nigeria can
 * audit"): blocked entirely while dispute_settings.tier3_max_authorization_ngn
 * is unset, and blocked above that threshold regardless — both cases
 * require escalating to Tier 4 instead, never a silent override here.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const body = await request.json().catch(() => null);
  const parsed = resolveDisputeSchema.safeParse(body);
  if (!parsed.success) return apiError('VALIDATION_ERROR', 'Invalid resolution request.', parsed.error.flatten());
  const { status, resolutionSummary, resolutionAmountNgn } = parsed.data;

  const admin = createServiceClient();

  const { data: dispute } = await admin.from('disputes').select('*').eq('id', params.id).maybeSingle();
  if (!dispute) return apiError('NOT_FOUND', 'Dispute not found.');
  if (dispute.status !== 'open') {
    return apiError('VALIDATION_ERROR', `Cannot resolve a dispute with status "${dispute.status}".`);
  }

  const authorizingRefund = dispute.tier === 3 && (resolutionAmountNgn ?? 0) > 0;
  if (authorizingRefund) {
    const { data: settings } = await admin
      .from('dispute_settings')
      .select('tier3_max_authorization_ngn')
      .eq('id', 1)
      .single();
    const threshold = settings?.tier3_max_authorization_ngn ?? null;

    if (threshold === null) {
      return apiError(
        'FORBIDDEN',
        'Tier 3 refund/adjustment authorization threshold is not configured yet — set it under dispute settings before resolving refund-bearing disputes, or escalate to Tier 4.'
      );
    }
    if (resolutionAmountNgn! > threshold) {
      return apiError(
        'FORBIDDEN',
        `Requested amount (₦${resolutionAmountNgn}) exceeds the Tier 3 authorization threshold (₦${threshold}) — escalate to Tier 4 for documented sign-off.`
      );
    }
  }

  const { data: updated, error } = await admin
    .from('disputes')
    .update({
      status,
      resolved_at: new Date().toISOString(),
      resolution_summary: resolutionSummary,
      resolution_amount_ngn: resolutionAmountNgn ?? null,
    })
    .eq('id', dispute.id)
    .select('*')
    .single();

  if (error || !updated) return apiError('INTERNAL_ERROR', 'Could not resolve this dispute.');

  return apiSuccess({ dispute: updated });
}
