/**
 * Tier 2 wallet KYC (BVN/NIN + liveness) vendor adapter seam. PRD §10 flags
 * this as its own "long pole" — real SmileID/Youverify/Prembly integration
 * needs actual vendor credentials, which don't exist in this environment.
 *
 * This file exists so /api/kyc/verify/tier2/route.ts has a stable interface
 * to call, with a real vendor swapped in behind it later without touching
 * the route or schema — same shape as src/lib/wallet/web3-adapter.ts's
 * "placeholder interface, real integration pending a vendor decision"
 * stance, except the stub here resolves successfully (rather than
 * throwing) so tier2 stays end-to-end testable locally, since — unlike a
 * real money-movement payout — there's no harm in a fake "verified"
 * result in dev/test.
 */

export interface Tier2VendorResult {
  vendorRef: string;
  decision: 'verified' | 'rejected' | 'processing';
  resultSummary: Record<string, unknown>;
}

export interface Tier2VendorAdapter {
  readonly name: 'internal' | 'smileid' | 'youverify' | 'stub';
  submit(params: { userId: string; bvnOrNin: string; livenessSelfieRef: string }): Promise<Tier2VendorResult>;
}

const stubTier2Adapter: Tier2VendorAdapter = {
  name: 'stub',
  // NON-PRODUCTION. Does not call any real identity-verification vendor,
  // does not validate the BVN/NIN against any registry, does not perform
  // real liveness detection. Always resolves 'verified' with a scrubbed
  // placeholder summary — never a real KYC decision.
  async submit(params) {
    return {
      vendorRef: `stub-${params.userId.slice(0, 8)}-${Date.now()}`,
      decision: 'verified',
      resultSummary: { checks_passed: ['stub_bvn_nin_format', 'stub_liveness'], reasons: [] },
    };
  },
};

function unimplementedAdapter(name: 'smileid' | 'youverify'): Tier2VendorAdapter {
  return {
    name,
    async submit() {
      throw new Error(
        `Tier 2 vendor '${name}' is not implemented — requires real vendor credentials. Set WALLET_KYC_TIER2_VENDOR=stub for local dev/test.`
      );
    },
  };
}

export function getTier2VendorAdapter(): Tier2VendorAdapter {
  const configured = process.env.WALLET_KYC_TIER2_VENDOR ?? 'stub';

  if (configured === 'stub') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'WALLET_KYC_TIER2_VENDOR=stub is not allowed in production — set a real vendor (smileid|youverify) before deploying Tier 2 KYC.'
      );
    }
    return stubTier2Adapter;
  }

  if (configured === 'smileid' || configured === 'youverify') {
    return unimplementedAdapter(configured);
  }

  throw new Error(`Unknown WALLET_KYC_TIER2_VENDOR: ${configured}`);
}
