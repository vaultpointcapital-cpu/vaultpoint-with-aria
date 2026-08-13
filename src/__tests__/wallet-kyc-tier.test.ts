import { describe, it, expect, beforeEach, vi } from 'vitest';

// Fake service-role Supabase client (same shape as billing-idempotency.test.ts's
// fake) standing in for users / wallet_kyc_tier_verifications / kyc_tier_limits,
// so tier-state.ts's actual logic (idempotent attempt reuse, forward-only tier
// ratchet, terminal-state no-op on redelivery) runs for real.

interface UserRow {
  id: string;
  kyc_tier: string;
  kyc_tier_verified_at: string | null;
}

interface VerificationRow {
  id: string;
  user_id: string;
  tier: string;
  method: string;
  provider: string;
  status: string;
  vendor_ref: string | null;
  result_summary: Record<string, unknown> | null;
  failure_reason: string | null;
  submitted_at: string;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

interface LimitRow {
  tier: string;
  max_single_deposit: number | null;
  max_monthly_deposit: number | null;
  withdrawals_allowed: boolean;
  max_single_withdrawal: number | null;
  max_monthly_withdrawal: number | null;
}

let users: UserRow[] = [];
let verifications: VerificationRow[] = [];
let limits: LimitRow[] = [];
let nextId = 1;

function tableFor(table: string): Record<string, unknown>[] {
  if (table === 'users') return users as unknown as Record<string, unknown>[];
  if (table === 'wallet_kyc_tier_verifications') return verifications as unknown as Record<string, unknown>[];
  if (table === 'kyc_tier_limits') return limits as unknown as Record<string, unknown>[];
  throw new Error(`unexpected table ${table}`);
}

function makeFakeClient() {
  return {
    from(table: string) {
      const rows = tableFor(table);
      return {
        select(_cols: string) {
          const eqFilters: [string, unknown][] = [];
          const inFilters: [string, unknown[]][] = [];
          const matches = (row: Record<string, unknown>) =>
            eqFilters.every(([c, v]) => row[c] === v) && inFilters.every(([c, vals]) => vals.includes(row[c]));
          const builder = {
            eq(col: string, val: unknown) {
              eqFilters.push([col, val]);
              return builder;
            },
            in(col: string, vals: unknown[]) {
              inFilters.push([col, vals]);
              return builder;
            },
            maybeSingle: async () => {
              const row = rows.find(matches);
              return { data: row ?? null, error: null };
            },
            single: async () => {
              const row = rows.find(matches);
              return row ? { data: row, error: null } : { data: null, error: { message: 'not found' } };
            },
          };
          return builder;
        },
        insert(values: Record<string, unknown>) {
          return {
            select(_cols: string) {
              return {
                single: async () => {
                  if (table === 'wallet_kyc_tier_verifications') {
                    const conflict = rows.find(
                      (r) => r.user_id === values.user_id && ['pending', 'processing'].includes(r.status as string)
                    );
                    if (conflict) return { data: null, error: { code: '23505', message: 'duplicate key value' } };
                  }
                  const now = new Date().toISOString();
                  const row = { id: `row-${nextId++}`, created_at: now, updated_at: now, submitted_at: now, decided_at: null, ...values };
                  rows.push(row);
                  return { data: row, error: null };
                },
              };
            },
          };
        },
        update(values: Record<string, unknown>) {
          return {
            eq: async (col: string, val: unknown) => {
              const row = rows.find((r) => r[col] === val);
              if (row) Object.assign(row, values);
              return { error: null };
            },
          };
        },
      };
    },
  };
}

const client = makeFakeClient();

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => client,
}));

describe('wallet KYC tier state', () => {
  beforeEach(() => {
    users = [{ id: 'user-1', kyc_tier: 'tier0', kyc_tier_verified_at: null }];
    verifications = [];
    limits = [
      { tier: 'tier0', max_single_deposit: 0, max_monthly_deposit: 0, withdrawals_allowed: false, max_single_withdrawal: 0, max_monthly_withdrawal: 0 },
      { tier: 'tier1', max_single_deposit: 50000, max_monthly_deposit: 200000, withdrawals_allowed: false, max_single_withdrawal: 0, max_monthly_withdrawal: 0 },
      { tier: 'tier2', max_single_deposit: null, max_monthly_deposit: null, withdrawals_allowed: true, max_single_withdrawal: null, max_monthly_withdrawal: null },
    ];
    nextId = 1;
  });

  it('startTierVerification creates a new pending row', async () => {
    const { startTierVerification } = await import('@/lib/kyc/tier-state');
    const verification = await startTierVerification({ userId: 'user-1', tier: 'tier1', method: 'phone_email', provider: 'internal' });
    expect(verification.status).toBe('pending');
    expect(verifications).toHaveLength(1);
  });

  it('startTierVerification reuses an in-flight attempt instead of creating a duplicate', async () => {
    const { startTierVerification } = await import('@/lib/kyc/tier-state');
    const first = await startTierVerification({ userId: 'user-1', tier: 'tier1', method: 'phone_email', provider: 'internal' });
    const second = await startTierVerification({ userId: 'user-1', tier: 'tier1', method: 'phone_email', provider: 'internal' });
    expect(second.id).toBe(first.id);
    expect(verifications).toHaveLength(1);
  });

  it('applyTierDecision(verified) bumps the user tier forward', async () => {
    const { startTierVerification, applyTierDecision } = await import('@/lib/kyc/tier-state');
    const verification = await startTierVerification({ userId: 'user-1', tier: 'tier1', method: 'phone_email', provider: 'internal' });
    await applyTierDecision({ verificationId: verification.id, decision: 'verified' });
    expect(users[0]?.kyc_tier).toBe('tier1');
    expect(users[0]?.kyc_tier_verified_at).not.toBeNull();
  });

  it('never downgrades a user already at a higher tier', async () => {
    users[0]!.kyc_tier = 'tier2';
    const { applyTierDecision } = await import('@/lib/kyc/tier-state');
    // Simulate a late/duplicate tier1 attempt resolving after the user already reached tier2.
    verifications.push({
      id: 'stale-1', user_id: 'user-1', tier: 'tier1', method: 'phone_email', provider: 'internal',
      status: 'pending', vendor_ref: null, result_summary: null, failure_reason: null,
      submitted_at: new Date().toISOString(), decided_at: null,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    });
    await applyTierDecision({ verificationId: 'stale-1', decision: 'verified' });
    expect(users[0]?.kyc_tier).toBe('tier2');
  });

  it('drops a redelivered decision that conflicts with an already-terminal row', async () => {
    const { startTierVerification, applyTierDecision } = await import('@/lib/kyc/tier-state');
    const verification = await startTierVerification({ userId: 'user-1', tier: 'tier1', method: 'phone_email', provider: 'internal' });
    await applyTierDecision({ verificationId: verification.id, decision: 'rejected' });
    expect(verifications[0]?.status).toBe('rejected');

    // A late 'verified' redelivery must not override the terminal 'rejected' state.
    await applyTierDecision({ verificationId: verification.id, decision: 'verified' });
    expect(verifications[0]?.status).toBe('rejected');
    expect(users[0]?.kyc_tier).toBe('tier0');
  });

  it('getKycTierStatus reports the current tier, limits, and any pending attempt', async () => {
    const { startTierVerification, getKycTierStatus } = await import('@/lib/kyc/tier-state');
    await startTierVerification({ userId: 'user-1', tier: 'tier1', method: 'phone_email', provider: 'internal' });

    const status = await getKycTierStatus('user-1');
    expect(status.tier).toBe('tier0');
    expect(status.limits.max_single_deposit).toBe(0);
    expect(status.pendingVerification?.tier).toBe('tier1');
  });
});
