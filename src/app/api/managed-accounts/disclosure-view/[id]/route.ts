import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * PATCH /api/managed-accounts/disclosure-view/:id
 * Marks that the client actually finished reading the disclosure — the
 * UI calls this once scroll-to-bottom (or the timed minimum view) is
 * reached, which is also what activates the "Continue" button
 * client-side. The authorization route re-checks this row exists with
 * scrolled_to_bottom_at set server-side too — defense in depth, not
 * reliance on the client-side gate alone.
 */
export async function PATCH(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data, error } = await supabase
    .from('disclosure_views')
    .update({ scrolled_to_bottom_at: new Date().toISOString() })
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .select()
    .single();

  if (error) {
    return apiError('NOT_FOUND', 'Disclosure view not found or you do not have access to it.');
  }

  return apiSuccess({ disclosureView: data });
}
