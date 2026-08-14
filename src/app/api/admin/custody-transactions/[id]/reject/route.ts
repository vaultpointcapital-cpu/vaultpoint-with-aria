import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { rejectCustodyTransactionSchema } from '@/lib/validations/custody';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/admin/custody-transactions/:id/reject
 *
 * Marks a pending_review withdrawal as rejected — no Cobo withdrawal
 * call ever fires for this row. The wallet was already debited when the
 * withdrawal was confirmed (POST /api/wallet/withdraw/confirm runs the
 * debit before attempting the payout) — a rejection here needs manual
 * ops follow-up to reverse that debit, same as every other
 * payout-attempt failure this codebase's wallet flow already treats as
 * a 'processing' row for manual handling, not an automatic reversal.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const body = await request.json().catch(() => null);
  const parsed = rejectCustodyTransactionSchema.safeParse(body);
  if (!parsed.success) return apiError('VALIDATION_ERROR', 'A reason is required.', parsed.error.flatten());

  const admin = createServiceClient();

  const { data: transaction } = await admin
    .from('custody_transactions')
    .select('id, status')
    .eq('id', params.id)
    .maybeSingle();
  if (!transaction) return apiError('NOT_FOUND', 'Custody transaction not found.');
  if (transaction.status !== 'pending_review') {
    return apiError('VALIDATION_ERROR', `Cannot reject a transaction with status "${transaction.status}".`);
  }

  const { data: updated, error } = await admin
    .from('custody_transactions')
    .update({ status: 'failed' })
    .eq('id', transaction.id)
    .select('*')
    .single();

  if (error || !updated) return apiError('INTERNAL_ERROR', 'Could not reject this transaction.');

  return apiSuccess({ transaction: updated });
}
