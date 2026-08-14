'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { addBrokerConnectionSchema, type AddBrokerConnectionInput } from '@/lib/validations/broker';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { BrokerType } from '@/types/database';

const SELECT_CLASSNAME =
  'flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent transition-colors';

const BROKER_LABELS: Record<BrokerType, string> = {
  bybit: 'Bybit',
  binance: 'Binance',
  kucoin: 'KuCoin',
  metatrader: 'MetaTrader',
};

interface AddBrokerClientProps {
  /** Partner Offers v1 — /connect/hantec pre-selects and locks MetaTrader
   * (Hantec is always MT5) rather than forking this component. */
  lockedBroker?: BrokerType;
  lockedAccountType?: 'live' | 'simulated';
  vpRef?: string;
  title?: string;
  description?: string;
}

export function AddBrokerClient({ lockedBroker, lockedAccountType, vpRef, title, description }: AddBrokerClientProps = {}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<AddBrokerConnectionInput>({
    resolver: zodResolver(addBrokerConnectionSchema),
    defaultValues: { broker: lockedBroker ?? 'bybit' },
  });

  const broker = watch('broker');
  const isMetaTrader = broker === 'metatrader';
  const isKucoin = broker === 'kucoin';

  async function onSubmit(data: AddBrokerConnectionInput) {
    setServerError(null);
    setIsSubmitting(true);

    try {
      const res = await fetch('/api/brokers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...data, vpRef, accountType: lockedAccountType }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setServerError(body?.error ?? 'Could not save this broker connection. Please try again.');
        return;
      }

      router.push('/dashboard/brokers');
      router.refresh();
    } catch {
      // A thrown fetch (network failure, etc.) previously left isSubmitting
      // stuck true forever with no feedback — same silent-failure shape as
      // an unhandled validation rejection. Never let this fail silently.
      setServerError('Could not reach the server. Check your connection and try again.');
    } finally {
      setIsSubmitting(false);
    }
  }

  function onInvalid(invalidFields: typeof errors) {
    // Client-side validation failing must never be silent — previously
    // there was no onInvalid handler at all, so a rejected/failed
    // validation left the user staring at an unresponsive form with zero
    // feedback (found during a real "the page isn't going through" report
    // testing the MetaTrader path).
    console.error('Broker form validation failed:', invalidFields);
    setServerError('Please check the highlighted fields and try again.');
  }

  return (
    <div className="mx-auto max-w-lg space-y-5 p-6">
      <Link
        href="/dashboard/brokers"
        className="inline-flex items-center gap-1.5 text-sm text-text-secondary hover:text-text-primary"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to brokers
      </Link>

      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">
          {title ?? 'Connect a broker'}
        </h1>
        <p className="mt-1 text-sm text-text-secondary">
          {description ??
            'Use a read-only API key — VaultPoint never places a trade or moves funds on a tracking-only connection.'}
        </p>
        {lockedAccountType === 'simulated' && (
          <p className="mt-2 text-xs text-warning">
            Simulated capital — not your own funds, and excluded from your net worth.
          </p>
        )}
      </div>

      <form onSubmit={handleSubmit(onSubmit, onInvalid)} className="space-y-4">
        {serverError && (
          <div role="alert" className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning">
            {serverError}
          </div>
        )}

        {lockedBroker ? (
          <input type="hidden" {...register('broker')} />
        ) : (
          <div className="space-y-2">
            <Label htmlFor="broker">Broker</Label>
            <select id="broker" className={SELECT_CLASSNAME} {...register('broker')}>
              {(Object.keys(BROKER_LABELS) as BrokerType[]).map((value) => (
                <option key={value} value={value}>
                  {BROKER_LABELS[value]}
                </option>
              ))}
            </select>
            {errors.broker && <p className="text-xs text-warning">{errors.broker.message}</p>}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="label">Label</Label>
          <Input id="label" placeholder='e.g. "Main Bybit"' {...register('label')} />
          {errors.label && <p className="text-xs text-warning">{errors.label.message}</p>}
        </div>

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
              {errors.mtPlatform && <p className="text-xs text-warning">{errors.mtPlatform.message}</p>}
            </div>
            <div className="space-y-2">
              <Label htmlFor="mtPassword">MT password</Label>
              <Input id="mtPassword" type="password" {...register('mtPassword')} />
              {errors.mtPassword && <p className="text-xs text-warning">{errors.mtPassword.message}</p>}
              <p className="text-xs text-text-tertiary">
                Use the investor/read-only password if your broker offers one — not the trading password.
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
              Create a read-only key — no trade or withdrawal permission. You can authorize trade
              execution for Signal Mode separately later, from this connection&apos;s own menu.
            </p>
          </>
        )}

        <Button type="submit" className="w-full" isLoading={isSubmitting}>
          Connect broker
        </Button>
      </form>
    </div>
  );
}
