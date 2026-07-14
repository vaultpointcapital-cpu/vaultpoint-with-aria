import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * DELETE /api/brokers/:id
 * Disconnects (deletes) a broker connection. RLS on broker_connections
 * already restricts this to the owning user, but we still scope the
 * query explicitly by user_id — defense in depth, not reliance on a
 * single layer.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { error } = await supabase
    .from('broker_connections')
    .delete()
    .eq('id', params.id)
    .eq('user_id', authData.user.id);

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not disconnect broker.');
  }

  return apiSuccess({ deleted: true });
}
