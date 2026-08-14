import { describe, it, expect } from 'vitest';
import { createTierContractVersionSchema } from '@/lib/validations/tier-contracts';

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    tierName: 'pro',
    priceNgn: 20000,
    priceUsd: null,
    effectiveDate: '2026-08-15',
    changeReason: 'Adjusted pricing for Q3.',
    commitments: [
      {
        commitmentKey: 'connected_trading_accounts',
        commitmentDescription: 'Connect up to 5 trading accounts.',
        commitmentType: 'feature_access',
        measurable: true,
        metricKey: 'connected_account_count',
      },
    ],
    ...overrides,
  };
}

describe('createTierContractVersionSchema', () => {
  it('accepts a well-formed payload', () => {
    const result = createTierContractVersionSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
  });

  it('rejects a missing change_reason', () => {
    const result = createTierContractVersionSchema.safeParse(validPayload({ changeReason: '' }));
    expect(result.success).toBe(false);
  });

  it('rejects an unknown tier_name', () => {
    const result = createTierContractVersionSchema.safeParse(validPayload({ tierName: 'enterprise' }));
    expect(result.success).toBe(false);
  });

  it('rejects a measurable commitment with no metric_key', () => {
    const result = createTierContractVersionSchema.safeParse(
      validPayload({
        commitments: [
          {
            commitmentKey: 'x',
            commitmentDescription: 'x',
            commitmentType: 'feature_access',
            measurable: true,
            metricKey: null,
          },
        ],
      })
    );
    expect(result.success).toBe(false);
  });

  it('accepts a non-measurable commitment with no metric_key', () => {
    const result = createTierContractVersionSchema.safeParse(
      validPayload({
        commitments: [
          {
            commitmentKey: 'net_worth_dashboard',
            commitmentDescription: 'Basic Net Worth Dashboard.',
            commitmentType: 'feature_access',
            measurable: false,
            metricKey: null,
          },
        ],
      })
    );
    expect(result.success).toBe(true);
  });

  it('rejects an empty commitments array', () => {
    const result = createTierContractVersionSchema.safeParse(validPayload({ commitments: [] }));
    expect(result.success).toBe(false);
  });

  it('rejects a negative price', () => {
    const result = createTierContractVersionSchema.safeParse(validPayload({ priceNgn: -1 }));
    expect(result.success).toBe(false);
  });

  it('accepts a null price', () => {
    const result = createTierContractVersionSchema.safeParse(validPayload({ priceNgn: null, priceUsd: null }));
    expect(result.success).toBe(true);
  });
});
