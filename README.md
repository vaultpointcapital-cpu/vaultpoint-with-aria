# VaultPoint

Cross-broker portfolio aggregation and wealth management for active traders.
Built for Meir FX Academy students as the initial beta user base.

## What's actually built (Sprint 1–2 scope, fully working)

- **Database schema** — every MVP table, with Row Level Security on all of
  them, atomic pod-contribution writes, and auto-provisioning triggers.
  `supabase/migrations/`
- **Auth** — signup, login, email verification, password reset. Real
  Supabase Auth integration, not mocked.
- **Onboarding** — skippable two-step checklist (connect broker, create pod).
- **Broker connections** — add/list/disconnect, with AES-256-GCM encryption
  for API keys at rest. Keys are never logged or returned to the frontend.
- **Savings Pods** — full CRUD, tier-limited (Free: 1, Pro: 10, Elite:
  unlimited), atomic contribution logging via a Postgres function.
- **Manual assets** — bank/property/other entries that feed into net worth.
- **Portfolio aggregation** — combines live positions + manual assets into
  net worth and P&L, computed by a unit-tested financial utils module.
- **Dashboard UI** — empty state + populated state, matching the design
  tokens from the original mockup (dark theme, Space Grotesk/Inter/JetBrains
  Mono, the exact color palette).
- **Security headers, middleware session refresh, consistent API error
  shapes** — the cross-cutting stuff that's easy to skip and expensive to
  retrofit later.

## What's NOT built yet (later sprints, by design)

- Live broker API polling (Bybit/Binance/KuCoin/MetaTrader) — that's the
  FastAPI Python service, Sprint 3–4. The `positions` table exists and the
  UI reads from it, but nothing writes real data into it yet.
- Alert engine, billing (Stripe/Paystack), email — Sprint 7–8.
- The AI advisor (Aria), Liquidation Heatmap, and other post-launch
  features — separate PRDs, not in this codebase yet.

## Stack

Next.js 14 (App Router) · TypeScript (strict) · Supabase (Postgres, Auth,
RLS) · Tailwind · Zustand · Zod · react-hook-form · Vitest

## Deploying this yourself

I can't create accounts or push to live infrastructure on your behalf —
this section is the part that's actually on you. It's mostly clicking
buttons, not writing code.

### 1. Supabase
1. Create a project at supabase.com (free tier is fine to start).
2. In the SQL Editor, run the two files in `supabase/migrations/` **in
   order** — the filenames are timestamp-prefixed so the order is obvious.
3. Copy your Project URL and anon key from Settings → API.

### 2. Environment variables
1. Copy `.env.example` to `.env.local`.
2. Fill in the Supabase URL and anon key from step 1.
3. Generate an encryption key: `openssl rand -hex 32` — paste it into
   `ENCRYPTION_KEY`. **Do this once and never change it** unless you're
   prepared to re-encrypt every stored broker key; rotating it without a
   migration plan will permanently lock you out of decrypting existing
   credentials.

### 3. Domain
You mentioned grabbing this now — once you have it, point it at Vercel in
step 4 below (Vercel's dashboard walks through the DNS records).

### 4. Local run (sanity check before deploying)
```bash
npm install
npm run test        # confirms the financial math is correct
npm run type-check  # confirms nothing's broken
npm run dev          # http://localhost:3000
```

### 5. Deploy to Vercel
1. Push this repo to GitHub.
2. Import it at vercel.com — it auto-detects Next.js.
3. Add the same environment variables from `.env.local` in Vercel's
   project settings (Environment Variables tab).
4. Deploy. Vercel gives you a `*.vercel.app` URL immediately; attach your
   custom domain in Project Settings → Domains.

### 6. GitHub Actions (already configured)
`.github/workflows/ci.yml` runs type-checking, linting, tests, and a build
on every push automatically once this is on GitHub — no setup needed
beyond having the repo there.

## Testing

```bash
npm run test           # run once
npm run test:watch     # watch mode while developing
npm run test:coverage  # coverage report — financial.ts is held to 95%+
```
