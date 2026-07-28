import crypto from 'crypto';
import { createServiceClient } from '@/lib/supabase/server';
import { sendEmail } from '@/lib/email/send';
import { NewDeviceLoginTemplate } from '@/lib/email/templates/new-device-login';

export const LOGIN_DEVICE_COOKIE = 'vp_ldf';
export const LOGIN_DEVICE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // 1 year, seconds

function hashFingerprint(raw: string): string {
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex');
}

export interface CheckLoginDeviceParams {
  userId: string;
  userEmail: string;
  existingFingerprint: string | null;
  userAgent: string | null;
  ip: string;
  appUrl: string;
}

export interface CheckLoginDeviceResult {
  /** Value the caller should (re-)set in the LOGIN_DEVICE_COOKIE cookie. */
  fingerprint: string;
  isNewDevice: boolean;
}

/**
 * The real half of Ticket 6's "push + email on new device fingerprint" —
 * email is fully wired through Resend below. Push is NOT: no APNs/FCM
 * credentials exist anywhere in this codebase (the same gap Ticket 1's
 * device registration flagged), so there's nothing to actually send a
 * push notification through yet. Building a function that pretends to
 * send one would be a stub with no real effect, not a feature.
 *
 * A "device" is an opaque per-browser value the login route persists in
 * a long-lived httpOnly cookie — this function only ever sees its hash
 * once it exists. Not seeing that cookie at all (first-ever login on
 * this browser, or the cookie was cleared) always mints a fresh one.
 */
export async function checkAndRecordLoginDevice(params: CheckLoginDeviceParams): Promise<CheckLoginDeviceResult> {
  const supabase = createServiceClient();
  const fingerprint = params.existingFingerprint ?? crypto.randomUUID();
  const fingerprintHash = hashFingerprint(fingerprint);

  const { data: existing } = await supabase
    .from('login_device_fingerprints')
    .select('id')
    .eq('user_id', params.userId)
    .eq('fingerprint_hash', fingerprintHash)
    .maybeSingle();

  if (existing) {
    await supabase
      .from('login_device_fingerprints')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', existing.id);
    return { fingerprint, isNewDevice: false };
  }

  const { error } = await supabase.from('login_device_fingerprints').insert({
    user_id: params.userId,
    fingerprint_hash: fingerprintHash,
    user_agent: params.userAgent,
    first_seen_ip: params.ip,
  });

  if (error) {
    // Race: two requests from the same brand-new browser landed
    // concurrently — the loser hits the unique constraint, which just
    // means the winner already recorded (and is about to alert). Not an
    // error worth surfacing.
    if (error.code === '23505') return { fingerprint, isNewDevice: false };
    throw new Error(`Failed to record login device fingerprint: ${error.message}`);
  }

  await sendEmail({
    to: params.userEmail,
    subject: 'New login to your VaultPoint account',
    react: NewDeviceLoginTemplate({ appUrl: params.appUrl, ip: params.ip, userAgent: params.userAgent }),
    emailType: 'new-device-login',
  });

  return { fingerprint, isNewDevice: true };
}
