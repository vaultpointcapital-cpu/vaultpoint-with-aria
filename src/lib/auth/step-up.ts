import crypto from 'crypto';
import { SignJWT, jwtVerify, errors as joseErrors, type JWTPayload } from 'jose';
import { createServiceClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/encryption/broker-keys';
import { hasActiveTotpEnrollment, verifyActiveTotpCode } from '@/lib/auth/totp-enrollment';
import { getChatIdForUser, getUserIdForChatId } from '@/lib/auth/telegram-link';
import { sendMessage, buildApproveDenyKeyboard } from '@/lib/telegram/api';
import type { StepUpMethod, StepUpStatus } from '@/types/database';

const TTL_SECONDS = 90;

function getSecret(): Uint8Array {
  const secret = process.env.STEP_UP_JWT_SECRET;
  if (!secret) {
    throw new Error('STEP_UP_JWT_SECRET is not set. Generate one with `openssl rand -hex 32`.');
  }
  return new TextEncoder().encode(secret);
}

interface ApprovalTokenPayload extends JWTPayload {
  sub: string; // step_up_approvals.id
  user_id: string;
  action_type: string;
  resource_id: string | null;
}

async function signApprovalToken(payload: Omit<ApprovalTokenPayload, 'exp' | 'iat'>): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);
  const token = await new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(getSecret());
  return { token, expiresAt };
}

/**
 * Verifies the approval_id JWT's signature and decodes its claims. An
 * expired-but-validly-signed token is NOT treated as invalid here — the
 * underlying step_up_approvals row's own expires_at is the authoritative
 * source for whether an approval can still be resolved (confirm_step_up_
 * approval() checks it independently), so this only rejects a token that
 * was tampered with or malformed, never one that's merely past its exp.
 */
async function decodeApprovalToken(token: string): Promise<ApprovalTokenPayload> {
  try {
    const { payload } = await jwtVerify(token, getSecret());
    return payload as ApprovalTokenPayload;
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      return err.payload as ApprovalTokenPayload;
    }
    throw err;
  }
}

export interface InitiateStepUpResult {
  approvalId: string;
  // The raw step_up_approvals.id — distinct from approvalId (a signed
  // JWT whose `sub` claim happens to equal this value, but which no
  // caller should ever parse to recover it). Added for the Decision
  // Gate's manual-account alert route, which needs a real uuid to store
  // as decision_gate_log.step_up_approval_id's FK target — a JWT string
  // cannot satisfy that column's uuid type. Existing callers are
  // unaffected; this is purely additive.
  approvalRowId: string;
  expiresAt: string;
  methods: StepUpMethod[];
}

/**
 * Creates a pending step-up approval and mints its signed approval_id.
 *
 * `methods` reflects what confirm() can actually verify today, not what
 * the spec's endpoint contract lists: 'push' is offered only if the user
 * has at least one registered device (src/lib/auth/devices.ts) — confirm
 * verifies it against that device's raw token (see verifyPushResponse
 * below), a real check, not a stub. 'totp' is offered only if the user
 * has an ACTIVE TOTP enrollment (Ticket 3 — src/lib/auth/totp-enrollment.ts).
 * 'telegram' is offered whenever the user has linked a chat (Ticket 4 —
 * src/lib/auth/telegram-link.ts): approve/deny happens via inline
 * keyboard buttons sent below, resolved entirely server-side by
 * POST /api/webhooks/telegram/updates — see confirmStepUpViaTelegram.
 * A user with none of the three gets methods: [] and has no way to ever
 * resolve this approval, same known trade-off as the KYC-gated funding
 * flow.
 */
export async function initiateStepUp(params: {
  userId: string;
  actionType: string;
  resourceId?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<InitiateStepUpResult> {
  const supabase = createServiceClient();

  const [devicesResult, totpActive, telegramChatId] = await Promise.all([
    supabase.from('user_devices').select('id', { count: 'exact', head: true }).eq('user_id', params.userId),
    hasActiveTotpEnrollment(params.userId),
    getChatIdForUser(params.userId),
  ]);

  const methods: StepUpMethod[] = [
    ...(devicesResult.count && devicesResult.count > 0 ? (['push'] as const) : []),
    ...(totpActive ? (['totp'] as const) : []),
    ...(telegramChatId ? (['telegram'] as const) : []),
  ];
  const expiresAt = new Date(Date.now() + TTL_SECONDS * 1000);

  const { data: row, error } = await supabase
    .from('step_up_approvals')
    .insert({
      user_id: params.userId,
      action_type: params.actionType,
      resource_id: params.resourceId ?? null,
      metadata: params.metadata ?? {},
      methods,
      expires_at: expiresAt.toISOString(),
    })
    .select('id, expires_at')
    .single();

  if (error) throw new Error(`Failed to create step-up approval: ${error.message}`);

  const { token } = await signApprovalToken({
    sub: row.id,
    user_id: params.userId,
    action_type: params.actionType,
    resource_id: params.resourceId ?? null,
  });

  if (telegramChatId) {
    await sendMessage({
      chatId: telegramChatId,
      text: `VaultPoint: approve this ${params.actionType} request? Expires in 90 seconds.`,
      replyMarkup: buildApproveDenyKeyboard(row.id),
    });
  }

  return { approvalId: token, approvalRowId: row.id, expiresAt: row.expires_at, methods };
}

/**
 * Proves the confirm caller holds the raw device token registered in
 * Ticket 1 — HMAC-SHA256(key: raw device token, message: approval_id),
 * hex-encoded. Checked against every device registered to the user
 * (there's no device_id in the spec's /confirm payload to narrow it down
 * to one) since a match against any one of them is a legitimate approval
 * from a device this user actually registered.
 *
 * This is deliberately NOT the asymmetric per-device signature a real
 * push-approval flow would use (challenge signed with a device-held
 * private key, verified against a registered public key) — Ticket 1 only
 * stored an opaque encrypted push token for outbound send, never a
 * keypair. Flagged as a real gap, not silently papered over.
 */
async function verifyPushResponse(params: { userId: string; approvalId: string; signedResponse: string }): Promise<boolean> {
  const supabase = createServiceClient();
  const { data: devices } = await supabase
    .from('user_devices')
    .select('encrypted_device_token, device_token_iv')
    .eq('user_id', params.userId);

  if (!devices || devices.length === 0) return false;

  const receivedBuffer = Buffer.from(params.signedResponse.toLowerCase(), 'utf8');

  for (const device of devices) {
    let rawToken: string;
    try {
      rawToken = decrypt({ ciphertext: device.encrypted_device_token, iv: device.device_token_iv });
    } catch {
      continue; // a corrupt/unrecoverable row shouldn't block checking the rest
    }
    const expected = crypto.createHmac('sha256', rawToken).update(params.approvalId, 'utf8').digest('hex');
    const expectedBuffer = Buffer.from(expected, 'utf8');
    if (expectedBuffer.length === receivedBuffer.length && crypto.timingSafeEqual(expectedBuffer, receivedBuffer)) {
      return true;
    }
  }
  return false;
}

export type ConfirmStepUpOutcome =
  | { ok: true; status: StepUpStatus }
  | { ok: false; reason: 'NOT_FOUND' | 'METHOD_NOT_OFFERED' | 'INVALID_TOKEN' };

/**
 * Resolves a pending approval. Idempotent redelivery of the same
 * approval_id (already approved/denied/expired) returns the existing
 * outcome untouched — confirm_step_up_approval() enforces that at the DB
 * level under a row lock, not just here.
 */
export async function confirmStepUp(params: {
  userId: string;
  approvalToken: string;
  method: StepUpMethod;
  signedResponse?: string;
  totpCode?: string;
}): Promise<ConfirmStepUpOutcome> {
  let payload: ApprovalTokenPayload;
  try {
    payload = await decodeApprovalToken(params.approvalToken);
  } catch {
    return { ok: false, reason: 'INVALID_TOKEN' };
  }

  const supabase = createServiceClient();
  const { data: row } = await supabase
    .from('step_up_approvals')
    .select('id, status, methods')
    .eq('id', payload.sub)
    .eq('user_id', params.userId)
    .maybeSingle();

  if (!row) return { ok: false, reason: 'NOT_FOUND' };

  // Only gate on "method offered" while still pending — an
  // already-resolved approval always short-circuits to its existing
  // outcome inside the RPC regardless of what's passed, so re-checking
  // this here would incorrectly block a harmless idempotent re-confirm.
  if (row.status === 'pending' && !row.methods.includes(params.method)) {
    return { ok: false, reason: 'METHOD_NOT_OFFERED' };
  }

  let decision: StepUpStatus = 'denied';
  if (row.status === 'pending') {
    if (params.method === 'push' && params.signedResponse) {
      const verified = await verifyPushResponse({
        userId: params.userId,
        approvalId: params.approvalToken,
        signedResponse: params.signedResponse,
      });
      decision = verified ? 'approved' : 'denied';
    } else if (params.method === 'totp' && params.totpCode) {
      const verified = await verifyActiveTotpCode({ userId: params.userId, code: params.totpCode });
      decision = verified ? 'approved' : 'denied';
    }
  }

  const { data: result, error } = await supabase.rpc('confirm_step_up_approval', {
    p_approval_id: row.id,
    p_user_id: params.userId,
    p_decision: decision,
    p_method: params.method,
  });

  const [resolved] = result ?? [];
  if (error || !resolved) {
    throw new Error(`Failed to resolve step-up approval: ${error?.message ?? 'no row returned'}`);
  }

  return { ok: true, status: resolved.out_status };
}

export type ConfirmViaTelegramOutcome =
  | { ok: true; status: StepUpStatus }
  | { ok: false; reason: 'NOT_LINKED' | 'NOT_FOUND' | 'METHOD_NOT_OFFERED' };

/**
 * Called by POST /api/webhooks/telegram/updates for a callback_query —
 * never by an authenticated HTTP caller (there's no session here, only
 * Telegram's own webhook secret and the chat_id the callback arrived
 * from). The proof of authorization IS that combination: the webhook
 * route already verified the request came from Telegram, and this
 * checks the chat_id maps to the approval's own user — nothing else
 * (no signature, no code) gates the decision, since which inline button
 * was tapped already IS the user's decision.
 */
export async function confirmStepUpViaTelegram(params: {
  chatId: string;
  approvalRowId: string;
  decision: 'approved' | 'denied';
}): Promise<ConfirmViaTelegramOutcome> {
  const userId = await getUserIdForChatId(params.chatId);
  if (!userId) return { ok: false, reason: 'NOT_LINKED' };

  const supabase = createServiceClient();
  const { data: row } = await supabase
    .from('step_up_approvals')
    .select('id, status, methods')
    .eq('id', params.approvalRowId)
    .eq('user_id', userId)
    .maybeSingle();

  if (!row) return { ok: false, reason: 'NOT_FOUND' };
  if (row.status === 'pending' && !row.methods.includes('telegram')) {
    return { ok: false, reason: 'METHOD_NOT_OFFERED' };
  }

  const { data: result, error } = await supabase.rpc('confirm_step_up_approval', {
    p_approval_id: row.id,
    p_user_id: userId,
    p_decision: params.decision,
    p_method: 'telegram',
  });

  const [resolved] = result ?? [];
  if (error || !resolved) {
    throw new Error(`Failed to resolve step-up approval via Telegram: ${error?.message ?? 'no row returned'}`);
  }

  return { ok: true, status: resolved.out_status };
}

export interface StepUpApprovalStatus {
  status: StepUpStatus;
  createdAt: string;
  resolvedAt: string | null;
}

/**
 * Read-only status lookup. A pending row past its own expires_at is
 * reported as 'expired' without writing that back — the row only
 * actually flips to 'expired' in the DB the next time confirm() runs
 * against it (or a future cleanup sweep), same lazy-expiry approach used
 * elsewhere in this codebase (e.g. KYC's expires_at check).
 */
export async function getStepUpApprovalStatus(params: {
  userId: string;
  approvalToken: string;
}): Promise<StepUpApprovalStatus | null> {
  let payload: ApprovalTokenPayload;
  try {
    payload = await decodeApprovalToken(params.approvalToken);
  } catch {
    return null;
  }

  const supabase = createServiceClient();
  const { data: row } = await supabase
    .from('step_up_approvals')
    .select('status, expires_at, created_at, resolved_at')
    .eq('id', payload.sub)
    .eq('user_id', params.userId)
    .maybeSingle();

  if (!row) return null;

  const effectiveStatus: StepUpStatus =
    row.status === 'pending' && new Date(row.expires_at).getTime() < Date.now() ? 'expired' : row.status;

  return { status: effectiveStatus, createdAt: row.created_at, resolvedAt: row.resolved_at };
}

/**
 * The check withdrawal/broker-credential-change routes gate on: is there
 * a step-up approval, belonging to this user, for exactly this
 * action_type + resource_id, that resolved to 'approved'? Verifies the
 * JWT signature too (not just the DB row) so a forged approval_id whose
 * `sub` happens to guess a real row id still can't pass — the row lookup
 * alone isn't the security boundary, the signature is.
 */
export async function isStepUpApproved(params: {
  userId: string;
  approvalToken: string;
  actionType: string;
  resourceId?: string | null;
}): Promise<boolean> {
  let payload: ApprovalTokenPayload;
  try {
    payload = await jwtVerify(params.approvalToken, getSecret()).then((r) => r.payload as ApprovalTokenPayload);
  } catch {
    return false; // includes genuinely expired tokens — approving a withdrawal needs a live, unexpired approval
  }

  if (payload.user_id !== params.userId || payload.action_type !== params.actionType) return false;
  if ((payload.resource_id ?? null) !== (params.resourceId ?? null)) return false;

  const supabase = createServiceClient();
  const { data: row } = await supabase
    .from('step_up_approvals')
    .select('status, expires_at')
    .eq('id', payload.sub)
    .eq('user_id', params.userId)
    .maybeSingle();

  if (!row || row.status !== 'approved') return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  return true;
}
