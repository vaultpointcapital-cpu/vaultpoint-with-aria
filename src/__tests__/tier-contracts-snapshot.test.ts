import { describe, it, expect, beforeEach } from 'vitest';
import { snapshotTierContractOnRenewal } from '@/lib/tier-contracts/snapshot';

// Same in-memory query-builder-with-then() shape as aria-findings.test.ts
// — a small fake standing in for the two tables this function actually
// touches (tier_contracts, subscriptions), so the real filter/order logic
// runs rather than being asserted via call-argument snapshots.

interface FakeTierContractRow {
  id: string;
  tier_name: string;
  status: string;
}

interface FakeSubscriptionRow {
  id: string;
  user_id: string;
  tier: string;
  created_at: string;
  tier_contract_id: string | null;
}

type Predicate = { col: string; val: unknown };

let tierContracts: FakeTierContractRow[] = [];
let subscriptions: FakeSubscriptionRow[] = [];
let updateCalls: Array<{ table: string; values: Record<string, unknown>; id: string }> = [];

class FakeQueryBuilder {
  private predicates: Predicate[] = [];
  private op: 'select' | 'update' = 'select';
  private updateValues: Record<string, unknown> | null = null;
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private single = false;

  constructor(private table: 'tier_contracts' | 'subscriptions') {}

  select(_cols: string) {
    this.op = 'select';
    return this;
  }

  update(values: Record<string, unknown>) {
    this.op = 'update';
    this.updateValues = values;
    return this;
  }

  eq(col: string, val: unknown) {
    this.predicates.push({ col, val });
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

  private rows(): (FakeTierContractRow | FakeSubscriptionRow)[] {
    return this.table === 'tier_contracts' ? tierContracts : subscriptions;
  }

  private matched() {
    return this.rows().filter((row) => this.predicates.every((p) => (row as never)[p.col] === p.val));
  }

  then<TResult>(onfulfilled: (value: { data: unknown; error: null }) => TResult) {
    if (this.op === 'update') {
      const matched = this.matched();
      for (const row of matched) {
        updateCalls.push({ table: this.table, values: this.updateValues!, id: (row as { id: string }).id });
        if (this.table === 'subscriptions') {
          Object.assign(row, this.updateValues);
        }
      }
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
  from: (table: 'tier_contracts' | 'subscriptions') => new FakeQueryBuilder(table),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

beforeEach(() => {
  tierContracts = [];
  subscriptions = [];
  updateCalls = [];
});

describe('snapshotTierContractOnRenewal', () => {
  it('stamps the active contract id on the matching subscription row', async () => {
    tierContracts = [{ id: 'contract-pro-v2', tier_name: 'pro', status: 'active' }];
    subscriptions = [
      { id: 'sub-1', user_id: 'user-1', tier: 'pro', created_at: '2026-08-01T00:00:00Z', tier_contract_id: null },
    ];

    await snapshotTierContractOnRenewal(client, 'user-1', 'pro');

    expect(updateCalls).toEqual([
      { table: 'subscriptions', values: { tier_contract_id: 'contract-pro-v2' }, id: 'sub-1' },
    ]);
    expect(subscriptions[0]?.tier_contract_id).toBe('contract-pro-v2');
  });

  it('no-ops without throwing when no active contract exists for the tier', async () => {
    tierContracts = []; // no seed data yet for this tier
    subscriptions = [
      { id: 'sub-1', user_id: 'user-1', tier: 'elite', created_at: '2026-08-01T00:00:00Z', tier_contract_id: null },
    ];

    await expect(snapshotTierContractOnRenewal(client, 'user-1', 'elite')).resolves.toBeUndefined();
    expect(updateCalls).toEqual([]);
  });

  it("does not touch another user's or another tier's subscription row", async () => {
    tierContracts = [{ id: 'contract-pro-v2', tier_name: 'pro', status: 'active' }];
    subscriptions = [
      { id: 'sub-other-user', user_id: 'user-2', tier: 'pro', created_at: '2026-08-01T00:00:00Z', tier_contract_id: null },
      { id: 'sub-other-tier', user_id: 'user-1', tier: 'elite', created_at: '2026-08-01T00:00:00Z', tier_contract_id: null },
    ];

    await snapshotTierContractOnRenewal(client, 'user-1', 'pro');

    expect(updateCalls).toEqual([]);
  });

  it('stamps the most recent subscription row when several exist for the same user/tier', async () => {
    tierContracts = [{ id: 'contract-pro-v2', tier_name: 'pro', status: 'active' }];
    subscriptions = [
      { id: 'sub-old', user_id: 'user-1', tier: 'pro', created_at: '2026-01-01T00:00:00Z', tier_contract_id: null },
      { id: 'sub-new', user_id: 'user-1', tier: 'pro', created_at: '2026-08-01T00:00:00Z', tier_contract_id: null },
    ];

    await snapshotTierContractOnRenewal(client, 'user-1', 'pro');

    expect(updateCalls).toEqual([
      { table: 'subscriptions', values: { tier_contract_id: 'contract-pro-v2' }, id: 'sub-new' },
    ]);
  });

  it("no-ops for tier_name='managed' — that snapshot happens via the fund route, not this path", async () => {
    tierContracts = [{ id: 'contract-managed-v1', tier_name: 'managed', status: 'active' }];

    await snapshotTierContractOnRenewal(client, 'user-1', 'managed');

    expect(updateCalls).toEqual([]);
  });
});
