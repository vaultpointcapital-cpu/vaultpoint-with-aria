import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { getFeatureCustodyProvider } from '@/lib/custody/provider';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/admin/custody-transactions/:id/approve
 *
 * The "multi-party approval on your side" spec 4.3.4 asks for — the
 * only place a pending_review withdrawal's real Cobo withdrawal call
 * ever fires. Cobo's own MPC already prevents unilateral key
 * compromise; this is the independent, VaultPoint-side control.
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const provider = getFeatureCustodyProvider();
  if (!provider) return apiError('INTERNAL_ERROR', 'Crypto custody is not enabled.');

  const admin = createServiceClient();

  const { data: transaction } = await admin.from('custody_transactions').select('*').eq('id', params.id).maybeSingle();
  if (!transaction) return apiError('NOT_FOUND', 'Custody transaction not found.');
  if (transaction.direction !== 'withdrawal') {
    return apiError('VALIDATION_ERROR', 'Only withdrawals can be approved.');
  }
  if (transaction.status !== 'pending_review') {
    return apiError('VALIDATION_ERROR', `Cannot approve a transaction with status "${transaction.status}".`);
  }
  if (!transaction.destination_address) {
    return apiError('INTERNAL_ERROR', 'This transaction has no destination address on file.');
  }

  const { data: account } = await admin
    .from('custody_accounts')
    .select('chain')
    .eq('id', transaction.custody_account_id)
    .maybeSingle();
  if (!account) return apiError('INTERNAL_ERROR', 'Could not resolve the custody account for this transaction.');

  try {
    const result = await provider.initiateWithdrawal({
      chain: account.chain,
      asset: transaction.asset,
      amount: transaction.amount,
      destinationAddress: transaction.destination_address,
    });

    const { data: updated, error } = await admin
      .from('custody_transactions')
      .update({ status: 'confirmed', provider_tx_id: result.providerTxId, confirmed_at: new Date().toISOString() })
      .eq('id', transaction.id)
      .select('*')
      .single();

    if (error || !updated) return apiError('INTERNAL_ERROR', 'Withdrawal was submitted but the ledger could not be updated.');

    return apiSuccess({ transaction: updated });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await admin.from('custody_transactions').update({ status: 'failed' }).eq('id', transaction.id);
    return apiError('PAYMENT_ERROR', `Cobo withdrawal failed: ${message}`);
  }
}
