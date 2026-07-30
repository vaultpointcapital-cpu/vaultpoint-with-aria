import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET /api/managed-traders/:id
 *
 * Public (approved-only), per the PRD's API spec — for the client-facing
 * trader directory / profile screen. No auth check in this route at
 * all: RLS's "Anyone can view approved trader profiles" policy
 * (20260725000000_add_managed_trader_pathway.sql) is the actual
 * enforcement — a pending/rejected/suspended trader's row is simply
 * invisible to this query regardless of who's asking, so there's
 * nothing extra for the route to gate.
 *
 * NOTE: the PRD's questionnaire (Section B.10 "Describe your trading
 * strategy") expects a strategy-summary text to show on the trader
 * profile screen, but the given managed_traders schema has no column
 * for it — flagged, not silently invented. This response only returns
 * columns that actually exist.
 */
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const supabase = createClient();

  // managed_traders has two FKs to users (user_id and reviewed_by), so
  // PostgREST's embedded-resource shorthand (`users(full_name)`) is
  // ambiguous and errors — a separate query sidesteps that entirely.
  const { data: trader, error } = await supabase
    .from('managed_traders')
    .select('id, user_id, trailing_90d_return, max_drawdown, proposed_profit_split, approved_profit_split, max_clients, created_at, reviewed_at')
    .eq('id', params.id)
    .eq('status', 'approved')
    .maybeSingle();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load trader profile.');
  }
  if (!trader) {
    return apiError('NOT_FOUND', 'Trader not found.');
  }

  const [{ data: profile }, { count: clientCount }] = await Promise.all([
    supabase.from('users').select('full_name').eq('id', trader.user_id).maybeSingle(),
    supabase.from('managed_sub_accounts').select('id', { count: 'exact', head: true }).eq('trader_id', params.id).eq('status', 'active'),
  ]);

  return apiSuccess({
    trader: {
      id: trader.id,
      fullName: profile?.full_name ?? null,
      trailing90dReturn: trader.trailing_90d_return,
      maxDrawdown: trader.max_drawdown,
      profitSplitPct: trader.approved_profit_split ?? trader.proposed_profit_split,
      maxClients: trader.max_clients,
      activeClientCount: clientCount ?? 0,
      traderSince: trader.reviewed_at ?? trader.created_at,
    },
  });
}
