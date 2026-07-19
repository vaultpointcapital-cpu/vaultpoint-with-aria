import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { authorizationSchema } from '@/lib/validations/managed-accounts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/managed-accounts/authorization
 * Step 4 of onboarding — the limited power of attorney signature.
 * Requires a disclosure_views row for the same document_version, owned
 * by this user, with scrolled_to_bottom_at set — a client cannot sign
 * an authorization for a disclosure they never (per the server's own
 * record) finished reading. This is the same acceptance criteria the
 * UI's own "Continue" button gate enforces, re-checked here rather than
 * trusted from the client.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = authorizationSchema.safeParse(body);
  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid authorization request.', parsed.error.flatten());
  }

  const { data: disclosureView } = await supabase
    .from('disclosure_views')
    .select('id')
    .eq('user_id', authData.user.id)
    .eq('document_version', parsed.data.documentVersion)
    .not('scrolled_to_bottom_at', 'is', null)
    .order('viewed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!disclosureView) {
    return apiError(
      'VALIDATION_ERROR',
      'You must finish reading the risk disclosure for this document version before signing.'
    );
  }

  const ipAddress =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip') ?? null;

  const { data, error } = await supabase
    .from('client_authorizations')
    .insert({
      user_id: authData.user.id,
      document_version: parsed.data.documentVersion,
      document_url: parsed.data.documentUrl,
      typed_legal_name: parsed.data.typedLegalName,
      signed_at: new Date().toISOString(),
      ip_address: ipAddress,
      signature_method: 'checkbox_and_typed_name',
      revoked_at: null,
    })
    .select()
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not record your authorization.');
  }

  return apiSuccess({ authorization: data }, 201);
}
