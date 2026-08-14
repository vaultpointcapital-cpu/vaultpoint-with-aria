import { type NextRequest } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabase/server';
import { encrypt, maskKey } from '@/lib/encryption/broker-keys';
import { addBrokerConnectionSchema } from '@/lib/validations/broker';
import { isStepUpApproved } from '@/lib/auth/step-up';
import { apiError, apiSuccess } from '@/lib/utils/api-response';
import { invalidateAriaContext } from '@/lib/aria/cache';

/**
 * GET /api/brokers
 * Lists the authenticated user's broker connections. Returns masked key
 * labels only — the real encrypted_api_key/secret columns are never
 * included in this response shape.
 */
export async function GET() {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data, error } = await supabase
    .from('broker_connections')
    .select(
      'id, broker, label, is_read_only, trade_execution_enabled, managed_mode_enabled, managed_mode_risk_pct, managed_mode_daily_loss_limit_pct, sync_status, last_synced_at, last_error, health, last_error_code, closed_reason, source, account_type, created_at'
    )
    .eq('user_id', authData.user.id)
    // A connection with trade history is soft-disconnected (health flips
    // to 'closed', sync_status derives to 'disconnected' from it — see
    // sync_service.py's _DERIVED_SYNC_STATUS), never hard-deleted — see
    // DELETE /api/brokers/:id. Exclude it here so it disappears from the
    // user's list exactly as if it had been deleted, even though the row
    // (and its trade history) still exists.
    .neq('health', 'closed')
    .order('created_at', { ascending: false });

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not load broker connections.');
  }

  return apiSuccess({ connections: data });
}

/**
 * POST /api/brokers
 * Adds a new broker connection. The API key/secret are encrypted before
 * insert and never echoed back in the response — only a masked label is
 * returned so the UI can confirm what was saved without exposing the
 * real credential.
 */
export async function POST(request: NextRequest) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const body = await request.json();
  const parsed = addBrokerConnectionSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid broker connection data.', parsed.error.flatten());
  }

  const {
    broker,
    label,
    apiKey,
    apiSecret,
    apiPassphrase,
    mtLogin,
    mtServer,
    mtPlatform,
    mtPassword,
    stepUpApprovalId,
    vpRef,
    accountType,
  } = parsed.data;

  // Step-Up Auth Ticket 2 — "broker-credential-change flow", the other
  // highest-risk flow the spec names explicitly. resource_id is null: a
  // new connection has no id to reference until after this insert
  // succeeds. A user with neither a registered device (Ticket 1) nor an
  // active TOTP enrollment (Ticket 3) still has no way to ever produce
  // an 'approved' approval — both are opt-in, so this remains a real
  // gate some users haven't set up yet, not a fully resolved one.
  const stepUpOk = await isStepUpApproved({
    userId: authData.user.id,
    approvalToken: stepUpApprovalId,
    actionType: 'broker_credential_change',
    resourceId: null,
  });
  if (!stepUpOk) {
    return apiError('VALIDATION_ERROR', 'Adding a broker connection requires a confirmed step-up approval.');
  }

  // Exactly one of these two credential sets is present, enforced by
  // addBrokerConnectionSchema's .refine() checks above — apiKey/apiSecret
  // for everything except metatrader, mtLogin/mtServer/mtPassword only
  // for metatrader. metaapi_account_id/metaapi_region are deliberately
  // NOT set here — the Python poller provisions those on first sync.
  const encryptedKey = apiKey ? encrypt(apiKey) : null;
  const encryptedSecret = apiSecret ? encrypt(apiSecret) : null;
  const encryptedPassphrase = apiPassphrase ? encrypt(apiPassphrase) : null;
  const encryptedMtPassword = mtPassword ? encrypt(mtPassword) : null;

  const { data, error } = await supabase
    .from('broker_connections')
    .insert({
      user_id: authData.user.id,
      broker,
      label,
      encrypted_api_key: encryptedKey?.ciphertext ?? null,
      encrypted_api_secret: encryptedSecret?.ciphertext ?? null,
      api_key_iv: encryptedKey?.iv ?? null,
      api_secret_iv: encryptedSecret?.iv ?? null,
      encrypted_api_passphrase: encryptedPassphrase?.ciphertext ?? null,
      api_passphrase_iv: encryptedPassphrase?.iv ?? null,
      mt_login: mtLogin ?? null,
      mt_server: mtServer ?? null,
      mt_platform: mtPlatform ?? null,
      encrypted_mt_password: encryptedMtPassword?.ciphertext ?? null,
      mt_password_iv: encryptedMtPassword?.iv ?? null,
      is_read_only: true,
      sync_status: 'pending',
      source: vpRef ? 'partner_hantec' : 'manual',
      account_type: accountType ?? 'live',
    })
    .select('id, broker, label, sync_status, created_at')
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not save broker connection.');
  }

  // Partner Offers v1 — best-effort referral linking. An invalid/foreign
  // vpRef is logged and ignored rather than failing the request: the
  // broker connection itself is the important side effect, referral
  // attribution is secondary.
  if (vpRef) {
    const serviceClient = createServiceClient();
    const { data: referral } = await serviceClient
      .from('partner_referrals')
      .select('id, status')
      .eq('state_token', vpRef)
      .eq('user_id', authData.user.id)
      .maybeSingle();

    if (referral && referral.status !== 'connected') {
      const { error: linkError } = await serviceClient
        .from('partner_referrals')
        .update({ status: 'connected', connected_at: new Date().toISOString(), broker_connection_id: data.id })
        .eq('id', referral.id);

      if (linkError) {
        console.error('[brokers] Could not link partner referral:', linkError.message);
      } else {
        await serviceClient.from('usage_events').insert({
          user_id: authData.user.id,
          event_name: 'partner_account_connected',
          properties: { referral_id: referral.id, broker_connection_id: data.id },
        });
      }
    } else if (!referral) {
      console.error('[brokers] vpRef did not match a referral for this user:', vpRef);
    }
  }

  // A new connection changes what Aria would report (a new source of
  // holdings, or a fresh 'pending' health) — invalidate rather than
  // wait out the 60s TTL.
  await invalidateAriaContext(authData.user.id);

  return apiSuccess(
    {
      connection: data,
      maskedKey: apiKey ? maskKey(apiKey) : maskKey(mtLogin ?? ''),
    },
    201
  );
}
