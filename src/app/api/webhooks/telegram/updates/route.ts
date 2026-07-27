import { type NextRequest, NextResponse } from 'next/server';
import { verifyTelegramWebhookSecret, sendMessage, answerCallbackQuery, editMessageText } from '@/lib/telegram/api';
import { completeTelegramLink } from '@/lib/auth/telegram-link';
import { confirmStepUpViaTelegram } from '@/lib/auth/step-up';

/**
 * POST /api/webhooks/telegram/updates
 *
 * Step-Up Auth Ticket 4. Handles the two update shapes this integration
 * needs: a "/link CODE" message (completes account linking) and an
 * approve/deny inline-keyboard tap (callback_query, resolves a step-up
 * approval). Auth is Telegram's own secret_token mechanism — see
 * verifyTelegramWebhookSecret — not a Supabase session; there isn't one
 * here.
 *
 * NOT registered against a real bot yet: TELEGRAM_BOT_TOKEN/
 * TELEGRAM_WEBHOOK_SECRET aren't provisioned anywhere in this codebase's
 * env files, and no setWebhook call has been made. Same "real code,
 * pending real credentials" gap as Ticket 1's push infra.
 */
export async function POST(request: NextRequest) {
  const secretHeader = request.headers.get('x-telegram-bot-api-secret-token');
  if (!verifyTelegramWebhookSecret(secretHeader)) {
    return NextResponse.json({ error: 'Invalid webhook secret' }, { status: 401 });
  }

  const update = await request.json().catch(() => null);
  if (!update) {
    return NextResponse.json({ ok: true });
  }

  try {
    const messageText: string | undefined = update.message?.text;
    if (typeof messageText === 'string' && /^\/link\s+\S+/i.test(messageText.trim())) {
      const chatId = String(update.message.chat.id);
      const code = messageText.trim().split(/\s+/)[1]!;
      const outcome = await completeTelegramLink({ code, chatId });
      await sendMessage({
        chatId,
        text:
          outcome === 'linked'
            ? '✅ Linked. VaultPoint step-up approvals can now be sent here.'
            : '❌ That code is invalid or has expired. Generate a new one in the VaultPoint app.',
      });
      return NextResponse.json({ ok: true });
    }

    const callbackQuery = update.callback_query;
    const callbackData: string | undefined = callbackQuery?.data;
    if (callbackQuery && typeof callbackData === 'string') {
      const match = /^su:([0-9a-f-]{36}):(approve|deny)$/i.exec(callbackData);
      if (!match) {
        await answerCallbackQuery({ callbackQueryId: callbackQuery.id });
        return NextResponse.json({ ok: true });
      }

      const approvalRowId = match[1]!;
      const action = match[2]!;
      const chatId = String(callbackQuery.from.id);

      const outcome = await confirmStepUpViaTelegram({
        chatId,
        approvalRowId,
        decision: action.toLowerCase() === 'approve' ? 'approved' : 'denied',
      });

      const resultText = outcome.ok
        ? `Request ${outcome.status}.`
        : outcome.reason === 'NOT_LINKED'
          ? 'This chat is not linked to a VaultPoint account.'
          : 'This request could not be resolved (not found or expired).';

      await answerCallbackQuery({ callbackQueryId: callbackQuery.id, text: resultText });
      if (callbackQuery.message?.chat?.id && callbackQuery.message?.message_id) {
        await editMessageText({
          chatId: String(callbackQuery.message.chat.id),
          messageId: callbackQuery.message.message_id,
          text: resultText,
        });
      }
      return NextResponse.json({ ok: true });
    }
  } catch (err) {
    console.error('[webhooks/telegram/updates] error:', err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ ok: true });
}
