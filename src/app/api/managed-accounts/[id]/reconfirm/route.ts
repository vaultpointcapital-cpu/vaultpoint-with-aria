import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { AUTHORIZATION_DOCUMENT_VERSION } from '@/lib/validations/managed-accounts';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/managed-accounts/:id/reconfirm
 * Clears requires_disclosure_reconfirmation once the client has, for
 * the CURRENT document version, both re-viewed the disclosure (scrolled
 * to the bottom, via the same disclosure-view routes onboarding uses)
 * and re-signed the authorization (via POST
 * /api/managed-accounts/authorization, which itself already re-checks
 * the disclosure gate). This route just verifies both records exist for
 * this account's owner and this version, then re-links
 * client_authorization_id to the fresh signature and clears the flag —
 * it does not itself collect the signature, so a client always goes
 * through the real disclosure/authorization screens first, never a
 * silent one-click "confirm."
 */
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data: account } = await supabase
    .from('managed_accounts')
    .select('id, status, requires_disclosure_reconfirmation')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (!account) {
    return apiError('NOT_FOUND', 'Managed account not found or you do not have access to it.');
  }

  if (!account.requires_disclosure_reconfirmation) {
    return apiError('VALIDATION_ERROR', 'This account does not require reconfirmation.');
  }

  const { data: authorization } = await supabase
    .from('client_authorizations')
    .select('id')
    .eq('user_id', authData.user.id)
    .eq('document_version', AUTHORIZATION_DOCUMENT_VERSION)
    .is('revoked_at', null)
    .order('signed_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!authorization) {
    return apiError(
      'VALIDATION_ERROR',
      'You must re-read the disclosure and re-sign the authorization for the current terms before continuing.'
    );
  }

  const { data, error } = await supabase
    .from('managed_accounts')
    .update({
      client_authorization_id: authorization.id,
      requires_disclosure_reconfirmation: false,
    })
    .eq('id', account.id)
    .eq('user_id', authData.user.id)
    .select('id, requires_disclosure_reconfirmation')
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not confirm updated terms for this account.');
  }

  return apiSuccess({ managedAccount: data });
}
