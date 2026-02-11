import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/infra/storage/stateStore.js';
import { LendingMonitorService } from '../src/services/lendingMonitorService.js';
import { classifyHealth } from '../src/domain/lending/lendingTypes.js';
import { buildTestConfig, createTempDir } from './helpers.js';

describe('LendingMonitorService', () => {
  let store: StateStore;
  let service: LendingMonitorService;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await createTempDir();
    const config = buildTestConfig(tmpDir);
    store = new StateStore(config.paths.stateFile);
    await store.init();
    service = new LendingMonitorService(store, config);
  });

  afterEach(() => {
    service.stop();
  });

  it('classifies health factors correctly', () => {
    expect(classifyHealth(2.0)).toBe('SAFE');
    expect(classifyHealth(1.5)).toBe('SAFE');
    expect(classifyHealth(1.3)).toBe('WARNING');
    expect(classifyHealth(1.2)).toBe('WARNING');
    expect(classifyHealth(1.1)).toBe('CRITICAL');
    expect(classifyHealth(0.5)).toBe('CRITICAL');
  });

  it('registers a position and retrieves it', async () => {
    const position = await service.registerPosition({
      agentId: 'agent-1',
      protocol: 'kamino',
      market: 'SOL-USDC',
      suppliedUsd: 10000,
      borrowedUsd: 5000,
      healthFactor: 1.8,
      ltv: 0.5,
      wallet: 'wallet123',
    });

    expect(position.id).toBeDefined();
    expect(position.protocol).toBe('kamino');
    expect(position.healthFactor).toBe(1.8);

    const positions = service.getPositions();
    expect(positions).toHaveLength(1);
    expect(positions[0].id).toBe(position.id);
  });

  it('scan generates alerts for risky positions', async () => {
    await service.registerPosition({
      agentId: 'agent-1',
      protocol: 'marginfi',
      market: 'SOL-USDC',
      suppliedUsd: 10000,
      borrowedUsd: 8500,
      healthFactor: 1.1,
      ltv: 0.85,
      wallet: 'wallet-abc',
    });

    await service.registerPosition({
      agentId: 'agent-2',
      protocol: 'solend',
      market: 'ETH-USDC',
      suppliedUsd: 5000,
      borrowedUsd: 1000,
      healthFactor: 2.5,
      ltv: 0.2,
      wallet: 'wallet-def',
    });

    const { alerts, rebalanceIntents } = await service.scan();

    // Only the critical position should produce an alert
    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('CRITICAL');
    expect(alerts[0].agentId).toBe('agent-1');

    // Critical positions should generate a rebalance intent
    expect(rebalanceIntents).toHaveLength(1);
    expect(rebalanceIntents[0].agentId).toBe('agent-1');
    expect(rebalanceIntents[0].meta.source).toBe('lending-monitor');

    // Verify alerts are stored
    const storedAlerts = service.getAlerts();
    expect(storedAlerts).toHaveLength(1);
  });

  it('scan generates WARNING alerts for borderline positions', async () => {
    await service.registerPosition({
      agentId: 'agent-1',
      protocol: 'kamino',
      market: 'SOL-USDC',
      suppliedUsd: 10000,
      borrowedUsd: 6500,
      healthFactor: 1.35,
      ltv: 0.65,
      wallet: 'wallet-xyz',
    });

    const { alerts, rebalanceIntents } = await service.scan();

    expect(alerts).toHaveLength(1);
    expect(alerts[0].severity).toBe('WARNING');
    // Warnings don't auto-generate rebalance intents
    expect(rebalanceIntents).toHaveLength(0);
  });

  it('returns empty when no positions exist', async () => {
    const positions = service.getPositions();
    expect(positions).toHaveLength(0);

    const alerts = service.getAlerts();
    expect(alerts).toHaveLength(0);

    const { alerts: scanAlerts, rebalanceIntents } = await service.scan();
    expect(scanAlerts).toHaveLength(0);
    expect(rebalanceIntents).toHaveLength(0);
  });
});
