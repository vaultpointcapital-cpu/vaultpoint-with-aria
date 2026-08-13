import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { contributeToPodSchema } from '@/lib/validations/pods';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import { invalidateAriaContext } from '@/lib/aria/cache';
import { applyValueLedgerEvent } from '@/lib/value-ledger/events';

/**
 * POST /api/pods/:id/contribute
 *
 * Logs a contribution and bumps the pod's current_amount atomically via
 * the contribute_to_pod() Postgres function (see
 * supabase/migrations/20260617000001_atomic_pod_contribution.sql). Both
 * writes succeed or fail together, and the pod row is locked for the
 * transaction so two simultaneous contributions can't race each other
 * into an inconsistent total.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = contributeToPodSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid contribution data.', parsed.error.flatten());
  }

  // Money & Currency Layer: a contribution's currency is always the
  // pod's own currency, read server-side — never accepted from the
  // client. contribute_to_pod() asserts this match itself too (defense
  // in depth against a stale/forged p_currency), but fetching it here
  // also lets a nonexistent pod fail with a clean NOT_FOUND before ever
  // reaching the RPC.
  const { data: pod } = await supabase
    .from('savings_pods')
    .select('currency')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .maybeSingle();

  if (!pod) {
    return apiError('NOT_FOUND', 'Pod not found or you do not have access to it.');
  }

  const { data, error } = await supabase
    .rpc('contribute_to_pod', {
      p_pod_id: params.id,
      p_user_id: authData.user.id,
      p_amount: parsed.data.amount,
      p_note: parsed.data.note ?? null,
      p_currency: pod.currency,
    })
    .single();

  if (error) {
    // Postgres error codes raised explicitly in the function map to
    // specific, safe-to-show messages rather than a generic 500.
    if (error.code === 'P0001') {
      return apiError('NOT_FOUND', 'Pod not found or you do not have access to it.');
    }
    if (error.code === 'P0002') {
      return apiError('VALIDATION_ERROR', 'Cannot contribute to an archived pod.');
    }
    if (error.code === 'P0005') {
      return apiError('VALIDATION_ERROR', "Contribution currency does not match this pod's currency.");
    }
    return apiError('INTERNAL_ERROR', 'Could not log contribution.');
  }

  const result = data as {
    contribution_id: string;
    new_current_amount: number;
    goal_just_hit: boolean;
    target_amount: number;
    pod_deadline: string | null;
    pod_created_at: string;
  };

  await invalidateAriaContext(authData.user.id);

  // Value Ledger — best-effort side effect, same non-blocking posture as
  // invalidateAriaContext above: a ledger-write failure must never fail
  // the user's contribution. Idempotency key is pod-scoped (not
  // contribution-scoped) so this fires exactly once per pod, on the
  // crossing itself.
  if (result.goal_just_hit) {
    const service = createServiceClient();
    await applyValueLedgerEvent(service, {
      userId: authData.user.id,
      eventName: 'pod_goal_hit',
      idempotencyKey: `pod_goal_hit:${params.id}`,
      properties: {
        pod_id: params.id,
        target_amount: result.target_amount,
        final_amount: result.new_current_amount,
        deadline: result.pod_deadline,
      },
      source: 'pods_api',
    });
  }

  return apiSuccess(
    {
      contributionId: result.contribution_id,
      newCurrentAmount: result.new_current_amount,
    },
    201
  );
}
