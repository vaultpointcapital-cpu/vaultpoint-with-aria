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
