import type { Signal, SignalAction } from '@/types/database';
import type { BrokerConnectionSummary } from '@/components/brokers/types';

/** A signal plus the caller's own action on it, if any (null = not yet acted on). */
export interface SignalWithAction {
  signal: Signal;
  action: SignalAction | null;
}

/** Only connections eligible to execute a Signal Mode trade — see broker-connection-card.tsx's re-authorization flow. */
export type ExecutableBrokerConnection = Pick<BrokerConnectionSummary, 'id' | 'broker' | 'label'>;
