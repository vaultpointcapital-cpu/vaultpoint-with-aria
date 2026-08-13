import * as Sentry from '@sentry/nextjs';
import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { getFeatureCustodyProvider } from '@/lib/custody/provider';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET/POST /api/custody/cron/reconcile
 *
 * Hourly (see vercel.json), Bearer $CRON_SECRET gated, same shape as
 * /api/disputes/cron/sla-check. Sums confirmed custody_transactions per
 * (chain, asset) from VaultPoint's own ledger and compares against
 * CustodyProvider.getAccountBalance() — spec 4.4's "these are not
 * routine errors, they're financial integrity events," so a mismatch is
 * a Sentry captureMessage, not just a log line.
 */
const RECONCILIATION_TOLERANCE = 0.01;

export async function GET(request: NextRequest) {
  return runReconciliation(request);
}

export async function POST(request: NextRequest) {
  return runReconciliation(request);
}

async function runReconciliation(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (!cronSecret) {
    console.error('[custody/cron/reconcile] CRON_SECRET is not set.');
    return apiError('INTERNAL_ERROR', 'Reconciliation is not configured.');
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return apiError('UNAUTHORIZED', 'Invalid or missing cron secret.');
  }

  const provider = getFeatureCustodyProvider();
  if (!provider) {
    return apiSuccess({ checked: 0, mismatches: 0, note: 'Crypto custody is not enabled — nothing to reconcile.' });
  }

  const supabase = createServiceClient();

  const [accountsResult, transactionsResult] = await Promise.all([
    supabase.from('custody_accounts').select('id, chain').eq('provider', 'cobo'),
    supabase.from('custody_transactions').select('custody_account_id, direction, amount, asset').eq('status', 'confirmed'),
  ]);

  if (accountsResult.error || transactionsResult.error) {
    console.error('[custody/cron/reconcile] Could not load custody data:', accountsResult.error ?? transactionsResult.error);
    return apiError('INTERNAL_ERROR', 'Could not run reconciliation.');
  }

  const chainByAccountId = new Map((accountsResult.data ?? []).map((a) => [a.id, a.chain]));

  const ledgerTotals = new Map<string, number>();
  for (const tx of transactionsResult.data ?? []) {
    const chain = chainByAccountId.get(tx.custody_account_id);
    if (!chain) continue;
    const key = `${chain}:${tx.asset}`;
    const delta = tx.direction === 'deposit' ? tx.amount : -tx.amount;
    ledgerTotals.set(key, (ledgerTotals.get(key) ?? 0) + delta);
  }

  let checked = 0;
  let mismatches = 0;

  for (const [key, ledgerTotal] of ledgerTotals) {
    checked++;
    const [chain, asset] = key.split(':');
    try {
      const providerBalance = await provider.getAccountBalance({ chain, asset });
      const diff = Math.abs(providerBalance - ledgerTotal);
      if (diff > RECONCILIATION_TOLERANCE) {
        mismatches++;
        Sentry.captureMessage(`Custody reconciliation mismatch: ${key}`, {
          level: 'error',
          tags: { source: 'custody-reconcile', chain, asset },
          extra: { ledgerTotal, providerBalance, diff },
        });
      }
    } catch (err) {
      Sentry.captureException(err, { tags: { source: 'custody-reconcile', chain, asset } });
    }
  }

  return apiSuccess({ checked, mismatches });
}
