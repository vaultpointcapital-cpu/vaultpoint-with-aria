# Meir FX Academy Integration Loop

## Current state: content display only, zero engagement loop

`academy_videos` (`video_type`: `daily_short` shown on the main dashboard, `long_form` shown on
Settings via `AcademyVideosSection`) is a static, founder-managed content list — per its own
migration comment, "managed directly via the Supabase Table Editor," same pattern as the
Managed Accounts compliance gate's `is_admin` flag. `users.academy_student` is a self-reported
boolean set at onboarding, displayed read-only on Settings ("Verified member" / "Not linked").

Searching the entire codebase for any connection between watching/completing academy content and
anything else in the app — unlocked features, XP/progress tracking, tailored Aria behavior, a
completion-based badge, a reward — returns nothing. A student and a non-student see the same app
behavior in every respect except that one Settings-page label.

**Until this session's Track D migration fix, `academy_videos` didn't even exist on the live
database** — so today, before that fix, the daily-short video and the Settings video list were
both silently empty for every real user, not just "static." That's now resolved as a side effect of
the earlier fix, but it means this feature likely has zero real engagement data to look at yet
either way.

## Proposed loop concepts, not yet built

None of these exist in any form today — this is a from-scratch proposal, ordered roughly by how
much new backend they need.

### 1. Completion tracking (prerequisite for everything else)

There's currently no way to know if a user watched a video at all. A minimal
`academy_video_views` table (mirroring `disclosure_views`' shape: `user_id`, `video_id`,
`viewed_at`, maybe a `completed_at` if the player reports watch percentage) is the prerequisite for
any of the following — none of them are buildable without first knowing what a user has actually
watched.

### 2. Academy-aware Aria context (cheapest real loop, reuses existing infrastructure)

Both `buildSystemPrompt` (web) and `claude_advisor.py` (Telegram) already inject portfolio context
into Aria's system prompt every message. Adding "this user has watched [topics]" (once #1 exists)
lets Aria reference concepts the user has actually been taught — e.g. only using SMC terminology
(which Telegram Aria is already instructed to use — see the cross-surface consistency doc) with
users who've actually watched the SMC-explainer content, rather than assuming everyone knows it.

### 3. Academy-gated features (bigger decision)

E.g., require watching a specific onboarding video before Managed Mode or Managed Accounts
onboarding unlocks — using education as a real risk-mitigation step for the higher-risk features,
not just a marketing surface. This is a genuine product/compliance decision (does gating
autonomous-trading access behind education actually reduce real-world harm, or just add friction?)
worth deciding deliberately, not defaulting into.

### 4. Engagement-driven content surfacing

Once #1 exists, surface *unwatched* content relevant to a user's actual situation — e.g. a user
whose portfolio just hit a drawdown alert gets the risk-management video surfaced, not a random
next-in-list video. This is the most "integrated" version of the loop but depends on #1 and #2
existing first.

## Recommendation

Build #1 first regardless of which of #2-4 gets prioritized — nothing else is possible without it,
and it's small (one table, same shape as an existing one). Then #2, since it's genuinely cheap
(reuses Aria's existing context-injection pattern on both surfaces) and gives real signal on
whether academy content is being watched at all before investing in #3 or #4.
