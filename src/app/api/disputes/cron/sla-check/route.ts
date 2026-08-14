import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { computeSlaStatus } from '@/lib/validations/disputes';
import { sendDisputeAlert } from '@/lib/disputes/alerts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * GET/POST /api/disputes/cron/sla-check
 *
 * Same Authorization: Bearer $CRON_SECRET convention as
 * offers/cron/process and aria/pantheon/proactive-check. Finds every
 * open dispute past its tier's SLA deadline (computeSlaStatus, src/lib/
 * validations/disputes.ts — the same function the admin list view uses,
 * so both agree on what "breached" means) that hasn't already been
 * alerted on, sends one Slack+email alert, and stamps
 * sla_alert_sent_at so it never re-alerts on the same breach every tick.
 */
export async function GET(request: NextRequest) {
  return runSlaCheck(request);
}

export async function POST(request: NextRequest) {
  return runSlaCheck(request);
}

async function runSlaCheck(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (!cronSecret) {
    console.error('[disputes/cron/sla-check] CRON_SECRET is not set.');
    return apiError('INTERNAL_ERROR', 'SLA check is not configured.');
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return apiError('UNAUTHORIZED', 'Invalid or missing cron secret.');
  }

  const supabase = createServiceClient();
  const { data: disputes, error } = await supabase.from('disputes').select('*').eq('status', 'open').is('sla_alert_sent_at', null);

  if (error) {
    console.error('[disputes/cron/sla-check] Could not load open disputes:', error);
    return apiError('INTERNAL_ERROR', 'Could not check dispute SLAs.');
  }

  let checked = 0;
  let alerted = 0;

  for (const dispute of disputes ?? []) {
    checked++;
    try {
      const sla = computeSlaStatus(dispute);
      if (!sla.isBreached) continue;

      const breachDescription = sla.ackBreached ? 'acknowledgment' : 'resolution';
      await sendDisputeAlert({
        disputeId: dispute.id,
        reason: 'sla_breach',
        summary: `Tier ${dispute.tier} dispute (${dispute.category}) has breached its ${breachDescription} SLA — opened ${dispute.opened_at}.`,
      });

      const { error: updateError } = await supabase
        .from('disputes')
        .update({ sla_alert_sent_at: new Date().toISOString() })
        .eq('id', dispute.id);
      if (updateError) {
        console.error(`[disputes/cron/sla-check] Could not stamp sla_alert_sent_at for dispute=${dispute.id}:`, updateError);
        continue;
      }
      alerted++;
    } catch (err) {
      console.error(`[disputes/cron/sla-check] Failed processing dispute=${dispute.id}:`, err);
    }
  }

  return apiSuccess({ checked, alerted });
}
