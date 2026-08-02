import { createServiceClient } from '@/lib/supabase/server';

/**
 * Placeholder crypto (USDT-TRC20) rail adapter — see the compliance flag in
 * supabase/migrations/20260802000000_add_wallet.sql. Nothing in this file
 * performs real blockchain custody: no private key generation, no HSM, no
 * on-chain broadcast. Both functions exist so the wallet API routes have a
 * stable interface to call, with a real custodian/off-ramp vendor integration
 * swapped in behind it before this ever handles real funds.
 */

const PLACEHOLDER_CHAIN = 'TRC20';

/**
 * Returns the user's existing deposit address, or "generates" one — in
 * this placeholder, a deterministic non-functional stand-in, never a real
 * wallet address with a spendable private key anywhere in this codebase.
 */
export async function getOrCreateDepositAddress(userId: string): Promise<{ address: string; chain: string }> {
  const supabase = createServiceClient();

  const { data: existing } = await supabase
    .from('wallet_web3_deposit_addresses')
    .select('address, chain')
    .eq('user_id', userId)
    .eq('chain', PLACEHOLDER_CHAIN)
    .maybeSingle();

  if (existing) {
    return { address: existing.address, chain: existing.chain };
  }

  // NOT a real address — placeholder only, pending a real custodian
  // integration. Never send real funds to this value.
  const placeholderAddress = `PLACEHOLDER-${PLACEHOLDER_CHAIN}-${userId.slice(0, 8)}`;

  const { error } = await supabase.from('wallet_web3_deposit_addresses').insert({
    user_id: userId,
    chain: PLACEHOLDER_CHAIN,
    address: placeholderAddress,
  });
  if (error) throw error;

  return { address: placeholderAddress, chain: PLACEHOLDER_CHAIN };
}

/**
 * Placeholder for executing a crypto withdrawal payout. Throws rather than
 * silently no-op — there is no real off-ramp/custodian vendor wired up yet
 * (PRD's off-ramp partner decision is explicitly unresolved, see
 * docs/web3-payments/wallet-integration-spec.md). Wallet withdrawal
 * confirmation catches this and leaves the withdrawal_requests row in
 * 'processing' for manual/ops handling, same as managed_accounts' existing
 * no-real-payout-rail withdrawal flow.
 */
export async function initiateCryptoPayout(_params: {
  amount: number;
  destinationAddress: string;
  reference: string;
}): Promise<never> {
  throw new Error(
    'Crypto withdrawal payouts are not yet wired to a real off-ramp/custodian — requires a vendor decision before this can execute a real on-chain payout.'
  );
}
