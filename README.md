# Colosseum AI Agent Trading API (v4)

Autonomous, agent-facing Solana trading API built for Colosseum judging.

## What this ships

- Autonomous intent processing worker (`/trade-intents` queue)
- Safety-first risk engine (position, order, drawdown, cooldown limits)
- Strategy plugins (momentum + mean-reversion)
- Verifiable execution receipts + deterministic verification
- Idempotent intent ingestion (`x-idempotency-key`)
- Treasury fee accounting + monetization telemetry
- x402 paid-route policy model
- Live judge dashboard at `/experiment`
- Clawpump token-revenue integration endpoints with robust error mapping

## Key endpoints

### Core trading
- `POST /agents/register`
- `PATCH /agents/:agentId/strategy`
- `POST /trade-intents`
- `GET /trade-intents/:intentId`
- `GET /executions`

### Trust / verification
- `GET /executions/:executionId/receipt`
- `GET /receipts/verify/:executionId`

### Risk / observability
- `GET /agents/:agentId/risk`
- `GET /metrics`
- `GET /experiment`

### Monetization / policy
- `GET /paid-plan/policy`

### Token revenue integration (Clawpump)
- `GET /integrations/clawpump/health`
- `GET /integrations/clawpump/earnings?agentId=...`
- `POST /integrations/clawpump/launch`
- `GET /integrations/clawpump/launch-attempts`

## Quick start

```bash
npm install
cp .env.example .env
npm run dev
```

Default URL: `http://localhost:8787`

## Judge flow (recommended)

```bash
bash scripts/demo-judge.sh
```

This demo proves in one run:
- successful trade execution
- risk rejection behavior
- receipt retrieval + verification
- fee accrual into treasury
- risk telemetry exposure

See `docs/JUDGES.md` for manual checks.

## Tests

```bash
npm test
```

Current suite validates risk, fees, receipts, strategies, idempotency, experiment route, and Clawpump integration mapping/wallet logic.
