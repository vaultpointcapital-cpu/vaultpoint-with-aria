import { type NextRequest } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { encrypt } from '@/lib/encryption/broker-keys';
import { reauthorizeBrokerConnectionSchema } from '@/lib/validations/broker';
import { apiError, apiSuccess } from '@/lib/utils/api-response';

/**
 * POST /api/brokers/:id/authorize-execution
 *
 * Opts an existing, previously read-only broker connection into Signal
 * Mode trade execution. This is deliberately NOT a toggle on the
 * existing row's credentials — broker_connections.trade_execution_enabled
 * is DB CHECK-constrained to require is_read_only = false (see
 * supabase/migrations/20260718000000_add_signal_mode.sql), and the
 * credentials already on file were submitted as read-only-scoped keys
 * (POST /api/brokers hardcodes is_read_only: true on every connection —
 * there is no way to know, after the fact, whether a key the user
 * originally pasted actually carries trade permission). So this route
 * requires resubmitting credentials — the same fields
 * addBrokerConnectionSchema asks for on creation — and treats them as
 * the new trade-permission credentials for this connection, overwriting
 * the old ones.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient();
  const { data: authData, error: authError } = await supabase.auth.getUser();

  if (authError || !authData.user) {
    return apiError('UNAUTHORIZED', 'You must be logged in.');
  }

  const { data: existing, error: fetchError } = await supabase
    .from('broker_connections')
    .select('id, broker')
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .single();

  if (fetchError || !existing) {
    return apiError('NOT_FOUND', 'Broker connection not found or you do not have access to it.');
  }

  const body = await request.json();
  const parsed = reauthorizeBrokerConnectionSchema.safeParse(body);

  if (!parsed.success) {
    return apiError('VALIDATION_ERROR', 'Invalid re-authorization data.', parsed.error.flatten());
  }

  if (parsed.data.broker !== existing.broker) {
    return apiError(
      'VALIDATION_ERROR',
      `This connection is a ${existing.broker} connection — submitted credentials must match.`
    );
  }

  const { apiKey, apiSecret, apiPassphrase, mtLogin, mtServer, mtPlatform, mtPassword } = parsed.data;

  const encryptedKey = apiKey ? encrypt(apiKey) : null;
  const encryptedSecret = apiSecret ? encrypt(apiSecret) : null;
  const encryptedPassphrase = apiPassphrase ? encrypt(apiPassphrase) : null;
  const encryptedMtPassword = mtPassword ? encrypt(mtPassword) : null;

  const { data, error } = await supabase
    .from('broker_connections')
    .update({
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
      is_read_only: false,
      trade_execution_enabled: true,
      // The newly-submitted credentials haven't been validated against
      // the broker yet — same 'pending' state a brand new connection
      // starts in, resolved by the next poll cycle.
      sync_status: 'pending',
    })
    .eq('id', params.id)
    .eq('user_id', authData.user.id)
    .select('id, broker, label, is_read_only, trade_execution_enabled, sync_status, last_synced_at, last_error, created_at')
    .single();

  if (error) {
    return apiError('INTERNAL_ERROR', 'Could not re-authorize this connection.');
  }

  return apiSuccess({ connection: data });
}
