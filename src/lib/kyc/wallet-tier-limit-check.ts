import { createServiceClient } from '@/lib/supabase/server';

/**
 * Thin wrapper around the wallet_check_kyc_limit RPC
 * (20260814000000_add_wallet_kyc_tiering.sql). Called from
 * /api/wallet/deposit/initiate and /api/wallet/withdraw/request before any
 * provider call — complements, does not replace, checkWalletLimit()'s
 * static per-currency min/max in src/lib/wallet/limits.ts.
 */
export async function checkKycTierLimit(params: {
  userId: string;
  type: 'deposit' | 'withdrawal';
  amount: number;
  currency: string;
}): Promise<{ allowed: true } | { allowed: false; reasonCode: string; message: string }> {
  const supabase = createServiceClient();

  const { data, error } = await supabase
    .rpc('wallet_check_kyc_limit', {
      p_user_id: params.userId,
      p_type: params.type,
      p_amount: params.amount,
      p_currency: params.currency,
    })
    .single();

  if (error || !data) {
    throw new Error(`wallet_check_kyc_limit failed: ${error?.message}`);
  }

  if (data.allowed) return { allowed: true };

  return {
    allowed: false,
    reasonCode: data.reason_code ?? 'limit_exceeded',
    message: data.message ?? 'This action is not available at your current KYC tier.',
  };
}
