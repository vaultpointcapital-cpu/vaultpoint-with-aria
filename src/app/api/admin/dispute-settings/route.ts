import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { isAdmin } from '@/lib/auth/admin';
import { updateDisputeSettingsSchema } from '@/lib/validations/disputes';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import type { DisputeSettings } from '@/types/database';

/**
 * GET/PUT /api/admin/dispute-settings
 *
 * The singleton dispute_settings row — the spec's own "Open Items for
 * Pells to Fill In Before Build" (Tier 2 owner name, Tier 3 ₦
 * authorization threshold, Tier 4 legal contact), admin-editable rather
 * than hardcoded so the build isn't blocked on knowing these values up
 * front. See POST /api/admin/disputes/:id/resolve for where
 * tier3_max_authorization_ngn is actually enforced.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const admin = createServiceClient();
  const { data: settings, error } = await admin.from('dispute_settings').select('*').eq('id', 1).single();
  if (error || !settings) return apiError('INTERNAL_ERROR', 'Could not load dispute settings.');

  return apiSuccess({ settings });
}

export async function PUT(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();
  if (authError || !authData.user) return apiError('UNAUTHORIZED', 'You must be logged in.');
  if (!(await isAdmin(supabase, authData.user.id))) return apiError('FORBIDDEN', 'Admin access required.');

  const body = await request.json().catch(() => null);
  const parsed = updateDisputeSettingsSchema.safeParse(body);
  if (!parsed.success) return apiError('VALIDATION_ERROR', 'Invalid settings update.', parsed.error.flatten());

  const admin = createServiceClient();
  const updates: Partial<Omit<DisputeSettings, 'id' | 'updated_at'>> = { updated_by: authData.user.id };
  if (parsed.data.tier2SupportOwnerName !== undefined) updates.tier2_support_owner_name = parsed.data.tier2SupportOwnerName;
  if (parsed.data.tier3MaxAuthorizationNgn !== undefined) updates.tier3_max_authorization_ngn = parsed.data.tier3MaxAuthorizationNgn;
  if (parsed.data.tier4LegalContact !== undefined) updates.tier4_legal_contact = parsed.data.tier4LegalContact;

  const { data: settings, error } = await admin
    .from('dispute_settings')
    .update(updates)
    .eq('id', 1)
    .select('*')
    .single();

  if (error || !settings) return apiError('INTERNAL_ERROR', 'Could not update dispute settings.');

  return apiSuccess({ settings });
}
