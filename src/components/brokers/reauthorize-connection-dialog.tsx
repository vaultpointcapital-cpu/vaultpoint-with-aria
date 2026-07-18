'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  reauthorizeBrokerConnectionSchema,
  type ReauthorizeBrokerConnectionInput,
} from '@/lib/validations/broker';
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

const SELECT_CLASSNAME =
  'flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent transition-colors';

interface ReauthorizeConnectionDialogProps {
  connection: BrokerConnectionSummary | null;
  onOpenChange: (open: boolean) => void;
  onReauthorized: (connection: BrokerConnectionSummary) => void;
}

export function ReauthorizeConnectionDialog({
  connection,
  onOpenChange,
  onReauthorized,
}: ReauthorizeConnectionDialogProps) {
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<ReauthorizeBrokerConnectionInput>({
    resolver: zodResolver(reauthorizeBrokerConnectionSchema),
    values: connection ? { broker: connection.broker } : undefined,
  });

  async function onSubmit(data: ReauthorizeBrokerConnectionInput) {
    if (!connection) return;
    setServerError(null);
    setIsSubmitting(true);

    const res = await fetch(`/api/brokers/${connection.id}/authorize-execution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not re-authorize this connection. Please try again.');
      return;
    }

    const { connection: updated } = await res.json();
    onReauthorized(updated);
    reset();
    onOpenChange(false);
  }

  const isMetaTrader = connection?.broker === 'metatrader';
  const isKucoin = connection?.broker === 'kucoin';

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
          <DialogTitle>Authorize for trade execution</DialogTitle>
          <DialogDescription>
            {connection
              ? `Submit trade-permission credentials for ${connection.label}. VaultPoint will use these to
                 place real orders from Signal Mode — never automatically, only when you tap Execute.`
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

          {isMetaTrader ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="mtLogin">MT account login</Label>
                <Input id="mtLogin" {...register('mtLogin')} />
                {errors.mtLogin && <p className="text-xs text-warning">{errors.mtLogin.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="mtServer">MT server</Label>
                <Input id="mtServer" placeholder="Exness-MT5Real8" {...register('mtServer')} />
                {errors.mtServer && <p className="text-xs text-warning">{errors.mtServer.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="mtPlatform">Platform</Label>
                <select id="mtPlatform" className={SELECT_CLASSNAME} {...register('mtPlatform')}>
                  <option value="mt4">MT4</option>
                  <option value="mt5">MT5</option>
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="mtPassword">MT trading password</Label>
                <Input id="mtPassword" type="password" {...register('mtPassword')} />
                {errors.mtPassword && <p className="text-xs text-warning">{errors.mtPassword.message}</p>}
                <p className="text-xs text-text-tertiary">
                  This must be able to place trades — not the investor/read-only password used for the
                  original connection.
                </p>
              </div>
            </>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor="apiKey">API key</Label>
                <Input id="apiKey" {...register('apiKey')} />
                {errors.apiKey && <p className="text-xs text-warning">{errors.apiKey.message}</p>}
              </div>
              <div className="space-y-2">
                <Label htmlFor="apiSecret">API secret</Label>
                <Input id="apiSecret" type="password" {...register('apiSecret')} />
                {errors.apiSecret && <p className="text-xs text-warning">{errors.apiSecret.message}</p>}
              </div>
              {isKucoin && (
                <div className="space-y-2">
                  <Label htmlFor="apiPassphrase">API passphrase</Label>
                  <Input id="apiPassphrase" type="password" {...register('apiPassphrase')} />
                  {errors.apiPassphrase && (
                    <p className="text-xs text-warning">{errors.apiPassphrase.message}</p>
                  )}
                </div>
              )}
              <p className="text-xs text-text-tertiary">
                This key must have order-placement permission enabled — not the read-only key used for the
                original connection.
              </p>
            </>
          )}

          <Button type="submit" className="w-full" isLoading={isSubmitting}>
            Authorize for trade execution
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
