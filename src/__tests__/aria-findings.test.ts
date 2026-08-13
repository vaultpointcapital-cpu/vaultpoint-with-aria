import { describe, it, expect, beforeEach, vi } from 'vitest';

// Same fake-Supabase-client shape as billing-idempotency.test.ts — a
// small in-memory query builder standing in for the service-role client,
// so findings.ts's actual filter/order/group logic runs for real rather
// than being asserted via call-argument snapshots.

interface FakeFindingRow {
  id: string;
  user_id: string;
  source_agent: string;
  finding_type: string;
  severity: string;
  raw_data: Record<string, unknown>;
  dedup_key: string;
  status: string;
  created_at: string;
  delivered_at: string | null;
}

type Predicate = { type: 'eq' | 'in' | 'lte'; col: string; val: unknown };

let rows: FakeFindingRow[] = [];
let updateCalls: Array<{ values: Partial<FakeFindingRow>; predicates: Predicate[] }> = [];

class FakeQueryBuilder {
  private predicates: Predicate[] = [];
  private op: 'select' | 'update' = 'select';
  private updateValues: Partial<FakeFindingRow> | null = null;
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private single = false;

  select(_cols: string) {
    this.op = 'select';
    return this;
  }

  update(values: Partial<FakeFindingRow>) {
    this.op = 'update';
    this.updateValues = values;
    return this;
  }

  eq(col: string, val: unknown) {
    this.predicates.push({ type: 'eq', col, val });
    return this;
  }

  in(col: string, val: unknown[]) {
    this.predicates.push({ type: 'in', col, val });
    return this;
  }

  lte(col: string, val: unknown) {
    this.predicates.push({ type: 'lte', col, val });
    return this;
  }

  order(col: string, opts: { ascending: boolean }) {
    this.orderCol = col;
    this.orderAsc = opts.ascending;
    return this;
  }

  limit(n: number) {
    this.limitN = n;
    return this;
  }

  maybeSingle() {
    this.single = true;
    return this;
  }

  private matched(): FakeFindingRow[] {
    return rows.filter((row) =>
      this.predicates.every((p) => {
        const v = (row as never)[p.col];
        if (p.type === 'eq') return v === p.val;
        if (p.type === 'in') return (p.val as unknown[]).includes(v);
        if (p.type === 'lte') return (v as string) <= (p.val as string);
        return true;
      })
    );
  }

  then<TResult>(onfulfilled: (value: { data: unknown; error: null }) => TResult) {
    if (this.op === 'update') {
      updateCalls.push({ values: this.updateValues!, predicates: this.predicates });
      return Promise.resolve({ data: null, error: null }).then(onfulfilled);
    }

    let result = this.matched();
    if (this.orderCol) {
      const col = this.orderCol;
      result = [...result].sort((a, b) => {
        const av = (a as never)[col] as string;
        const bv = (b as never)[col] as string;
        const cmp = av < bv ? -1 : av > bv ? 1 : 0;
        return this.orderAsc ? cmp : -cmp;
      });
    }
    if (this.limitN !== null) result = result.slice(0, this.limitN);

    const data = this.single ? (result[0] ?? null) : result;
    return Promise.resolve({ data, error: null }).then(onfulfilled);
  }
}

const client = {
  from: (table: string) => {
    if (table !== 'aria_findings') throw new Error(`unexpected table ${table}`);
    return new FakeQueryBuilder();
  },
};

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => client,
}));

function findingRow(overrides: Partial<FakeFindingRow> = {}): FakeFindingRow {
  return {
    id: 'finding-1',
    user_id: 'user-1',
    source_agent: 'argus',
    finding_type: 'loss_warning',
    severity: 'warning',
    raw_data: { unrealized_pnl_pct: -12 },
    dedup_key: 'argus:loss_warning:BTC:warning',
    status: 'new',
    created_at: new Date().toISOString(),
    delivered_at: null,
    ...overrides,
  };
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

describe('getNewFindings', () => {
  beforeEach(() => {
    rows = [];
  });

  it("returns only this user's status='new' findings", async () => {
    const { getNewFindings } = await import('@/lib/aria/findings');
    rows = [
      findingRow({ id: 'f1', user_id: 'user-1', status: 'new' }),
      findingRow({ id: 'f2', user_id: 'user-2', status: 'new' }),
      findingRow({ id: 'f3', user_id: 'user-1', status: 'delivered' }),
    ];

    const findings = await getNewFindings('user-1');

    expect(findings.map((f) => f.id)).toEqual(['f1']);
  });

  it('maps snake_case DB fields to camelCase', async () => {
    const { getNewFindings } = await import('@/lib/aria/findings');
    rows = [findingRow({ id: 'f1', user_id: 'user-1', source_agent: 'plutus', finding_type: 'profit_alert' })];

    const [finding] = await getNewFindings('user-1');

    expect(finding).toMatchObject({ id: 'f1', sourceAgent: 'plutus', findingType: 'profit_alert' });
  });

  it('excludes a stale buy_signal older than the 4h TTL', async () => {
    const { getNewFindings } = await import('@/lib/aria/findings');
    rows = [
      findingRow({ id: 'stale', user_id: 'user-1', finding_type: 'buy_signal', created_at: hoursAgo(5) }),
      findingRow({ id: 'fresh', user_id: 'user-1', finding_type: 'buy_signal', created_at: hoursAgo(1) }),
    ];

    const findings = await getNewFindings('user-1');

    expect(findings.map((f) => f.id)).toEqual(['fresh']);
  });

  it('does not apply the buy_signal TTL to other finding types', async () => {
    const { getNewFindings } = await import('@/lib/aria/findings');
    rows = [findingRow({ id: 'old-loss', user_id: 'user-1', finding_type: 'loss_warning', created_at: hoursAgo(10) })];

    const findings = await getNewFindings('user-1');

    expect(findings.map((f) => f.id)).toEqual(['old-loss']);
  });
});

describe('markFindingsDelivered', () => {
  beforeEach(() => {
    rows = [];
    updateCalls = [];
  });

  it('updates status to delivered and sets delivered_at for the given ids', async () => {
    const { markFindingsDelivered } = await import('@/lib/aria/findings');

    await markFindingsDelivered(['f1', 'f2']);

    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]?.values.status).toBe('delivered');
    expect(typeof updateCalls[0]?.values.delivered_at).toBe('string');
    expect(updateCalls[0]?.predicates).toEqual([{ type: 'in', col: 'id', val: ['f1', 'f2'] }]);
  });

  it('is a no-op for an empty id list — never issues an update call', async () => {
    const { markFindingsDelivered } = await import('@/lib/aria/findings');

    await markFindingsDelivered([]);

    expect(updateCalls).toHaveLength(0);
  });
});

describe('getPendingProactiveFindingsByUser', () => {
  beforeEach(() => {
    rows = [];
  });

  it('filters to warning/critical severity only — structural enforcement of "caution/info never proactive"', async () => {
    const { getPendingProactiveFindingsByUser } = await import('@/lib/aria/findings');
    rows = [
      findingRow({ id: 'critical', severity: 'critical', created_at: hoursAgo(1) }),
      findingRow({ id: 'warning', severity: 'warning', created_at: hoursAgo(1) }),
      findingRow({ id: 'caution', severity: 'caution', created_at: hoursAgo(1) }),
      findingRow({ id: 'info', severity: 'info', created_at: hoursAgo(1) }),
    ];

    const byUser = await getPendingProactiveFindingsByUser(5);

    const ids = (byUser.get('user-1') ?? []).map((f) => f.id);
    expect(ids.sort()).toEqual(['critical', 'warning']);
  });

  it('excludes findings younger than minAgeMinutes', async () => {
    const { getPendingProactiveFindingsByUser } = await import('@/lib/aria/findings');
    rows = [
      findingRow({ id: 'too-young', severity: 'critical', created_at: new Date().toISOString() }),
      findingRow({ id: 'old-enough', severity: 'critical', created_at: hoursAgo(1) }),
    ];

    const byUser = await getPendingProactiveFindingsByUser(5);

    expect((byUser.get('user-1') ?? []).map((f) => f.id)).toEqual(['old-enough']);
  });

  it('groups findings by user_id', async () => {
    const { getPendingProactiveFindingsByUser } = await import('@/lib/aria/findings');
    rows = [
      findingRow({ id: 'a', user_id: 'user-1', severity: 'warning', created_at: hoursAgo(1) }),
      findingRow({ id: 'b', user_id: 'user-1', severity: 'critical', created_at: hoursAgo(1) }),
      findingRow({ id: 'c', user_id: 'user-2', severity: 'warning', created_at: hoursAgo(1) }),
    ];

    const byUser = await getPendingProactiveFindingsByUser(5);

    expect(byUser.size).toBe(2);
    expect(byUser.get('user-1')).toHaveLength(2);
    expect(byUser.get('user-2')).toHaveLength(1);
  });

  it('excludes status other than new', async () => {
    const { getPendingProactiveFindingsByUser } = await import('@/lib/aria/findings');
    rows = [findingRow({ id: 'delivered', severity: 'critical', status: 'delivered', created_at: hoursAgo(1) })];

    const byUser = await getPendingProactiveFindingsByUser(5);

    expect(byUser.size).toBe(0);
  });
});

describe('minutesSinceLastProactiveDelivery', () => {
  beforeEach(() => {
    rows = [];
  });

  it('returns null when the user has no delivered findings', async () => {
    const { minutesSinceLastProactiveDelivery } = await import('@/lib/aria/findings');

    expect(await minutesSinceLastProactiveDelivery('user-1')).toBeNull();
  });

  it('returns minutes since the most recent delivered_at', async () => {
    const { minutesSinceLastProactiveDelivery } = await import('@/lib/aria/findings');
    const deliveredAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    rows = [findingRow({ id: 'f1', status: 'delivered', delivered_at: deliveredAt })];

    const minutes = await minutesSinceLastProactiveDelivery('user-1');

    expect(minutes).not.toBeNull();
    expect(minutes!).toBeGreaterThanOrEqual(9.5);
    expect(minutes!).toBeLessThan(10.5);
  });

  it('picks the most recent delivered_at when several exist', async () => {
    const { minutesSinceLastProactiveDelivery } = await import('@/lib/aria/findings');
    rows = [
      findingRow({ id: 'old', status: 'delivered', delivered_at: hoursAgo(3) }),
      findingRow({ id: 'recent', status: 'delivered', delivered_at: hoursAgo(0.1) }),
    ];

    const minutes = await minutesSinceLastProactiveDelivery('user-1');

    expect(minutes!).toBeLessThan(30);
  });
});
