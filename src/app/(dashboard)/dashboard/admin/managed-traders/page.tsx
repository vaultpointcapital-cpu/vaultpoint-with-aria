import { redirect } from 'next/navigation';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { AdminTraderReviewDashboard } from '@/components/managed-traders/admin-trader-review-dashboard';

export default async function AdminManagedTradersPage() {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();

  if (!authData.user) {
    return null;
  }
  if (!(await isAdmin(supabase, authData.user.id))) {
    redirect('/dashboard');
  }

  const admin = createServiceClient();

  const { data: traders } = await admin
    .from('managed_traders')
    .select(
      'id, user_id, status, proposed_profit_split, approved_profit_split, max_clients, academy_modules_confirmed, strategy_description, has_managed_funds_before, has_managed_funds_before_explanation, understands_trade_only_confirmed_at, agrees_to_audit_logging_confirmed_at, reviewer_notes, created_at, reviewed_at'
    )
    .order('created_at', { ascending: false });

  const rows = await Promise.all(
    (traders ?? []).map(async (trader) => {
      const [{ data: profile }, { data: kyc }] = await Promise.all([
        admin.from('users').select('full_name').eq('id', trader.user_id).maybeSingle(),
        admin
          .from('kyc_verifications')
          .select('state, vendor, decided_at')
          .eq('managed_trader_id', trader.id)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

      return {
        trader,
        applicantName: profile?.full_name ?? null,
        kycState: kyc?.state ?? 'not_started',
        kycVendor: kyc?.vendor ?? null,
      };
    })
  );

  return <AdminTraderReviewDashboard rows={rows} />;
}
