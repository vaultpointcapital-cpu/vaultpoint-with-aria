'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DepositDialog } from '@/components/wallet/deposit-dialog';
import { WithdrawDialog } from '@/components/wallet/withdraw-dialog';
import type { Wallet, WalletTransaction } from '@/types/database';

interface WalletClientProps {
  initialWallets: Pick<Wallet, 'currency' | 'balance_cached' | 'updated_at'>[];
  initialTransactions: Omit<WalletTransaction, 'wallet_id' | 'user_id' | 'idempotency_key' | 'updated_at'>[];
}

function formatAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
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

export function WalletClient({ initialWallets, initialTransactions }: WalletClientProps) {
  const [wallets, setWallets] = useState(initialWallets);
  const [transactions, setTransactions] = useState(initialTransactions);
  const [depositOpen, setDepositOpen] = useState(false);
  const [withdrawOpen, setWithdrawOpen] = useState(false);

  async function refresh() {
    const [balanceRes, txRes] = await Promise.all([
      fetch('/api/wallet/balance'),
      fetch('/api/wallet/transactions'),
    ]);
    if (balanceRes.ok) {
      const { wallets: nextWallets } = await balanceRes.json();
      setWallets(nextWallets);
    }
    if (txRes.ok) {
      const { transactions: nextTransactions } = await txRes.json();
      setTransactions(nextTransactions);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5 p-6">
      <div className="flex items-center justify-between">
        <h1 className="font-display text-xl font-semibold text-text-primary">Wallet</h1>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setWithdrawOpen(true)}>
            Withdraw
          </Button>
          <Button onClick={() => setDepositOpen(true)}>Deposit</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {wallets.length === 0 && (
          <Card className="sm:col-span-3">
            <CardContent className="py-6 text-center text-sm text-text-secondary">
              No wallet balance yet — make your first deposit to get started.
            </CardContent>
          </Card>
        )}
        {wallets.map((wallet) => (
          <Card key={wallet.currency}>
            <CardHeader>
              <CardDescription>{wallet.currency} balance</CardDescription>
              <CardTitle className="font-mono-num">{formatAmount(Number(wallet.balance_cached), wallet.currency)}</CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent transactions</CardTitle>
        </CardHeader>
        <CardContent>
          {transactions.length === 0 ? (
            <p className="py-4 text-sm text-text-secondary">No transactions yet.</p>
          ) : (
            <div className="divide-y divide-border">
              {transactions.map((txn) => (
                <div key={txn.id} className="flex items-center justify-between py-3 text-sm">
                  <div>
                    <p className="font-medium text-text-primary">{TYPE_LABEL[txn.type] ?? txn.type}</p>
                    <p className="text-xs text-text-tertiary">
                      {new Date(txn.created_at).toLocaleString()} &middot; {txn.provider} &middot; {txn.status}
                    </p>
                  </div>
                  <p className="font-mono-num text-text-primary">{formatAmount(Number(txn.amount), txn.currency)}</p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <DepositDialog open={depositOpen} onOpenChange={setDepositOpen} />
      <WithdrawDialog
        open={withdrawOpen}
        onOpenChange={setWithdrawOpen}
        wallets={wallets}
        onWithdrawn={refresh}
      />
    </div>
  );
}
