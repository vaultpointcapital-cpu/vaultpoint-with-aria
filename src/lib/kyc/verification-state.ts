import { createServiceClient } from '@/lib/supabase/server';
import type { KycVendor, KycVerification, KycVerificationState } from '@/types/database';

/**
 * The single writer for KYC state, per spec §1/§4: managed_accounts.kyc_status
 * stays the fast CHECK-constraint gate, but this module (invoked only from
 * service-role contexts — the vendor webhook routes) is the only thing
 * ever allowed to move it to 'verified'. Nothing else in the codebase
 * should update that column directly.
 */

const TERMINAL_STATES: readonly KycVerificationState[] = ['verified', 'rejected', 'expired'];

/**
 * Creates the 'not_started' row a client's KYC step should have before
 * they're handed off to the vendor (spec §5.1/§5.2 step 1). Idempotent
 * against the one-active-per-account partial unique index: if an
 * active (pending/processing/verified) row already exists for this
 * account, that row is returned instead of erroring, since a client
 * re-entering the KYC step shouldn't spawn a second parallel attempt.
 */
export async function getOrCreateKycVerificationRow(params: {
  userId: string;
  managedAccountId: string;
  vendor: KycVendor;
}): Promise<KycVerification> {
  const supabase = createServiceClient();

  const { data: existing } = await supabase
    .from('kyc_verifications')
    .select('*')
    .eq('managed_account_id', params.managedAccountId)
    .in('state', ['pending', 'processing', 'verified'])
    .maybeSingle();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('kyc_verifications')
    .insert({
      user_id: params.userId,
      managed_account_id: params.managedAccountId,
      vendor: params.vendor,
      state: 'not_started',
      vendor_ref: null,
      result_summary: null,
      failure_reason: null,
      submitted_at: null,
      decided_at: null,
      expires_at: null,
    })
    .select('*')
    .single();

  if (error) {
    // Race: another request created the active row between our select
    // and insert — re-fetch rather than surface a spurious 500.
    if (error.code === '23505') {
      const { data: raced } = await supabase
        .from('kyc_verifications')
        .select('*')
        .eq('managed_account_id', params.managedAccountId)
        .in('state', ['pending', 'processing', 'verified'])
        .maybeSingle();
      if (raced) return raced;
    }
    throw new Error(`Failed to create KYC verification row: ${error.message}`);
  }

  return created;
}

/**
 * Applies a vendor decision to a kyc_verifications row and, when the
 * decision is 'verified', syncs managed_accounts.kyc_status /
 * kyc_verified_at in the same call — this is the fix for the gap
 * flagged on that column ("nothing in this codebase can set it to
 * 'verified' automatically yet").
 *
 * One-directional state machine (spec §7): a row already in a terminal
 * state (verified/rejected/expired) is never overwritten by an incoming
 * non-terminal or different-terminal update — a late/reordered webhook
 * delivery cannot flip a verified account back to processing. Redelivery
 * of the SAME terminal decision is a no-op, not an error.
 */
export async function applyKycDecision(params: {
  vendor: KycVendor;
  vendorRef: string;
  userId: string;
  managedAccountId: string | null;
  decision: KycVerificationState;
  resultSummary?: Record<string, unknown> | null;
  failureReason?: string | null;
  expiresAt?: string | null;
}): Promise<void> {
  const supabase = createServiceClient();

  const { data: existing } = await supabase
    .from('kyc_verifications')
    .select('*')
    .eq('vendor', params.vendor)
    .eq('vendor_ref', params.vendorRef)
    .maybeSingle();

  if (existing && TERMINAL_STATES.includes(existing.state)) {
    if (existing.state === params.decision) return; // idempotent redelivery
    return; // late/out-of-order delivery attempting to override a terminal decision — dropped
  }

  const decidedAt = TERMINAL_STATES.includes(params.decision) ? new Date().toISOString() : null;

  if (existing) {
    const { error } = await supabase
      .from('kyc_verifications')
      .update({
        state: params.decision,
        result_summary: params.resultSummary ?? existing.result_summary,
        failure_reason: params.failureReason ?? null,
        decided_at: decidedAt,
        expires_at: params.expiresAt ?? existing.expires_at,
        updated_at: new Date().toISOString(),
      })
      .eq('id', existing.id);
    if (error) throw new Error(`Failed to update KYC verification row: ${error.message}`);
  } else {
    const { error } = await supabase.from('kyc_verifications').insert({
      user_id: params.userId,
      managed_account_id: params.managedAccountId,
      vendor: params.vendor,
      vendor_ref: params.vendorRef,
      state: params.decision,
      result_summary: params.resultSummary ?? null,
      failure_reason: params.failureReason ?? null,
      submitted_at: new Date().toISOString(),
      decided_at: decidedAt,
      expires_at: params.expiresAt ?? null,
    });
    if (error) throw new Error(`Failed to create KYC verification row from webhook: ${error.message}`);
  }

  if (params.decision === 'verified' && params.managedAccountId) {
    const { error } = await supabase
      .from('managed_accounts')
      .update({ kyc_status: 'verified', kyc_verified_at: new Date().toISOString() })
      .eq('id', params.managedAccountId);
    if (error) throw new Error(`Failed to sync managed_accounts.kyc_status: ${error.message}`);
  }

  if (params.decision === 'rejected' && params.managedAccountId) {
    const { error } = await supabase
      .from('managed_accounts')
      .update({ kyc_status: 'rejected' })
      .eq('id', params.managedAccountId);
    if (error) throw new Error(`Failed to sync managed_accounts.kyc_status: ${error.message}`);
  }
}

/**
 * The read side of the server-side gate (spec §6): true only if there is
 * a verified, non-expired kyc_verifications row for this account. Reads
 * the audit table directly rather than trusting managed_accounts.kyc_status
 * alone, so an expired verification can't silently keep gating open.
 */
export async function isKycVerifiedForAccount(managedAccountId: string): Promise<boolean> {
  const supabase = createServiceClient();
  const { data } = await supabase
    .from('kyc_verifications')
    .select('state, expires_at')
    .eq('managed_account_id', managedAccountId)
    .eq('state', 'verified')
    .maybeSingle();

  if (!data) return false;
  if (data.expires_at && new Date(data.expires_at).getTime() < Date.now()) return false;
  return true;
}
