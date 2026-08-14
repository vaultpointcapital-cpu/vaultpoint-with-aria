import crypto from 'crypto';

/**
 * Thin Telegram Bot API client for Step-Up Auth Ticket 4. No SDK exists
 * in this project's dependencies — the Bot API is a handful of plain
 * HTTPS POSTs, not worth a new dependency for.
 *
 * TELEGRAM_BOT_TOKEN is not provisioned anywhere in this codebase's env
 * files (checked .env.example — same "blocker check first" rule Ticket
 * 1 followed for push credentials), so sendMessage/answerCallbackQuery/
 * editMessageText below are real, correct calls against Telegram's
 * actual API, but can't actually deliver anything until that token
 * exists. Never throws — same "a notification failure must never break
 * the calling flow" contract src/lib/email/send.ts already follows.
 */

function getBotToken(): string | null {
  return process.env.TELEGRAM_BOT_TOKEN ?? null;
}

/**
 * Telegram's documented webhook auth mechanism: the secret_token passed
 * to setWebhook is echoed back on every delivery as this header — a
 * plain shared-secret compare, same pattern as verifyVerifyMeSignature
 * in src/lib/kyc/verifyme.ts.
 */
export function verifyTelegramWebhookSecret(headerValue: string | null): boolean {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected || !headerValue) return false;

  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(headerValue, 'utf8');
  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

async function callTelegramApi(method: string, body: Record<string, unknown>): Promise<void> {
  const token = getBotToken();
  if (!token) {
    console.warn(`[telegram] TELEGRAM_BOT_TOKEN not set — skipping ${method}`, body);
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[telegram] ${method} failed: ${res.status} ${text}`);
    }
  } catch (err) {
    console.error(`[telegram] ${method} error:`, err instanceof Error ? err.message : err);
  }
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

/**
 * callback_data encodes "su:<approval row id>:<approve|deny>" — well
 * under Telegram's 64-byte callback_data limit (a uuid is 36 chars, so
 * the longest variant is 3 + 36 + 1 + 7 = 47 bytes).
 */
export function buildApproveDenyKeyboard(approvalId: string): { inline_keyboard: InlineKeyboardButton[][] } {
  return {
    inline_keyboard: [
      [
        { text: '✅ Approve', callback_data: `su:${approvalId}:approve` },
        { text: '❌ Deny', callback_data: `su:${approvalId}:deny` },
      ],
    ],
  };
}

export async function sendMessage(params: {
  chatId: string;
  text: string;
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] };
}): Promise<void> {
  await callTelegramApi('sendMessage', {
    chat_id: params.chatId,
    text: params.text,
    reply_markup: params.replyMarkup,
  });
}

export async function answerCallbackQuery(params: { callbackQueryId: string; text?: string }): Promise<void> {
  await callTelegramApi('answerCallbackQuery', { callback_query_id: params.callbackQueryId, text: params.text });
}

export async function editMessageText(params: { chatId: string; messageId: number; text: string }): Promise<void> {
  await callTelegramApi('editMessageText', { chat_id: params.chatId, message_id: params.messageId, text: params.text });
}
