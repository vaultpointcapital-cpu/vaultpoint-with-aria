import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { computeAccountStats, computeDistributionBreakdown, withdrawalRequestSchema } from '@/lib/validations/managed-accounts';
import { createNotification } from '@/lib/managed-accounts/notifications';
import { isStepUpApproved } from '@/lib/auth/step-up';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/managed-accounts/:id/withdraw
 * Step 4 of the withdrawal flow — creates the profit_distributions
 * request row. Recomputes the breakdown server-side from current data
 * rather than trusting whatever the client's preview screen showed (the
 * same "never trust client-submitted amounts" rule as
 * POST /api/managed-accounts/authorization re-checking the disclosure
 * gate). profit_distributions_one_per_account_per_period gives this
 * insert the same idempotency guard runProfitShareForUser relies on for
 * profit-share billing: a duplicate submit for the same day's period
 * fails the unique constraint rather than creating a second payout
 * obligation.
 *
 * This only creates a 'pending' request — no real payout rail (bank
 * transfer, broker withdrawal API) is wired up anywhere in this
 * codebase, matching the same self-reported/manual-confirmation pattern
 * already used for KYC and funding. An admin moves it to
 * confirmed/paid via the (not yet built, task #21) compliance
 * dashboard.
 *
 * full_closure additionally sets the account to 'closed' in the same
 * request — per the spec's own edge case, a client must be able to
 * withdraw principal and close out even mid-drawdown; nothing here
 * blocks that on drawdown grounds.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = withdrawalRequestSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid withdrawal request.', parsed.error.flatten());
  }

  const { data: account } = await supabase
    .from('managed_accounts')
    .select(
      'id, status, starting_capital, profit_split_pct, withdrawal_window_cadence, next_withdrawal_window_date, requires_disclosure_reconfirmation'
    )
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (!account) {
    return apiError('NOT_FOUND', 'Managed account not found or you do not have access to it.');
  }

  if (account.status !== 'active') {
    return apiError('VALIDATION_ERROR', 'Only an active managed account can request a withdrawal.');
  }

  if (account.requires_disclosure_reconfirmation) {
    return apiError('VALIDATION_ERROR', 'You must reconfirm the updated terms for this account before withdrawing.');
  }

  if (
    account.withdrawal_window_cadence !== 'on_demand' &&
    account.next_withdrawal_window_date &&
    new Date(account.next_withdrawal_window_date) > new Date()
  ) {
    return apiError(
      'VALIDATION_ERROR',
      `The next withdrawal window for this account opens ${account.next_withdrawal_window_date}.`
    );
  }

  const { withdrawalType, payoutMethod, stepUpApprovalId } = parsed.data;

  // Step-Up Auth Ticket 2 — highest-risk flow named explicitly in the
  // spec. Requires a step-up approval already resolved to 'approved' for
  // this exact user + action_type + account id; a prior initiate/confirm
  // for a different account, or one that's merely pending/denied/expired,
  // is rejected here. Known consequence, same as the KYC-gated funding
  // flow: a user with neither a registered device (Ticket 1) nor an
  // active TOTP enrollment (Ticket 3) has no way to ever produce an
  // 'approved' one — both are opt-in, so this gate isn't satisfiable for
  // every user until they set one up.
  const stepUpOk = await isStepUpApproved({
    userId: authData.user.id,
    approvalToken: stepUpApprovalId,
    actionType: 'withdrawal',
    resourceId: account.id,
  });
  if (!stepUpOk) {
    return apiError('VALIDATION_ERROR', 'This withdrawal requires a confirmed step-up approval.');
  }

  const [tradesResult, lastDistributionResult] = await Promise.all([
    supabase.from('managed_trades').select('realized_pnl, closed_at').eq('managed_account_id', account.id),
    supabase
      .from('profit_distributions')
      .select('period_end')
      .eq('managed_account_id', account.id)
      .eq('status', 'paid')
      .order('period_end', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);

  const trades = tradesResult.data ?? [];
  const periodStartDate = lastDistributionResult.data?.period_end ?? null;
  const stats = computeAccountStats(account.starting_capital ?? 0, trades, periodStartDate);

  if (withdrawalType === 'profit' && stats.pnlSinceLastDistribution <= 0) {
    return apiError('VALIDATION_ERROR', 'There is no profit available to withdraw since your last distribution.');
  }

  const breakdown = computeDistributionBreakdown(stats.pnlSinceLastDistribution, account.profit_split_pct);
  const periodStart = periodStartDate ?? new Date(0).toISOString().slice(0, 10);
  const periodEnd = new Date().toISOString().slice(0, 10);
  const now = new Date().toISOString();

  const { data: distribution, error: insertError } = await supabase
    .from('profit_distributions')
    .insert({
      managed_account_id: account.id,
      period_start: periodStart,
      period_end: periodEnd,
      gross_pnl: breakdown.grossPnl,
      client_share: breakdown.clientShare,
      vaultpoint_share: breakdown.vaultpointShare,
      payout_method: payoutMethod,
      status: 'pending',
      statement_pdf_url: null,
      requested_at: now,
      confirmed_at: null,
      paid_at: null,
    })
    .select()
    .single();

  if (insertError) {
    if (insertError.code === '23505') {
      return apiError(
        'VALIDATION_ERROR',
        'A withdrawal for this period has already been requested. Wait for it to be processed before requesting another.'
      );
    }
    return apiError('INTERNAL_ERROR', 'Could not create your withdrawal request.');
  }

  if (withdrawalType === 'full_closure') {
    const { error: closeError } = await supabase
      .from('managed_accounts')
      .update({ status: 'closed' })
      .eq('id', account.id)
      .eq('user_id', authData.user.id);

    if (closeError) {
      return apiError('INTERNAL_ERROR', 'Withdrawal was recorded but the account could not be closed. Contact support.');
    }
  }

  await createNotification(supabase, {
    userId: authData.user.id,
    managedAccountId: account.id,
    type: 'distribution_requested',
    title: 'Withdrawal requested',
    body: `Your ${withdrawalType === 'full_closure' ? 'account closure and full ' : ''}withdrawal request has been submitted and is pending review.`,
  });

  return apiSuccess({ distribution }, 201);
}
