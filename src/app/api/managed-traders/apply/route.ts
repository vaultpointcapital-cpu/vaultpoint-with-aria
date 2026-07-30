import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { applyAsManagedTraderSchema } from '@/lib/validations/managed-traders';
import { resolveKycVendor } from '@/lib/kyc/routing';
import { getOrCreateKycVerificationRow } from '@/lib/kyc/verification-state';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/managed-traders/apply
 *
 * Managed Trader Pathway PRD, Sprints 1–2. Creates a 'pending'
 * application — status can only ever move to approved/rejected via the
 * admin review route (service-role write there too), never set by this
 * route or any client input. See
 * 20260725000000_add_managed_trader_pathway.sql's RLS comment for why
 * this writes via the service client rather than a client-permissioned
 * insert.
 *
 * Also kicks off the same KYC flow Managed Accounts uses (Sprint 2 —
 * 20260726000000_extend_managed_trader_application.sql generalized
 * kyc_verifications to support this) for the questionnaire's Section A
 * identity/sanctions check, rather than building separate ID-upload
 * infra.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = applyAsManagedTraderSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid trader application.', parsed.error.flatten());
  }

  const admin = createServiceClient();

  const { data: existing } = await admin
    .from('managed_traders')
    .select('id, status')
    .eq('user_id', authData.user.id)
    .in('status', ['pending', 'approved'])
    .maybeSingle();

  if (existing) {
    return apiError(
      'VALIDATION_ERROR',
      existing.status === 'approved'
        ? 'You are already an approved managed trader.'
        : 'You already have a trader application pending review.'
    );
  }

  const { data: profile } = await admin.from('users').select('country_code').eq('id', authData.user.id).single();

  const now = new Date().toISOString();
  const { data, error } = await admin
    .from('managed_traders')
    .insert({
      user_id: authData.user.id,
      status: 'pending',
      trailing_90d_return: null,
      max_drawdown: null,
      academy_modules_confirmed: parsed.data.academy_modules_confirmed,
      proposed_profit_split: parsed.data.proposed_profit_split,
      approved_profit_split: null,
      max_clients: parsed.data.max_clients ?? null,
      strategy_description: parsed.data.strategy_description,
      has_managed_funds_before: parsed.data.has_managed_funds_before,
      has_managed_funds_before_explanation: parsed.data.has_managed_funds_before_explanation ?? null,
      understands_trade_only_confirmed_at: now,
      agrees_to_audit_logging_confirmed_at: now,
      reviewer_notes: null,
      reviewed_by: null,
      reviewed_at: null,
    })
    .select('id, status, proposed_profit_split, max_clients, created_at')
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not submit your trader application.');
  }

  await getOrCreateKycVerificationRow({
    userId: authData.user.id,
    managedTraderId: data.id,
    vendor: resolveKycVendor(profile?.country_code),
  });

  return apiSuccess({ trader: data }, 201);
}
