# Aria Cross-Surface Consistency — Web vs. Telegram

## A note on method

The checklist item asks for this to be audited "using real beta interaction logs." **No such logs
were available to this audit** — there's no analytics/transcript tool wired up that surfaces real
Aria conversation content, and pulling raw user conversation history to read personally would be a
privacy-sensitive action beyond what was asked. This audit instead compares the two system prompts
and their actual tool/capability differences at the source level — which already surfaces concrete,
user-visible inconsistencies without needing transcripts. A real log-based pass (tone drift within
a single persona, response length in practice, etc.) is a legitimate follow-up once there's a way
to do it that doesn't mean me reading users' private conversations unprompted.

## The two prompts, compared directly

**Web** (`src/app/api/aria/chat/route.ts`, `buildSystemPrompt`): "AI portfolio advisor," three jobs
— Portfolio Q&A, Risk awareness (may proactively flag concentration/leverage), Market context (via
a real `web_search` tool, answers must be grounded in search results or the live snapshot, never
stated from the model's own unverified knowledge). Tone: "concise and conversational... this is a
chat interface, not a report."

**Telegram** (`aria_bot/claude_advisor.py`, `ARIA_SYSTEM_PROMPT`): "AI financial advisor," three
jobs — PROTECT (loss warnings), PROFIT (take-profit guidance), **POSITION (recommend the next
asset to buy)**. Tone: "sharp, calm, protective... direct, no fluff." Explicitly instructed to use
Smart Money Concepts terminology (order blocks, CHOCH, liquidity sweeps, supply/demand zones). No
tool access — reasons only from portfolio/MT5 snapshot data passed in, no live web search.

## Concrete inconsistencies a user bouncing between both surfaces would notice

1. **Telegram Aria proactively recommends what to buy next ("POSITION"). Web Aria does not** — its
   three jobs are Q&A, risk-flagging, and market-context lookup, with no equivalent "recommend a
   trade" mandate. A user asking "what should I buy" would get a materially different kind of
   answer depending on which surface they're on.
2. **Telegram has an explicit hard rule — "Never recommend risking more than 5% of account equity
   on a single trade." Web Aria's system prompt has no equivalent risk-cap rule at all.** This is
   the most concrete gap: Managed Mode enforces a 5%-per-trade cap at the *database* level
   (`managed_mode_risk_pct <= 5`, see the Managed Accounts docs), so 5% is clearly VaultPoint's real
   risk policy — but web Aria isn't told about it, so nothing stops it from casually suggesting a
   larger position size in conversation, only for the system to separately refuse to execute past
   the real cap. Worth fixing regardless of the broader consistency question: this is Aria's advice
   potentially contradicting a hard constraint that exists elsewhere in the same product.
3. **Vocabulary/register mismatch**: Telegram Aria is explicitly told to speak in SMC terminology;
   web Aria is given no such instruction. A user who's learned to expect "liquidity sweep" /
   "order block" language from Telegram may get plainer, less technical language on web, or Aria on
   web may never surface SMC analysis at all despite it being core to Telegram's identity.
4. **Capability mismatch, not just tone**: web Aria can research live market news via `web_search`;
   Telegram Aria cannot. "Why did BTC drop today" gets a genuinely researched answer on web and — as
   far as the system prompt discloses — no equivalent capability on Telegram, meaning either a
   generic non-answer or (worse, and not something the prompt guards against) a fabricated one from
   the model's stale training knowledge, since nothing in the Telegram prompt tells it to decline
   answering questions outside its portfolio/MT5 data.
5. **Disclaimer consistency is fine**: both explicitly state "not a licensed financial advisor" —
   this one's actually aligned.

## Recommendation

Not attempting to unilaterally rewrite either prompt here — persona/tone is a product decision, not
a bug to silently patch. But #2 (the missing risk-cap mention on web) is worth fixing regardless of
any broader consistency decision: it's a real prompt telling Aria nothing about a hard constraint
that exists elsewhere in this exact product. The other three are genuine product decisions: do you
want one unified Aria persona across both surfaces, or is the current split (Telegram: more
proactive/technical trading co-pilot; Web: more conservative Q&A/research assistant) intentional and
should just be documented as such rather than "fixed"?
