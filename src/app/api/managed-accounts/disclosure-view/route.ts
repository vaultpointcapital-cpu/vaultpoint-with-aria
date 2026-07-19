import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { disclosureViewSchema } from '@/lib/validations/managed-accounts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/managed-accounts/disclosure-view
 * Step 2 of onboarding, opened. Logs that the client reached the
 * disclosure screen — scrolled_to_bottom_at is set later, by PATCH
 * /api/managed-accounts/disclosure-view/:id, once they actually finish
 * reading it. Per the flow's own acceptance criteria ("Disclosure
 * screen view is logged with a timestamp for audit purposes"), this
 * row is the audit record regardless of whether they ever finish or
 * abandon the flow.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = disclosureViewSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid disclosure view request.', parsed.error.flatten());
  }

  const { data, error } = await supabase
    .from('disclosure_views')
    .insert({
      user_id: authData.user.id,
      document_version: parsed.data.documentVersion,
      scrolled_to_bottom_at: null,
    })
    .select()
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not record disclosure view.');
  }

  return apiSuccess({ disclosureView: data }, 201);
}
