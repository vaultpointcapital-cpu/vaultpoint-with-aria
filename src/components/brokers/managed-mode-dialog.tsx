'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { managedModeOptInSchema, type ManagedModeOptInInput } from '@/lib/validations/broker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import type { BrokerConnectionSummary } from '@/components/brokers/types';

interface ManagedModeDialogProps {
  connection: BrokerConnectionSummary | null;
  onOpenChange: (open: boolean) => void;
  onEnabled: (connection: BrokerConnectionSummary) => void;
}

export function ManagedModeDialog({ connection, onOpenChange, onEnabled }: ManagedModeDialogProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ManagedModeOptInInput>({
    resolver: zodResolver(managedModeOptInSchema),
    defaultValues: { riskPct: 1, dailyLossLimitPct: 5, consent: undefined },
  });

  async function onSubmit(data: ManagedModeOptInInput) {
    if (!connection) return;
    setServerError(null);
    setIsSubmitting(true);

    const res = await fetch(`/api/brokers/${connection.id}/managed-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not enable Managed Mode. Please try again.');
      return;
    }

    const { connection: updated } = await res.json();
    onEnabled(updated);
    reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={connection !== null}
      onOpenChange={(next) => {
        if (!next) {
          setServerError(null);
          reset();
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Enable Managed Mode</DialogTitle>
          <DialogDescription>
            {connection
              ? `Aria will place trades on ${connection.label} automatically, with no per-signal tap — a materially bigger step than Signal Mode's manual Execute button.`
              : ''}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          {serverError && (
            <div
              role="alert"
              className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
            >
              {serverError}
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="riskPct">Risk per trade (% of equity)</Label>
            <Input id="riskPct" type="number" step="0.1" min="0.1" max="5" {...register('riskPct')} />
            {errors.riskPct && <p className="text-xs text-warning">{errors.riskPct.message}</p>}
            <p className="text-xs text-text-tertiary">
              Position size is derived from this and each signal&apos;s stop-loss distance. Capped at 5%.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="dailyLossLimitPct">Daily loss limit (kill-switch, % of equity)</Label>
            <Input
              id="dailyLossLimitPct"
              type="number"
              step="0.5"
              min="0.5"
              max="20"
              {...register('dailyLossLimitPct')}
            />
            {errors.dailyLossLimitPct && (
              <p className="text-xs text-warning">{errors.dailyLossLimitPct.message}</p>
            )}
            <p className="text-xs text-text-tertiary">
              Managed Mode disables itself automatically the moment today&apos;s realized loss on this
              connection reaches this percentage. Capped at 20%.
            </p>
          </div>

          <div className="flex items-start gap-2 rounded-lg border border-border bg-surface-elevated p-3">
            <input
              id="consent"
              type="checkbox"
              className="mt-0.5 h-4 w-4 shrink-0"
              {...register('consent')}
            />
            <Label htmlFor="consent" className="text-xs font-normal leading-relaxed text-text-secondary">
              I understand Aria will place real trades on this connection automatically, without asking me
              first each time, up to the risk limits above, until I disable Managed Mode or the daily loss
              limit triggers it off.
            </Label>
          </div>
          {errors.consent && <p className="text-xs text-warning">{errors.consent.message}</p>}

          <Button type="submit" className="w-full" isLoading={isSubmitting}>
            Enable Managed Mode
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
