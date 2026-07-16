'use client';

import { format } from 'date-fns';
import {
  Area,
  AreaChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipProps,
} from 'recharts';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { formatCurrency } from '@/lib/utils/cn';
import type { PortfolioSnapshot } from '@/types/database';

const ACCENT = '#6C63FF';
const BORDER = '#1E2330';
const TEXT_TERTIARY = '#4A5168';

interface NetWorthChartProps {
  snapshots: PortfolioSnapshot[];
}

export function NetWorthChart({ snapshots }: NetWorthChartProps) {
  if (snapshots.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Net Worth History</CardTitle>
        </CardHeader>
        <p className="py-10 text-center text-sm text-text-tertiary">
          Net worth history will appear here once your first daily snapshot is recorded.
        </p>
      </Card>
    );
  }

  const data = snapshots.map((s) => ({
    date: s.snapshot_date,
    total: s.total_net_worth,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Net Worth History</CardTitle>
      </CardHeader>
      <div className="h-56 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
            <defs>
              <linearGradient id="netWorthFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ACCENT} stopOpacity={0.35} />
                <stop offset="100%" stopColor={ACCENT} stopOpacity={0} />
              </linearGradient>
            </defs>
            <XAxis
              dataKey="date"
              tickFormatter={(value: string) => format(new Date(value), 'MMM d')}
              stroke={BORDER}
              tick={{ fill: TEXT_TERTIARY, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              minTickGap={24}
            />
            <YAxis
              tickFormatter={(value: number) => formatCurrency(value)}
              stroke={BORDER}
              tick={{ fill: TEXT_TERTIARY, fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              width={70}
            />
            <Tooltip content={<NetWorthTooltip />} />
            <Area
              type="monotone"
              dataKey="total"
              stroke={ACCENT}
              strokeWidth={2}
              fill="url(#netWorthFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}

function NetWorthTooltip({ active, payload, label }: TooltipProps<number, string>) {
  if (!active || !payload?.length) return null;

  return (
    <div className="rounded-lg border border-border bg-surface-elevated px-3 py-2 text-xs shadow-lg">
      <p className="text-text-tertiary">{format(new Date(label as string), 'MMM d, yyyy')}</p>
      <p className="mt-0.5 font-mono-num font-semibold text-text-primary">
        {formatCurrency(payload[0]?.value ?? 0)}
      </p>
    </div>
  );
}
