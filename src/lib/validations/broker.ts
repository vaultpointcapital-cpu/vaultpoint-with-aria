import { z } from 'zod';

/**
 * Validation for adding a new broker connection. Note what's deliberately
 * absent: there's no field for trade permissions or withdrawal permissions.
 * The UX enforces read-only API keys per dev rule — platform never trades.
 */
export const addBrokerConnectionSchema = z.object({
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
});

export type AddBrokerConnectionInput = z.infer<typeof addBrokerConnectionSchema>;
