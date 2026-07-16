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

  const { broker, label, apiKey, apiSecret, apiPassphrase } = parsed.data;

  const encryptedKey = encrypt(apiKey);
  const encryptedSecret = encrypt(apiSecret);
  const encryptedPassphrase = apiPassphrase ? encrypt(apiPassphrase) : null;

  const { data, error } = await supabase
    .from('broker_connections')
    .insert({
      user_id: authData.user.id,
      broker,
      label,
      encrypted_api_key: encryptedKey.ciphertext,
      encrypted_api_secret: encryptedSecret.ciphertext,
      api_key_iv: encryptedKey.iv,
      api_secret_iv: encryptedSecret.iv,
      encrypted_api_passphrase: encryptedPassphrase?.ciphertext ?? null,
      api_passphrase_iv: encryptedPassphrase?.iv ?? null,
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
      maskedKey: maskKey(apiKey),
    },
    201
  );
}
