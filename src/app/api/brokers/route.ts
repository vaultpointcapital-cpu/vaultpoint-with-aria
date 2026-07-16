import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encrypt, maskKey } from '@/lib/encryption/broker-keys';
import { addBrokerConnectionSchema } from '@/lib/validations/broker';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

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
    .select('id, broker, label, is_read_only, sync_status, last_synced_at, last_error, created_at')
    .eq('user_id', authData.user.id)
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

  const { broker, label, apiKey, apiSecret, apiPassphrase, mtLogin, mtServer, mtPlatform, mtPassword } =
    parsed.data;

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
    })
    .select('id, broker, label, sync_status, created_at')
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not save broker connection.');
  }

  return apiSuccess(
    {
      connection: data,
      maskedKey: apiKey ? maskKey(apiKey) : maskKey(mtLogin ?? ''),
    },
    201
  );
}
