import crypto from 'crypto';
import { createServiceClient } from '@/lib/supabase/server';

const LINK_CODE_TTL_SECONDS = 60 * 10; // 10 minutes
const LINK_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I — avoids the classic typed-code ambiguity

function generateLinkCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (const byte of bytes) {
    code += LINK_CODE_ALPHABET[byte % LINK_CODE_ALPHABET.length];
  }
  return code;
}

export interface InitiateTelegramLinkResult {
  code: string;
  expiresAt: string;
}

/** Shown in-app; the user sends it to the bot as "/link CODE" to prove they own that chat. */
export async function initiateTelegramLink(userId: string): Promise<InitiateTelegramLinkResult> {
  const supabase = createServiceClient();
  const expiresAt = new Date(Date.now() + LINK_CODE_TTL_SECONDS * 1000);

  // Astronomically unlikely to collide (32^8 space), but the unique
  // constraint exists for exactly this — retry once on the 1-in-a-
  // trillion chance rather than trusting probability alone.
  for (let attempt = 0; attempt < 3; attempt++) {
    const code = generateLinkCode();
    const { error } = await supabase.from('telegram_link_codes').insert({
      user_id: userId,
      code,
      expires_at: expiresAt.toISOString(),
    });
    if (!error) return { code, expiresAt: expiresAt.toISOString() };
    if (error.code !== '23505') throw new Error(`Failed to create Telegram link code: ${error.message}`);
  }
  throw new Error('Failed to generate a unique Telegram link code after 3 attempts');
}

export type CompleteTelegramLinkOutcome = 'linked' | 'invalid_or_expired_code';

/**
 * Called from the webhook when a "/link CODE" message arrives. A chat
 * is treated as belonging to whichever user most recently linked it —
 * same reassignment reasoning as user_devices (Ticket 1) — so
 * re-linking an already-linked chat to a different user's code just
 * reassigns it rather than erroring.
 */
export async function completeTelegramLink(params: { code: string; chatId: string }): Promise<CompleteTelegramLinkOutcome> {
  const supabase = createServiceClient();
  const normalizedCode = params.code.trim().toUpperCase();

  const { data: codeRow } = await supabase
    .from('telegram_link_codes')
    .select('id, user_id, expires_at, consumed_at')
    .eq('code', normalizedCode)
    .maybeSingle();

  if (!codeRow || codeRow.consumed_at || new Date(codeRow.expires_at).getTime() < Date.now()) {
    return 'invalid_or_expired_code';
  }

  const { error: consumeError } = await supabase
    .from('telegram_link_codes')
    .update({ consumed_at: new Date().toISOString() })
    .eq('id', codeRow.id)
    .is('consumed_at', null); // idempotency guard against a racing double-delivery of the same message

  if (consumeError) throw new Error(`Failed to consume Telegram link code: ${consumeError.message}`);

  // Delete any row that would collide on either unique constraint first
  // (this user's existing link to a different chat, or this chat's
  // existing link to a different user) rather than upserting — a plain
  // upsert-on-user_id-conflict can't also resolve a simultaneous
  // chat_id collision without a second, error-prone step. Two separate
  // calls rather than one .or() filter — avoids building a PostgREST
  // filter string by hand for values that don't strictly need to share
  // one round trip.
  await supabase.from('telegram_links').delete().eq('user_id', codeRow.user_id);
  await supabase.from('telegram_links').delete().eq('chat_id', params.chatId);

  const { error: linkError } = await supabase
    .from('telegram_links')
    .insert({ user_id: codeRow.user_id, chat_id: params.chatId });
  if (linkError) throw new Error(`Failed to create Telegram link: ${linkError.message}`);

  return 'linked';
}

export async function getUserIdForChatId(chatId: string): Promise<string | null> {
  const supabase = createServiceClient();
  const { data } = await supabase.from('telegram_links').select('user_id').eq('chat_id', chatId).maybeSingle();
  return data?.user_id ?? null;
}

export async function getChatIdForUser(userId: string): Promise<string | null> {
  const supabase = createServiceClient();
  const { data } = await supabase.from('telegram_links').select('chat_id').eq('user_id', userId).maybeSingle();
  return data?.chat_id ?? null;
}
