import { createServiceClient } from '@/lib/supabase/server';
import { encrypt, decrypt } from '@/lib/encryption/broker-keys';
import { generateTotpSecret, buildOtpauthUri, base32Encode, verifyTotpCode } from '@/lib/auth/totp';

export interface EnrollTotpResult {
  otpauthUrl: string;
  /** Base32 form, for manual entry when the user can't scan the QR code the client renders from otpauthUrl. */
  secretBase32: string;
}

/**
 * Issues a new pending enrollment, replacing any existing one for this
 * user (there's no separate "disable TOTP" flow in this ticket's scope —
 * see the migration's own comment). Not active until verifyTotpEnrollment
 * confirms the user's authenticator app actually has the secret.
 */
export async function enrollTotp(params: { userId: string; userEmail: string }): Promise<EnrollTotpResult> {
  const secret = generateTotpSecret();
  // encrypt() takes a plaintext string — hex-encode the raw secret bytes
  // first, same as how broker credentials (which are already strings)
  // pass straight through.
  const encrypted = encrypt(secret.toString('hex'));
  const supabase = createServiceClient();

  const { error } = await supabase.from('totp_enrollments').upsert(
    {
      user_id: params.userId,
      encrypted_secret: encrypted.ciphertext,
      secret_iv: encrypted.iv,
      status: 'pending',
      last_consumed_counter: null,
      activated_at: null,
    },
    { onConflict: 'user_id' }
  );
  if (error) throw new Error(`Failed to create TOTP enrollment: ${error.message}`);

  return {
    otpauthUrl: buildOtpauthUri({ secret, accountEmail: params.userEmail }),
    secretBase32: base32Encode(secret),
  };
}

export type VerifyTotpEnrollmentOutcome = 'activated' | 'already_active' | 'invalid_code' | 'not_enrolled';

/**
 * Confirms enrollment: a valid code proves the user's authenticator app
 * really has the secret this codebase generated, not just that they
 * clicked through the QR screen. A code that's already valid for an
 * enrollment that's already active still advances last_consumed_counter
 * (so it can't be replayed later against a step-up challenge) but
 * reports 'already_active' rather than re-activating.
 */
export async function verifyTotpEnrollment(params: { userId: string; code: string }): Promise<VerifyTotpEnrollmentOutcome> {
  const supabase = createServiceClient();
  const { data: row } = await supabase.from('totp_enrollments').select('*').eq('user_id', params.userId).maybeSingle();
  if (!row) return 'not_enrolled';

  const secret = Buffer.from(decrypt({ ciphertext: row.encrypted_secret, iv: row.secret_iv }), 'hex');
  const result = verifyTotpCode({ secret, code: params.code, lastConsumedCounter: row.last_consumed_counter });
  if (!result.valid) return 'invalid_code';

  const wasAlreadyActive = row.status === 'active';
  const { error } = await supabase
    .from('totp_enrollments')
    .update({
      status: 'active',
      last_consumed_counter: result.matchedCounter,
      activated_at: row.activated_at ?? new Date().toISOString(),
    })
    .eq('id', row.id);
  if (error) throw new Error(`Failed to activate TOTP enrollment: ${error.message}`);

  return wasAlreadyActive ? 'already_active' : 'activated';
}

/** What src/lib/auth/step-up.ts's initiateStepUp checks to decide whether 'totp' belongs in an approval's offered methods. */
export async function hasActiveTotpEnrollment(userId: string): Promise<boolean> {
  const supabase = createServiceClient();
  const { count } = await supabase
    .from('totp_enrollments')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('status', 'active');
  return !!count && count > 0;
}

/** What src/lib/auth/step-up.ts's confirmStepUp calls for method 'totp'. Advances last_consumed_counter on success — same anti-replay guarantee as enrollment verification. */
export async function verifyActiveTotpCode(params: { userId: string; code: string }): Promise<boolean> {
  const supabase = createServiceClient();
  const { data: row } = await supabase
    .from('totp_enrollments')
    .select('*')
    .eq('user_id', params.userId)
    .eq('status', 'active')
    .maybeSingle();
  if (!row) return false;

  const secret = Buffer.from(decrypt({ ciphertext: row.encrypted_secret, iv: row.secret_iv }), 'hex');
  const result = verifyTotpCode({ secret, code: params.code, lastConsumedCounter: row.last_consumed_counter });
  if (!result.valid) return false;

  await supabase.from('totp_enrollments').update({ last_consumed_counter: result.matchedCounter }).eq('id', row.id);
  return true;
}
