'use client';

import { useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { TrendingUp, TrendingDown } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils/cn';
import type { Signal, SignalConfidence } from '@/types/database';
import type { SignalWithAction } from '@/components/signals/types';

const CONFIDENCE_STYLES: Record<SignalConfidence, string> = {
  low: 'bg-surface-elevated text-text-tertiary',
  medium: 'bg-info/10 text-info',
  high: 'bg-success/10 text-success',
};

const ACTION_LABELS: Record<string, string> = {
  executed: 'Executed',
  skipped: 'Skipped',
  ignored: 'Ignored',
  failed: 'Execution failed — you can retry',
};

interface SignalCardProps {
  item: SignalWithAction;
  canExecute: boolean;
  onExecuteClick: (signal: Signal) => void;
  onSkip: (signalId: string) => Promise<void>;
}

export function SignalCard({ item, canExecute, onExecuteClick, onSkip }: SignalCardProps) {
  const { signal, action } = item;
  const [isSkipping, setIsSkipping] = useState(false);

  // Only 'failed' leaves the door open to act again — every other action
  // is terminal (signal_actions_one_terminal_action_per_user_per_signal).
  const isSettled = action !== null && action.action !== 'failed';

  async function handleSkip() {
    setIsSkipping(true);
    await onSkip(signal.id);
    setIsSkipping(false);
  }

  return (
    <Card className="space-y-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-2">
          {signal.direction === 'long' ? (
            <TrendingUp className="h-4 w-4 text-success" />
          ) : (
            <TrendingDown className="h-4 w-4 text-warning" />
          )}
          <p className="text-sm font-semibold text-text-primary">
            {signal.direction === 'long' ? 'Long' : 'Short'} {signal.pair}
          </p>
          {signal.confidence && (
            <span
              className={cn(
                'rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                CONFIDENCE_STYLES[signal.confidence]
              )}
            >
              {signal.confidence} confidence
            </span>
          )}
        </div>
        <p className="shrink-0 text-xs text-text-tertiary">
          {formatDistanceToNow(new Date(signal.created_at), { addSuffix: true })}
        </p>
      </div>

      <div className="grid grid-cols-4 gap-3 text-sm">
        <div>
          <p className="text-xs text-text-tertiary">Entry</p>
          <p className="font-medium text-text-primary">{signal.entry_price.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-text-tertiary">Stop loss</p>
          <p className="font-medium text-text-primary">{signal.stop_loss.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-text-tertiary">Take profit</p>
          <p className="font-medium text-text-primary">{signal.take_profit.toLocaleString()}</p>
        </div>
        <div>
          <p className="text-xs text-text-tertiary">R:R</p>
          <p className="font-medium text-text-primary">{signal.risk_reward_ratio.toFixed(1)}</p>
        </div>
      </div>

      <p className="text-sm text-text-secondary">{signal.rationale}</p>

      {isSettled && action ? (
        <p className="text-xs font-medium text-text-tertiary">
          {ACTION_LABELS[action.action] ?? action.action}
          {action.action === 'failed' && action.failure_reason ? ` — ${action.failure_reason}` : ''}
        </p>
      ) : (
        <div className="flex items-center gap-2 pt-1">
          <span title={!canExecute ? 'No broker connection is authorized for trade execution yet.' : undefined}>
            <Button size="sm" onClick={() => onExecuteClick(signal)} disabled={!canExecute}>
              Execute
            </Button>
          </span>
          <Button size="sm" variant="outline" onClick={handleSkip} isLoading={isSkipping}>
            Skip
          </Button>
        </div>
      )}
    </Card>
  );
}
