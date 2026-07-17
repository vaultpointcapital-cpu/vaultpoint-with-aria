'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createAlertSchema, type CreateAlertInput } from '@/lib/validations/alerts';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils/cn';
import type { Alert } from '@/types/database';

const SELECT_CLASSNAME =
  'flex h-10 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-accent transition-colors';

interface CreateAlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (alert: Alert) => void;
}

const DEFAULTS = {
  single: { symbol: '', conditionType: 'price' as const, operator: 'above' as const, threshold: undefined },
  portfolio: {
    symbol: null,
    conditionType: 'pnl_pct' as const,
    operator: 'below' as const,
    threshold: undefined,
  },
};

export function CreateAlertDialog({ open, onOpenChange, onCreated }: CreateAlertDialogProps) {
  const [tab, setTab] = useState<'single' | 'portfolio'>('single');
  const [serverError, setServerError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<CreateAlertInput>({
    resolver: zodResolver(createAlertSchema),
    defaultValues: DEFAULTS.single,
  });

  const conditionType = watch('conditionType');
  const thresholdUnit =
    conditionType === 'pnl_pct' || conditionType === 'margin_pct' || conditionType === 'drawdown_pct' ? '%' : '$';

  function switchTab(next: 'single' | 'portfolio') {
    setTab(next);
    reset(DEFAULTS[next]);
  }

  async function onSubmit(data: CreateAlertInput) {
    setServerError(null);
    setIsSubmitting(true);

    // Explicit per-tab override rather than trusting the unmounted tab's
    // fields still hold their reset() value in RHF's submitted data —
    // cheap insurance against silently sending the wrong condition_type.
    const payload: CreateAlertInput =
      tab === 'single' ? { ...data, conditionType: 'price' } : { ...data, symbol: null };

    const res = await fetch('/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    setIsSubmitting(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not create alert. Please try again.');
      return;
    }

    const { alert } = await res.json();
    onCreated(alert);
    setTab('single');
    reset(DEFAULTS.single);
    onOpenChange(false);
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setServerError(null);
          setTab('single');
          reset(DEFAULTS.single);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New Alert</DialogTitle>
          <DialogDescription>Get notified when a price or your portfolio crosses a level you set.</DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => switchTab(v as 'single' | 'portfolio')}>
          <TabsList>
            <TabsTrigger value="single">Single Asset</TabsTrigger>
            <TabsTrigger value="portfolio">Portfolio-Wide</TabsTrigger>
          </TabsList>

          <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
            {serverError && (
              <div
                role="alert"
                className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-sm text-warning"
              >
                {serverError}
              </div>
            )}

            <TabsContent value="single" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="symbol">Symbol</Label>
                <Input id="symbol" placeholder="BTCUSDT" {...register('symbol')} />
                {errors.symbol && <p className="text-xs text-warning">{errors.symbol.message}</p>}
              </div>
            </TabsContent>

            <TabsContent value="portfolio" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="conditionType">Watch</Label>
                <select id="conditionType" className={SELECT_CLASSNAME} {...register('conditionType')}>
                  <option value="pnl_pct">Portfolio P&amp;L (%)</option>
                  <option value="pnl_abs">Portfolio P&amp;L ($)</option>
                  <option value="margin_pct">Margin utilization (%)</option>
                  <option value="drawdown_pct">Drawdown from peak (%)</option>
                </select>
              </div>
            </TabsContent>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="operator">Direction</Label>
                <select id="operator" className={SELECT_CLASSNAME} {...register('operator')}>
                  <option value="above">Crosses above</option>
                  <option value="below">Crosses below</option>
                </select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="threshold">Threshold ({thresholdUnit})</Label>
                <Input
                  id="threshold"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder={thresholdUnit === '%' ? '10' : '100000'}
                  {...register('threshold')}
                />
                {errors.threshold && (
                  <p className={cn('text-xs text-warning')}>{errors.threshold.message}</p>
                )}
              </div>
            </div>

            <Button type="submit" className="w-full" isLoading={isSubmitting}>
              Create alert
            </Button>
          </form>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
