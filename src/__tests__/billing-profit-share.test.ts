import { describe, it, expect, vi, beforeEach } from 'vitest';

// Minimal chainable fake matching supabase-js's query builder shape well
// enough for profit-share.ts's calls: plain `await supabase.from(x).select(...).eq(...)`
// resolves via `.then()`, and `.maybeSingle()` narrows to a single row.
// responses is keyed by table name — each test configures only the
// tables its scenario touches.
function makeFakeSupabase(responses: Record<string, unknown>) {
  const calls: { table: string; op: string; values?: unknown }[] = [];

  function builder(table: string) {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      neq: () => b,
      in: () => b,
      gte: () => b,
      lt: () => b,
      order: () => b,
      limit: () => b,
      maybeSingle: () => {
        calls.push({ table, op: 'maybeSingle' });
        const data = responses[table];
        const row = Array.isArray(data) ? (data[0] ?? null) : (data ?? null);
        return Promise.resolve({ data: row, error: null });
      },
      insert: (values: unknown) => {
        calls.push({ table, op: 'insert', values });
        return Promise.resolve({ data: null, error: null });
      },
      then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) => {
        const data = responses[table] ?? [];
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      },
    };
    return b;
  }

  return {
    from: (table: string) => builder(table),
    calls,
  };
}

const stripeMock = {
  customers: { retrieve: vi.fn() },
  paymentIntents: { create: vi.fn() },
};

vi.mock('@/lib/billing/stripe', () => ({
  getStripeClient: () => stripeMock,
}));

let fakeSupabase: ReturnType<typeof makeFakeSupabase>;

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => fakeSupabase,
}));

beforeEach(() => {
  stripeMock.customers.retrieve.mockReset();
  stripeMock.paymentIntents.create.mockReset();
});

describe('getPreviousCalendarMonth', () => {
  it('returns the previous full calendar month for a mid-month reference date', async () => {
    const { getPreviousCalendarMonth } = await import('@/lib/billing/profit-share');
    const result = getPreviousCalendarMonth(new Date('2026-07-15T12:00:00Z'));
    expect(result).toEqual({ periodStart: '2026-06-01', periodEnd: '2026-07-01' });
  });

  it('rolls over the year boundary for a January reference date', async () => {
    const { getPreviousCalendarMonth } = await import('@/lib/billing/profit-share');
    const result = getPreviousCalendarMonth(new Date('2026-01-10T00:00:00Z'));
    expect(result).toEqual({ periodStart: '2025-12-01', periodEnd: '2026-01-01' });
  });
});

describe('computeAttributedProfit', () => {
  it('returns 0 when the user has no aria-initiated executed actions', async () => {
    fakeSupabase = makeFakeSupabase({ signal_actions: [] });
    const { computeAttributedProfit } = await import('@/lib/billing/profit-share');

    const profit = await computeAttributedProfit('user-1', '2026-06-01', '2026-07-01');
    expect(profit).toBe(0);
  });

  it('sums realized_pnl across all matching outcomes', async () => {
    fakeSupabase = makeFakeSupabase({
      signal_actions: [{ id: 'action-1' }, { id: 'action-2' }],
      signal_outcomes: [{ realized_pnl: 300 }, { realized_pnl: -50 }, { realized_pnl: 120 }],
    });
    const { computeAttributedProfit } = await import('@/lib/billing/profit-share');

    const profit = await computeAttributedProfit('user-1', '2026-06-01', '2026-07-01');
    expect(profit).toBe(370);
  });
});

describe('runProfitShareForUser', () => {
  it('skips a period that has already been billed, without computing or charging anything', async () => {
    fakeSupabase = makeFakeSupabase({
      profit_share_charges: [{ id: 'existing-charge' }],
    });
    const { runProfitShareForUser } = await import('@/lib/billing/profit-share');

    const result = await runProfitShareForUser('user-1', '2026-06-01', '2026-07-01');

    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/already billed/i);
    expect(fakeSupabase.calls.some((c) => c.op === 'insert')).toBe(false);
    expect(stripeMock.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('records a skipped charge when attributed profit is zero or negative, without touching Stripe', async () => {
    fakeSupabase = makeFakeSupabase({
      profit_share_charges: [],
      signal_actions: [{ id: 'action-1' }],
      signal_outcomes: [{ realized_pnl: -200 }],
    });
    const { runProfitShareForUser } = await import('@/lib/billing/profit-share');

    const result = await runProfitShareForUser('user-1', '2026-06-01', '2026-07-01');

    expect(result).toEqual({ userId: 'user-1', status: 'skipped', attributedProfit: -200, feeAmount: 0 });
    expect(stripeMock.paymentIntents.create).not.toHaveBeenCalled();

    const insertCall = fakeSupabase.calls.find((c) => c.table === 'profit_share_charges' && c.op === 'insert');
    expect((insertCall?.values as { status: string }).status).toBe('skipped');
    expect((insertCall?.values as { fee_amount: number }).fee_amount).toBe(0);
  });

  it('records a failure when the user has no active subscription or payment method on file', async () => {
    fakeSupabase = makeFakeSupabase({
      profit_share_charges: [],
      signal_actions: [{ id: 'action-1' }],
      signal_outcomes: [{ realized_pnl: 500 }],
      subscriptions: [],
    });
    const { runProfitShareForUser } = await import('@/lib/billing/profit-share');

    const result = await runProfitShareForUser('user-1', '2026-06-01', '2026-07-01');

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/no active subscription/i);
    expect(stripeMock.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('fails loudly for Paystack subscribers rather than charging the wrong currency amount', async () => {
    fakeSupabase = makeFakeSupabase({
      profit_share_charges: [],
      signal_actions: [{ id: 'action-1' }],
      signal_outcomes: [{ realized_pnl: 500 }],
      subscriptions: [{ payment_provider: 'paystack', provider_customer_id: 'CUS_abc123' }],
    });
    const { runProfitShareForUser } = await import('@/lib/billing/profit-share');

    const result = await runProfitShareForUser('user-1', '2026-06-01', '2026-07-01');

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/USD\/NGN conversion/);
    expect(stripeMock.paymentIntents.create).not.toHaveBeenCalled();

    const insertCall = fakeSupabase.calls.find((c) => c.table === 'profit_share_charges' && c.op === 'insert');
    expect((insertCall?.values as { payment_provider: string }).payment_provider).toBe('paystack');
  });

  it('charges the Stripe customer the correct percentage and records the charge', async () => {
    fakeSupabase = makeFakeSupabase({
      profit_share_charges: [],
      signal_actions: [{ id: 'action-1' }],
      signal_outcomes: [{ realized_pnl: 1000 }],
      subscriptions: [{ payment_provider: 'stripe', provider_customer_id: 'cus_abc123' }],
    });
    stripeMock.customers.retrieve.mockResolvedValueOnce({
      deleted: false,
      invoice_settings: { default_payment_method: 'pm_123' },
    });
    stripeMock.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_456', status: 'succeeded' });

    const { runProfitShareForUser, PROFIT_SHARE_PCT } = await import('@/lib/billing/profit-share');
    const result = await runProfitShareForUser('user-1', '2026-06-01', '2026-07-01');

    expect(result.status).toBe('charged');
    expect(result.attributedProfit).toBe(1000);
    expect(result.feeAmount).toBe(1000 * (PROFIT_SHARE_PCT / 100));

    expect(stripeMock.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        amount: 20000, // $200.00 in cents, 20% of $1000
        currency: 'usd',
        customer: 'cus_abc123',
        payment_method: 'pm_123',
        off_session: true,
        confirm: true,
      })
    );

    const insertCall = fakeSupabase.calls.find((c) => c.table === 'profit_share_charges' && c.op === 'insert');
    expect(insertCall?.values).toMatchObject({
      status: 'charged',
      provider_charge_id: 'pi_456',
      payment_provider: 'stripe',
      fee_amount: 200,
    });
  });

  it('records a failure when Stripe has no default payment method on file', async () => {
    fakeSupabase = makeFakeSupabase({
      profit_share_charges: [],
      signal_actions: [{ id: 'action-1' }],
      signal_outcomes: [{ realized_pnl: 1000 }],
      subscriptions: [{ payment_provider: 'stripe', provider_customer_id: 'cus_abc123' }],
    });
    stripeMock.customers.retrieve.mockResolvedValueOnce({ deleted: false, invoice_settings: {} });

    const { runProfitShareForUser } = await import('@/lib/billing/profit-share');
    const result = await runProfitShareForUser('user-1', '2026-06-01', '2026-07-01');

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/no default payment method/i);
    expect(stripeMock.paymentIntents.create).not.toHaveBeenCalled();
  });

  it('records a failure when the payment intent does not succeed', async () => {
    fakeSupabase = makeFakeSupabase({
      profit_share_charges: [],
      signal_actions: [{ id: 'action-1' }],
      signal_outcomes: [{ realized_pnl: 1000 }],
      subscriptions: [{ payment_provider: 'stripe', provider_customer_id: 'cus_abc123' }],
    });
    stripeMock.customers.retrieve.mockResolvedValueOnce({
      deleted: false,
      invoice_settings: { default_payment_method: 'pm_123' },
    });
    stripeMock.paymentIntents.create.mockResolvedValueOnce({ id: 'pi_456', status: 'requires_action' });

    const { runProfitShareForUser } = await import('@/lib/billing/profit-share');
    const result = await runProfitShareForUser('user-1', '2026-06-01', '2026-07-01');

    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/requires_action/);

    const insertCall = fakeSupabase.calls.find((c) => c.table === 'profit_share_charges' && c.op === 'insert');
    expect((insertCall?.values as { provider_charge_id: string | null }).provider_charge_id).toBeNull();
  });
});
