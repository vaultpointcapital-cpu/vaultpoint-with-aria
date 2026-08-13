import { createServiceClient } from '@/lib/supabase/server';
import { getFeatureCustodyProvider } from '@/lib/custody/provider';

/**
 * Crypto (USDT-TRC20) rail adapter — see the compliance flag in
 * supabase/migrations/20260802000000_add_wallet.sql. Branches on
 * getFeatureCustodyProvider(): a real provider (Cobo) present means real
 * custody, backed by custody_accounts/custody_transactions
 * (20260818000001_add_crypto_custody_infrastructure.sql); absent (the
 * default) means the exact placeholder behavior this file always had —
 * a non-functional stand-in address and a throwing payout — so nothing
 * about existing behavior changes until COBO_INTEGRATION_ENABLED is
 * deliberately turned on. See src/lib/custody/cobo-adapter.ts's module
 * docstring for why that flag defaults off.
 */

const PLACEHOLDER_CHAIN = 'TRC20';
// The only chain/asset this wallet's crypto rail currently offers
// (CURRENCY_OPTIONS in deposit-dialog.tsx only lists 'USDT (TRC-20)') —
// hardcoded here for the same reason it's hardcoded in the UI, not a new
// limitation this file introduces.
const ASSET = 'USDT';

export interface DepositAddressResult {
  address: string;
  chain: string;
  /** True for the non-functional placeholder path — deposit-dialog.tsx uses this to decide whether to show the "do not send real funds" warning. */
  isPlaceholder: boolean;
}

/**
 * Returns the user's existing deposit address, or creates one. With no
 * real provider enabled, this is a deterministic non-functional
 * stand-in, never a real wallet address with a spendable private key
 * anywhere in this codebase.
 */
export async function getOrCreateDepositAddress(userId: string): Promise<DepositAddressResult> {
  const supabase = createServiceClient();
  const provider = getFeatureCustodyProvider();

  if (!provider) {
    const { data: existing } = await supabase
      .from('wallet_web3_deposit_addresses')
      .select('address, chain')
      .eq('user_id', userId)
      .eq('chain', PLACEHOLDER_CHAIN)
      .maybeSingle();

    if (existing) {
      return { address: existing.address, chain: existing.chain, isPlaceholder: true };
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

    return { address: placeholderAddress, chain: PLACEHOLDER_CHAIN, isPlaceholder: true };
  }

  const { data: existingAccount } = await supabase
    .from('custody_accounts')
    .select('deposit_address, chain')
    .eq('user_id', userId)
    .eq('provider', 'cobo')
    .eq('chain', PLACEHOLDER_CHAIN)
    .maybeSingle();

  if (existingAccount?.deposit_address) {
    return { address: existingAccount.deposit_address, chain: existingAccount.chain, isPlaceholder: false };
  }

  const result = await provider.getOrCreateDepositAddress({ userId, chain: PLACEHOLDER_CHAIN });

  const { error } = await supabase.from('custody_accounts').upsert(
    {
      user_id: userId,
      provider: 'cobo',
      provider_wallet_id: result.providerWalletId,
      deposit_address: result.address,
      chain: result.chain,
      status: 'active',
    },
    { onConflict: 'user_id,provider,chain' }
  );
  if (error) throw error;

  return { address: result.address, chain: result.chain, isPlaceholder: false };
}

export interface CryptoPayoutResult {
  status: 'submitted' | 'pending_review';
}

/**
 * Executes (or queues for review) a crypto withdrawal payout. With no
 * real provider enabled, throws exactly as before — the caller
 * (POST /api/wallet/withdraw/confirm) already catches this and leaves
 * the withdrawal in 'processing' for manual/ops follow-up, the same
 * self-reported/manual-confirmation pattern this file always documented.
 *
 * With a real provider enabled: creates a custody_transactions row
 * first, always. If the amount exceeds custody_settings
 * .withdrawal_review_hold_threshold_usd — or that threshold is unset,
 * fail-safe not fail-open — the row is left 'pending_review' and NO
 * Cobo withdrawal call fires; an admin must approve it via
 * POST /api/admin/custody-transactions/:id/approve (spec 4.3.4's
 * "multi-party approval on your side"). Otherwise the provider's
 * initiateWithdrawal is called immediately.
 */
export async function initiateCryptoPayout(params: {
  userId: string;
  amount: number;
  destinationAddress: string;
  reference: string;
}): Promise<CryptoPayoutResult> {
  const provider = getFeatureCustodyProvider();

  if (!provider) {
    throw new Error(
      'Crypto withdrawal payouts are not yet wired to a real off-ramp/custodian — requires a vendor decision before this can execute a real on-chain payout.'
    );
  }

  const supabase = createServiceClient();

  const { data: account } = await supabase
    .from('custody_accounts')
    .select('id')
    .eq('user_id', params.userId)
    .eq('provider', 'cobo')
    .eq('chain', PLACEHOLDER_CHAIN)
    .maybeSingle();
  if (!account) {
    throw new Error('No custody account on file for this user — a deposit address must be issued before a withdrawal can be made.');
  }

  const { data: settings } = await supabase
    .from('custody_settings')
    .select('withdrawal_review_hold_threshold_usd')
    .eq('id', 1)
    .single();
  const threshold = settings?.withdrawal_review_hold_threshold_usd;
  const needsReview = threshold === null || threshold === undefined || params.amount > threshold;

  if (needsReview) {
    const { error } = await supabase.from('custody_transactions').insert({
      custody_account_id: account.id,
      direction: 'withdrawal',
      amount: params.amount,
      asset: ASSET,
      provider_tx_id: null,
      status: 'pending_review',
      confirmed_at: null,
      ledger_entry_id: null,
    });
    if (error) throw error;
    return { status: 'pending_review' };
  }

  const result = await provider.initiateWithdrawal({
    chain: PLACEHOLDER_CHAIN,
    asset: ASSET,
    amount: params.amount,
    destinationAddress: params.destinationAddress,
  });

  const { error } = await supabase.from('custody_transactions').insert({
    custody_account_id: account.id,
    direction: 'withdrawal',
    amount: params.amount,
    asset: ASSET,
    provider_tx_id: result.providerTxId,
    status: 'confirmed',
    confirmed_at: new Date().toISOString(),
    ledger_entry_id: null,
  });
  if (error) throw error;

  return { status: 'submitted' };
}
