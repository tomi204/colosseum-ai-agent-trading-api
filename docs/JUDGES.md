# JUDGES.md — 2-Minute Walkthrough

> **TL;DR:** Run `bash scripts/demo-judge.sh` — it proves safety, auditability, and monetization in one shot. Then explore the live demo.

---

## Live Deployment

> **🔴 Live now:** [`https://colosseum-ai-agent-trading-api.onrender.com`](https://colosseum-ai-agent-trading-api.onrender.com/health)

Try these endpoints right now:
- [`/health`](https://colosseum-ai-agent-trading-api.onrender.com/health) — system health + stats
- [`/experiment`](https://colosseum-ai-agent-trading-api.onrender.com/experiment) — interactive dashboard
- [`/agents`](https://colosseum-ai-agent-trading-api.onrender.com/agents) — registered agents
- [`/marketplace/listings`](https://colosseum-ai-agent-trading-api.onrender.com/marketplace/listings) — strategy marketplace
- [`/orderbook/SOL-USDC`](https://colosseum-ai-agent-trading-api.onrender.com/orderbook/SOL-USDC) — order book depth
- [`/arbitrage/status`](https://colosseum-ai-agent-trading-api.onrender.com/arbitrage/status) — arbitrage scanner
- [`/reputation/leaderboard`](https://colosseum-ai-agent-trading-api.onrender.com/reputation/leaderboard) — agent reputation

---

## Live Mainnet Proof

Two confirmed swaps on Solana mainnet via Jupiter:

> **TX 1 (Sell SOL→USDC):** [`3XmPquL...sZdKf`](https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf)
> **TX 2 (Buy USDC→SOL):** [`5qZERks...x8kG7`](https://solscan.io/tx/5qZERks6yv1Rjhm5wHvuLRt36nofPrgrCdmeFP5xbVwkGoj4sAubdnXo6MoZUS3XsxYECcgL7ENBdMkoMjmx8kG7)

Flow: Jupiter lite-api quote → swap instruction → `@solana/web3.js` sign → RPC broadcast → on-chain confirmation.

---

## Live Pipeline Proof (Feb 12, 2026)

Full end-to-end execution captured on the live Render deployment:

```
1. Agent registered → proof-agent-live (66fe3108...)
2. Price oracle seeded → 8 ascending SOL prices ($190→$200)
3. Momentum strategy evaluates → BUY signal (fast MA above slow MA)
4. Risk engine validates → passes all 6 layers
5. Paper execution → BUY 5 SOL @ $200 ($1000 notional, $0.80 fee)
6. Receipt hash: 4e223dc8149b3f9f2fc921d2bd35c08949e0d13e105b23f4569538b5e7bfb968
7. Price drops to $191 → SELL signal → sells 3 SOL, realizes -$27 P&L
8. Receipt chain verified ✅ — deterministic hash re-computation matches

Metrics after demo:
  • 9 intents received, 5 executed, 4 rejected (risk engine active)
  • $1.50 in platform fees accrued to treasury
  • 5 receipts in hash chain, all verified
  • Worker ran 9000+ autonomous loops
```

Run it yourself: `bash scripts/proof.sh`

---

## Self-Improving Flywheel (HEADLINE FEATURE)

No other project has this. The agent literally makes itself smarter over time:

```
Trading Profits → Inference Budget Allocation
    → Performance Analyzer (win/loss patterns, strategy effectiveness, risk rejections)
    → Recommendation Engine (strategy switch, risk tuning, timing optimization)
    → Auto-Apply (confidence > 0.7)
    → Track ROI on AI Inference Spending
    → Better Trades → More Profits → Cycle Repeats
```

**API endpoints:**
- `POST /agents/:id/improve/analyze` — run performance analysis
- `GET /agents/:id/improve/recommendations` — get tuning suggestions
- `POST /agents/:id/improve/cycle` — run full improvement flywheel
- `GET /agents/:id/inference/budget` — check inference budget allocation
- `GET /agents/:id/inference/roi` — measure ROI on AI spending

---

## 0) Setup (30 seconds)

```bash
npm install
cp .env.example .env
npm run dev    # Paper mode works out of the box
```

---

## 1) Automated Demo (recommended)

```bash
bash scripts/demo-judge.sh
```

| Step | What happens | What it proves |
|---|---|---|
| Register agent | Creates agent with `momentum-v1` strategy + API key | Agent identity & auth |
| Seed price ramp | Pushes 6 ascending SOL prices | Strategy signal generation |
| Submit valid trade | $80 paper buy → executed | End-to-end intent → execution flow |
| Submit risky trade | $300 buy (exceeds $150 limit) → rejected | Risk engine blocks unsafe trades |
| Retrieve receipt | Hash-chained execution receipt | Verifiable audit trail |
| Verify receipt | Deterministic hash re-check → `ok: true` | Tamper-evidence |
| Check treasury | Fee accrued from executed trade | Monetization works |
| Check risk telemetry | Drawdown, exposure, reject counters, cooldown | Full observability |

---

## 2) Feature Tour

### 5 Trading Strategies
```bash
curl -s http://localhost:8787/strategies
# momentum-v1, mean-reversion-v1, arbitrage-v1, dca-v1, twap-v1
```

### Backtest Any Strategy
```bash
curl -s -X POST http://localhost:8787/backtest \
  -H 'content-type: application/json' \
  -d '{
    "strategyId": "momentum-v1",
    "priceHistory": [100,101,102,103,104,105,106,107,108,109,110,112,115,118,120,122],
    "capitalUsd": 10000
  }'
# Returns: Sharpe ratio, max drawdown, win rate, trade details
```

### Strategy Marketplace
```bash
# List a strategy
curl -s -X POST http://localhost:8787/marketplace/listings \
  -H 'content-type: application/json' \
  -d '{"agentId":"<AGENT_ID>","strategyId":"momentum-v1","description":"Trend-following SMA crossover"}'

# Browse strategies (ranked by reputation)
curl -s http://localhost:8787/marketplace/listings
```

### Multi-Agent Squads
```bash
# Create a squad
curl -s -X POST http://localhost:8787/squads \
  -H 'content-type: application/json' \
  -d '{"name":"alpha-squad","strategyId":"momentum-v1","creatorAgentId":"<AGENT_ID>"}'

# View aggregated squad positions
curl -s http://localhost:8787/squads/<SQUAD_ID>/positions
```

### Order Book Depth
```bash
curl -s http://localhost:8787/orderbook/SOL-USDC
# Bid/ask levels with 0.5% price bucketing + intent flow stats
```

### Agent Reputation & Governance
```bash
curl -s http://localhost:8787/reputation/leaderboard
curl -s http://localhost:8787/governance/proposals
```

### On-Chain Proof Anchoring
```bash
curl -s http://localhost:8787/proofs/anchors
# Receipt hashes anchored to Solana for tamper-proof verification
```

### Privacy Layer
```bash
curl -s http://localhost:8787/privacy/policy
# AES-256-GCM encrypted intents + redacted receipts
```

### Simulate Without Executing
```bash
curl -s -X POST http://localhost:8787/simulate \
  -H 'content-type: application/json' \
  -d '{"agentId":"<AGENT_ID>","symbol":"SOL-USDC","side":"buy","notionalUsd":100}'
# Runs full pipeline without touching live markets
```

---

## 3) Test Suite

```bash
npm test   # 410+ tests across 48+ files, all passing
```

Covers: risk engine, fee engine, receipt engine, 5 strategies, idempotency, arbitrage, DCA, backtesting, marketplace, squads, governance, reputation, simulation, webhooks, rate limiting, order book, pipeline, analytics, copy trading, credit ratings, self-improvement, inference budget, watchlist, trade history, diagnostics, strategy tournaments, social trading, Pyth oracle, sandbox scenarios, benchmarks, sentiment analysis, notifications, and more.

---

## 4) What Makes This Judge-Worthy

| Dimension | How we deliver |
|---|---|
| **Breadth** | Not just trading — backtesting, arbitrage, lending, marketplace, multi-agent squads, governance, privacy. A full DeFi hub. |
| **Safety** | 6-layer risk engine + staged execution pipeline (validate → simulate → execute). Autonomous guard with drawdown halt. |
| **Auditability** | SHA-256 hash-chained receipts + on-chain Solana proof anchoring. Append-only NDJSON event log. |
| **Intelligence** | 5 pluggable strategies + backtesting engine. Agents validate before risking capital. |
| **Coordination** | Multi-agent squads, agent messaging, reputation leaderboard, governance voting. |
| **Monetization** | Per-execution fees, Jupiter referral fees, x402 payment gates, strategy marketplace subscriptions. |
| **Reliability** | Idempotent ingestion, rate limiting, webhook delivery, WebSocket live feed. |
| **Privacy** | AES-256-GCM encrypted intents + redacted receipts with hash chain integrity. |
| **Self-Improving** | Trading profits fund AI inference that auto-tunes strategies — a closed-loop flywheel. No other project has this. |
| **Solana-Native** | Pyth Network oracle for real-time Solana price feeds. Jupiter swaps. On-chain proof anchoring. |
| **Social** | Social trading graph, strategy tournaments, copy trading, activity feeds. |
| **Proven** | 2 live mainnet transactions + interactive live demo + 410+ automated tests across 48+ files. |
| **SDK** | Zero-dep TypeScript client with 15 methods — agents can integrate in minutes. |

---

## Architecture at a Glance

```
Agent → API Gateway (auth + rate limit + idempotency)
     → Strategy Engine (5 strategies)
     → Risk Engine (6 layers)
     → Staged Pipeline (validate → simulate → execute)
     → Execution (paper or live Jupiter)
     → Receipt Chain (SHA-256 + on-chain anchor)
     → Webhook + WebSocket delivery
     → Analytics + Reputation
```

**90+ source files · ~20,000 lines · 410+ tests · 2 mainnet transactions · live on Render**
