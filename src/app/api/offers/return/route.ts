import { NextResponse, type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';

const REFERRAL_EXPIRY_DAYS = 30;

/**
 * GET /api/offers/return?vp_ref=...
 *
 * NOT a Hantec-initiated callback — Hantec has zero technical integration
 * with VaultPoint (that's the point of "refer, don't resell"). This route
 * is only ever reached by the user clicking a link *we* control (the
 * offer card's own interstitial "I've created my account →" button) after
 * they return from Hantec's site in a separate tab. Public, no auth guard
 * — same shape as src/app/auth/callback/route.ts: read a query param, do a
 * service-role lookup, always end in a redirect. Unknown/expired token →
 * redirect silently, no error leak, no enumeration.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = new URL(request.url);
  const token = searchParams.get('vp_ref');

  if (!token) {
    return NextResponse.redirect(`${origin}/dashboard/brokers/add`);
  }

  const supabase = createServiceClient();
  const { data: referral } = await supabase
    .from('partner_referrals')
    .select('id, user_id, status, clicked_at')
    .eq('state_token', token)
    .maybeSingle();

  const clickedTooLongAgo =
    referral && Date.now() - new Date(referral.clicked_at).getTime() > REFERRAL_EXPIRY_DAYS * 24 * 60 * 60 * 1000;

  if (!referral || referral.status === 'expired' || clickedTooLongAgo) {
    return NextResponse.redirect(`${origin}/dashboard/brokers/add`);
  }

  // Already connected from a prior visit to this same link — nothing left
  // to do, send them to their existing connection instead of back through
  // the connect flow.
  if (referral.status === 'connected') {
    return NextResponse.redirect(`${origin}/dashboard/brokers`);
  }

  if (referral.status === 'clicked') {
    await supabase
      .from('partner_referrals')
      .update({ status: 'returned', returned_at: new Date().toISOString() })
      .eq('id', referral.id);

    await supabase.from('usage_events').insert({
      user_id: referral.user_id,
      event_name: 'offer_returned',
      properties: { referral_id: referral.id },
    });
  }

  return NextResponse.redirect(`${origin}/dashboard/connect/hantec?vp_ref=${token}`);
}
