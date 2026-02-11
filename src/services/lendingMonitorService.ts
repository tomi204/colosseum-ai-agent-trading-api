import { v4 as uuid } from 'uuid';
import { AppConfig } from '../config.js';
import {
  classifyHealth,
  HealthSeverity,
  LendingAlert,
  LendingMonitorState,
  LendingPosition,
  LendingProtocol,
} from '../domain/lending/lendingTypes.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

export interface RegisterPositionInput {
  agentId: string;
  protocol: LendingProtocol;
  market: string;
  suppliedUsd: number;
  borrowedUsd: number;
  healthFactor: number;
  ltv: number;
  wallet: string;
}

const suggestedActionFor = (severity: HealthSeverity, position: LendingPosition): string => {
  switch (severity) {
    case 'CRITICAL':
      return `Urgent: repay debt or add collateral on ${position.protocol}/${position.market}. Health factor ${position.healthFactor.toFixed(2)} is below 1.2 — liquidation imminent.`;
    case 'WARNING':
      return `Consider rebalancing ${position.protocol}/${position.market}. Health factor ${position.healthFactor.toFixed(2)} approaching danger zone.`;
    case 'SAFE':
    default:
      return 'No action needed.';
  }
};

export interface RebalanceIntent {
  agentId: string;
  symbol: string;
  side: 'buy' | 'sell';
  notionalUsd: number;
  meta: { source: 'lending-monitor'; positionId: string; protocol: string };
}

export class LendingMonitorService {
  private scanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly config: AppConfig,
  ) {}

  /* ── lifecycle ─────────────────────────────────────────────── */

  start(): void {
    if (!this.config.lending.enabled) return;
    if (this.scanTimer) return;

    this.scanTimer = setInterval(() => {
      void this.scan();
    }, this.config.lending.scanIntervalMs);
  }

  stop(): void {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  /* ── read helpers ──────────────────────────────────────────── */

  getPositions(): LendingPosition[] {
    const state = this.store.snapshot();
    return Object.values(state.lending.positions);
  }

  getAlerts(activeOnly = true): LendingAlert[] {
    const state = this.store.snapshot();
    const all = Object.values(state.lending.alerts);
    return activeOnly ? all.filter((a) => !a.acknowledged) : all;
  }

  getLendingState(): LendingMonitorState {
    return this.store.snapshot().lending;
  }

  /* ── mutations ─────────────────────────────────────────────── */

  async registerPosition(input: RegisterPositionInput): Promise<LendingPosition> {
    const now = isoNow();
    const position: LendingPosition = {
      id: uuid(),
      agentId: input.agentId,
      protocol: input.protocol,
      market: input.market,
      suppliedUsd: input.suppliedUsd,
      borrowedUsd: input.borrowedUsd,
      healthFactor: input.healthFactor,
      ltv: input.ltv,
      wallet: input.wallet,
      lastUpdatedAt: now,
    };

    await this.store.transaction((state) => {
      state.lending.positions[position.id] = position;
    });

    return position;
  }

  /* ── scan ──────────────────────────────────────────────────── */

  async scan(): Promise<{ alerts: LendingAlert[]; rebalanceIntents: RebalanceIntent[] }> {
    const now = isoNow();
    const newAlerts: LendingAlert[] = [];
    const rebalanceIntents: RebalanceIntent[] = [];

    await this.store.transaction((state) => {
      const positions = Object.values(state.lending.positions);

      for (const position of positions) {
        const severity = classifyHealth(position.healthFactor);
        if (severity === 'SAFE') continue;

        const alert: LendingAlert = {
          id: uuid(),
          positionId: position.id,
          agentId: position.agentId,
          severity,
          healthFactor: position.healthFactor,
          suggestedAction: suggestedActionFor(severity, position),
          createdAt: now,
          acknowledged: false,
        };

        state.lending.alerts[alert.id] = alert;
        newAlerts.push(alert);

        if (severity === 'CRITICAL') {
          const repayAmount = Math.min(position.borrowedUsd * 0.25, position.borrowedUsd);
          rebalanceIntents.push({
            agentId: position.agentId,
            symbol: 'USDC',
            side: 'buy',
            notionalUsd: repayAmount,
            meta: {
              source: 'lending-monitor',
              positionId: position.id,
              protocol: position.protocol,
            },
          });
        }
      }

      state.lending.lastScanAt = now;
    });

    return { alerts: newAlerts, rebalanceIntents };
  }
}
