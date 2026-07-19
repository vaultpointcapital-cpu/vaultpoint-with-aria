'use client';

import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils/cn';
import type { ComplianceFlag } from '@/lib/validations/managed-accounts';

interface AccountRow {
  account: {
    id: string;
    user_id: string;
    tier: string;
    status: string;
    kyc_status: string;
    created_at: string;
  };
  drawdownPct: number;
  flags: ComplianceFlag[];
}

interface ComplianceDashboardProps {
  rows: AccountRow[];
}

const FLAG_LABELS: Record<ComplianceFlag['type'], string> = {
  high_drawdown: 'High drawdown',
  disclosure_reconfirmation_required: 'Reconfirmation pending',
  kyc_backlog: 'KYC backlog',
  stale_pending_withdrawal: 'Stale withdrawal',
  missing_authorization: 'Missing authorization',
};

export function ComplianceDashboard({ rows }: ComplianceDashboardProps) {
  const flagged = rows.filter((r) => r.flags.length > 0);
  const clean = rows.filter((r) => r.flags.length === 0);

  return (
    <div className="mx-auto max-w-4xl space-y-5 p-6">
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">Compliance dashboard</h1>
        <p className="mt-1 text-sm text-text-tertiary">
          {flagged.length} of {rows.length} managed accounts need attention.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Flagged accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {flagged.length === 0 ? (
            <p className="text-sm text-text-tertiary">Nothing flagged right now.</p>
          ) : (
            <div className="space-y-3">
              {flagged.map(({ account, drawdownPct, flags }) => (
                <div key={account.id} className="rounded-lg border border-warning/30 bg-warning/5 p-3">
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium capitalize text-text-primary">
                      {account.tier} — {account.status.replace(/_/g, ' ')}
                    </span>
                    <a
                      href={`/api/admin/managed-accounts/${account.id}/audit-export`}
                      className="text-xs text-accent hover:underline"
                    >
                      Export audit CSV
                    </a>
                  </div>
                  <p className="mt-0.5 text-xs text-text-tertiary">
                    Account {account.id.slice(0, 8)} · Drawdown {drawdownPct.toFixed(1)}%
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {flags.map((flag, i) => (
                      <span
                        key={i}
                        title={flag.detail}
                        className={cn(
                          'rounded-full border border-warning/40 bg-warning/10 px-2 py-0.5 text-xs text-warning'
                        )}
                      >
                        {FLAG_LABELS[flag.type]}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All other accounts ({clean.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {clean.length === 0 ? (
            <p className="text-sm text-text-tertiary">None.</p>
          ) : (
            <div className="space-y-1.5">
              {clean.map(({ account }) => (
                <div key={account.id} className="flex items-center justify-between text-sm text-text-secondary">
                  <span className="capitalize">
                    {account.tier} — {account.status.replace(/_/g, ' ')}
                  </span>
                  <a
                    href={`/api/admin/managed-accounts/${account.id}/audit-export`}
                    className="text-xs text-accent hover:underline"
                  >
                    Export audit CSV
                  </a>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
