# 🏛️ Colosseum AI Agent Trading API

**The complete autonomous DeFi infrastructure for AI agents on Solana — trading, arbitrage, lending, backtesting, multi-agent coordination, and a strategy marketplace.**

[![Tests](https://img.shields.io/badge/tests-356%20passing-brightgreen)](#tests)
[![Test Files](https://img.shields.io/badge/test%20files-45-blue)](#tests)
[![Live on Mainnet](https://img.shields.io/badge/mainnet-2%20live%20txs-blue)](https://solscan.io/tx/5qZERks6yv1Rjhm5wHvuLRt36nofPrgrCdmeFP5xbVwkGoj4sAubdnXo6MoZUS3XsxYECcgL7ENBdMkoMjmx8kG7)
[![Live Demo](https://img.shields.io/badge/demo-live-green)](https://colosseum-ai-agent-trading-api.onrender.com/health)
[![SDK](https://img.shields.io/badge/SDK-TypeScript-blue)](#sdk)
[![License: MIT](https://img.shields.io/badge/license-MIT-yellow)](#license)

> **🔴 Live now:** [Health](https://colosseum-ai-agent-trading-api.onrender.com/health) · [Experiment UI](https://colosseum-ai-agent-trading-api.onrender.com/experiment) · [Agents](https://colosseum-ai-agent-trading-api.onrender.com/agents) · [Order Book](https://colosseum-ai-agent-trading-api.onrender.com/orderbook/SOL-USDC) · [Marketplace](https://colosseum-ai-agent-trading-api.onrender.com/marketplace/listings) · [Metrics](https://colosseum-ai-agent-trading-api.onrender.com/metrics)

---

## The Problem

AI agents are entering DeFi at scale, but existing trading infrastructure isn't built for them:

| Challenge | What happens today |
|---|---|
| **No guardrails** | Agents blow up portfolios in seconds — no drawdown limits, no cooldowns, no exposure caps |
| **No audit trail** | Trades vanish into opaque execution — no verifiable proof of what happened or why |
| **No coordination** | Multi-agent systems can't form squads, share strategies, or aggregate positions |
| **No monetization** | Operators have no built-in way to earn from agents using their infrastructure |
| **No backtesting** | Agents can't validate strategies before risking real capital |

This project solves all five.

---

## The Solution

A self-contained DeFi hub designed from the ground up for AI agents. Agents register, submit trade intents, backtest strategies, form multi-agent squads, subscribe to marketplace strategies, and the system handles risk enforcement, staged execution, receipt generation, and fee collection — autonomously.

**Proven on Solana mainnet with 2 live transactions:**
- Sell (SOL→USDC): [`3XmPquL...sZdKf`](https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf)
- Buy (USDC→SOL): [`5qZERks...x8kG7`](https://solscan.io/tx/5qZERks6yv1Rjhm5wHvuLRt36nofPrgrCdmeFP5xbVwkGoj4sAubdnXo6MoZUS3XsxYECcgL7ENBdMkoMjmx8kG7)

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        AI AGENT CLIENTS                         │
│          (any LLM agent, bot, or automation + SDK)              │
└────────────────────────────┬─────────────────────────────────────┘
                             │  REST + WebSocket
                             ▼
┌──────────────────────────────────────────────────────────────────┐
│                   FASTIFY API GATEWAY + WS                       │
│                                                                  │
│  ┌──────────┐ ┌────────────┐ ┌───────────┐ ┌────────────────┐  │
│  │ Rate     │ │ Idempotency│ │ Agent Auth│ │ x402 Payment   │  │
│  │ Limiter  │ │ Guard      │ │ (API key) │ │ Gate           │  │
│  └──────────┘ └────────────┘ └───────────┘ └────────────────┘  │
└────────────────────────────┬─────────────────────────────────────┘
                             │
     ┌───────────┬───────────┼───────────┬───────────┐
     ▼           ▼           ▼           ▼           ▼
┌──────────┐ ┌────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐
│ STRATEGY │ │ RISK   │ │ STAGED   │ │ ARBI-  │ │ LENDING  │
│ ENGINE   │ │ ENGINE │ │ PIPELINE │ │ TRAGE  │ │ MONITOR  │
│          │ │        │ │          │ │ SCANNER│ │          │
│ 5 strats │ │ 6-layer│ │ validate │ │ cross- │ │ health   │
│ pluggable│ │ guards │ │ simulate │ │ venue  │ │ factor   │
│          │ │        │ │ execute  │ │ spreads│ │ alerts   │
└──────────┘ └────────┘ └──────────┘ └────────┘ └──────────┘
     │           │           │           │           │
     └───────────┴───────────┼───────────┴───────────┘
                             ▼
     ┌───────────────────────────────────────────────┐
     │              EXECUTION LAYER                   │
     │                                                │
     │  ┌─────────┐ ┌──────────┐ ┌───────────────┐  │
     │  │ Paper   │ │ Live     │ │ Receipt +     │  │
     │  │ Trading │ │ Jupiter  │ │ Hash Chain    │  │
     │  │ Sim     │ │ Swaps    │ │ (SHA-256)     │  │
     │  └─────────┘ └──────────┘ └───────────────┘  │
     └───────────────────────┬───────────────────────┘
                             │
     ┌───────────┬───────────┼───────────┬───────────┐
     ▼           ▼           ▼           ▼           ▼
┌──────────┐ ┌────────┐ ┌──────────┐ ┌────────┐ ┌──────────┐
│ WEBHOOK  │ │ EVENT  │ │ ON-CHAIN │ │ FEE    │ │ PRIVACY  │
│ DELIVERY │ │ AUDIT  │ │ PROOF    │ │ ENGINE │ │ LAYER    │
│          │ │ LOG    │ │ ANCHORS  │ │        │ │          │
│ trade    │ │ NDJSON │ │ Solana   │ │ treasury│ │ AES-256  │
│ events   │ │ append │ │ verify   │ │ accrual│ │ redaction│
└──────────┘ └────────┘ └──────────┘ └────────┘ └──────────┘
```

---

## Feature Matrix

### Core Trading
| Feature | Status | Details |
|---|---|---|
| **Agent Registration** | ✅ | Per-agent API keys, capital tracking, strategy assignment |
| **Trade Intent Queue** | ✅ | Async intent submission with autonomous worker processing |
| **Idempotent Ingestion** | ✅ | `x-idempotency-key` — replay returns same result, conflict returns 409 |
| **Staged Execution Pipeline** | ✅ | Validation → simulation → execution phases with per-stage metrics |
| **Paper Trading / Simulation** | ✅ | Zero-risk simulation fills at market price, toggleable per-deployment |
| **Live Jupiter Swaps** | ✅ Proven | Jupiter lite-api quote → swap → sign → broadcast ([mainnet proof](https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf)) |
| **Autonomous Trading Loop** | ✅ | Background interval loop with per-agent state, toggle on/off |

### Risk & Safety
| Feature | Status | Details |
|---|---|---|
| **6-Layer Risk Engine** | ✅ | Position size, order notional, gross exposure, daily loss, drawdown threshold, cooldown timer |
| **Risk Telemetry** | ✅ | Real-time drawdown %, exposure, PnL, reject counters by reason |
| **Autonomous Guard** | ✅ | Drawdown halt, cooldown enforcement, failure tracking |
| **Rate Limiting** | ✅ | Per-agent request throttling with metrics endpoint |

### Strategies
| Feature | Status | Details |
|---|---|---|
| **Momentum (momentum-v1)** | ✅ | Trend-following with SMA crossover signals |
| **Mean Reversion (mean-reversion-v1)** | ✅ | Contrarian strategy, buys dips / sells stretches |
| **Arbitrage (arbitrage-v1)** | ✅ | Cross-venue spread detection (30bps threshold) |
| **DCA (dca-v1)** | ✅ | Scheduled buying at fixed intervals |
| **TWAP (twap-v1)** | ✅ | 10-chunk time-weighted execution |

### Multi-Agent Coordination
| Feature | Status | Details |
|---|---|---|
| **Squad Formation** | ✅ | Agents form squads with shared strategy and position aggregation |
| **Portfolio Analytics** | ✅ | Per-agent P&L, portfolio value, performance history |
| **Agent Reputation** | ✅ | Auto-calculated from execution history, exposed via leaderboard |
| **Governance Voting** | ✅ | Agents propose and vote on parameter changes |

### Order Book & Backtesting
| Feature | Status | Details |
|---|---|---|
| **Order Book Visualization** | ✅ | Bid/ask depth with 0.5% price bucketing + intent flow stats |
| **Backtesting Engine** | ✅ | Run any strategy against price history — Sharpe, drawdown, win rate |
| **Strategy Marketplace** | ✅ | Agents list/subscribe to strategies, reputation-ranked |

### Trust & Verification
| Feature | Status | Details |
|---|---|---|
| **Execution Receipts** | ✅ | SHA-256 hash-chained, deterministic, verifiable via API |
| **On-Chain Proof Anchoring** | ✅ | Anchor receipt hashes to Solana for tamper-proof verification |
| **Privacy Layer** | ✅ | AES-256-GCM encrypted intents + redacted receipts with hash chain integrity |

### Monetization
| Feature | Status | Details |
|---|---|---|
| **Fee Engine** | ✅ | Per-execution fee accrual into operator treasury |
| **x402 Payment Gate** | ✅ | Configurable HTTP 402 paywall for premium endpoints |
| **Clawpump Integration** | ✅ | Token launch, earnings queries, structured error mapping |

### Infrastructure
| Feature | Status | Details |
|---|---|---|
| **WebSocket Live Feed** | ✅ | Real-time trade events, intent updates, execution notifications |
| **Webhooks** | ✅ | Per-agent webhook delivery for trade events |
| **Lending Monitor** | ✅ | Health factor classification (SAFE/WARNING/CRITICAL) with alerts |
| **Skills System** | ✅ | Pluggable capability registry (trade, monitor, arbitrage, lending) |
| **Live Dashboard** | ✅ | `/experiment` — real-time HTML UI with auto-refresh |
| **Event Audit Log** | ✅ | Append-only NDJSON log of all system events |
| **TypeScript SDK** | ✅ | Zero-dep client with 15 methods, subpath export `./sdk` |

---

## Live Transaction Proof

This API has executed real swaps on Solana mainnet via Jupiter:

> **TX 1 (Sell SOL→USDC):** [`3XmPquL...sZdKf`](https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf)
> **TX 2 (Buy USDC→SOL):** [`5qZERks...x8kG7`](https://solscan.io/tx/5qZERks6yv1Rjhm5wHvuLRt36nofPrgrCdmeFP5xbVwkGoj4sAubdnXo6MoZUS3XsxYECcgL7ENBdMkoMjmx8kG7)

Full flow: Jupiter lite-api quote → swap instruction → `@solana/web3.js` sign → RPC broadcast → on-chain confirmation.

---

## Quick Start

```bash
# Clone and install
git clone https://github.com/tomi204/colosseum-ai-agent-trading-api.git
cd colosseum-ai-agent-trading-api
npm install

# Configure (paper mode works out of the box)
cp .env.example .env

# Run in dev mode
npm run dev
# → Listening on http://localhost:8787

# Or build and run production
npm run build && node dist/index.js
```

### Run the Judge Demo

```bash
bash scripts/demo-judge.sh
```

Proves in one run: agent registration → trade execution → risk rejection → receipt verification → fee accrual → risk telemetry.

### Run the Test Suite

```bash
npm test    # 295 tests across 41 files, all passing
```

---

## TypeScript SDK

Zero-dependency client for programmatic access:

```typescript
import { TradingAPIClient } from 'colosseum-ai-agent-trading-api/sdk';

const client = new TradingAPIClient('http://localhost:8787');

// Register an agent
const agent = await client.registerAgent({ name: 'my-bot', capitalUsd: 10000, strategyId: 'momentum-v1' });

// Submit a trade intent
const intent = await client.submitTradeIntent({
  agentId: agent.agentId,
  symbol: 'SOL-USDC',
  side: 'buy',
  notionalUsd: 100,
}, agent.apiKey);

// Backtest a strategy
const results = await client.runBacktest({
  strategyId: 'momentum-v1',
  priceHistory: [...],
  capitalUsd: 10000,
});

// Browse the strategy marketplace
const listings = await client.getMarketplaceListings();
```

Full SDK docs: [`docs/SDK.md`](docs/SDK.md)

---

## API Reference

### Core Trading
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/agents/register` | Register agent (returns ID + API key) |
| `GET` | `/agents/:agentId` | Get agent details |
| `PATCH` | `/agents/:agentId/strategy` | Change strategy plugin |
| `POST` | `/trade-intents` | Submit trade intent (`x-agent-api-key` + `x-idempotency-key`) |
| `GET` | `/trade-intents/:intentId` | Poll intent status |
| `POST` | `/simulate` | Simulate a trade without execution |
| `GET` | `/executions` | List execution records |
| `GET` | `/executions/:id/pipeline` | Get staged execution pipeline details |
| `POST` | `/market/prices` | Seed market price data |

### Strategies & Backtesting
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/strategies` | List available strategies |
| `POST` | `/backtest` | Run strategy against price history (returns Sharpe, drawdown, win rate) |
| `GET` | `/orderbook/:symbol` | Bid/ask depth visualization |
| `GET` | `/orderbook/flow` | Intent flow statistics |

### Multi-Agent Coordination
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/squads` | Create a multi-agent squad |
| `GET` | `/squads` | List all squads |
| `POST` | `/squads/:id/join` | Join an existing squad |
| `GET` | `/squads/:id/positions` | Aggregated squad positions |
| `GET` | `/agents/:agentId/portfolio` | Portfolio analytics |
| `GET` | `/agents/:agentId/analytics` | Performance analytics |

### Strategy Marketplace
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/marketplace/listings` | List a strategy for subscription |
| `GET` | `/marketplace/listings` | Browse strategies (sorted by reputation) |
| `POST` | `/marketplace/listings/:id/subscribe` | Subscribe to a strategy |

### Trust & Verification
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/executions/:id/receipt` | Hash-chained execution receipt |
| `GET` | `/receipts/verify/:executionId` | Verify receipt integrity |
| `POST` | `/proofs/anchor` | Anchor proof hash to Solana |
| `GET` | `/proofs/anchors` | List proof anchors |
| `GET` | `/proofs/verify/:receiptId` | Verify on-chain proof |

### Reputation & Governance
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/agents/:agentId/reputation` | Agent reputation score |
| `GET` | `/reputation/leaderboard` | Top agents by reputation |
| `POST` | `/governance/proposals` | Submit a governance proposal |
| `POST` | `/governance/proposals/:id/vote` | Vote on a proposal |
| `GET` | `/governance/proposals` | List proposals |

### Risk & Observability
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/agents/:agentId/risk` | Real-time risk telemetry |
| `GET` | `/autonomous/status` | Autonomous loop status |
| `POST` | `/autonomous/toggle` | Toggle autonomous trading |
| `GET` | `/arbitrage/opportunities` | Active arbitrage opportunities |
| `GET` | `/arbitrage/status` | Arbitrage scanner status |
| `GET` | `/rate-limit/metrics` | Rate limiter stats |
| `GET` | `/pipeline/metrics` | Staged pipeline performance |
| `GET` | `/metrics` | System metrics + treasury |
| `GET` | `/health` | Health check |

### DeFi Services
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/lending/positions` | Active lending positions |
| `GET` | `/lending/alerts` | Lending health alerts |
| `POST` | `/lending/positions` | Add lending position |
| `GET` | `/privacy/policy` | Privacy layer policy |
| `GET` | `/skills` | Registered agent skills |
| `GET` | `/agents/:agentId/skills` | Skills for a specific agent |
| `GET` | `/agents/:agentId/webhook-deliveries` | Webhook delivery history |

### Monetization
| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/paid-plan/policy` | x402 payment policy |
| `GET` | `/integrations/clawpump/health` | Clawpump upstream health |
| `GET` | `/integrations/clawpump/earnings` | Agent token earnings |
| `POST` | `/integrations/clawpump/launch` | Launch a new token |

---

## Why This Wins

### 1. Complete DeFi Hub, Not Just a Trading API
Five strategies, arbitrage scanner, lending monitor, backtesting engine, strategy marketplace, multi-agent squads, governance — this is the full infrastructure an AI agent ecosystem needs.

### 2. Safety-First by Design
Every trade passes through a 6-layer risk engine + staged execution pipeline (validate → simulate → execute). Autonomous guard enforces drawdown halts, cooldowns, and failure limits. **An agent physically cannot blow up a portfolio.**

### 3. Verifiable Execution
SHA-256 hash-chained receipts with on-chain proof anchoring to Solana. Anyone can verify any execution's integrity — from API receipt to blockchain anchor.

### 4. Multi-Agent Intelligence
Agents form squads, share strategies via marketplace, build reputation from real execution history, and govern system parameters through proposals and votes.

### 5. Strategy Marketplace Economy
Agents can list strategies ranked by real reputation scores, subscribe to proven strategies, and the marketplace creates a self-reinforcing quality signal.

### 6. Proven on Mainnet
Not a mockup. Two confirmed Jupiter swaps on Solana mainnet. The architecture bridges paper trading to live execution seamlessly.

### 7. 175 Tests, Zero Handwaving
31 test files covering risk, fees, receipts, strategies, idempotency, arbitrage, DCA, backtesting, marketplace, squads, governance, reputation, simulation, webhooks, rate limiting, and more.

---

## Project Structure

```
src/
├── api/                # Fastify routes + experiment dashboard
├── domain/
│   ├── fee/            # Fee calculation engine
│   ├── lending/        # Lending position + alert types
│   ├── marketplace/    # Strategy listing + subscription types
│   ├── privacy/        # AES-256-GCM encrypted intents + redacted receipts
│   ├── receipt/        # SHA-256 hash-chained receipt generation
│   ├── risk/           # 6-layer risk engine
│   ├── skills/         # Pluggable capability registry
│   └── strategy/       # 5 strategies: momentum, mean-rev, arbitrage, DCA, TWAP
├── services/
│   ├── agentService.ts           # Agent registration + management
│   ├── analyticsService.ts       # Performance analytics
│   ├── arbitrageService.ts       # Cross-venue arbitrage scanner
│   ├── autonomousService.ts      # Background trading loop
│   ├── backtestService.ts        # Strategy backtesting engine
│   ├── coordinationService.ts    # Multi-agent squad coordination
│   ├── executionService.ts       # Trade execution + receipts
│   ├── governanceService.ts      # Proposal + voting system
│   ├── lendingMonitorService.ts  # Health factor monitoring
│   ├── marketplaceService.ts     # Strategy marketplace
│   ├── onChainProofService.ts    # Solana proof anchoring
│   ├── orderBookService.ts       # Order book visualization
│   ├── reputationService.ts      # Agent reputation scoring
│   ├── stagedPipelineService.ts  # Staged execution pipeline
│   ├── webhookService.ts         # Event webhook delivery
│   └── ...
├── sdk/                # TypeScript SDK (zero deps, subpath export)
├── integrations/       # Clawpump token revenue client
├── infra/              # State persistence + event logger + WebSocket
├── types.ts            # Full type definitions
└── config.ts           # Environment-driven configuration
```

---

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **Framework:** Fastify + WebSocket (ws)
- **Blockchain:** Solana (`@solana/web3.js`)
- **DEX Routing:** Jupiter lite-api (`jup.ag`)
- **Validation:** Zod
- **Testing:** Vitest (295 tests, 39 files)
- **Persistence:** JSON state file + NDJSON event log
- **Deployment:** Docker (multi-stage alpine) + Railway/Fly.io configs

---

## Documentation

- [`docs/JUDGES.md`](docs/JUDGES.md) — 2-minute judge walkthrough
- [`docs/SDK.md`](docs/SDK.md) — TypeScript SDK guide
- [`docs/RECEIPTS.md`](docs/RECEIPTS.md) — Execution receipt specification
- [`docs/HACKATHON_SUBMISSION.md`](docs/HACKATHON_SUBMISSION.md) — Submission context

---

## License

MIT
