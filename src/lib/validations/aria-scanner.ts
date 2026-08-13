import { z } from 'zod';

/**
 * Body for POST /api/aria/scanner/alert — called only by
 * services/broker-sync/app/decision_gate/step_up_client.py
 * (send_manual_alert), never by a browser. Field names mirror the
 * candidate_setups/signal_scores column names the Python service already
 * has in hand, camelCased for the JSON boundary.
 */
export const scannerAlertSchema = z.object({
  userId: z.string().uuid(),
  accountType: z.enum(['broker_connection', 'managed_sub_account']),
  accountId: z.string().uuid(),
  candidate: z.object({
    id: z.string().uuid(),
    symbol: z.string(),
    timeframe: z.string(),
    structureType: z.enum(['liquidity_sweep', 'bos', 'choch', 'order_block_retest', 'fvg_fill']),
    direction: z.enum(['long', 'short']),
    entryZoneLow: z.number(),
    entryZoneHigh: z.number(),
    stopLoss: z.number(),
    takeProfit: z.number(),
  }),
  score: z.object({
    confidenceScore: z.number().min(0).max(100),
    actionClass: z.enum(['ALERT_ONLY', 'AUTO_ELIGIBLE', 'REJECT']),
    reasoning: z.string(),
  }),
});

export type ScannerAlertInput = z.infer<typeof scannerAlertSchema>;
