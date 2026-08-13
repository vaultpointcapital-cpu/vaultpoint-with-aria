import crypto from 'crypto';
import { type NextRequest, NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabase/server';
import { claimWebhookEventForProcessing, markWebhookEventCompleted, markWebhookEventFailed } from '@/lib/billing/webhook-log';
import { getFeatureCustodyProvider } from '@/lib/custody/provider';

/**
 * With no real provider enabled (the default — see
 * src/lib/custody/cobo-adapter.ts's module docstring), signature
 * verification and payload shape here are exactly the placeholder guess
 * this route always used (HMAC-SHA256 over the raw body, same style as
 * Paystack, via WEB3_OFFRAMP_WEBHOOK_SECRET) — kept so the wallet API
 * surface stays testable end-to-end against a mock delivery without a
 * real vendor. With a real provider enabled, verification delegates to
 * CoboAdapter.verifyWebhookSignature — see that method's own docstring
 * for why it's still unverified against a real Cobo delivery and must be
 * fixed first if a real integration attempt shows it's wrong.
 *
 * User resolution never trusts a user_id field from the webhook payload
 * — a real custody vendor has no notion of VaultPoint's internal user
 * IDs, only the deposit address the funds arrived at. Real deposits
 * resolve the user via custody_accounts.deposit_address; the legacy
 * placeholder payload shape (which does carry user_id, since it's
 * VaultPoint's own test fixture, not a real vendor's) is only accepted
 * when no real provider is enabled.
 */
interface Web3WebhookPayload {
  event: string; // e.g. 'deposit.confirmed'
  data: {
    id?: string;
    user_id?: string; // placeholder-path only — see module docstring
    amount?: number; // in USDT, not smallest-unit — placeholder assumption
    address?: string;
    tx_hash?: string;
  };
}

function verifyPlaceholderSignature(rawBody: string, signatureHeader: string | null): boolean {
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
  const provider = getFeatureCustodyProvider();

  const verified = provider
    ? provider.verifyWebhookSignature({ rawBody, headers: request.headers })
    : verifyPlaceholderSignature(rawBody, request.headers.get('x-web3-signature'));

  if (!verified) {
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
        const { amount, tx_hash: txHash, address } = payload.data;
        if (amount == null || !txHash) break;

        let userId = payload.data.user_id ?? null;
        let custodyAccountId: string | null = null;

        if (provider && address) {
          const { data: account } = await supabase
            .from('custody_accounts')
            .select('id, user_id')
            .eq('deposit_address', address)
            .maybeSingle();
          if (!account) {
            // A confirmed deposit to an address we don't recognize is a
            // real anomaly (reconciliation-relevant), not a silent skip —
            // surfaced via the failed-processing path below rather than
            // crediting no one and returning 200.
            throw new Error(`No custody_accounts row found for deposit_address=${address}`);
          }
          userId = account.user_id;
          custodyAccountId = account.id;
        }

        if (!userId) break;

        const { data: rpcResult, error } = await supabase
          .rpc('wallet_apply_transaction', {
            p_user_id: userId,
            p_type: 'deposit',
            p_amount: amount,
            p_currency: 'USDT',
            p_provider: 'web3',
            p_provider_reference: txHash,
            p_idempotency_key: txHash,
            p_metadata: { address: address ?? null },
          })
          .single();
        if (error) throw error;

        if (custodyAccountId) {
          const { error: custodyError } = await supabase.from('custody_transactions').insert({
            custody_account_id: custodyAccountId,
            direction: 'deposit',
            amount,
            asset: 'USDT',
            provider_tx_id: txHash,
            status: 'confirmed',
            confirmed_at: new Date().toISOString(),
            ledger_entry_id: rpcResult?.transaction_id ?? null,
          });
          if (custodyError) throw custodyError;
        }
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
