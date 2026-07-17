import { describe, it, expect, vi, beforeEach } from 'vitest';

// First test of this shape in the repo (existing tests only exercise pure
// functions) — mocks the service-role Supabase client at the module
// boundary so recordWebhookEventIfNew's actual logic (insert-first,
// treat a unique-violation as "already processed") runs for real against
// a fake `.from().insert()`.
const insertMock = vi.fn();

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => ({ insert: insertMock }),
  }),
}));

describe('recordWebhookEventIfNew', () => {
  beforeEach(() => {
    insertMock.mockReset();
  });

  it('reports a new event when the insert succeeds', async () => {
    const { recordWebhookEventIfNew } = await import('@/lib/billing/webhook-log');
    insertMock.mockResolvedValueOnce({ error: null });

    const isNew = await recordWebhookEventIfNew({
      provider: 'stripe',
      eventId: 'evt_123',
      eventType: 'checkout.session.completed',
      metadata: {},
    });

    expect(isNew).toBe(true);
    expect(insertMock).toHaveBeenCalledTimes(1);
  });

  it('reports a duplicate (not new) when the same event id is processed twice — the DB unique constraint rejects the second insert', async () => {
    const { recordWebhookEventIfNew } = await import('@/lib/billing/webhook-log');

    insertMock.mockResolvedValueOnce({ error: null });
    const first = await recordWebhookEventIfNew({
      provider: 'stripe',
      eventId: 'evt_456',
      eventType: 'customer.subscription.updated',
      metadata: {},
    });

    // Second delivery of the identical event: Postgres rejects the insert
    // with 23505 (unique_violation) on the (provider, event_id) constraint.
    insertMock.mockResolvedValueOnce({
      error: { code: '23505', message: 'duplicate key value violates unique constraint' },
    });
    const second = await recordWebhookEventIfNew({
      provider: 'stripe',
      eventId: 'evt_456',
      eventType: 'customer.subscription.updated',
      metadata: {},
    });

    expect(first).toBe(true);
    expect(second).toBe(false);
    expect(insertMock).toHaveBeenCalledTimes(2);
  });

  it('throws on a non-duplicate database error rather than silently swallowing it', async () => {
    const { recordWebhookEventIfNew } = await import('@/lib/billing/webhook-log');
    insertMock.mockResolvedValueOnce({ error: { code: '08006', message: 'connection failure' } });

    await expect(
      recordWebhookEventIfNew({ provider: 'paystack', eventId: 'sig_abc', eventType: 'charge.success', metadata: {} })
    ).rejects.toThrow(/connection failure/);
  });
});
