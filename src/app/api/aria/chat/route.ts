import Anthropic from '@anthropic-ai/sdk';
import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { ariaChatSchema, canUseAria } from '@/lib/validations/aria';
import {
  calculatePositionPnl,
  calculatePositionPnlPct,
  calculateNetWorth,
  calculateTotalPnl,
  calculateMarginUtilization,
} from '@/lib/utils/financial';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import type { Position, ManualAsset, SubscriptionTier } from '@/types/database';

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

  // ---- Live portfolio state — same source of truth as /api/portfolio ----
  const [positionsResult, manualAssetsResult] = await Promise.all([
    supabase
      .from('positions')
      .select('*, broker_connections(broker, label)')
      .eq('user_id', authData.user.id),
    supabase.from('manual_assets').select('*').eq('user_id', authData.user.id),
  ]);

  if (positionsResult.error || manualAssetsResult.error) {
    return apiError('INTERNAL_ERROR', 'Could not load your portfolio data.');
  }

  const positions = (positionsResult.data ?? []) as Array<
    Position & { broker_connections: { broker: string; label: string } | null }
  >;
  const manualAssets = (manualAssetsResult.data ?? []) as ManualAsset[];

  const portfolioContext = buildPortfolioContext(positions, manualAssets);
  const systemPrompt = buildSystemPrompt(profile?.full_name ?? null, portfolioContext);

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

    const reply = extractReplyText(response.content);
    const sources = extractWebSources(response.content);

    return apiSuccess({
      reply,
      sources,
      portfolioSnapshot: {
        netWorth: portfolioContext.net_worth,
        totalUnrealizedPnl: portfolioContext.total_unrealized_pnl,
        marginUtilizationPct: portfolioContext.margin_utilization_pct,
      },
    });
  } catch (err) {
    console.error('[aria/chat] Anthropic API error:', err);
    return apiError('INTERNAL_ERROR', 'Aria is temporarily unavailable. Please try again.');
  }
}

// ---------------------------------------------------------------------
// Portfolio context — reuses lib/utils/financial.ts exclusively so this
// route can never drift from the numbers the dashboard itself shows.
// ---------------------------------------------------------------------

interface PortfolioContext {
  net_worth: number;
  total_unrealized_pnl: number;
  margin_utilization_pct: number;
  open_position_count: number;
  positions: Array<{
    symbol: string;
    side: string;
    broker: string;
    leverage: number;
    entry_price: number;
    mark_price: number;
    unrealized_pnl: number;
    unrealized_pnl_pct: number;
    margin_used: number | null;
    synced_at: string;
  }>;
}

function buildPortfolioContext(
  positions: Array<Position & { broker_connections: { broker: string; label: string } | null }>,
  manualAssets: ManualAsset[]
): PortfolioContext {
  const netWorth = calculateNetWorth(positions, manualAssets);
  const totalUnrealizedPnl = calculateTotalPnl(positions);
  const totalMarginUsed = positions.reduce((sum, p) => sum + (p.margin_used ?? 0), 0);
  const marginUtilizationPct = calculateMarginUtilization(totalMarginUsed, netWorth);

  const openPositions = positions
    .filter((p): p is typeof p & { mark_price: number } => p.mark_price !== null)
    .map((p) => ({
      symbol: p.symbol,
      side: p.side,
      broker: p.broker_connections?.broker ?? 'unknown',
      leverage: p.leverage,
      entry_price: p.entry_price,
      mark_price: p.mark_price,
      unrealized_pnl: round2(
        calculatePositionPnl({
          side: p.side,
          size: p.size,
          entry_price: p.entry_price,
          mark_price: p.mark_price,
        })
      ),
      unrealized_pnl_pct: round2(
        calculatePositionPnlPct({
          side: p.side,
          size: p.size,
          entry_price: p.entry_price,
          mark_price: p.mark_price,
        })
      ),
      margin_used: p.margin_used,
      synced_at: p.synced_at,
    }));

  return {
    net_worth: round2(netWorth),
    total_unrealized_pnl: round2(totalUnrealizedPnl),
    margin_utilization_pct: round2(marginUtilizationPct),
    open_position_count: positions.length,
    positions: openPositions,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------

function buildSystemPrompt(userName: string | null, portfolio: PortfolioContext): string {
  return `You are Aria, VaultPoint's AI portfolio advisor. You help ${
    userName ?? 'the trader'
  } understand their live cross-market portfolio (crypto, forex, and manually tracked assets) in plain language.

You have four jobs, per what the user asks:
1. Portfolio Q&A — answer questions about their actual current positions, exposure, and P&L using the live snapshot below. Never estimate or round loosely when an exact figure is available in the snapshot.
2. Risk awareness — if something in the snapshot looks concentrated or over-leveraged, you may point it out even if not asked directly, but don't be alarmist about ordinary risk.
3. Market context — if asked why an asset moved, use the web_search tool and base your answer only on what you find. Never state a price, news event, or market claim you have not verified via search or that isn't in the snapshot below.
4. Position guidance — if asked what to consider buying, you may recommend a next asset based on the portfolio snapshot and whatever you find via web_search, explaining your reasoning briefly so the user feels informed, not just told.

Hard rules:
- The portfolio snapshot below was synced within the last 60 seconds — treat it as current, not historical.
- If the snapshot doesn't contain something the user asks about (e.g. an asset they don't hold), say so plainly instead of guessing.
- Keep answers concise and conversational — this is a chat interface, not a report.
- You are not a licensed financial advisor. Frame observations as information, not directives ("your margin usage is high" not "you must close this position").
- Never guarantee returns. Say "this looks promising" not "this will go up."
- Never recommend risking more than 5% of account equity on a single trade — this matches the hard cap Managed Mode itself enforces elsewhere in this product; don't casually suggest a size the system wouldn't actually let the user execute.
- Use Smart Money Concepts (SMC) terminology when relevant: order blocks, supply/demand zones, CHOCH (change of character), internal vs swing structure, liquidity sweeps.

Live portfolio snapshot (JSON):
${JSON.stringify(portfolio)}`;
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
