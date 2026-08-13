import Anthropic from '@anthropic-ai/sdk';
import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ariaChatSchema, canUseAria } from '@/lib/validations/aria';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import { buildAriaContext } from '@/lib/aria/context';
import {
  containsProhibitedLanguage,
  DISCLAIMER_TEXT,
  REGENERATION_FALLBACK_MESSAGE,
  UNUSABLE_CONFIDENCE_MESSAGE,
} from '@/lib/aria/compliance';
import type { AriaContext } from '@/lib/aria/types';
import type { SubscriptionTier } from '@/types/database';

/**
 * POST /api/aria/chat
 *
 * Aria — VaultPoint's AI portfolio advisor (PRD Sprint 12-14, priority
 * 18/20). Covers two of the three PRD modes:
 *   - Portfolio Q&A   ("what's my BTC exposure right now")
 *   - Market Context  ("why is ETH down today" — via web search)
 *
 * The third mode, proactive Risk Alerts ("your SOL short is 80% of
 * margin used"), is NOT this route. That's a background job on the same
 * 60s poll cycle as the existing `alerts` evaluation, not something a
 * chat request triggers. See TODO in this sprint's tracking issue.
 *
 * Gated to Pro/Elite — Free tier gets FORBIDDEN.
 *
 * Aria Context Builder: this route no longer assembles its own context
 * inline — every portfolio/compliance figure it uses comes from
 * buildAriaContext() (src/lib/aria/context.ts), the one payload every
 * Aria surface reads from. Two compliance layers live here specifically
 * because they're response-layer concerns, not context: the D4
 * confidence gate (never let the model see/respond to unusable data)
 * and the post-generation prohibited-language check + disclaimer
 * (never trust the model to self-police or self-append these).
 */

const MODEL = 'claude-sonnet-5';
// Was 1024 — too tight once extended thinking is involved. Verified
// empirically (Aria migration Phase 2 testing): a real SMC-analysis
// request hit stop_reason='max_tokens' with 1193 of 1318 output tokens
// spent on thinking alone, leaving zero room for the actual reply text.
// 6000 was the smallest budget that reliably produced a clean
// stop_reason='end_turn' (not truncated) for the most demanding prompt
// this route handles (the SMC multi-timeframe analyze template).
const MAX_TOKENS = 6000;
// Cap tool round-trips so a single request can't spiral into an
// unbounded number of paid web searches.
const MAX_WEB_SEARCHES_PER_REQUEST = 3;

const anthropic = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  if (!anthropic) {
    // Misconfigured environment (missing ANTHROPIC_API_KEY) — fail loudly
    // server-side, but don't leak config details to the client.
    console.error('[aria/chat] ANTHROPIC_API_KEY is not set.');
    return apiError('INTERNAL_ERROR', 'Aria is temporarily unavailable.');
  }

  const { data: profile } = await supabase
    .from('users')
    .select('subscription_tier, full_name')
    .eq('id', authData.user.id)
    .single();

  const tier: SubscriptionTier = profile?.subscription_tier ?? 'free';

  if (!canUseAria(tier)) {
    return apiError(
      'TIER_LIMIT_REACHED',
      'Aria is available on Pro and Elite plans. Upgrade to chat with your portfolio advisor.',
      { tier }
    );
  }

  const body = await request.json();
  const parsed = ariaChatSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid chat request.', parsed.error.flatten());
  }

  const { message, history } = parsed.data;

  const ctx = await buildAriaContext(authData.user.id);

  // D4 — a fixed, non-model response when data isn't usable. A model
  // asked to refuse will sometimes comply anyway; this never reaches
  // Anthropic at all.
  if (ctx.dataQuality.confidence === 'unusable') {
    return apiSuccess({
      reply: UNUSABLE_CONFIDENCE_MESSAGE,
      sources: [],
      action: { type: 'reconnect', connections: ctx.dataQuality.degradedSources },
    });
  }

  const systemPrompt = buildSystemPrompt(profile?.full_name ?? null, ctx);

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: systemPrompt,
      messages: [
        ...history.map((turn) => ({ role: turn.role, content: turn.content })),
        { role: 'user' as const, content: message },
      ] satisfies Anthropic.MessageParam[],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
          max_uses: MAX_WEB_SEARCHES_PER_REQUEST,
        },
      ],
    });

    let reply = extractReplyText(response.content);
    let sources = extractWebSources(response.content);

    // Post-generation check (§5) — a regex pass over the model's actual
    // output, not just a prompt instruction it might ignore. On a hit:
    // regenerate once with the offending phrase named explicitly; if
    // that's still unclean, fall back to a safe static message rather
    // than a third model call or letting the flagged text through.
    const flaggedPhrase = containsProhibitedLanguage(reply);
    if (flaggedPhrase) {
      const regenerated = await anthropic.messages.create({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: `${systemPrompt}\n\nYour previous draft used the phrase "${flaggedPhrase}", which is not allowed (absolute/guaranteed-outcome language). Rewrite your answer without it or any similar phrasing.`,
        messages: [
          ...history.map((turn) => ({ role: turn.role, content: turn.content })),
          { role: 'user' as const, content: message },
        ] satisfies Anthropic.MessageParam[],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_WEB_SEARCHES_PER_REQUEST }],
      });
      const regeneratedReply = extractReplyText(regenerated.content);

      if (containsProhibitedLanguage(regeneratedReply)) {
        reply = REGENERATION_FALLBACK_MESSAGE;
        sources = [];
      } else {
        reply = regeneratedReply;
        sources = extractWebSources(regenerated.content);
      }
    }

    // Appended by this response layer, never left to the model — a
    // model that decides a reply is "too short to need one" would
    // otherwise omit it.
    if (ctx.compliance.disclaimerRequired) {
      reply = `${reply}${DISCLAIMER_TEXT}`;
    }

    // The old response also carried a `portfolioSnapshot` field
    // (net worth/PnL/margin) — confirmed via a repo-wide search that no
    // client ever reads it (src/components/markets/aria-chat.tsx only
    // uses `reply`/`sources`), so it's dropped here rather than rebuilt
    // against the new AriaContext shape for a field with zero consumers.
    return apiSuccess({ reply, sources });
  } catch (err) {
    console.error('[aria/chat] Anthropic API error:', err);
    return apiError('INTERNAL_ERROR', 'Aria is temporarily unavailable. Please try again.');
  }
}

// ---------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------

function buildSystemPrompt(userName: string | null, ctx: AriaContext): string {
  const capabilities = [
    '1. Portfolio Q&A — answer questions about their actual current holdings, exposure, and value using the live context below. Never estimate or round loosely when an exact figure is available.',
    "2. Risk awareness — if something in the context looks concentrated or over-leveraged, you may point it out even if not asked directly, but don't be alarmist about ordinary risk.",
    '3. Market context — if asked why an asset moved, use the web_search tool and base your answer only on what you find. Never state a price, news event, or market claim you have not verified via search or that isn\'t in the context below.',
  ];
  // Cool-down (§5): while active, the "position guidance" capability is
  // entirely omitted, not merely discouraged — the only real
  // enforcement point available, since no buy-signal tool/endpoint
  // exists in this codebase to disable at an API layer (see the Aria
  // Context Builder plan's reconciliation notes).
  if (!ctx.compliance.coolDownActive) {
    capabilities.push(
      '4. Position guidance — if asked what to consider buying, you may recommend a next asset based on the context and whatever you find via web_search, explaining your reasoning briefly so the user feels informed, not just told.'
    );
  }

  const coolDownRule = ctx.compliance.coolDownActive
    ? `\n- COOL-DOWN ACTIVE: ${ctx.compliance.coolDownReason} Do not suggest, recommend, or encourage any new position or purchase right now, even if asked directly — explain that new suggestions are paused today due to the portfolio move, and stick to answering questions about existing holdings.`
    : '';

  const regionNotesText = ctx.compliance.regionNotes.length > 0 ? ` ${ctx.compliance.regionNotes.join(' ')}` : '';

  return `You are Aria, VaultPoint's AI portfolio advisor. You help ${
    userName ?? 'the trader'
  } understand their live cross-market portfolio (crypto, forex, savings pods, and manually tracked assets) in plain language.

You have ${capabilities.length} jobs, per what the user asks:
${capabilities.join('\n')}

Hard rules:
- ${
    ctx.dataQuality.stale
      ? `Some of the data in the context below is stale as of ${ctx.dataQuality.oldestAsOf} — if you reference a figure that might be affected (total assets, or a specific holding with stale: true), say plainly that it may not reflect the latest market state rather than presenting it as live.`
      : 'The context below reflects a recent sync — treat it as current, not historical.'
  }
- A holding with stale: true hasn't synced recently — if you reference its value specifically, flag that it may be out of date.
- If the context doesn't contain something the user asks about (e.g. an asset they don't hold), say so plainly instead of guessing.
- Keep answers concise and conversational — this is a chat interface, not a report.
- You are not a licensed financial advisor. Frame observations as information, not directives ("your margin usage is high" not "you must close this position").
- Never guarantee returns. Say "this looks promising" not "this will go up."
- Never recommend risking more than 5% of account equity on a single trade — this matches the hard cap Managed Mode itself enforces elsewhere in this product; don't casually suggest a size the system wouldn't actually let the user execute.
- Use Smart Money Concepts (SMC) terminology when relevant: order blocks, supply/demand zones, CHOCH (change of character), internal vs swing structure, liquidity sweeps.
- excludedHoldings (reality: "simulated" or "pending" — e.g. a Hantec Trader Instant Funding prop-firm challenge account) are shown for context but are already excluded from portfolio.totalAssets. Never fold one into net worth or risk commentary, and never congratulate the user on an unrealized simulated gain — call it "challenge progress," not profit or gains.
- Every money field below is { amount, currency } — always state the currency when quoting a figure, never assume USD. portfolio.unpricedCount holdings couldn't be converted to the user's display currency and are excluded from totalAssets — never imply they're worth zero.${coolDownRule}${regionNotesText}

Live context (JSON):
${JSON.stringify(ctx)}`;
}

// ---------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------

function extractReplyText(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('\n\n')
    .trim();
}

/**
 * Pulls source URLs/titles out of any web_search citations attached to
 * text blocks, de-duplicated, so the client can render "Sources: ..."
 * under Aria's reply instead of the model inventing an unlinked claim.
 */
function extractWebSources(
  content: Anthropic.ContentBlock[]
): Array<{ url: string; title: string }> {
  const seen = new Map<string, { url: string; title: string }>();

  for (const block of content) {
    if (block.type !== 'text' || !block.citations) continue;

    for (const citation of block.citations) {
      if (citation.type === 'web_search_result_location') {
        const url = citation.url;
        if (url && !seen.has(url)) {
          seen.set(url, { url, title: citation.title ?? url });
        }
      }
    }
  }

  return Array.from(seen.values());
}
