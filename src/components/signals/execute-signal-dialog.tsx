'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { executeSignalSchema, describeSignal, type ExecuteSignalInput } from '@/lib/validations/signals';
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
import type { Signal } from '@/types/database';
import type { ExecutableBrokerConnection } from '@/components/signals/types';

const SELECT_CLASSNAME =
  'flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent transition-colors';

interface ExecuteSignalDialogProps {
  signal: Signal | null;
  connections: ExecutableBrokerConnection[];
  onOpenChange: (open: boolean) => void;
  // Called after both a successful execution AND a failed attempt — a
  // 'failed' signal_actions row is still recorded server-side on a
  // rejection (see services/broker-sync/app/signal_execution.py), so the
  // signal card needs to refetch either way to stop offering Execute
  // again for a settled attempt.
  onSettled: () => void;
}

export function ExecuteSignalDialog({ signal, connections, onOpenChange, onSettled }: ExecuteSignalDialogProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ExecuteSignalInput>({
    resolver: zodResolver(executeSignalSchema),
    defaultValues: { brokerConnectionId: connections[0]?.id ?? '', size: undefined },
  });

  async function onSubmit(data: ExecuteSignalInput) {
    if (!signal) return;
    setServerError(null);
    setIsSubmitting(true);

    const res = await fetch(`/api/signals/${signal.id}/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    setIsSubmitting(false);
    onSettled();

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not execute this signal. Please try again.');
      return;
    }

    reset();
    onOpenChange(false);
  }

  return (
    <Dialog
      open={signal !== null}
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
          <DialogTitle>Execute signal</DialogTitle>
          <DialogDescription>
            {signal
              ? `${describeSignal(signal)}. This places a real order on your connected broker.`
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
            <Label htmlFor="brokerConnectionId">Broker connection</Label>
            <select
              id="brokerConnectionId"
              className={SELECT_CLASSNAME}
              {...register('brokerConnectionId')}
            >
              {connections.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            {errors.brokerConnectionId && (
              <p className="text-xs text-warning">{errors.brokerConnectionId.message}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="size">Position size</Label>
            <Input
              id="size"
              type="number"
              step="any"
              min="0"
              placeholder="0.01"
              {...register('size')}
            />
            {errors.size && <p className="text-xs text-warning">{errors.size.message}</p>}
          </div>

          <Button type="submit" className="w-full" isLoading={isSubmitting} disabled={connections.length === 0}>
            Confirm and execute
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
