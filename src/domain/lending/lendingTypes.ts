export type LendingProtocol = 'kamino' | 'marginfi' | 'solend';

export type HealthSeverity = 'SAFE' | 'WARNING' | 'CRITICAL';

export interface LendingPosition {
  id: string;
  agentId: string;
  protocol: LendingProtocol;
  market: string;
  suppliedUsd: number;
  borrowedUsd: number;
  healthFactor: number;
  ltv: number;
  wallet: string;
  lastUpdatedAt: string;
}

export interface LendingAlert {
  id: string;
  positionId: string;
  agentId: string;
  severity: HealthSeverity;
  healthFactor: number;
  suggestedAction: string;
  createdAt: string;
  acknowledged: boolean;
}

export interface LendingMonitorState {
  positions: Record<string, LendingPosition>;
  alerts: Record<string, LendingAlert>;
  lastScanAt: string | null;
}

export const classifyHealth = (healthFactor: number): HealthSeverity => {
  if (healthFactor >= 1.5) return 'SAFE';
  if (healthFactor >= 1.2) return 'WARNING';
  return 'CRITICAL';
};
