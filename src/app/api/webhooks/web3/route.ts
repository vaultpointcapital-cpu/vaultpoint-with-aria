import crypto from 'crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { claimWebhookEventForProcessing, markWebhookEventCompleted, markWebhookEventFailed } from '@/lib/billing/webhook-log';

/**
 * PLACEHOLDER — no real crypto off-ramp/custodian vendor is wired up yet
 * (see src/lib/wallet/web3-adapter.ts and the compliance flag in
 * supabase/migrations/20260802000000_add_wallet.sql). This route exists so
 * the wallet API surface is complete and testable end-to-end against a
 * mock delivery, but its payload shape and signature scheme are a
 * placeholder guess (HMAC-SHA256 over the raw body, same style as
 * Paystack), NOT verified against any real vendor's actual webhook format.
 * Replace both the payload shape and verifyWeb3Signature below once a real
 * vendor is chosen — same "not yet verified against a real delivery"
 * caveat this codebase already carries for the Flutterwave webhook.
 */
interface Web3WebhookPayload {
  event: string; // e.g. 'deposit.confirmed'
  data: {
    id?: string;
    user_id?: string;
    amount?: number; // in USDT, not smallest-unit — placeholder assumption
    address?: string;
    tx_hash?: string;
  };
}

function verifyWeb3Signature(rawBody: string, signatureHeader: string | null): boolean {
  const secret = process.env.WEB3_OFFRAMP_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) return false;

  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'utf8');
  const receivedBuffer = Buffer.from(signatureHeader, 'utf8');

  if (expectedBuffer.length !== receivedBuffer.length) return false;
  return crypto.timingSafeEqual(expectedBuffer, receivedBuffer);
}

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get('x-web3-signature');

  if (!verifyWeb3Signature(rawBody, signature)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  const payload = JSON.parse(rawBody) as Web3WebhookPayload;

  const claim = await claimWebhookEventForProcessing({
    provider: 'web3',
    eventId: payload.data.id ?? payload.data.tx_hash ?? '',
    eventType: payload.event,
    metadata: { txHash: payload.data.tx_hash ?? null },
  });
  if (!claim.shouldProcess) {
    return NextResponse.json({ received: true, duplicate: true });
  }

  const supabase = createServiceClient();

  try {
    switch (payload.event) {
      case 'deposit.confirmed': {
        const { user_id: userId, amount, tx_hash: txHash } = payload.data;
        if (!userId || amount == null || !txHash) break;

        const { error } = await supabase.rpc('wallet_apply_transaction', {
          p_user_id: userId,
          p_type: 'deposit',
          p_amount: amount,
          p_currency: 'USDT',
          p_provider: 'web3',
          p_provider_reference: txHash,
          p_idempotency_key: txHash,
          p_metadata: { address: payload.data.address ?? null },
        });
        if (error) throw error;
        break;
      }

      default:
        break;
    }
  } catch (err) {
    console.error('web3 webhook processing error:', err instanceof Error ? err.message : err);
    await markWebhookEventFailed(claim.eventRowId);
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }

  await markWebhookEventCompleted(claim.eventRowId);
  return NextResponse.json({ received: true });
}
