'use client';

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';

interface TraderApplicationFormProps {
  connectedBrokers: Array<{ broker: string; label: string }>;
  accountAgeDays: number | null;
}

const MIN_ACCOUNT_AGE_DAYS = 90;

export function TraderApplicationForm({ connectedBrokers, accountAgeDays }: TraderApplicationFormProps) {
  const router = useRouter();
  const [proposedProfitSplit, setProposedProfitSplit] = useState('70');
  const [maxClients, setMaxClients] = useState('');
  const [strategyDescription, setStrategyDescription] = useState('');
  const [hasManagedFundsBefore, setHasManagedFundsBefore] = useState<'yes' | 'no' | ''>('');
  const [hasManagedFundsExplanation, setHasManagedFundsExplanation] = useState('');
  const [academyModulesConfirmed, setAcademyModulesConfirmed] = useState(false);
  const [understandsTradeOnly, setUnderstandsTradeOnly] = useState(false);
  const [agreesToAuditLogging, setAgreesToAuditLogging] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  const meetsMinimumAccountAge = accountAgeDays !== null && accountAgeDays >= MIN_ACCOUNT_AGE_DAYS;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setServerError(null);
    setIsSubmitting(true);

    const res = await fetch('/api/managed-traders/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        proposed_profit_split: Number(proposedProfitSplit),
        max_clients: maxClients ? Number(maxClients) : undefined,
        strategy_description: strategyDescription,
        has_managed_funds_before: hasManagedFundsBefore === 'yes',
        has_managed_funds_before_explanation: hasManagedFundsBefore === 'yes' ? hasManagedFundsExplanation : undefined,
        academy_modules_confirmed: academyModulesConfirmed,
        understands_trade_only: understandsTradeOnly,
        agrees_to_audit_logging: agreesToAuditLogging,
      }),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not submit your application. Please try again.');
      return;
    }

    router.refresh();
  }

  const canSubmit =
    Number(proposedProfitSplit) > 0 &&
    strategyDescription.trim().length > 0 &&
    hasManagedFundsBefore !== '' &&
    (hasManagedFundsBefore === 'no' || hasManagedFundsExplanation.trim().length > 0) &&
    academyModulesConfirmed &&
    understandsTradeOnly &&
    agreesToAuditLogging;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Apply to Become a Managed Trader</h1>
        <p className="mt-1 text-sm text-text-secondary">
          Manage client capital through VaultPoint under a limited Power of Attorney and earn a profit split. Every
          application is manually reviewed — there is no automatic approval.
        </p>
      </div>

      {serverError && (
        <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
          {serverError}
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        {/* Section B — track record context (informational, not editable) */}
        <div className="space-y-3 rounded-xl border border-border bg-surface p-6">
          <h2 className="font-display text-base font-semibold text-text-primary">Trading History</h2>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-text-secondary">Connected brokers</span>
              <span className="text-text-primary">
                {connectedBrokers.length > 0 ? connectedBrokers.map((c) => c.label).join(', ') : 'None connected'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Account age</span>
              <span className={meetsMinimumAccountAge ? 'text-success' : 'text-warning'}>
                {accountAgeDays !== null ? `${accountAgeDays} days` : 'No connection yet'}
                {!meetsMinimumAccountAge && ` (minimum ${MIN_ACCOUNT_AGE_DAYS} days)`}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-text-secondary">Trailing 90-day return / max drawdown</span>
              <span className="text-text-tertiary">Pending — computed during manual review</span>
            </div>
          </div>
          {!meetsMinimumAccountAge && (
            <p className="text-xs text-warning">
              You can still submit an application, but a reviewer will check this threshold before approving it.
            </p>
          )}

          <div className="space-y-2 pt-2">
            <Label htmlFor="strategyDescription">Describe your trading strategy (2-3 sentences)</Label>
            <Textarea
              id="strategyDescription"
              value={strategyDescription}
              onChange={(e) => setStrategyDescription(e.target.value)}
              maxLength={1000}
              placeholder="e.g. Smart Money Concepts approach focused on..."
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="hasManagedFundsBefore">Have you managed funds for other people before?</Label>
            <select
              id="hasManagedFundsBefore"
              value={hasManagedFundsBefore}
              onChange={(e) => setHasManagedFundsBefore(e.target.value as 'yes' | 'no' | '')}
              className="flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary"
            >
              <option value="">Select an answer</option>
              <option value="no">No</option>
              <option value="yes">Yes</option>
            </select>
          </div>

          {hasManagedFundsBefore === 'yes' && (
            <div className="space-y-2">
              <Label htmlFor="hasManagedFundsExplanation">Please explain</Label>
              <Textarea
                id="hasManagedFundsExplanation"
                value={hasManagedFundsExplanation}
                onChange={(e) => setHasManagedFundsExplanation(e.target.value)}
                maxLength={1000}
              />
            </div>
          )}
        </div>

        {/* Section D — intent & capacity */}
        <div className="space-y-4 rounded-xl border border-border bg-surface p-6">
          <h2 className="font-display text-base font-semibold text-text-primary">Intent &amp; Capacity</h2>

          <div className="space-y-2">
            <Label htmlFor="maxClients">How many clients do you intend to manage initially?</Label>
            <Input
              id="maxClients"
              type="number"
              min="1"
              value={maxClients}
              onChange={(e) => setMaxClients(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="proposedProfitSplit">What profit-split percentage are you proposing?</Label>
            <Input
              id="proposedProfitSplit"
              type="number"
              min="0"
              max="100"
              step="1"
              value={proposedProfitSplit}
              onChange={(e) => setProposedProfitSplit(e.target.value)}
            />
            <p className="text-xs text-text-tertiary">Subject to compliance-approved range at review.</p>
          </div>
        </div>

        {/* Section C/D — required attestations (hard gates) */}
        <div className="space-y-3 rounded-xl border border-border bg-surface p-6">
          <h2 className="font-display text-base font-semibold text-text-primary">Confirmations</h2>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={academyModulesConfirmed}
              onChange={(e) => setAcademyModulesConfirmed(e.target.checked)}
              className="mt-1"
            />
            <span className="text-text-secondary">
              I confirm I have completed the Meir FX Academy &quot;Risk &amp; Psychology&quot; and &quot;Live
              Application&quot; modules.
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={understandsTradeOnly}
              onChange={(e) => setUnderstandsTradeOnly(e.target.checked)}
              className="mt-1"
            />
            <span className="text-text-secondary">
              I understand that I will have trade-only permissions and cannot withdraw client funds under any
              circumstance.
            </span>
          </label>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={agreesToAuditLogging}
              onChange={(e) => setAgreesToAuditLogging(e.target.checked)}
              className="mt-1"
            />
            <span className="text-text-secondary">
              I agree to VaultPoint&apos;s audit logging of all trades and payouts on managed accounts I oversee.
            </span>
          </label>
        </div>

        <p className="text-xs text-text-tertiary">
          Submitting this application also starts identity verification (government ID + sanctions check), the same
          process used for Managed Accounts clients.
        </p>

        <Button type="submit" className="w-full" isLoading={isSubmitting} disabled={!canSubmit || isSubmitting}>
          Submit Application
        </Button>
      </form>
    </div>
  );
}
