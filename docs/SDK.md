# Colosseum AI-Agent Trading API — SDK

A lightweight, zero-dependency TypeScript client for the Colosseum AI-Agent Trading API.

Works with Node.js 18+ (native `fetch`). Copy-paste friendly — designed so AI agents and developers can integrate in minutes.

## Installation

The SDK ships as part of the main package. Import from the `sdk` path:

```typescript
import { TradingAPIClient } from 'colosseum-ai-agent-trading-api/sdk';
```

Or import directly from source:

```typescript
import { TradingAPIClient } from './src/sdk/index.js';
```

## Quick Start

```typescript
import { TradingAPIClient } from 'colosseum-ai-agent-trading-api/sdk';

// 1. Create client
const client = new TradingAPIClient('http://localhost:3000');

// 2. Register an agent
const { agent, apiKey } = await client.registerAgent({
  name: 'MyTradingBot',
  startingCapitalUsd: 10_000,
  strategyId: 'momentum-v1',
});

// 3. Create authenticated client with the API key
const authedClient = new TradingAPIClient('http://localhost:3000', apiKey);

// 4. Set market price (paper mode)
await authedClient.updatePrice('SOL', 148.50);

// 5. Submit a trade
const result = await authedClient.submitIntent({
  agentId: agent.id,
  symbol: 'SOL',
  side: 'buy',
  quantity: 2,
});

console.log(result.intent.id, result.intent.status);
```

## Constructor

```typescript
// Simple
const client = new TradingAPIClient('http://localhost:3000', 'optional-api-key');

// Options object
const client = new TradingAPIClient({
  baseUrl: 'http://localhost:3000',
  apiKey: 'optional-api-key',
  fetch: customFetchImpl,  // optional: override fetch (useful for testing)
});
```

## API Reference

### Agent Management

#### `registerAgent(opts)`

Register a new trading agent. Returns the agent details and a **one-time API key**.

```typescript
const { agent, apiKey, note } = await client.registerAgent({
  name: 'AlphaBot',
  startingCapitalUsd: 50_000,       // optional, default 10000
  strategyId: 'mean-reversion-v1',  // optional: 'momentum-v1' | 'mean-reversion-v1'
  riskOverrides: {                   // optional
    maxPositionSizePct: 0.15,
    dailyLossCapUsd: 500,
  },
});
```

#### `getAgent(agentId)`

```typescript
const agent = await client.getAgent('agent-abc-123');
// → { id, name, cashUsd, realizedPnlUsd, positions, riskLimits, ... }
```

#### `getPortfolio(agentId)`

Full portfolio snapshot with mark-to-market values.

```typescript
const portfolio = await client.getPortfolio('agent-abc-123');
// → { cashUsd, inventoryValueUsd, equityUsd, realizedPnlUsd, positions, marketPricesUsd }
```

#### `getRiskTelemetry(agentId)`

Live risk metrics including drawdown, exposure, cooldown status.

```typescript
const risk = await client.getRiskTelemetry('agent-abc-123');
// → { grossExposureUsd, drawdownPct, cooldown: { active, remainingSeconds }, ... }
```

### Trading

#### `submitIntent(intent, opts?)`

Submit a trade intent. **Requires API key** (set in constructor).

```typescript
const result = await client.submitIntent({
  agentId: 'agent-abc-123',
  symbol: 'SOL',
  side: 'buy',
  quantity: 5,            // either quantity or notionalUsd required
  // notionalUsd: 1000,   // alternative: trade by dollar amount
  requestedMode: 'paper', // optional: 'paper' | 'live'
  meta: { reason: 'momentum signal' },  // optional
});
// → { message: 'intent_queued', replayed: false, intent: { id, status, ... } }
```

**Idempotency** — prevent duplicate trades:

```typescript
const result = await client.submitIntent(intent, {
  idempotencyKey: 'unique-request-id-123',
});
```

#### `getIntent(intentId)`

```typescript
const intent = await client.getIntent('intent-xyz');
// → { id, status, executionId, ... }
```

### Market Data

#### `updatePrice(symbol, priceUsd)`

Set the market price for paper-trading mode.

```typescript
await client.updatePrice('SOL', 148.50);
await client.updatePrice('BTC', 97_250);
```

### Executions

#### `getExecutions(opts?)`

```typescript
const executions = await client.getExecutions({
  agentId: 'agent-abc-123',  // optional filter
  limit: 20,                  // optional, default 50, max 200
});
// → ExecutionRecord[]
```

#### `getReceipt(executionId)`

Get the cryptographic receipt (hash-chained, tamper-evident).

```typescript
const receipt = await client.getReceipt('exec-123');
// → { version, receiptHash, prevReceiptHash, payload, signaturePayload, ... }
```

#### `verifyReceipt(executionId)`

Server-side integrity verification.

```typescript
const verification = await client.verifyReceipt('exec-123');
console.log(verification.ok); // true = receipt is valid
```

### Autonomous Loop

#### `getAutonomousStatus()`

```typescript
const status = await client.getAutonomousStatus();
// → { enabled, intervalMs, loopCount, lastRunAt, agentStates }
```

#### `toggleAutonomous(enabled)`

```typescript
const status = await client.toggleAutonomous(true);  // enable
const status = await client.toggleAutonomous(false); // disable
```

### System

#### `health()`

```typescript
const health = await client.health();
// → { status: 'ok', uptimeSeconds, stateSummary: { agents, intents, executions, receipts } }
```

#### `metrics()`

```typescript
const metrics = await client.metrics();
// → { runtime, metrics, treasury, monetization }
```

## Error Handling

All API errors throw `TradingAPIError` with structured information:

```typescript
import { TradingAPIClient, TradingAPIError } from 'colosseum-ai-agent-trading-api/sdk';

try {
  await client.getAgent('nonexistent');
} catch (err) {
  if (err instanceof TradingAPIError) {
    console.error(err.status);   // 404
    console.error(err.code);     // 'AGENT_NOT_FOUND'
    console.error(err.message);  // 'Agent not found.'
    console.error(err.details);  // optional additional context
  }
}
```

## For AI Agents

This SDK is designed for agent-to-agent integration. A typical autonomous agent flow:

```typescript
// 1. Register yourself
const { agent, apiKey } = await client.registerAgent({ name: 'AutonomousTrader' });
const authed = new TradingAPIClient(baseUrl, apiKey);

// 2. Monitor the market (your own data source)
await authed.updatePrice('SOL', currentSolPrice);

// 3. Check risk before trading
const risk = await authed.getRiskTelemetry(agent.id);
if (risk.cooldown.active) {
  console.log('Cooling down, skipping...');
  return;
}

// 4. Trade based on your strategy
const { intent } = await authed.submitIntent({
  agentId: agent.id,
  symbol: 'SOL',
  side: risk.drawdownPct > 0.05 ? 'sell' : 'buy',
  notionalUsd: 500,
});

// 5. Verify execution integrity
const verification = await authed.verifyReceipt(intent.executionId!);
assert(verification.ok, 'Receipt integrity check failed!');
```

## Full Example

See [`examples/quickstart.ts`](../examples/quickstart.ts) for a complete working demo.

```bash
# Start the server
npm run dev

# In another terminal
npx tsx examples/quickstart.ts
```
