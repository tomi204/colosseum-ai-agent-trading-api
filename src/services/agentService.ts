import crypto from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { AppConfig } from '../config.js';
import { defaultRiskLimits } from '../domain/risk/defaults.js';
import { DEFAULT_STRATEGY_ID, StrategyRegistry } from '../domain/strategy/strategyRegistry.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { Agent, RiskLimits, StrategyId } from '../types.js';
import { isoNow } from '../utils/time.js';

export interface RegisterAgentInput {
  name: string;
  startingCapitalUsd?: number;
  strategyId?: StrategyId;
  webhookUrl?: string;
  riskOverrides?: Partial<RiskLimits>;
}

export class AgentService {
  constructor(
    private readonly store: StateStore,
    private readonly config: AppConfig,
    private readonly strategyRegistry: StrategyRegistry,
  ) {}

  async register(input: RegisterAgentInput): Promise<Agent> {
    const now = isoNow();
    const id = uuid();

    const strategyId = input.strategyId ?? DEFAULT_STRATEGY_ID;
    if (!this.strategyRegistry.get(strategyId)) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `Unknown strategyId '${strategyId}'.`,
      );
    }

    const defaults = defaultRiskLimits(this.config.risk);
    const mergedRisk: RiskLimits = {
      ...defaults,
      ...input.riskOverrides,
    };

    const startCapital = input.startingCapitalUsd ?? this.config.trading.defaultStartingCapitalUsd;

    const agent: Agent = {
      id,
      name: input.name,
      apiKey: crypto.randomBytes(24).toString('hex'),
      createdAt: now,
      updatedAt: now,
      startingCapitalUsd: startCapital,
      cashUsd: startCapital,
      realizedPnlUsd: 0,
      peakEquityUsd: startCapital,
      riskLimits: mergedRisk,
      positions: {},
      dailyRealizedPnlUsd: {},
      strategyId,
      riskRejectionsByReason: {},
      ...(input.webhookUrl ? { webhookUrl: input.webhookUrl } : {}),
    };

    await this.store.transaction((state) => {
      state.agents[id] = agent;
      return undefined;
    });

    return agent;
  }

  async setStrategy(agentId: string, strategyId: StrategyId): Promise<Agent> {
    if (!this.strategyRegistry.get(strategyId)) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `Unknown strategyId '${strategyId}'.`,
      );
    }

    const updated = await this.store.transaction((state) => {
      const agent = state.agents[agentId];
      if (!agent) {
        throw new DomainError(ErrorCode.AgentNotFound, 404, 'Agent not found.');
      }

      agent.strategyId = strategyId;
      agent.updatedAt = isoNow();
      return { ...agent };
    });

    return updated;
  }

  getById(agentId: string): Agent | undefined {
    return this.store.snapshot().agents[agentId];
  }

  findByApiKey(apiKey: string): Agent | undefined {
    const agents = Object.values(this.store.snapshot().agents);
    return agents.find((agent) => agent.apiKey === apiKey);
  }
}
