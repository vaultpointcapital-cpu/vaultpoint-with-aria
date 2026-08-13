import { redirect } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { ValueLedgerDashboard } from '@/components/admin/value-ledger-dashboard';

interface TierChangeProperties {
  fromTier?: string;
  toTier?: string;
}

export default async function ValueLedgerPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }

  if (!(await isAdmin(supabase, authData.user.id))) {
    redirect('/dashboard');
  }

  const admin = createServiceClient();

  // value_ledger_rollups has no select-own policy (service-role only),
  // so this page is the only reader — see 20260815000000_add_value_ledger.sql.
  const { data: latest } = await admin
    .from('value_ledger_rollups')
    .select('rollup_date')
    .order('rollup_date', { ascending: false })
    .limit(1)
    .maybeSingle();

  const rollupDate = latest?.rollup_date ?? null;

  const { data: rollupRows } = rollupDate
    ? await admin
        .from('value_ledger_rollups')
        .select('*')
        .eq('rollup_date', rollupDate)
        .order('churn_risk_score', { ascending: false })
    : { data: [] };

  const userIds = [...new Set((rollupRows ?? []).map((r) => r.user_id))];
  const { data: users } = userIds.length
    ? await admin.from('users').select('id, full_name, academy_student').in('id', userIds)
    : { data: [] };
  const usersById = new Map((users ?? []).map((u) => [u.id, u]));

  const rollups = (rollupRows ?? []).map((row) => ({
    ...row,
    user: usersById.get(row.user_id) ?? null,
  }));

  // Tier-conversion funnel — computed here from raw events rather than a
  // new SQL aggregate RPC, same "compute in TS over raw rows" pattern the
  // compliance dashboard already uses for its own summary stats.
  const since90d = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: tierChangeEvents } = await admin
    .from('value_ledger_events')
    .select('properties, created_at')
    .eq('event_name', 'tier_changed')
    .gte('created_at', since90d);

  const funnelCounts = new Map<string, number>();
  for (const event of tierChangeEvents ?? []) {
    const props = event.properties as TierChangeProperties;
    if (!props.fromTier || !props.toTier) continue;
    const key = `${props.fromTier} -> ${props.toTier}`;
    funnelCounts.set(key, (funnelCounts.get(key) ?? 0) + 1);
  }
  const funnel = [...funnelCounts.entries()]
    .map(([transition, count]) => ({ transition, count }))
    .sort((a, b) => b.count - a.count);

  return <ValueLedgerDashboard rows={rollups} rollupDate={rollupDate} funnel={funnel} />;
}
