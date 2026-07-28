import crypto from 'crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { encrypt } from '@/lib/encryption/broker-keys';
import type { DevicePlatform } from '@/types/database';

/**
 * Registers (or re-registers) a push-notification device token.
 *
 * The token is encrypted at rest (src/lib/encryption/broker-keys.ts —
 * same AES-256-GCM module broker credentials use), but that module uses
 * a random IV per call, so re-encrypting the same raw token twice
 * produces different ciphertext. device_token_hash (a plain SHA-256 of
 * the raw token) is the only way to detect "this exact device already
 * registered" without decrypting every existing row to compare — the
 * DB's unique constraint on that column is what actually enforces
 * one-row-per-physical-device.
 *
 * A device token is treated as belonging to whichever user most
 * recently registered it, not permanently tied to the first one — if a
 * different VaultPoint user logs in on the same physical device later,
 * re-registration re-assigns this row rather than erroring or creating
 * a duplicate.
 */
export async function registerDevice(params: {
  userId: string;
  deviceToken: string;
  platform: DevicePlatform;
}): Promise<{ deviceId: string }> {
  const supabase = createServiceClient();
  const tokenHash = crypto.createHash('sha256').update(params.deviceToken, 'utf8').digest('hex');
  const encrypted = encrypt(params.deviceToken);
  const now = new Date().toISOString();

  const { data: existing } = await supabase
    .from('user_devices')
    .select('id')
    .eq('device_token_hash', tokenHash)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('user_devices')
      .update({
        user_id: params.userId,
        platform: params.platform,
        encrypted_device_token: encrypted.ciphertext,
        device_token_iv: encrypted.iv,
        last_seen_at: now,
      })
      .eq('id', existing.id);
    if (error) throw new Error(`Failed to update device registration: ${error.message}`);
    return { deviceId: existing.id };
  }

  const { data: created, error } = await supabase
    .from('user_devices')
    .insert({
      user_id: params.userId,
      platform: params.platform,
      encrypted_device_token: encrypted.ciphertext,
      device_token_iv: encrypted.iv,
      device_token_hash: tokenHash,
      last_seen_at: now,
    })
    .select('id')
    .single();

  if (error) {
    // Race: another request registered the same token between our
    // select and insert — re-fetch and reassign rather than surface a
    // spurious 500 for what is functionally the same "already
    // registered" case handled above.
    if (error.code === '23505') {
      const { data: raced } = await supabase
        .from('user_devices')
        .select('id')
        .eq('device_token_hash', tokenHash)
        .single();
      if (raced) {
        await supabase
          .from('user_devices')
          .update({ user_id: params.userId, platform: params.platform, last_seen_at: now })
          .eq('id', raced.id);
        return { deviceId: raced.id };
      }
    }
    throw new Error(`Failed to register device: ${error.message}`);
  }

  return { deviceId: created.id };
}
