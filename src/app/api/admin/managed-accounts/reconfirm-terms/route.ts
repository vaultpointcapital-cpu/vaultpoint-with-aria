import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

const reconfirmTermsSchema = z.object({
  tier: z.enum(['bronze', 'silver', 'gold']),
});

/**
 * POST /api/admin/managed-accounts/reconfirm-terms
 * MANAGED_TIER_TERMS is a compile-time constant (see
 * validations/managed-accounts.ts) — there is no per-account "terms
 * version" stored anywhere, so nothing can automatically detect "this
 * account's terms are now stale" the moment a deploy changes the
 * numbers. This route is the honest alternative: an admin who just
 * shipped a tier-terms change calls this for the affected tier, and it
 * flips requires_disclosure_reconfirmation on every active account of
 * that tier. Deliberately manual and tier-scoped, not silently
 * automatic — the spec's own requirement is that reconfirmation is
 * never skipped, not that detection is automatic.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  if (!(await isAdmin(supabase, authData.user.id))) {
    return apiError('FORBIDDEN', 'Admin access required.');
  }

  const body = await request.json();
  const parsed = reconfirmTermsSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid request.', parsed.error.flatten());
  }

  const admin = createServiceClient();

  const { data, error } = await admin
    .from('managed_accounts')
    .update({ requires_disclosure_reconfirmation: true })
    .eq('tier', parsed.data.tier)
    .eq('status', 'active')
    .select('id');

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not flag accounts for reconfirmation.');
  }

  return apiSuccess({ flaggedAccountCount: data.length });
}
