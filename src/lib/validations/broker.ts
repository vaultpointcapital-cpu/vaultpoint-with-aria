import { z } from 'zod';

/**
 * Validation for adding a new broker connection. Note what's deliberately
 * absent: there's no field for trade permissions or withdrawal permissions.
 * The UX enforces read-only API keys per dev rule — platform never trades.
 *
 * Three different credential shapes share this one schema:
 * - bybit/binance: apiKey + apiSecret
 * - kucoin: apiKey + apiSecret + apiPassphrase
 * - metatrader: mtLogin + mtServer + mtPassword (no api key/secret at all —
 *   MT4/5 has no scoped-permission API key concept, so mtPassword should
 *   be the investor/read-only password, not the trading password; nothing
 *   here can enforce that the way is_read_only enforces it for the others)
 *
 * All broker-specific fields are optional at the object level and
 * required conditionally via .refine() below, rather than a discriminated
 * union, so each error attaches to the specific field that's missing.
 */
export const addBrokerConnectionSchema = z
  .object({
    broker: z.enum(['bybit', 'binance', 'kucoin', 'metatrader'], {
      errorMap: () => ({ message: 'Select a supported broker' }),
    }),
    label: z
      .string()
      .trim()
      .min(1, 'Give this connection a label, e.g. "Main Bybit"')
      .max(50, 'Label is too long'),
    apiKey: z.string().trim().min(10, 'API key looks too short — check you copied it fully').optional(),
    apiSecret: z
      .string()
      .trim()
      .min(10, 'API secret looks too short — check you copied it fully')
      .optional(),
    apiPassphrase: z.string().trim().min(1).optional(),
    mtLogin: z.string().trim().min(1).optional(),
    mtServer: z.string().trim().min(1).optional(),
    mtPlatform: z.enum(['mt4', 'mt5']).optional(),
    mtPassword: z.string().trim().min(1).optional(),
    // Step-Up Auth Ticket 2 — the approval_id returned by a prior,
    // already-approved POST /api/auth/step-up/initiate + /confirm
    // (action_type: 'broker_credential_change', resource_id: null — this
    // is a new connection, there's no existing id to reference yet).
    stepUpApprovalId: z.string().trim().min(1, 'A confirmed step-up approval is required'),
  })
  .refine((data) => data.broker !== 'kucoin' || !!data.apiPassphrase, {
    message: 'KuCoin requires an API passphrase in addition to the key and secret',
    path: ['apiPassphrase'],
  })
  .refine((data) => data.broker === 'metatrader' || (!!data.apiKey && !!data.apiSecret), {
    message: 'API key and secret are required',
    path: ['apiKey'],
  })
  .refine((data) => data.broker !== 'metatrader' || !!data.mtLogin, {
    message: 'MT account login is required',
    path: ['mtLogin'],
  })
  .refine((data) => data.broker !== 'metatrader' || !!data.mtServer, {
    message: 'MT server name is required, e.g. "Exness-MT5Real8"',
    path: ['mtServer'],
  })
  .refine((data) => data.broker !== 'metatrader' || !!data.mtPlatform, {
    message: 'Select whether this is an MT4 or MT5 account',
    path: ['mtPlatform'],
  })
  .refine((data) => data.broker !== 'metatrader' || !!data.mtPassword, {
    message: 'MT account password is required — use the investor/read-only password if your broker offers one',
    path: ['mtPassword'],
  });

export type AddBrokerConnectionInput = z.infer<typeof addBrokerConnectionSchema>;

/**
 * Re-authorizing an existing connection for Signal Mode trade execution.
 * broker_connections.trade_execution_enabled is DB CHECK-constrained to
 * require is_read_only = false (see
 * supabase/migrations/20260718000000_add_signal_mode.sql) — there is no
 * such thing as flipping the flag without also submitting real
 * trade-permission credentials, so this asks for the same fields
 * addBrokerConnectionSchema does (minus broker/label, which the existing
 * connection row already has and cannot change here). Kept as a separate
 * schema rather than reusing addBrokerConnectionSchema directly: that
 * schema's type is a ZodEffects (post-.refine()), which zod doesn't allow
 * .omit()'ing fields from — this duplicates the shape instead, consistent
 * with this file's existing "three different credential shapes, no
 * discriminated union" approach.
 */
export const reauthorizeBrokerConnectionSchema = z
  .object({
    broker: z.enum(['bybit', 'binance', 'kucoin', 'metatrader'], {
      errorMap: () => ({ message: 'Unknown broker type' }),
    }),
    apiKey: z.string().trim().min(10, 'API key looks too short — check you copied it fully').optional(),
    apiSecret: z
      .string()
      .trim()
      .min(10, 'API secret looks too short — check you copied it fully')
      .optional(),
    apiPassphrase: z.string().trim().min(1).optional(),
    mtLogin: z.string().trim().min(1).optional(),
    mtServer: z.string().trim().min(1).optional(),
    mtPlatform: z.enum(['mt4', 'mt5']).optional(),
    mtPassword: z.string().trim().min(1).optional(),
  })
  .refine((data) => data.broker !== 'kucoin' || !!data.apiPassphrase, {
    message: 'KuCoin requires an API passphrase in addition to the key and secret',
    path: ['apiPassphrase'],
  })
  .refine((data) => data.broker === 'metatrader' || (!!data.apiKey && !!data.apiSecret), {
    message: 'API key and secret are required',
    path: ['apiKey'],
  })
  .refine((data) => data.broker !== 'metatrader' || !!data.mtLogin, {
    message: 'MT account login is required',
    path: ['mtLogin'],
  })
  .refine((data) => data.broker !== 'metatrader' || !!data.mtServer, {
    message: 'MT server name is required, e.g. "Exness-MT5Real8"',
    path: ['mtServer'],
  })
  .refine((data) => data.broker !== 'metatrader' || !!data.mtPlatform, {
    message: 'Select whether this is an MT4 or MT5 account',
    path: ['mtPlatform'],
  })
  .refine((data) => data.broker !== 'metatrader' || !!data.mtPassword, {
    message: 'MT account trading password is required — this connection needs order-placement permission now',
    path: ['mtPassword'],
  });

export type ReauthorizeBrokerConnectionInput = z.infer<typeof reauthorizeBrokerConnectionSchema>;

/**
 * Opting a connection into Managed Mode (autonomous execution — see
 * supabase/migrations/20260718000002_add_managed_mode.sql). The bounds
 * here mirror that migration's own CHECK constraint exactly (risk 0-5%,
 * daily loss limit 0-20%) — duplicated deliberately so a user gets an
 * immediate, specific validation message instead of a raw Postgres
 * constraint-violation error if they somehow submit an out-of-range
 * value past client-side validation.
 *
 * consent must be the literal boolean true — this is the field the
 * explicit consent checkbox binds to; managed_mode_consented_at is set
 * server-side to the current time only when this parses successfully,
 * never client-supplied.
 */
export const managedModeOptInSchema = z.object({
  riskPct: z.coerce
    .number()
    .positive('Risk per trade must be greater than 0%')
    .max(5, 'Risk per trade cannot exceed 5% (VaultPoint-enforced maximum)'),
  dailyLossLimitPct: z.coerce
    .number()
    .positive('Daily loss limit must be greater than 0%')
    .max(20, 'Daily loss limit cannot exceed 20% (VaultPoint-enforced maximum)'),
  consent: z.literal(true, {
    errorMap: () => ({ message: 'You must acknowledge that Aria will place trades automatically' }),
  }),
});

export type ManagedModeOptInInput = z.infer<typeof managedModeOptInSchema>;
