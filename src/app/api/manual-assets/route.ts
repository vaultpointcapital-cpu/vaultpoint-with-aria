import { type NextRequest } from 'next/server';
import { z } from 'zod';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import { invalidateAriaContext } from '@/lib/aria/cache';

const manualAssetSchema = z.object({
  label: z.string().trim().min(1, 'Give this asset a name').max(60),
  assetType: z.enum(['bank', 'property', 'other']),
  value: z.coerce.number().nonnegative('Value cannot be negative'),
  currency: z.string().trim().length(3).default('USD'),
});

/**
 * GET /api/manual-assets
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data, error } = await supabase
    .from('manual_assets')
    .select('*')
    .eq('user_id', authData.user.id)
    .order('created_at', { ascending: false });

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load manual assets.');
  }

  return apiSuccess({ assets: data });
}

/**
 * POST /api/manual-assets
 * Adds a manually entered asset — bank balance, property value, or other
 * holding not pulled from a connected broker.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = manualAssetSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid asset data.', parsed.error.flatten());
  }

  const { data, error } = await supabase
    .from('manual_assets')
    .insert({
      user_id: authData.user.id,
      label: parsed.data.label,
      asset_type: parsed.data.assetType,
      value: parsed.data.value,
      currency: parsed.data.currency,
    })
    .select()
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not save asset.');
  }

  // A new manual asset changes net worth — invalidate rather than wait out the TTL.
  await invalidateAriaContext(authData.user.id);

  return apiSuccess({ asset: data }, 201);
}
