import { createServiceClient } from '@/lib/supabase/server';
import { applyValueLedgerEvent } from '@/lib/value-ledger/events';
import type { KycTier, KycTierLimits, WalletKycTierVerification, WalletKycTierVerificationStatus } from '@/types/database';

/**
 * Single writer for the wallet KYC tier gate (users.kyc_tier /
 * wallet_kyc_tier_verifications), called only from service-role contexts
 * (the /api/kyc/* route handlers) — mirrors src/lib/kyc/verification-state.ts's
 * convention for the separate, incompatible Managed Accounts identity
 * system. These two modules never share a table or call each other.
 */

const TIER_ORDER: Record<KycTier, number> = { tier0: 0, tier1: 1, tier2: 2 };

const TERMINAL_STATUSES: readonly WalletKycTierVerificationStatus[] = ['verified', 'rejected', 'error'];

/**
 * Creates a 'pending' tier-verification-attempt row. Idempotent against the
 * one-active-per-user partial unique index: if an attempt already in
 * flight (pending/processing) exists for this user, that row is returned
 * instead of erroring — same race-handling shape as
 * getOrCreateKycVerificationRow.
 */
export async function startTierVerification(params: {
  userId: string;
  tier: 'tier1' | 'tier2';
  method: 'phone_email' | 'bvn_nin_liveness';
  provider: 'internal' | 'smileid' | 'youverify' | 'stub';
}): Promise<WalletKycTierVerification> {
  const supabase = createServiceClient();

  const { data: existing } = await supabase
    .from('wallet_kyc_tier_verifications')
    .select('*')
    .eq('user_id', params.userId)
    .in('status', ['pending', 'processing'])
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('wallet_kyc_tier_verifications')
    .insert({
      user_id: params.userId,
      tier: params.tier,
      method: params.method,
      provider: params.provider,
      status: 'pending',
      vendor_ref: null,
      result_summary: null,
      failure_reason: null,
    })
    .select('*')
    .single();

  if (error) {
    // Race: another request created the active row between our select and
    // insert — re-fetch rather than surface a spurious error.
    if (error.code === '23505') {
      const { data: raced } = await supabase
        .from('wallet_kyc_tier_verifications')
        .select('*')
        .eq('user_id', params.userId)
        .in('status', ['pending', 'processing'])
        .maybeSingle();
      if (raced) return raced;
    }
    throw new Error(`Failed to create wallet KYC tier verification row: ${error.message}`);
  }

  return created;
}

/**
 * Applies a decision to a tier-verification-attempt row and, on 'verified',
 * bumps users.kyc_tier / kyc_tier_verified_at — but only forward. A user
 * already at tier2 who somehow gets a delayed 'verified' decision for a
 * tier1 attempt never gets downgraded; this is a one-directional ratchet,
 * same spirit as verification-state.ts's one-directional terminal state
 * machine (never overwrite a "better" outcome with a "worse" or stale one).
 */
export async function applyTierDecision(params: {
  verificationId: string;
  decision: WalletKycTierVerificationStatus;
  vendorRef?: string | null;
  resultSummary?: Record<string, unknown> | null;
  failureReason?: string | null;
}): Promise<void> {
  const supabase = createServiceClient();

  const { data: existing, error: fetchError } = await supabase
    .from('wallet_kyc_tier_verifications')
    .select('*')
    .eq('id', params.verificationId)
    .single();

  if (fetchError || !existing) {
    throw new Error(`wallet_kyc_tier_verifications row not found: ${params.verificationId}`);
  }

  if (TERMINAL_STATUSES.includes(existing.status)) {
    if (existing.status === params.decision) return; // idempotent redelivery
    return; // late/out-of-order attempt to override a terminal decision — dropped
  }

  const decidedAt = TERMINAL_STATUSES.includes(params.decision) ? new Date().toISOString() : null;

  const { error: updateError } = await supabase
    .from('wallet_kyc_tier_verifications')
    .update({
      status: params.decision,
      vendor_ref: params.vendorRef ?? existing.vendor_ref,
      result_summary: params.resultSummary ?? existing.result_summary,
      failure_reason: params.failureReason ?? null,
      decided_at: decidedAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', existing.id);

  if (updateError) {
    throw new Error(`Failed to update wallet KYC tier verification row: ${updateError.message}`);
  }

  if (params.decision !== 'verified') return;

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('kyc_tier')
    .eq('id', existing.user_id)
    .single();

  if (userError || !user) {
    throw new Error(`Failed to read users.kyc_tier for ${existing.user_id}: ${userError?.message}`);
  }

  if (TIER_ORDER[existing.tier] <= TIER_ORDER[user.kyc_tier]) return; // already at or above this tier

  const { error: tierError } = await supabase
    .from('users')
    .update({ kyc_tier: existing.tier, kyc_tier_verified_at: new Date().toISOString() })
    .eq('id', existing.user_id);

  if (tierError) {
    throw new Error(`Failed to update users.kyc_tier for ${existing.user_id}: ${tierError.message}`);
  }

  // Value Ledger — feeds time_to_first_value_days. Keyed to this specific
  // verification attempt, so a re-verified/replayed decision can't double-emit.
  await applyValueLedgerEvent(supabase, {
    userId: existing.user_id,
    eventName: 'kyc_tier_upgraded',
    idempotencyKey: `kyc_tier_upgraded:${existing.id}`,
    properties: { tier: existing.tier },
    source: 'kyc',
  });
}

export async function getKycTierStatus(userId: string): Promise<{
  tier: KycTier;
  tierVerifiedAt: string | null;
  pendingVerification: WalletKycTierVerification | null;
  limits: KycTierLimits;
}> {
  const supabase = createServiceClient();

  const { data: user, error: userError } = await supabase
    .from('users')
    .select('kyc_tier, kyc_tier_verified_at')
    .eq('id', userId)
    .single();

  if (userError || !user) {
    throw new Error(`Failed to read KYC tier status for ${userId}: ${userError?.message}`);
  }

  const [{ data: pendingVerification }, { data: limits }] = await Promise.all([
    supabase
      .from('wallet_kyc_tier_verifications')
      .select('*')
      .eq('user_id', userId)
      .in('status', ['pending', 'processing'])
      .maybeSingle(),
    supabase.from('kyc_tier_limits').select('*').eq('tier', user.kyc_tier).single(),
  ]);

  if (!limits) {
    throw new Error(`No kyc_tier_limits row found for tier ${user.kyc_tier}`);
  }

  return {
    tier: user.kyc_tier,
    tierVerifiedAt: user.kyc_tier_verified_at,
    pendingVerification: pendingVerification ?? null,
    limits,
  };
}
