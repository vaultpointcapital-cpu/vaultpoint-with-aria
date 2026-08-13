import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { createTierContractVersionSchema } from '@/lib/validations/tier-contracts';
import { createTierContractVersion } from '@/lib/tier-contracts/admin';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/admin/tier-contracts
 *
 * Creates a new tier_contract version — the only sanctioned write path
 * for the Tier Contract data (see
 * supabase/migrations/20260815000002_add_tier_contracts.sql). Never
 * updates an active row in place; create_tier_contract_version() always
 * inserts a new row and flips the prior active one to 'superseded'.
 * created_by is set from the authenticated admin's own session, never
 * accepted from the request body — an admin shouldn't be able to spoof
 * who made a change.
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
  const parsed = createTierContractVersionSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid tier contract version.', parsed.error.flatten());
  }

  const admin = createServiceClient();

  try {
    const { tierContractId, version } = await createTierContractVersion(admin, {
      tierName: parsed.data.tierName,
      priceNgn: parsed.data.priceNgn,
      priceUsd: parsed.data.priceUsd,
      effectiveDate: parsed.data.effectiveDate,
      createdBy: authData.user.email ?? authData.user.id,
      changeReason: parsed.data.changeReason,
      commitments: parsed.data.commitments.map((c) => ({
        commitmentKey: c.commitmentKey,
        commitmentDescription: c.commitmentDescription,
        commitmentType: c.commitmentType,
        measurable: c.measurable,
        metricKey: c.metricKey,
      })),
    });

    return apiSuccess({ tierContractId, version }, 201);
  } catch (err) {
    console.error('[admin/tier-contracts] create_tier_contract_version failed:', err);
    return apiError('INTERNAL_ERROR', 'Could not create the new tier contract version.');
  }
}
