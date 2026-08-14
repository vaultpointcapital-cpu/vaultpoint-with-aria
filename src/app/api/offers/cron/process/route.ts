import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email/send';
import { OfferNudgeEmailTemplate } from '@/lib/email/templates/offer-nudge';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

const NUDGE_THRESHOLDS_HOURS = [24, 72]; // index === nudges_sent already sent
const EXPIRY_DAYS = 30;

/**
 * POST /api/offers/cron/process
 *
 * Combines the nudge and expiry jobs into one route (not two) to stay
 * within a likely 2-cron-job Hobby-plan budget — one slot is already used
 * by /api/billing/profit-share/run. Threshold-based, not exact-window
 * (clicked_at <= now() - Nh), so it's correct regardless of how coarse the
 * actual cron invocation frequency ends up being — see vercel.json.
 *
 * Same Authorization: Bearer $CRON_SECRET convention as
 * profit-share/run/route.ts, for the same reason (Vercel Cron sends this
 * header automatically).
 */
export async function GET(request: NextRequest) {
  return processOffers(request);
}

export async function POST(request: NextRequest) {
  return processOffers(request);
}

async function processOffers(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (!cronSecret) {
    console.error('[offers/cron/process] CRON_SECRET is not set.');
    return apiError('INTERNAL_ERROR', 'Offer reminders are not configured.');
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return apiError('UNAUTHORIZED', 'Invalid or missing cron secret.');
  }

  const supabase = createServiceClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const now = Date.now();

  const { data: openReferrals, error } = await supabase
    .from('partner_referrals')
    .select('id, user_id, status, clicked_at, returned_at, nudges_sent, state_token')
    .in('status', ['clicked', 'returned']);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load open referrals.');
  }

  let nudged = 0;
  let expired = 0;

  for (const referral of openReferrals ?? []) {
    const clickedAt = new Date(referral.clicked_at).getTime();

    if (now - clickedAt > EXPIRY_DAYS * 24 * 60 * 60 * 1000) {
      await supabase.from('partner_referrals').update({ status: 'expired' }).eq('id', referral.id);
      expired++;
      continue;
    }

    if (referral.nudges_sent >= NUDGE_THRESHOLDS_HOURS.length) continue;

    const thresholdHours = NUDGE_THRESHOLDS_HOURS[referral.nudges_sent]!;
    if (now - clickedAt < thresholdHours * 60 * 60 * 1000) continue;

    const { data: user } = await supabase.auth.admin.getUserById(referral.user_id);
    const email = user?.user?.email;
    if (!email) continue;

    const result = await sendEmail({
      to: email,
      subject: 'Bought your Hantec account? Connect it to see it in your dashboard.',
      react: OfferNudgeEmailTemplate({
        appUrl,
        connectUrl: `${appUrl}/api/offers/return?vp_ref=${referral.state_token}`,
      }),
      emailType: 'offer-nudge',
    });

    if (result.success) {
      await supabase
        .from('partner_referrals')
        .update({ nudges_sent: referral.nudges_sent + 1 })
        .eq('id', referral.id);
      nudged++;
    }
  }

  return apiSuccess({ referralsChecked: (openReferrals ?? []).length, nudged, expired });
}
