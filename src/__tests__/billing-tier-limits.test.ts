import { describe, it, expect } from 'vitest';
import { TIER_LIMITS } from '@/lib/billing/tier-limits';
import { canCreateAnotherPod, POD_LIMITS_BY_TIER } from '@/lib/validations/pods';

describe('TIER_LIMITS', () => {
  it('is the single source of truth pods.ts delegates to', () => {
    expect(POD_LIMITS_BY_TIER.free).toBe(TIER_LIMITS.free.maxPods);
    expect(POD_LIMITS_BY_TIER.pro).toBe(TIER_LIMITS.pro.maxPods);
    expect(POD_LIMITS_BY_TIER.elite).toBe(TIER_LIMITS.elite.maxPods);
  });
});

describe('canCreateAnotherPod', () => {
  it('blocks creation at the free tier limit (1 pod)', () => {
    expect(canCreateAnotherPod('free', 1)).toBe(false);
  });

  it('allows creation under the free tier limit', () => {
    expect(canCreateAnotherPod('free', 0)).toBe(true);
  });

  it('blocks creation at the pro tier limit (10 pods)', () => {
    expect(canCreateAnotherPod('pro', 10)).toBe(false);
  });

  it('allows creation under the pro tier limit', () => {
    expect(canCreateAnotherPod('pro', 9)).toBe(true);
  });

  it('never blocks Elite, no matter how many pods exist', () => {
    expect(canCreateAnotherPod('elite', 0)).toBe(true);
    expect(canCreateAnotherPod('elite', 1000)).toBe(true);
    expect(canCreateAnotherPod('elite', Number.MAX_SAFE_INTEGER)).toBe(true);
  });
});
