import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAlertSchema, canCreateAnotherAlert } from '@/lib/validations/alerts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import type { SubscriptionTier } from '@/types/database';

/**
 * GET /api/alerts
 * Lists the authenticated user's alerts (all of them, active or not —
 * the frontend distinguishes via is_active, not this route).
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data, error } = await supabase
    .from('alerts')
    .select('*')
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load alerts.');
  }

  return apiSuccess({ alerts: data });
}

/**
 * POST /api/alerts
 * Creates a new alert, enforcing the ACTIVE-alert tier limit server-side
 * (see ALERT_LIMITS_BY_TIER — Free: 3, Pro/Elite: unlimited). New alerts
 * are always created active, so this is the same check re-run on PATCH
 * when re-enabling a disabled one.
 *
 * This is CRUD only — nothing here evaluates alerts against live prices.
 * That's the Python microservice's job (not built yet, per .env.example's
 * PYTHON_SERVICE_URL / "Sprint 3+" note).
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data: profile } = await supabase
    .from('users')
    .select('subscription_tier')
    .eq('id', authData.user.id)
    .single();

  const tier: SubscriptionTier = profile?.subscription_tier ?? 'free';

  const { count } = await supabase
    .from('alerts')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', authData.user.id)
    .eq('is_active', true);

  if (!canCreateAnotherAlert(tier, count ?? 0)) {
    return apiError(
      'TIER_LIMIT_REACHED',
      `Your ${tier} plan allows a limited number of active alerts. Upgrade or disable another alert first.`,
      { tier, currentActiveCount: count }
    );
  }

  const body = await request.json();
  const parsed = createAlertSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid alert data.', parsed.error.flatten());
  }

  const { data, error } = await supabase
    .from('alerts')
    .insert({
      user_id: authData.user.id,
      symbol: parsed.data.symbol,
      condition_type: parsed.data.conditionType,
      operator: parsed.data.operator,
      threshold: parsed.data.threshold,
      is_active: true,
    })
    .select()
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not create alert.');
  }

  return apiSuccess({ alert: data }, 201);
}
