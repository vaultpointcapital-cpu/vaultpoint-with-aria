import { describe, it, expect, beforeEach, vi } from 'vitest';

// First test of this shape in the repo (existing tests only exercise pure
// functions) — a small in-memory fake standing in for the service-role
// Supabase client, so claimWebhookEventForProcessing/markWebhookEvent*'s
// actual logic (insert-first, unique-violation means a row already
// exists, only 'completed' rows are true duplicates) runs for real
// against something that behaves like the real (provider, event_id)
// unique constraint, not a hand-waved mock.

interface FakeRow {
  id: string;
  provider: string;
  event_id: string;
  event_type: string;
  metadata: Record<string, unknown>;
  status: string;
}

let rows: FakeRow[] = [];
let nextId = 1;

function makeFakeClient() {
  return {
    from: (table: string) => {
      if (table !== 'billing_webhook_events') throw new Error(`unexpected table ${table}`);
      return {
        insert: (values: Omit<FakeRow, 'id' | 'status'>) => {
          const exists = rows.some((r) => r.provider === values.provider && r.event_id === values.event_id);
          if (exists) {
            return {
              select: () => ({
                single: async () => ({
                  data: null,
                  error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                }),
              }),
            };
          }
          const row: FakeRow = { id: `row-${nextId++}`, status: 'processing', ...values };
          rows.push(row);
          return {
            select: () => ({
              single: async () => ({ data: { id: row.id }, error: null }),
            }),
          };
        },
        select: (_cols: string) => ({
          eq: (col1: string, val1: string) => ({
            eq: (col2: string, val2: string) => ({
              single: async () => {
                const row = rows.find((r) => (r as never)[col1] === val1 && (r as never)[col2] === val2);
                return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } };
              },
            }),
          }),
        }),
        update: (values: Partial<FakeRow>) => ({
          eq: async (col: string, val: string) => {
            const row = rows.find((r) => (r as never)[col] === val);
            if (row) Object.assign(row, values);
            return { error: null };
          },
        }),
      };
    },
  };
}

const client = makeFakeClient();

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => client,
}));

describe('claimWebhookEventForProcessing / markWebhookEventCompleted / markWebhookEventFailed', () => {
  beforeEach(() => {
    rows = [];
    nextId = 1;
  });

  it('claims a brand-new event', async () => {
    const { claimWebhookEventForProcessing } = await import('@/lib/billing/webhook-log');

    const claim = await claimWebhookEventForProcessing({
      provider: 'stripe',
      eventId: 'evt_123',
      eventType: 'checkout.session.completed',
      metadata: {},
    });

    expect(claim.shouldProcess).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('processing');
  });

  it('skips a retry of an event whose prior attempt already completed — a true duplicate', async () => {
    const { claimWebhookEventForProcessing, markWebhookEventCompleted } = await import('@/lib/billing/webhook-log');

    const first = await claimWebhookEventForProcessing({
      provider: 'stripe',
      eventId: 'evt_456',
      eventType: 'customer.subscription.updated',
      metadata: {},
    });
    expect(first.shouldProcess).toBe(true);
    if (first.shouldProcess) await markWebhookEventCompleted(first.eventRowId);

    const retry = await claimWebhookEventForProcessing({
      provider: 'stripe',
      eventId: 'evt_456',
      eventType: 'customer.subscription.updated',
      metadata: {},
    });

    expect(retry.shouldProcess).toBe(false);
  });

  it('reclaims (does NOT skip) a retry of an event whose prior attempt failed — closes the swallowed-event bug', async () => {
    const { claimWebhookEventForProcessing, markWebhookEventFailed } = await import('@/lib/billing/webhook-log');

    const first = await claimWebhookEventForProcessing({
      provider: 'stripe',
      eventId: 'evt_789',
      eventType: 'invoice.payment_failed',
      metadata: {},
    });
    expect(first.shouldProcess).toBe(true);
    if (first.shouldProcess) await markWebhookEventFailed(first.eventRowId);
    expect(rows.find((r) => r.event_id === 'evt_789')?.status).toBe('failed');

    const retry = await claimWebhookEventForProcessing({
      provider: 'stripe',
      eventId: 'evt_789',
      eventType: 'invoice.payment_failed',
      metadata: {},
    });

    // The whole point of this fix: a retry after a failed attempt must be
    // allowed to actually reprocess, not silently acked as a duplicate.
    expect(retry.shouldProcess).toBe(true);
    expect(rows.find((r) => r.event_id === 'evt_789')?.status).toBe('processing');
  });

  it('reclaims a retry of an event that never finished at all (still processing — e.g. the server crashed mid-request)', async () => {
    const { claimWebhookEventForProcessing } = await import('@/lib/billing/webhook-log');

    const first = await claimWebhookEventForProcessing({
      provider: 'paystack',
      eventId: 'sig_abc',
      eventType: 'charge.success',
      metadata: {},
    });
    expect(first.shouldProcess).toBe(true);
    // Never marked completed or failed — simulates a crash mid-processing.

    const retry = await claimWebhookEventForProcessing({
      provider: 'paystack',
      eventId: 'sig_abc',
      eventType: 'charge.success',
      metadata: {},
    });

    expect(retry.shouldProcess).toBe(true);
  });
});
