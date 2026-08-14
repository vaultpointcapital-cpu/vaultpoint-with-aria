import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { reviewManagedTraderSchema } from '@/lib/validations/managed-traders';
import { isKycVerifiedForTrader } from '@/lib/kyc/verification-state';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/admin/managed-traders/:id/review
 *
 * The manual-review gate from PRD §5.1 ("Manual review + approval — no
 * automatic qualification at launch") and the questionnaire's Section E
 * gate rule ("All checkboxes must be ticked before a trader profile can
 * go live... No partial approvals"). Only ever acts on a currently
 * 'pending' application — re-reviewing an already-decided one is
 * refused rather than silently allowed to overwrite a prior decision.
 *
 * Approval is hard-blocked unless KYC is verified (Section E's "KYC
 * verified" checkbox) and academy_modules_confirmed is true (Section
 * E's "Required Academy modules confirmed complete" checkbox) — matching
 * the questionnaire's own "no partial approvals" rule literally, not
 * just trusting the admin to have checked manually. Track-record
 * threshold and the sanctions-flag checkbox are NOT auto-gated here:
 * PRD Open Question #3-adjacent thresholds are unset by compliance, and
 * a sanctions flag is a judgment call from the KYC result_summary an
 * admin reviews, not a single boolean this route can mechanically check.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }
  if (!(await isAdmin(supabase, authData.user.id))) {
    return apiError('FORBIDDEN', 'Admin access required.');
  }

  const body = await request.json();
  const parsed = reviewManagedTraderSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid review submission.', parsed.error.flatten());
  }

  const admin = createServiceClient();

  const { data: trader } = await admin
    .from('managed_traders')
    .select('id, status, max_clients, academy_modules_confirmed')
    .eq('id', params.id)
    .maybeSingle();
  if (!trader) {
    return apiError('NOT_FOUND', 'Trader application not found.');
  }
  if (trader.status !== 'pending') {
    return apiError('VALIDATION_ERROR', `This application was already reviewed (status=${trader.status}).`);
  }

  if (parsed.data.status === 'approved') {
    const missing: string[] = [];
    if (!trader.academy_modules_confirmed) missing.push('required Academy modules not confirmed');
    if (!(await isKycVerifiedForTrader(params.id))) missing.push('KYC not verified');
    if (missing.length > 0) {
      return apiError('VALIDATION_ERROR', `Cannot approve — ${missing.join('; ')}.`);
    }
  }

  const { data, error } = await admin
    .from('managed_traders')
    .update({
      status: parsed.data.status,
      approved_profit_split: parsed.data.status === 'approved' ? (parsed.data.approved_profit_split ?? null) : null,
      // Preserve the trader's originally-proposed max_clients unless this
      // review explicitly overrides it — an admin submitting a review
      // without touching this field must not silently wipe it out.
      max_clients: parsed.data.max_clients ?? trader.max_clients,
      reviewer_notes: parsed.data.reviewer_notes ?? null,
      reviewed_by: authData.user.id,
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', params.id)
    .select('id, status, approved_profit_split, max_clients, reviewer_notes, reviewed_at')
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not save the review decision.');
  }

  return apiSuccess({ trader: data });
}
