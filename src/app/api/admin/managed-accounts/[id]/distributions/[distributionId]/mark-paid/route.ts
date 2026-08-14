import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { createNotification } from '@/lib/managed-accounts/notifications';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/admin/managed-accounts/:id/distributions/:distributionId/mark-paid
 * Nothing else in this codebase ever moves a profit_distributions row
 * out of 'pending' — no payout rail is integrated (see the withdraw
 * route's own comment), so an admin manually confirms a payout actually
 * went out. Without this route, every withdrawal request would stay
 * 'pending' forever with no way to close the loop; this is a genuine
 * gap-closer, not a nice-to-have. Fires the distribution_paid
 * notification the client sees on their dashboard.
 */
export async function POST(_request: Request, { params }: { params: { id: string; distributionId: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  if (!(await isAdmin(supabase, authData.user.id))) {
    return apiError('FORBIDDEN', 'Admin access required.');
  }

  const admin = createServiceClient();

  const { data: distribution } = await admin
    .from('profit_distributions')
    .select('id, managed_account_id, status, client_share')
    .eq('id', params.distributionId)
    .eq('managed_account_id', params.id)
    .maybeSingle();

  if (!distribution) {
    return apiError('NOT_FOUND', 'Distribution not found for this account.');
  }

  if (distribution.status === 'paid') {
    return apiError('VALIDATION_ERROR', 'This distribution has already been marked paid.');
  }

  const { data: account } = await admin
    .from('managed_accounts')
    .select('id, user_id')
    .eq('id', params.id)
    .single();

  if (!account) {
    return apiError('NOT_FOUND', 'Managed account not found.');
  }

  const now = new Date().toISOString();
  const { data: updated, error } = await admin
    .from('profit_distributions')
    .update({ status: 'paid', confirmed_at: now, paid_at: now })
    .eq('id', distribution.id)
    .select()
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not mark this distribution as paid.');
  }

  await createNotification(admin, {
    userId: account.user_id,
    managedAccountId: account.id,
    type: 'distribution_paid',
    title: 'Withdrawal paid',
    body: `Your withdrawal has been paid — net amount ${distribution.client_share.toLocaleString('en-US', { style: 'currency', currency: 'USD' })}.`,
  });

  return apiSuccess({ distribution: updated });
}
