import { StrategyId } from '../../types.js';
import { arbitrageStrategy } from './arbitrageStrategy.js';
import { dcaStrategy } from './dcaStrategy.js';
import { meanReversionStrategy } from './meanReversionStrategy.js';
import { momentumStrategy } from './momentumStrategy.js';
import { twapStrategy } from './twapStrategy.js';
import { StrategyInput, StrategyPlugin, StrategySignal } from './types.js';

const defaultStrategyId: StrategyId = 'momentum-v1';

export class StrategyRegistry {
  private readonly strategies: Record<StrategyId, StrategyPlugin> = {
    'momentum-v1': momentumStrategy,
    'mean-reversion-v1': meanReversionStrategy,
    'arbitrage-v1': arbitrageStrategy,
    'dca-v1': dcaStrategy,
    'twap-v1': twapStrategy,
  };

  list(): StrategyPlugin[] {
    return Object.values(this.strategies);
  }

  get(strategyId: string): StrategyPlugin | undefined {
    return this.strategies[strategyId as StrategyId];
  }

  mustGet(strategyId: string): StrategyPlugin {
    return this.get(strategyId) ?? this.strategies[defaultStrategyId];
  }

  evaluate(strategyId: string, input: StrategyInput): StrategySignal {
    return this.mustGet(strategyId).evaluate(input);
  }
}

export const DEFAULT_STRATEGY_ID: StrategyId = defaultStrategyId;
