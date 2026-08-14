'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { MoreHorizontal } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { DepositDialog } from '@/components/wallet/deposit-dialog';
import { WithdrawDialog } from '@/components/wallet/withdraw-dialog';
import { TierUpgradeDialog } from '@/components/wallet/tier-upgrade-dialog';
import { formatMoneyJSON } from '@/lib/utils/cn';
import type { DashboardWallet } from '@/components/dashboard/dashboard-client';
import type { KycTier } from '@/types/database';

interface WalletCardProps {
  wallet: DashboardWallet;
  /** Lighter styling for the no-broker-connected empty dashboard state —
   * still the real wallet data, just not the visual centerpiece there. */
  compact?: boolean;
}

const TYPE_LABEL: Record<string, string> = {
  deposit: 'Deposit',
  withdrawal: 'Withdrawal',
  pod_funding: 'Pod funding',
  prop_funding: 'Prop funding',
  prop_payout: 'Prop payout',
  fee: 'Fee',
  reversal: 'Reversal',
};

const STATUS_LABEL: Record<string, string> = {
  pending: 'Processing',
  completed: 'Completed',
  failed: 'Failed',
  reversed: 'Reversed',
};

export function WalletCard({ wallet, compact = false }: WalletCardProps) {
  const router = useRouter();
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);
  const [tierUpgradeOpen, setTierUpgradeOpen] = useState(false);
  // Reactive only — flipped when DepositDialog's own onKycBlocked fires
  // (the deposit route already returns KYC_REQUIRED/LIMIT_EXCEEDED
  // correctly). Not computed proactively from kycLimits vs. a running
  // monthly total, which would need a query this card doesn't otherwise
  // fetch for a state the reactive path already covers correctly.
  const [kycBlocked, setKycBlocked] = useState(false);
  const [kycTier, setKycTier] = useState<KycTier>(wallet.kycTier);

  function refresh() {
    router.refresh();
  }

  if (wallet.error) {
    return (
      <Card className={compact ? 'p-4' : undefined}>
        <div className="flex items-center justify-between">
          <div>
            <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">WALLET</p>
            <p className="mt-1 font-mono-num text-2xl font-semibold text-text-primary">—</p>
            <p className="text-xs text-text-secondary">Available</p>
          </div>
        </div>
        <p className="mt-3 text-sm text-warning">Couldn&apos;t load your balance.</p>
        <Button variant="outline" size="sm" className="mt-2" onClick={refresh}>
          Retry
        </Button>
        <div className="mt-4 flex gap-2">
          <Button className="flex-1" onClick={() => setDepositOpen(true)}>
            Deposit
          </Button>
          <Button variant="outline" className="flex-1" onClick={() => setWithdrawOpen(true)}>
            Withdraw
          </Button>
        </div>
        <DepositDialog
          open={depositOpen}
          onOpenChange={setDepositOpen}
          defaultRail={wallet.lastUsedRail}
          kycLimits={wallet.kycLimits}
          onKycBlocked={() => {
            setDepositOpen(false);
            setKycBlocked(true);
            setTierUpgradeOpen(true);
          }}
          onDeposited={refresh}
        />
        <WithdrawDialog
          open={withdrawOpen}
          onOpenChange={setWithdrawOpen}
          wallets={wallet.wallets}
          onWithdrawn={refresh}
          onKycBlocked={() => {
            setWithdrawOpen(false);
            setTierUpgradeOpen(true);
          }}
        />
      </Card>
    );
  }

  const isEmpty = !wallet.hasAnyWallet || wallet.balance === null || Number(wallet.balance.amount) === 0;

  return (
    <Card className={compact ? 'p-4' : undefined}>
      <div className="flex items-start justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-text-secondary">WALLET</p>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="text-text-tertiary transition-colors hover:text-text-primary"
              aria-label="Wallet options"
            >
              <MoreHorizontal className="h-4 w-4" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link href="/dashboard/wallet">History</Link>
            </DropdownMenuItem>
            <DropdownMenuItem disabled title="Coming soon">
              Statements
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <p className="mt-1 font-mono-num text-2xl font-semibold text-text-primary">
        {isEmpty
          ? formatMoneyJSON({ amount: '0', currency: wallet.currency })
          : formatMoneyJSON(wallet.balance!)}
      </p>
      <p className="text-xs text-text-secondary">Available</p>

      {!isEmpty && wallet.pendingAmount && (
        <p className="mt-1 text-sm text-info">{formatMoneyJSON(wallet.pendingAmount)} processing →</p>
      )}

      {isEmpty ? (
        <>
          <p className="mt-3 text-sm text-text-secondary">Fund your account to start trading or saving.</p>
          <Button className="mt-3 w-full" onClick={() => setDepositOpen(true)}>
            Deposit
          </Button>
        </>
      ) : (
        <>
          {kycBlocked && wallet.kycLimits && (
            <p className="mt-2 text-xs text-warning">
              Verification level limits deposits to {formatMoneyJSON({ amount: String(wallet.kycLimits.max_monthly_deposit ?? 0), currency: 'NGN' })}/mo
            </p>
          )}
          <div className="mt-3 flex gap-2">
            {kycBlocked ? (
              <Button
                variant="outline"
                className="flex-1 border-warning/40 text-warning hover:bg-warning/10"
                onClick={() => setTierUpgradeOpen(true)}
              >
                Upgrade Verification
              </Button>
            ) : (
              <Button className="flex-1" onClick={() => setDepositOpen(true)}>
                Deposit
              </Button>
            )}
            <Button variant="outline" className="flex-1" onClick={() => setWithdrawOpen(true)}>
              Withdraw
            </Button>
          </div>

          {wallet.lastTransaction && (
            <p className="mt-3 text-xs text-text-secondary">
              {TYPE_LABEL[wallet.lastTransaction.type] ?? wallet.lastTransaction.type}{' '}
              {formatMoneyJSON(wallet.lastTransaction.amount)} · {STATUS_LABEL[wallet.lastTransaction.status] ?? wallet.lastTransaction.status} →
            </p>
          )}
        </>
      )}

      <DepositDialog
        open={depositOpen}
        onOpenChange={setDepositOpen}
        defaultRail={wallet.lastUsedRail}
        kycLimits={wallet.kycLimits}
        onKycBlocked={() => {
          setDepositOpen(false);
          setKycBlocked(true);
          setTierUpgradeOpen(true);
        }}
        onDeposited={refresh}
      />
      <WithdrawDialog
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        wallets={wallet.wallets}
        onWithdrawn={refresh}
        onKycBlocked={() => {
          setWithdrawOpen(false);
          setTierUpgradeOpen(true);
        }}
      />
      <TierUpgradeDialog
        open={tierUpgradeOpen}
        onOpenChange={setTierUpgradeOpen}
        currentTier={kycTier}
        onTierChanged={(tier) => {
          setKycTier(tier);
          if (tier !== 'tier0') setKycBlocked(false);
          refresh();
        }}
      />
    </Card>
  );
}
