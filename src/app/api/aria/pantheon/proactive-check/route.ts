import Anthropic from '@anthropic-ai/sdk';
import { type NextRequest } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { canUseAria } from '@/lib/validations/aria';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import { buildAriaContext } from '@/lib/aria/context';
import {
  getPendingProactiveFindingsByUser,
  markFindingsDelivered,
  minutesSinceLastProactiveDelivery,
  type AriaFinding,
} from '@/lib/aria/findings';
import { sendEmail } from '@/lib/email/send';
import { AriaProactiveAlertEmailTemplate } from '@/lib/email/templates/aria-proactive-alert';
import type { AriaContext } from '@/lib/aria/types';
import type { AriaFindingType, AriaMessageType, SubscriptionTier } from '@/types/database';

/**
 * POST /api/aria/pantheon/proactive-check
 *
 * Aria Pantheon's proactive delivery leg. A lightweight scheduled check
 * (vercel.json cron, every 10 min) — mostly a Supabase query, one
 * Anthropic call only when there's actually something warning/critical
 * and undelivered to say. See src/lib/aria/findings.ts for why the
 * severity filter (warning/critical only) and the 30-min same-user gap
 * both live at the query/read layer, not as post-hoc checks here.
 *
 * Same Authorization: Bearer $CRON_SECRET convention as
 * offers/cron/process/route.ts and billing/profit-share/run/route.ts.
 *
 * Delivery is in-app (aria_conversations) + email — NOT push. Push
 * notifications aren't wired end-to-end anywhere in this codebase (only
 * device registration exists — src/lib/auth/devices.ts; both the
 * user_devices migration and login-alerts.ts document zero APNs/FCM
 * credentials configured). Building a push send path here would be a
 * stub with no real effect, not a feature.
 */

const MODEL = 'claude-sonnet-5';
// Smaller than aria/chat's 6000 — a proactive nudge is 2-4 sentences,
// not an SMC multi-timeframe analysis; no extended-thinking budget needed.
const MAX_TOKENS = 1024;
const PROACTIVE_MIN_AGE_MINUTES = 5;
const PROACTIVE_MIN_GAP_MINUTES = 30;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MESSAGE_TYPE_BY_FINDING_TYPE: Record<AriaFindingType, AriaMessageType> = {
  loss_warning: 'LOSS_WARNING',
  profit_alert: 'PROFIT_ALERT',
  buy_signal: 'BUY_SIGNAL',
  portfolio_review: 'PORTFOLIO_REVIEW',
  market_update: 'MARKET_UPDATE',
  risk_check: 'RISK_CHECK',
  community_nudge: 'COMMUNITY_NUDGE',
  // Unreachable in practice: the Decision Gate (app/decision_gate/service.py)
  // always writes trade_setup_alert findings at severity='caution', which
  // getPendingProactiveFindingsByUser's own query filters to
  // warning/critical only — this entry exists purely to satisfy
  // Record<AriaFindingType, AriaMessageType>'s exhaustiveness, not because
  // this route is expected to ever deliver one. See
  // 20260814000003_extend_aria_findings_for_scanner_alerts.sql for why.
  trade_setup_alert: 'BUY_SIGNAL',
};

const SEVERITY_RANK: Record<AriaFinding['severity'], number> = { critical: 3, warning: 2, caution: 1, info: 0 };

export async function GET(request: NextRequest) {
  return runProactiveCheck(request);
}

export async function POST(request: NextRequest) {
  return runProactiveCheck(request);
}

async function runProactiveCheck(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get('authorization');

  if (!cronSecret) {
    console.error('[aria/pantheon/proactive-check] CRON_SECRET is not set.');
    return apiError('INTERNAL_ERROR', 'Proactive Aria delivery is not configured.');
  }
  if (authHeader !== `Bearer ${cronSecret}`) {
    return apiError('UNAUTHORIZED', 'Invalid or missing cron secret.');
  }
  if (!anthropic) {
    console.error('[aria/pantheon/proactive-check] ANTHROPIC_API_KEY is not set.');
    return apiError('INTERNAL_ERROR', 'Proactive Aria delivery is not configured.');
  }

  const supabase = createServiceClient();
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
  const pending = await getPendingProactiveFindingsByUser(PROACTIVE_MIN_AGE_MINUTES);

  let delivered = 0;
  let skipped = 0;

  for (const [userId, findings] of pending) {
    try {
      const wasDelivered = await deliverForUser(supabase, appUrl, userId, findings);
      if (wasDelivered) {
        delivered++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[aria/pantheon/proactive-check] delivery failed for user=${userId}:`, err);
      skipped++;
    }
  }

  return apiSuccess({ usersWithPendingFindings: pending.size, delivered, skipped });
}

async function deliverForUser(
  supabase: ReturnType<typeof createServiceClient>,
  appUrl: string,
  userId: string,
  findings: AriaFinding[]
): Promise<boolean> {
  const { data: profile } = await supabase
    .from('users')
    .select('subscription_tier, full_name')
    .eq('id', userId)
    .single();

  // Free tier can't chat with Aria at all — no proactive messages either.
  const tier: SubscriptionTier = profile?.subscription_tier ?? 'free';
  if (!canUseAria(tier)) return false;

  // Batches rather than drops — findings stay 'new' and roll into the
  // next tick once the gap clears.
  const minutesSinceLast = await minutesSinceLastProactiveDelivery(userId);
  if (minutesSinceLast !== null && minutesSinceLast < PROACTIVE_MIN_GAP_MINUTES) return false;

  const ctx = await buildAriaContext(userId);
  // Same D4 guard the reactive chat route uses — never let the model
  // see/respond to unusable data.
  if (ctx.dataQuality.confidence === 'unusable') return false;

  const message = await synthesizeProactiveMessage(profile?.full_name ?? null, ctx, findings);

  await deliverInApp(supabase, userId, findings, message);

  // Email lives in auth.users, not public.users — same
  // supabase.auth.admin.getUserById() lookup offers/cron/process.ts uses,
  // not a `users.email` column (public.users has no such column).
  const { data: authUser } = await supabase.auth.admin.getUserById(userId);
  const email = authUser?.user?.email;
  if (email) {
    await sendEmail({
      to: email,
      subject: 'A note from Aria',
      react: AriaProactiveAlertEmailTemplate({ appUrl, message }),
      emailType: 'aria-proactive-alert',
    });
  }

  await markFindingsDelivered(findings.map((f) => f.id));
  return true;
}

async function synthesizeProactiveMessage(
  userName: string | null,
  ctx: AriaContext,
  findings: AriaFinding[]
): Promise<string> {
  const response = await anthropic!.messages.create({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: buildProactiveSystemPrompt(userName, ctx, findings),
    // No web_search tool — an unattended call synthesizing structured
    // findings needs no live market lookup, and skipping it keeps this
    // deterministic and cheap.
    messages: [
      {
        role: 'user',
        content:
          'Reach out proactively based on the pending findings in your system prompt — nothing the user said triggered this; you are initiating.',
      },
    ],
  });

  return extractReplyText(response.content);
}

function buildProactiveSystemPrompt(userName: string | null, ctx: AriaContext, findings: AriaFinding[]): string {
  // Cool-down (§5, mirrored from aria/chat/route.ts's own capability-4
  // omission): while active, no buy-side suggestion may appear in this
  // message even if a pending finding is itself a Hermes buy signal — a
  // proactive Argus-critical message must never end with "...so maybe
  // pick up some ETH here" during an active cool-down.
  const coolDownRule = ctx.compliance.coolDownActive
    ? `\n- COOL-DOWN ACTIVE: ${ctx.compliance.coolDownReason} Do not suggest, recommend, or encourage any new position or purchase in this message, even if one of the findings below is a buy signal — cover the loss/risk findings if any, and omit any buy-side suggestion entirely.`
    : '';

  return `You are Aria, VaultPoint's AI portfolio advisor, proactively reaching out to ${
    userName ?? 'the trader'
  }. They did not ask you anything — you are initiating this message based on findings from your specialist monitoring agents (Argus: loss/drawdown, Plutus: profit-taking, Hermes: opportunity scouting, Mnemosyne: periodic reports).

These findings are FACTS, not scripts: reformulate them in your own voice, never repeat raw_data verbatim as if reading a log. If more than one finding is pending, weigh them together into one coherent message rather than listing them separately.

Hard rules:
- Keep this short — a proactive nudge, not a report. 2-4 sentences.
- You are not a licensed financial advisor. Frame observations as information, not directives.
- Never guarantee returns.
- Every money field in the context below is { amount, currency } — state the currency when quoting a figure.${coolDownRule}

Pending findings (JSON):
${JSON.stringify(findings)}

Portfolio context (JSON):
${JSON.stringify(ctx)}`;
}

// Same extraction as aria/chat/route.ts's own extractReplyText — kept as
// a small local copy rather than importing from that route file (a
// Next.js route module isn't meant to be imported elsewhere).
function extractReplyText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

async function deliverInApp(
  supabase: ReturnType<typeof createServiceClient>,
  userId: string,
  findings: AriaFinding[],
  message: string
): Promise<void> {
  const highestSeverityFinding = findings.reduce((top, f) =>
    SEVERITY_RANK[f.severity] > SEVERITY_RANK[top.severity] ? f : top
  );

  await supabase.from('aria_conversations').insert({
    user_id: userId,
    channel: 'web',
    role: 'assistant',
    content: message,
    message_type: MESSAGE_TYPE_BY_FINDING_TYPE[highestSeverityFinding.findingType],
  });
}
