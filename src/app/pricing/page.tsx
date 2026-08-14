import type { Metadata } from 'next';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/server';
import { getActiveTierContract } from '@/lib/tier-contracts/get-active-contract';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import type { TierName } from '@/types/database';

export const metadata: Metadata = { title: 'Pricing — VaultPoint' };

// Managed Accounts is deliberately excluded from this page — its
// tier_contract's commitment copy is not yet compliance-approved (see
// supabase/migrations/20260815000002_add_tier_contracts.sql's header
// comment and compliance_signoff_at). Publishing unapproved SEC
// Nigeria-adjacent copy here would be worse than not having the row at
// all.
const PUBLIC_TIERS: TierName[] = ['free', 'pro', 'elite'];

function formatPrice(ngn: number | null): string {
  if (ngn === null || ngn === 0) return 'Free';
  return `₦${ngn.toLocaleString()}/mo`;
}

export default async function PricingPage() {
  const supabase = createClient();

  const contracts = await Promise.all(PUBLIC_TIERS.map((tier) => getActiveTierContract(supabase, tier)));

  return (
    <div className="mx-auto max-w-5xl px-6 py-16">
      <div className="mx-auto max-w-2xl text-center">
        <h1 className="font-display text-3xl font-semibold text-text-primary">Pricing</h1>
        <p className="mt-3 text-text-secondary">
          What each plan promises — pulled directly from what we've committed to, not separately-maintained
          marketing copy.
        </p>
      </div>

      <div className="mt-12 grid gap-6 sm:grid-cols-3">
        {PUBLIC_TIERS.map((tier, i) => {
          const contract = contracts[i];

          return (
            <Card key={tier} className="flex flex-col">
              <CardHeader>
                <CardTitle className="capitalize">{tier}</CardTitle>
                <p className="mt-1 text-2xl font-semibold text-text-primary">{formatPrice(contract?.price_ngn ?? null)}</p>
              </CardHeader>
              <CardContent className="flex flex-1 flex-col justify-between gap-6">
                <ul className="space-y-3 text-sm text-text-secondary">
                  {(contract?.commitments ?? []).map((commitment) => (
                    <li key={commitment.id} className="flex gap-2">
                      <span aria-hidden className="text-success">
                        ✓
                      </span>
                      <span>{commitment.commitment_description}</span>
                    </li>
                  ))}
                  {!contract && <li className="text-text-tertiary">Pricing details coming soon.</li>}
                </ul>
                <Button asChild className="w-full">
                  <Link href="/signup">Get started</Link>
                </Button>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
