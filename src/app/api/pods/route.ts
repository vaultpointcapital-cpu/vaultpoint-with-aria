import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createPodSchema, canCreateAnotherPod } from '@/lib/validations/pods';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import type { SubscriptionTier } from '@/types/database';

/**
 * GET /api/pods
 * Lists the authenticated user's savings pods.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data, error } = await supabase
    .from('savings_pods')
    .select('*')
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load savings pods.');
  }

  return apiSuccess({ pods: data });
}

/**
 * POST /api/pods
 * Creates a new savings pod, enforcing the tier limit (Free: 1, Pro: 10,
 * Elite: unlimited) server-side. The client-side UI should also disable
 * the "add pod" button when at the limit, but that's UX sugar — this
 * check is the actual enforcement boundary.
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
    .from('savings_pods')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', authData.user.id)
    .neq('status', 'archived');

  if (!canCreateAnotherPod(tier, count ?? 0)) {
    return apiError(
      'TIER_LIMIT_REACHED',
      `Your ${tier} plan allows a limited number of Savings Pods. Upgrade to create more.`,
      { tier, currentCount: count }
    );
  }

  const body = await request.json();
  const parsed = createPodSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid pod data.', parsed.error.flatten());
  }

  const { data, error } = await supabase
    .from('savings_pods')
    .insert({
      user_id: authData.user.id,
      name: parsed.data.name,
      target_amount: parsed.data.targetAmount,
      currency: parsed.data.currency,
      color: parsed.data.color,
      deadline: parsed.data.deadline ?? null,
      status: 'active',
    })
    .select()
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not create savings pod.');
  }

  return apiSuccess({ pod: data }, 201);
}
