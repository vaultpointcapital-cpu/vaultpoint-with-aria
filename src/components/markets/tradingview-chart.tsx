'use client';

import { useEffect, useId, useState } from 'react';
import Script from 'next/script';
import { Card } from '@/components/ui/card';

declare global {
  interface Window {
    TradingView?: {
      widget: new (config: Record<string, unknown>) => unknown;
    };
  }
}

const WIDGET_HEIGHT = 500;

interface TradingViewChartProps {
  symbol: string;
}

export function TradingViewChart({ symbol }: TradingViewChartProps) {
  const containerId = `tradingview_chart_${useId().replace(/[^a-zA-Z0-9]/g, '')}`;
  const [scriptReady, setScriptReady] = useState(false);

  useEffect(() => {
    if (!scriptReady || !window.TradingView) return;

    // Clear any previously mounted widget before re-initializing (e.g. if
    // this effect re-runs for a new symbol).
    const container = document.getElementById(containerId);
    if (container) container.innerHTML = '';

    new window.TradingView.widget({
      width: '100%',
      height: WIDGET_HEIGHT,
      symbol,
      interval: '60',
      timezone: 'Etc/UTC',
      theme: 'dark',
      style: '1',
      locale: 'en',
      toolbar_bg: '#0A0C10',
      enable_publishing: false,
      hide_top_toolbar: false,
      save_image: false,
      container_id: containerId,
    });
  }, [scriptReady, symbol, containerId]);

  return (
    <Card className="overflow-hidden p-0">
      <Script
        src="https://s3.tradingview.com/tv.js"
        strategy="afterInteractive"
        onReady={() => setScriptReady(true)}
      />
      <div id={containerId} style={{ height: WIDGET_HEIGHT }} />
    </Card>
  );
}
