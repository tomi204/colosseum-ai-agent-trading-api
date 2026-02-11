#!/usr/bin/env npx tsx
// ─── Colosseum AI-Agent Trading API — SDK Quick-Start ──────────────────────
// Full flow: register agent → set prices → submit intent → check execution → verify receipt
//
// Usage:
//   npx tsx examples/quickstart.ts                         # uses localhost:3000
//   API_URL=https://your-server.com npx tsx examples/quickstart.ts
// ────────────────────────────────────────────────────────────────────────────

import { TradingAPIClient, TradingAPIError } from '../src/sdk/index.js';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';

async function main() {
  console.log(`\n🚀 Colosseum Trading SDK — Quick-Start`);
  console.log(`   API: ${API_URL}\n`);

  // ── 1. Create an unauthenticated client for public endpoints ──────────
  const publicClient = new TradingAPIClient(API_URL);

  // Health check
  const health = await publicClient.health();
  console.log(`✅ Health: ${health.status} | mode=${health.defaultMode} | agents=${health.stateSummary.agents}`);

  // ── 2. Register an agent ──────────────────────────────────────────────
  console.log(`\n📝 Registering agent...`);
  const registration = await publicClient.registerAgent({
    name: 'SDK-Demo-Agent',
    startingCapitalUsd: 10_000,
    strategyId: 'momentum-v1',
  });

  const { agent, apiKey } = registration;
  console.log(`   Agent ID:  ${agent.id}`);
  console.log(`   Name:      ${agent.name}`);
  console.log(`   Capital:   $${agent.startingCapitalUsd}`);
  console.log(`   API Key:   ${apiKey.slice(0, 12)}...`);

  // ── 3. Create an authenticated client ─────────────────────────────────
  const client = new TradingAPIClient(API_URL, apiKey);

  // ── 4. Set market prices (paper mode) ─────────────────────────────────
  console.log(`\n💰 Setting market prices...`);
  await client.updatePrice('SOL', 148.50);
  await client.updatePrice('BTC', 97_250);
  console.log(`   SOL = $148.50, BTC = $97,250`);

  // ── 5. Submit a trade intent ──────────────────────────────────────────
  console.log(`\n📊 Submitting trade intent: BUY 2 SOL...`);
  const intentResult = await client.submitIntent({
    agentId: agent.id,
    symbol: 'SOL',
    side: 'buy',
    quantity: 2,
  });

  const intent = intentResult.intent;
  console.log(`   Intent ID: ${intent.id}`);
  console.log(`   Status:    ${intent.status}`);

  // ── 6. Wait for execution (worker processes intents async) ────────────
  console.log(`\n⏳ Waiting for execution...`);
  let executionId: string | undefined;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const refreshed = await client.getIntent(intent.id);
    if (refreshed.status === 'executed' && refreshed.executionId) {
      executionId = refreshed.executionId;
      console.log(`   ✅ Executed! Execution ID: ${executionId}`);
      break;
    }
    if (refreshed.status === 'rejected' || refreshed.status === 'failed') {
      console.log(`   ❌ Intent ${refreshed.status}: ${refreshed.statusReason}`);
      break;
    }
    process.stdout.write('.');
  }

  if (!executionId) {
    console.log(`\n   ⚠️  Intent not yet executed. The worker may not be running.`);
    console.log(`   Check /executions or run the server with worker enabled.\n`);
  }

  // ── 7. Check executions ───────────────────────────────────────────────
  const executions = await client.getExecutions({ agentId: agent.id, limit: 5 });
  console.log(`\n📋 Recent executions for agent: ${executions.length}`);
  for (const ex of executions) {
    console.log(`   ${ex.id} | ${ex.side} ${ex.quantity} ${ex.symbol} @ $${ex.priceUsd} | ${ex.status} | PnL=$${ex.realizedPnlUsd}`);
  }

  // ── 8. Verify receipt (if executed) ───────────────────────────────────
  if (executionId) {
    console.log(`\n🔐 Verifying receipt...`);
    try {
      const receipt = await client.getReceipt(executionId);
      console.log(`   Receipt hash: ${receipt.receiptHash.slice(0, 16)}...`);
      console.log(`   Chain link:   ${receipt.prevReceiptHash?.slice(0, 16) ?? 'GENESIS'}...`);

      const verification = await client.verifyReceipt(executionId);
      console.log(`   Integrity:    ${verification.ok ? '✅ VALID' : '❌ INVALID'}`);
    } catch (err) {
      if (err instanceof TradingAPIError && err.status === 404) {
        console.log(`   Receipt not yet generated (worker lag).`);
      } else {
        throw err;
      }
    }
  }

  // ── 9. Portfolio snapshot ─────────────────────────────────────────────
  console.log(`\n💼 Portfolio snapshot:`);
  const portfolio = await client.getPortfolio(agent.id);
  console.log(`   Cash:      $${portfolio.cashUsd.toFixed(2)}`);
  console.log(`   Inventory: $${portfolio.inventoryValueUsd.toFixed(2)}`);
  console.log(`   Equity:    $${portfolio.equityUsd.toFixed(2)}`);
  console.log(`   PnL:       $${portfolio.realizedPnlUsd.toFixed(2)}`);

  // ── 10. Risk telemetry ────────────────────────────────────────────────
  console.log(`\n🛡️  Risk telemetry:`);
  const risk = await client.getRiskTelemetry(agent.id);
  console.log(`   Gross exposure: $${risk.grossExposureUsd.toFixed(2)}`);
  console.log(`   Drawdown:       ${(risk.drawdownPct * 100).toFixed(2)}%`);
  console.log(`   Cooldown:       ${risk.cooldown.active ? `active (${risk.cooldown.remainingSeconds}s)` : 'inactive'}`);

  // ── 11. Autonomous status ─────────────────────────────────────────────
  console.log(`\n🤖 Autonomous loop:`);
  const autoStatus = await client.getAutonomousStatus();
  console.log(`   Enabled: ${autoStatus.enabled} | Loops: ${autoStatus.loopCount}`);

  // ── 12. Metrics ───────────────────────────────────────────────────────
  console.log(`\n📈 Metrics:`);
  const m = await client.metrics();
  console.log(`   Uptime:    ${m.runtime.uptimeSeconds}s`);
  console.log(`   Executed:  ${m.metrics.intentsExecuted}`);
  console.log(`   Rejected:  ${m.metrics.intentsRejected}`);
  console.log(`   Receipts:  ${m.metrics.receiptCount}`);
  console.log(`   Treasury:  $${m.treasury.totalFeesUsd.toFixed(4)}`);

  console.log(`\n🎉 Quick-start complete!\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('\n💥 Error:', err instanceof TradingAPIError
    ? `[${err.code}] ${err.message}`
    : err,
  );
  process.exit(1);
});
