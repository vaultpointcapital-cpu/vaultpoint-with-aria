import { type NextRequest } from 'next/server';
import { initiateStepUp } from '@/lib/auth/step-up';
import { requireServiceApiKey } from '@/lib/auth/service-auth';
import { scannerAlertSchema } from '@/lib/validations/aria-scanner';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/aria/scanner/alert
 *
 * Aria Autonomous Trading Agent — Decision Gate manual-account alert (PRD
 * Sprint 3, component 4C). Called only by services/broker-sync/app/
 * decision_gate/step_up_client.py (send_manual_alert), x-api-key gated
 * like every other Python <-> Next.js boundary in this codebase — never
 * reachable from a browser.
 *
 * This route owns exactly one thing: the real-time, confirmation-required
 * step-up challenge (initiateStepUp() — its own code already documents
 * that 'push' isn't real push delivery and that Telegram is the only
 * channel that reliably delivers an interactive out-of-band prompt today,
 * a limitation unchanged here). It deliberately does NOT also write the
 * durable public.aria_findings fallback record itself: that table's own
 * Database type (src/types/database.ts) declares `Insert: never` with an
 * explicit comment — "written only by the Python worker modules... no
 * Next.js insert path" — a real architectural boundary, not an oversight.
 * decision_gate/service.py writes that record on the Python side instead,
 * via the same shared app/pantheon/dedup.py upsert_finding() every other
 * Pantheon worker uses, immediately after this route responds.
 */
export async function POST(request: NextRequest) {
  if (!requireServiceApiKey(request)) {
    return apiError('UNAUTHORIZED', 'Invalid or missing API key.');
  }

  const body = await request.json().catch(() => null);
  const parsed = scannerAlertSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid scanner alert payload.', parsed.error.flatten());
  }
  const { userId, accountType, accountId, candidate, score } = parsed.data;

  const stepUp = await initiateStepUp({
    userId,
    actionType: 'aria_scanner_trade_alert',
    resourceId: candidate.id,
    metadata: { accountType, accountId, symbol: candidate.symbol, actionClass: score.actionClass },
  });

  return apiSuccess(
    {
      approvalId: stepUp.approvalId,
      approvalRowId: stepUp.approvalRowId,
      expiresAt: stepUp.expiresAt,
      methods: stepUp.methods,
    },
    201
  );
}
