import { z } from 'zod';

/**
 * Validation for adding a new broker connection. Note what's deliberately
 * absent: there's no field for trade permissions or withdrawal permissions.
 * The UX enforces read-only API keys per dev rule — platform never trades.
 *
 * apiPassphrase is optional at the field level but required for KuCoin —
 * KuCoin signs every request with a passphrase on top of the key/secret;
 * every other supported broker leaves it unset. Enforced below via
 * .refine() rather than a discriminated union so the error attaches to
 * the apiPassphrase field specifically.
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
    apiKey: z.string().trim().min(10, 'API key looks too short — check you copied it fully'),
    apiSecret: z
      .string()
      .trim()
      .min(10, 'API secret looks too short — check you copied it fully'),
    apiPassphrase: z.string().trim().min(1).optional(),
  })
  .refine((data) => data.broker !== 'kucoin' || !!data.apiPassphrase, {
    message: 'KuCoin requires an API passphrase in addition to the key and secret',
    path: ['apiPassphrase'],
  });

export type AddBrokerConnectionInput = z.infer<typeof addBrokerConnectionSchema>;
