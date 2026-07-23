import type { AlertConditionType, AlertOperator } from '@/types/database';

export type AlertVisualCategory = 'data' | 'profit' | 'loss' | 'risk';

/**
 * Mirrors services/broker-sync/app/alert_engine.py's _message_type_for:
 * margin/drawdown always read as a risk check regardless of direction;
 * price and P&L alerts read as profit (crossed above) or loss (crossed
 * below). Kept in sync deliberately — the same alert should look the
 * same way it's categorized when it actually fires.
 */
export function categorizeAlert(
  conditionType: AlertConditionType,
  operator: AlertOperator
): AlertVisualCategory {
  if (conditionType === 'margin_pct' || conditionType === 'drawdown_pct') {
    return 'risk';
  }
  if (conditionType === 'price') {
    return 'data';
  }
  return operator === 'below' ? 'loss' : 'profit';
}

export const ALERT_CATEGORY_BORDER: Record<AlertVisualCategory, string> = {
  data: 'border-l-info',
  profit: 'border-l-success',
  loss: 'border-l-warning',
  risk: 'border-l-warning',
};

export const ALERT_CATEGORY_ICON_BG: Record<AlertVisualCategory, string> = {
  data: 'bg-info/10 text-info',
  profit: 'bg-success/10 text-success',
  loss: 'bg-warning/10 text-warning',
  risk: 'bg-warning/10 text-warning',
};

export const ALERT_CATEGORY_TEXT: Record<AlertVisualCategory, string> = {
  data: 'text-info',
  profit: 'text-success',
  loss: 'text-warning',
  risk: 'text-warning',
};

export const ALERT_CATEGORY_LABEL: Record<AlertVisualCategory, string> = {
  data: 'Price',
  profit: 'Profit',
  loss: 'Loss',
  risk: 'Risk',
};
