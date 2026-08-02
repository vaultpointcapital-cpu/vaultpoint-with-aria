import { createClient } from '@/lib/supabase/server';
import { calculateNetWorth, calculateTotalPnl, excludeSimulatedPositions } from '@/lib/utils/financial';
import { isOfferAvailableForRegion } from '@/lib/offers/routing';
import { DashboardClient } from '@/components/dashboard/dashboard-client';

export default async function DashboardPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    // Layout already redirects unauthenticated users; this is a type
    // guard for the fetches below, not a real runtime path.
    return null;
  }

  const [
    positionsResult,
    manualAssetsResult,
    podsResult,
    brokerConnectionsResult,
    snapshotsResult,
    dailyVideoResult,
    profileResult,
    offersResult,
  ] = await Promise.all([
    supabase
      .from('positions')
      .select('*, broker_connections(account_type)')
      .eq('user_id', authData.user.id),
    supabase.from('manual_assets').select('*').eq('user_id', authData.user.id),
    supabase
      .from('savings_pods')
      .select('*')
      .eq('user_id', authData.user.id)
      .neq('status', 'archived'),
    supabase
      .from('broker_connections')
      .select('id, broker, label, sync_status')
      .eq('user_id', authData.user.id),
    // Written once daily by the (not-yet-deployed) Python service's
    // snapshot job — may be empty for a brand new user, which is a
    // "no history yet" state, not an error.
    supabase
      .from('portfolio_snapshots')
      .select('*')
      .eq('user_id', authData.user.id)
      .order('snapshot_date', { ascending: true }),
    // Shared content, not per-user — exactly one active row expected at
    // a time (see supabase/migrations/20260716000002_add_academy_videos.sql).
    supabase
      .from('academy_videos')
      .select('*')
      .eq('video_type', 'daily_short')
      .eq('is_active', true)
      .limit(1)
      .maybeSingle(),
    supabase.from('users').select('country_code').eq('id', authData.user.id).single(),
    // Partner Offers v1 — same query GET /api/offers runs, done server-side
    // here since this page already SSRs every other piece of dashboard data.
    supabase
      .from('partner_offers')
      .select('id, partner_slug, program, account_size_usd, price_from_usd, ref_url, affiliate_code, regions_allowed')
      .eq('active', true),
  ]);

  const positions = positionsResult.data ?? [];
  const manualAssets = manualAssetsResult.data ?? [];
  const pods = podsResult.data ?? [];
  const brokerConnections = brokerConnectionsResult.data ?? [];
  const snapshots = snapshotsResult.data ?? [];
  const dailyVideo = dailyVideoResult.data ?? null;
  const offers = (offersResult.data ?? [])
    .filter((offer) => isOfferAvailableForRegion(offer, profileResult.data?.country_code))
    .map((offer) => ({
      id: offer.id,
      partner: offer.partner_slug,
      program: offer.program,
      account_size_usd: offer.account_size_usd,
      price_from_usd: offer.price_from_usd,
      affiliate_code: offer.affiliate_code,
    }));

  const netWorthEligiblePositions = excludeSimulatedPositions(positions);
  const netWorth = calculateNetWorth(netWorthEligiblePositions, manualAssets);
  const totalUnrealizedPnl = calculateTotalPnl(netWorthEligiblePositions);

  return (
    <DashboardClient
      initialNetWorth={netWorth}
      initialPnl={totalUnrealizedPnl}
      initialPositions={positions}
      initialPods={pods}
      initialSnapshots={snapshots}
      dailyVideo={dailyVideo}
      hasConnectedBroker={brokerConnections.length > 0}
      offers={offers}
    />
  );
}
