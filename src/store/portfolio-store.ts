import { create } from 'zustand';
import type { Position, ManualAsset, BrokerConnection } from '@/types/database';

interface PortfolioState {
  netWorth: number;
  totalUnrealizedPnl: number;
  positions: Position[];
  manualAssets: ManualAsset[];
  brokerConnections: Pick<BrokerConnection, 'id' | 'broker' | 'label' | 'sync_status' | 'last_synced_at'>[];
  isLoading: boolean;
  error: string | null;
  setPortfolio: (data: {
    netWorth: number;
    totalUnrealizedPnl: number;
    positions: Position[];
    manualAssets: ManualAsset[];
    brokerConnections: PortfolioState['brokerConnections'];
  }) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}

/**
 * Lightweight client-side cache of portfolio data, populated by a fetch
 * to GET /api/portfolio and refreshed via the dashboard's polling/realtime
 * subscription (wired up in Sprint 5). Kept deliberately thin — Zustand,
 * not Redux, per the approved stack — since this is just a shared cache,
 * not a place for business logic.
 */
export const usePortfolioStore = create<PortfolioState>((set) => ({
  netWorth: 0,
  totalUnrealizedPnl: 0,
  positions: [],
  manualAssets: [],
  brokerConnections: [],
  isLoading: true,
  error: null,
  setPortfolio: (data) =>
    set({
      netWorth: data.netWorth,
      totalUnrealizedPnl: data.totalUnrealizedPnl,
      positions: data.positions,
      manualAssets: data.manualAssets,
      brokerConnections: data.brokerConnections,
      isLoading: false,
      error: null,
    }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error, isLoading: false }),
}));
