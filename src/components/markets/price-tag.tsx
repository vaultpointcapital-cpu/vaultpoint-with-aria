import { ArrowUp, ArrowDown } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { formatCurrency, formatPercentage } from '@/lib/utils/cn';

interface PriceTagProps {
  price: number;
  changePct: number | null;
  className?: string;
}

/**
 * The one place price + %-change coloring/typography is decided —
 * every ticker/position/alert surface should render deltas through this
 * rather than re-deciding success/warning + arrow direction inline.
 * Design-token rule: positive = success (emerald), negative = warning
 * (orange), never red/green: see globals design token audit.
 */
export function PriceTag({ price, changePct, className }: PriceTagProps) {
  const isPositive = (changePct ?? 0) >= 0;
  const colorClass = changePct === null ? 'text-text-secondary' : isPositive ? 'text-success' : 'text-warning';

  return (
    <div className={cn('flex items-baseline gap-1.5', className)}>
      <span className="font-mono-num text-sm font-medium text-text-primary">{formatCurrency(price)}</span>
      {changePct !== null && (
        <span className={cn('flex items-center gap-0.5 font-mono-num text-xs font-medium', colorClass)}>
          {isPositive ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />}
          {formatPercentage(changePct)}
        </span>
      )}
    </div>
  );
}
