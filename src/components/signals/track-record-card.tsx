import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import type { TrackRecordSummary } from '@/lib/validations/signals';

export function TrackRecordCard({ trackRecord }: { trackRecord: TrackRecordSummary }) {
  if (trackRecord.totalClosed === 0) {
    return null; // Nothing to show yet — first closed signal is what makes this card meaningful.
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Your track record</CardTitle>
      </CardHeader>
      <CardContent className="grid grid-cols-3 gap-4">
        <div>
          <p className="text-2xl font-semibold text-text-primary">
            {trackRecord.winRatePct !== null ? `${trackRecord.winRatePct.toFixed(0)}%` : '—'}
          </p>
          <p className="text-xs text-text-tertiary">Win rate</p>
        </div>
        <div>
          <p className="text-2xl font-semibold text-text-primary">
            {trackRecord.avgRMultiple !== null ? `${trackRecord.avgRMultiple.toFixed(2)}R` : '—'}
          </p>
          <p className="text-xs text-text-tertiary">Avg R:R realized</p>
        </div>
        <div>
          <p className="text-2xl font-semibold text-text-primary">{trackRecord.totalClosed}</p>
          <p className="text-xs text-text-tertiary">
            Signals closed ({trackRecord.wins}W / {trackRecord.losses}L
            {trackRecord.breakevens > 0 ? ` / ${trackRecord.breakevens}BE` : ''})
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
