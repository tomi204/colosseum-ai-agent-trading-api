# JUDGES.md — 2-Minute Walkthrough

This walkthrough is designed for fast evaluation: trust/proof, reliability, and monetization in one pass.

## 0) One-time setup

```bash
npm install
cp .env.example .env
```

## 1) Run the judge demo (recommended)

```bash
bash scripts/demo-judge.sh
```

What it demonstrates automatically:
1. **Successful trade** (paper fill)
2. **Rejected risky trade** (`max_order_notional_exceeded`)
3. **Execution receipt retrieval** (`GET /executions/:executionId/receipt`)
4. **Receipt verification** (`GET /receipts/verify/:executionId`)
5. **Fee accrual** in treasury (`/metrics`)
6. **Risk telemetry** (`GET /agents/:agentId/risk`) with drawdown, gross exposure, daily PnL, cooldown status, and reject counters (agent + global)

---

## 2) Optional manual spot checks

Start server:

```bash
npm run build
node dist/index.js
```

In another terminal:

### Register agent

```bash
curl -s -X POST http://localhost:8787/agents/register \
  -H 'content-type: application/json' \
  -d '{"name":"judge-manual","strategyId":"momentum-v1"}'
```

### Idempotency replay + conflict

Use the same `x-idempotency-key` with same payload (replay), then conflicting payload (409):

```bash
curl -s -X POST http://localhost:8787/trade-intents \
  -H 'content-type: application/json' \
  -H "x-agent-api-key: <API_KEY>" \
  -H 'x-idempotency-key: demo-key-1' \
  -d '{"agentId":"<AGENT_ID>","symbol":"SOL","side":"buy","notionalUsd":80,"requestedMode":"paper"}'

curl -s -X POST http://localhost:8787/trade-intents \
  -H 'content-type: application/json' \
  -H "x-agent-api-key: <API_KEY>" \
  -H 'x-idempotency-key: demo-key-1' \
  -d '{"agentId":"<AGENT_ID>","symbol":"SOL","side":"buy","notionalUsd":80,"requestedMode":"paper"}'

curl -i -s -X POST http://localhost:8787/trade-intents \
  -H 'content-type: application/json' \
  -H "x-agent-api-key: <API_KEY>" \
  -H 'x-idempotency-key: demo-key-1' \
  -d '{"agentId":"<AGENT_ID>","symbol":"SOL","side":"buy","notionalUsd":120,"requestedMode":"paper"}'
```

### Risk telemetry endpoint

```bash
curl -s http://localhost:8787/agents/<AGENT_ID>/risk
```

### Receipt endpoint

```bash
curl -s http://localhost:8787/executions/<EXECUTION_ID>/receipt
curl -s http://localhost:8787/receipts/verify/<EXECUTION_ID>
```

### Token revenue integration health (Clawpump)

```bash
curl -s http://localhost:8787/integrations/clawpump/health
curl -s 'http://localhost:8787/integrations/clawpump/earnings?agentId=<AGENT_ID>'
curl -s http://localhost:8787/integrations/clawpump/launch-attempts
```

If upstream is degraded, the API returns structured integration errors (with status/action hints) instead of opaque failures.

---

## 3) Why this is judge-relevant

- **Trust / proof:** hash-chained deterministic receipts + verification endpoint
- **Reliability:** idempotent intent ingestion + retry/backoff on Jupiter quote path
- **Explainability:** real-time risk telemetry with reject counters and cooldown state
- **Monetization rails:** fee accrual ledger + Jupiter referral fee plumbing + x402 gate stub
