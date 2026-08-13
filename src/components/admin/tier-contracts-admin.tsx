'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils/cn';
import type { TierName } from '@/types/database';
import type { TierContractWithCommitments } from '@/app/(dashboard)/dashboard/admin/tier-contracts/page';

interface TierContractsAdminProps {
  active: (TierContractWithCommitments | null)[];
  history: TierContractWithCommitments[];
  tiers: TierName[];
}

const DEFAULT_COMMITMENTS_PLACEHOLDER = `[
  {
    "commitmentKey": "example_commitment",
    "commitmentDescription": "Describe what this promises, in user-facing language.",
    "commitmentType": "feature_access",
    "measurable": false,
    "metricKey": null
  }
]`;

function formatPrice(ngn: number | null, usd: number | null): string {
  const parts: string[] = [];
  if (ngn !== null) parts.push(`₦${ngn.toLocaleString()}`);
  if (usd !== null) parts.push(`$${usd.toLocaleString()}`);
  return parts.length > 0 ? parts.join(' / ') : 'Free';
}

export function TierContractsAdmin({ active, history, tiers }: TierContractsAdminProps) {
  const router = useRouter();
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [tierName, setTierName] = useState<TierName>('pro');
  const [priceNgn, setPriceNgn] = useState('');
  const [priceUsd, setPriceUsd] = useState('');
  const [effectiveDate, setEffectiveDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [changeReason, setChangeReason] = useState('');
  const [commitmentsJson, setCommitmentsJson] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    let commitments: unknown;
    try {
      commitments = JSON.parse(commitmentsJson || '[]');
    } catch {
      setError('Commitments must be valid JSON.');
      return;
    }

    setIsSubmitting(true);
    try {
      const res = await fetch('/api/admin/tier-contracts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tierName,
          priceNgn: priceNgn.trim() === '' ? null : Number(priceNgn),
          priceUsd: priceUsd.trim() === '' ? null : Number(priceUsd),
          effectiveDate,
          changeReason,
          commitments,
        }),
      });
      const body = await res.json().catch(() => null);

      if (!res.ok) {
        setError(body?.error ?? 'Could not create the new tier contract version.');
        return;
      }

      setSuccess(`Created version ${body.version} for ${tierName}.`);
      setChangeReason('');
      setCommitmentsJson('');
      router.refresh();
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Tier contracts</h1>
        <p className="mt-1 text-sm text-text-tertiary">
          What each tier promises — versioned. An active contract is never edited in place; submitting the form
          below always creates a new version and supersedes the current one for that tier.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        {tiers.map((tier, i) => {
          const contract = active[i];
          const needsComplianceSignoff = tier === 'managed' && contract && !contract.compliance_signoff_at;

          return (
            <Card key={tier}>
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base capitalize">
                  {tier}
                  {contract && <span className="text-xs font-normal text-text-tertiary">v{contract.version}</span>}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {!contract ? (
                  <p className="text-text-tertiary">No active contract.</p>
                ) : (
                  <>
                    <p className="text-text-secondary">{formatPrice(contract.price_ngn, contract.price_usd)}</p>
                    <p className="text-text-tertiary">{contract.commitments.length} commitments</p>
                    {needsComplianceSignoff && (
                      <Badge className="border-danger/30 bg-danger/10 text-danger">
                        Not compliance-approved
                      </Badge>
                    )}
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Create a new version</CardTitle>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tierName">Tier</Label>
                <select
                  id="tierName"
                  value={tierName}
                  onChange={(e) => setTierName(e.target.value as TierName)}
                  className={cn(
                    'flex h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text-primary',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent'
                  )}
                >
                  {tiers.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="effectiveDate">Effective date</Label>
                <Input
                  id="effectiveDate"
                  type="date"
                  value={effectiveDate}
                  onChange={(e) => setEffectiveDate(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="priceNgn">Price (NGN)</Label>
                <Input
                  id="priceNgn"
                  type="number"
                  min={0}
                  placeholder="Leave blank if none"
                  value={priceNgn}
                  onChange={(e) => setPriceNgn(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="priceUsd">Price (USD)</Label>
                <Input
                  id="priceUsd"
                  type="number"
                  min={0}
                  placeholder="Leave blank if none"
                  value={priceUsd}
                  onChange={(e) => setPriceUsd(e.target.value)}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="changeReason">Change reason (required)</Label>
              <Input
                id="changeReason"
                value={changeReason}
                onChange={(e) => setChangeReason(e.target.value)}
                placeholder="Why is this version changing?"
                required
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="commitments">Commitments (JSON array)</Label>
              <Textarea
                id="commitments"
                value={commitmentsJson}
                onChange={(e) => setCommitmentsJson(e.target.value)}
                placeholder={DEFAULT_COMMITMENTS_PLACEHOLDER}
                rows={10}
                className="font-mono text-xs"
                required
              />
              <p className="text-xs text-text-tertiary">
                Each item needs commitmentKey, commitmentDescription, commitmentType (feature_access | outcome |
                sla | limit), measurable, and metricKey (required text if measurable is true).
              </p>
            </div>

            {error && (
              <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-2 text-xs text-warning">
                {error}
              </div>
            )}
            {success && (
              <div role="status" className="rounded-lg border border-success/30 bg-success/10 px-4 py-2 text-xs text-success">
                {success}
              </div>
            )}

            <Button type="submit" isLoading={isSubmitting} disabled={isSubmitting || !changeReason.trim()}>
              Create new version
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Superseded versions</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-text-tertiary">No superseded versions yet.</p>
          ) : (
            <ul className="space-y-2 text-sm">
              {history.map((contract) => (
                <li key={contract.id} className="border-b border-border pb-2 last:border-0">
                  <span className="font-medium capitalize text-text-primary">{contract.tier_name}</span>{' '}
                  <span className="text-text-tertiary">v{contract.version}</span>
                  {contract.change_reason && (
                    <p className="text-xs text-text-tertiary">{contract.change_reason}</p>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
