// Proves the Step-Up Auth Ticket 4 Telegram linking + approve/deny
// callback flow end-to-end against the running dev server (real HTTP).
// The webhook itself isn't authenticated via a Supabase session — only
// Telegram's own secret_token header — so those calls go in unauthenticated,
// simulating exactly what Telegram would POST. Runs against SHADOW — same
// reasoning as scripts/test-step-up-flow.mjs's header comment: this
// migration has only been applied to shadow, and the dev server this hits
// must itself be started with NEXT_PUBLIC_SUPABASE_URL/ANON_KEY and
// SUPABASE_SERVICE_ROLE_KEY overridden to the SHADOW_* values below.
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';

for (const line of readFileSync('.env.local', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] = m[2];
}

const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3004';
const supabaseUrl = process.env.SHADOW_SUPABASE_URL;
const admin = createClient(supabaseUrl, process.env.SHADOW_SUPABASE_SERVICE_ROLE_KEY);
const anonKey = process.env.SHADOW_SUPABASE_ANON_KEY;
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;

let failures = 0;
function report(label, condition, detail) {
  if (condition) console.log(`  PASS  ${label}`);
  else { console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`); failures += 1; }
}

function cookieHeaderFor(session) {
  const projectRef = new URL(supabaseUrl).hostname.split('.')[0];
  const cookieValue = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64');
  return `sb-${projectRef}-auth-token=${cookieValue}`;
}

async function call(method, path, session, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (session) headers['Cookie'] = cookieHeaderFor(session);
  const res = await fetch(`${BASE_URL}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function callWebhook(update, { badSecret = false, noSecret = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (!noSecret) headers['X-Telegram-Bot-Api-Secret-Token'] = badSecret ? 'wrong-secret' : WEBHOOK_SECRET;
  const res = await fetch(`${BASE_URL}/api/webhooks/telegram/updates`, { method: 'POST', headers, body: JSON.stringify(update) });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function approvalRowIdFrom(jwt) {
  const [, payloadB64] = jwt.split('.');
  return JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')).sub;
}

let updateId = 1;
function messageUpdate(chatId, text) {
  return { update_id: updateId++, message: { message_id: updateId, chat: { id: chatId }, text, date: Math.floor(Date.now() / 1000) } };
}
function callbackUpdate({ callbackQueryId, fromId, chatId, messageId, data }) {
  return {
    update_id: updateId++,
    callback_query: {
      id: callbackQueryId,
      from: { id: fromId },
      message: { message_id: messageId, chat: { id: chatId } },
      data,
    },
  };
}

async function main() {
  const password = 'TelegramFlowTest!2026x';
  const { data: user } = await admin.auth.admin.createUser({
    email: `telegram-flow-test-${Date.now()}@example.com`,
    password,
    email_confirm: true,
  });
  const anon = createClient(supabaseUrl, anonKey);
  const { data: session } = await anon.auth.signInWithPassword({ email: user.user.email, password });
  const fakeChatId = 900000000 + Math.floor(Math.random() * 1000000);

  try {
    const unauthInitiate = await call('POST', '/api/auth/telegram/link/initiate', null);
    report('unauthenticated link initiate is rejected', unauthInitiate.status === 401);

    const noSecret = await callWebhook(messageUpdate(fakeChatId, '/link ABCD1234'), { noSecret: true });
    report('webhook with no secret header is rejected', noSecret.status === 401);
    const wrongSecret = await callWebhook(messageUpdate(fakeChatId, '/link ABCD1234'), { badSecret: true });
    report('webhook with the wrong secret header is rejected', wrongSecret.status === 401);

    const initiate = await call('POST', '/api/auth/telegram/link/initiate', session.session);
    report('link initiate succeeds (201)', initiate.status === 201, JSON.stringify(initiate.body));
    report('link initiate returns a code and expiry', !!initiate.body?.code && !!initiate.body?.expires_at, JSON.stringify(initiate.body));

    const badLink = await callWebhook(messageUpdate(fakeChatId, '/link WRONGCODE'));
    report('webhook accepts a bad-code /link message with 200 (Telegram contract)', badLink.status === 200);

    const { data: rowBeforeLink } = await admin.from('telegram_links').select('id').eq('chat_id', String(fakeChatId)).maybeSingle();
    report('a wrong code does not create a link', !rowBeforeLink);

    const goodLink = await callWebhook(messageUpdate(fakeChatId, `/link ${initiate.body.code}`));
    report('webhook accepts a correct /link message', goodLink.status === 200);

    const { data: rowAfterLink } = await admin.from('telegram_links').select('user_id').eq('chat_id', String(fakeChatId)).maybeSingle();
    report('a correct code creates the link to the right user', rowAfterLink?.user_id === user.user.id, JSON.stringify(rowAfterLink));

    const init = await call('POST', '/api/auth/step-up/initiate', session.session, { action_type: 'test-telegram' });
    report('step-up initiate now offers telegram as a method', init.body?.methods?.includes('telegram'), JSON.stringify(init.body));

    const approvalRowId = approvalRowIdFrom(init.body.approval_id);

    const malformedCallback = await callWebhook(
      callbackUpdate({ callbackQueryId: 'cbq-1', fromId: fakeChatId, chatId: fakeChatId, messageId: 1, data: 'not-a-real-callback' })
    );
    report('a malformed callback_data is accepted (200) without resolving anything', malformedCallback.status === 200);

    const statusStillPending = await call('GET', `/api/auth/step-up/status/${encodeURIComponent(init.body.approval_id)}`, session.session);
    report('approval is still pending after a malformed callback', statusStillPending.body?.status === 'pending', JSON.stringify(statusStillPending.body));

    const unlinkedCallback = await callWebhook(
      callbackUpdate({ callbackQueryId: 'cbq-2', fromId: 111222333, chatId: 111222333, messageId: 2, data: `su:${approvalRowId}:approve` })
    );
    report('a callback from an unlinked chat is accepted (200) without resolving anything', unlinkedCallback.status === 200);

    const statusStillPending2 = await call('GET', `/api/auth/step-up/status/${encodeURIComponent(init.body.approval_id)}`, session.session);
    report('approval is still pending after an unlinked-chat callback', statusStillPending2.body?.status === 'pending', JSON.stringify(statusStillPending2.body));

    const approveCallback = await callWebhook(
      callbackUpdate({ callbackQueryId: 'cbq-3', fromId: fakeChatId, chatId: fakeChatId, messageId: 3, data: `su:${approvalRowId}:approve` })
    );
    report('a real approve tap from the linked chat is accepted', approveCallback.status === 200);

    const statusApproved = await call('GET', `/api/auth/step-up/status/${encodeURIComponent(init.body.approval_id)}`, session.session);
    report('approval resolved to approved via Telegram', statusApproved.body?.status === 'approved', JSON.stringify(statusApproved.body));

    const replayDeny = await callWebhook(
      callbackUpdate({ callbackQueryId: 'cbq-4', fromId: fakeChatId, chatId: fakeChatId, messageId: 3, data: `su:${approvalRowId}:deny` })
    );
    report('a second tap (deny) on an already-resolved approval is accepted (200)', replayDeny.status === 200);

    const statusStillApproved = await call('GET', `/api/auth/step-up/status/${encodeURIComponent(init.body.approval_id)}`, session.session);
    report('idempotent: a later deny tap cannot flip an already-approved approval', statusStillApproved.body?.status === 'approved', JSON.stringify(statusStillApproved.body));

    const init2 = await call('POST', '/api/auth/step-up/initiate', session.session, { action_type: 'test-telegram' });
    const approvalRowId2 = approvalRowIdFrom(init2.body.approval_id);
    await callWebhook(callbackUpdate({ callbackQueryId: 'cbq-5', fromId: fakeChatId, chatId: fakeChatId, messageId: 4, data: `su:${approvalRowId2}:deny` }));
    const statusDenied = await call('GET', `/api/auth/step-up/status/${encodeURIComponent(init2.body.approval_id)}`, session.session);
    report('a deny tap resolves the approval to denied', statusDenied.body?.status === 'denied', JSON.stringify(statusDenied.body));
  } finally {
    await admin.from('step_up_audit_log').delete().eq('user_id', user.user.id);
    await admin.from('step_up_approvals').delete().eq('user_id', user.user.id);
    await admin.from('telegram_link_codes').delete().eq('user_id', user.user.id);
    await admin.from('telegram_links').delete().eq('user_id', user.user.id);
    await admin.auth.admin.deleteUser(user.user.id).catch(() => {});
  }

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log('\nAll Telegram step-up flow checks passed.');
}

main().catch((err) => {
  console.error('Unhandled error:', err);
  process.exit(1);
});
