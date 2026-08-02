'use client';

import { useEffect, useState } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { trackEvent } from '@/lib/analytics/track';

export interface OfferCardData {
  id: string;
  partner: string;
  program: string;
  account_size_usd: number;
  price_from_usd: number;
  affiliate_code: string | null;
}

interface OfferCardProps {
  offer: OfferCardData;
}

/**
 * Partner Offers v1 (Hantec Trader Instant Funding). "Refer, don't
 * resell" — VaultPoint never processes payment; clicking opens the
 * partner's own purchase page in a new tab and shows an interstitial in
 * this tab with the affiliate code (URL params get stripped by ad
 * blockers, new-tab behavior, or a purchase made days later — the visible
 * code is attribution insurance) and a link back into the connect flow.
 */
export function OfferCard({ offer }: OfferCardProps) {
  const [stage, setStage] = useState<'card' | 'interstitial'>('card');
  const [stateToken, setStateToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  useEffect(() => {
    trackEvent('offer_viewed', { offerId: offer.id, partner: offer.partner });
    // Only fire once per mount, not on every re-render this component
    // might go through.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleOpen() {
    setServerError(null);
    setIsLoading(true);

    const res = await fetch(`/api/offers/${offer.id}/click`, { method: 'POST' });
    setIsLoading(false);

    if (!res.ok) {
      const body = await res.json().catch(() => null);
      setServerError(body?.error ?? 'Could not open this offer. Please try again.');
      return;
    }

    const { redirect_url, state_token } = await res.json();
    trackEvent('offer_clicked', { offerId: offer.id, partner: offer.partner });
    window.open(redirect_url, '_blank', 'noopener,noreferrer');
    setStateToken(state_token);
    setStage('interstitial');
  }

  async function copyCode() {
    if (!offer.affiliate_code) return;
    await navigator.clipboard.writeText(offer.affiliate_code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (stage === 'interstitial') {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Finish your purchase on Hantec Trader</CardTitle>
          <CardDescription>Opened in a new tab — come back here when you&apos;re done.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-text-secondary">
          <ol className="list-inside list-decimal space-y-1">
            <li>Select Instant Funding</li>
            <li>Choose Platform 5</li>
            <li>
              Apply the code below if it isn&apos;t already applied
              {offer.affiliate_code && (
                <span className="ml-2 inline-flex items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 py-0.5 font-mono text-xs text-text-primary">
                  {offer.affiliate_code}
                  <button
                    type="button"
                    onClick={copyCode}
                    className="text-text-tertiary hover:text-text-primary"
                    aria-label="Copy affiliate code"
                  >
                    <Copy className="h-3 w-3" />
                  </button>
                  {copied && <span className="text-success">Copied</span>}
                </span>
              )}
            </li>
            <li>Keep your login details — you&apos;ll need them to connect</li>
          </ol>
          <Button asChild className="w-full">
            <a href={`/api/offers/return?vp_ref=${stateToken}`}>I&apos;ve created my account →</a>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Get a funded trading account</CardTitle>
        <CardDescription>
          Hantec Trader Instant Funding — start on a simulated funded account with no evaluation phase. From $
          {offer.price_from_usd}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-text-secondary">
          Connect it to VaultPoint afterwards and track your drawdown, daily loss limit, and challenge progress
          automatically.
        </p>

        {offer.affiliate_code && (
          <div className="flex items-center gap-2 text-xs text-text-tertiary">
            Affiliate code:
            <span className="rounded-md border border-border bg-surface-elevated px-2 py-0.5 font-mono text-text-primary">
              {offer.affiliate_code}
            </span>
            <button type="button" onClick={copyCode} className="hover:text-text-primary" aria-label="Copy affiliate code">
              <Copy className="h-3 w-3" />
            </button>
            {copied && <span className="text-success">Copied</span>}
          </div>
        )}

        {serverError && (
          <p role="alert" className="text-xs text-warning">
            {serverError}
          </p>
        )}

        <Button onClick={handleOpen} isLoading={isLoading} className="w-full">
          Open Hantec Trader
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>

        <p className="text-xs text-text-tertiary">
          Simulated capital — not your own funds, and excluded from your net worth. VaultPoint earns a commission
          if you purchase. Not available in all countries. Trading involves risk of loss.
        </p>
      </CardContent>
    </Card>
  );
}
