/**
 * Auto-generated API documentation page.
 * Beautiful dark theme matching the experiment page design.
 */

export interface EndpointDoc {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT';
  path: string;
  description: string;
  category: string;
  auth?: boolean;
  requestBody?: string;
  responseBody?: string;
  curl?: string;
}

const API_ENDPOINTS: EndpointDoc[] = [
  // ─── Core ─────────────────────────────
  { method: 'GET', path: '/', description: 'API root — returns name, version, status, and trading mode.', category: 'Core', responseBody: '{ name, version, status, mode }' },
  { method: 'GET', path: '/health', description: 'System health check with uptime, pending intents, and state summary.', category: 'Core', responseBody: '{ status, env, uptimeSeconds, pendingIntents, stateSummary }', curl: "curl $BASE/health" },
  { method: 'GET', path: '/metrics', description: 'Platform metrics including intent counters, treasury, and monetization model.', category: 'Core', responseBody: '{ runtime, metrics, treasury, monetization }', curl: "curl $BASE/metrics" },
  { method: 'GET', path: '/state', description: 'Full state snapshot (debug). Returns all agents, intents, executions, etc.', category: 'Core', responseBody: '{ agents, tradeIntents, executions, ... }' },
  { method: 'GET', path: '/experiment', description: 'Interactive experiment dashboard with live demo, flywheel, and system status.', category: 'Core' },
  { method: 'GET', path: '/docs', description: 'This API documentation page.', category: 'Core' },

  // ─── Agents ───────────────────────────
  { method: 'POST', path: '/agents/register', description: 'Register a new AI trading agent with optional strategy and risk overrides.', category: 'Agents', requestBody: '{ name, startingCapitalUsd?, strategyId?, webhookUrl?, riskOverrides? }', responseBody: '{ agent, apiKey, note }', curl: "curl -X POST $BASE/agents/register -H 'Content-Type: application/json' -d '{\"name\":\"my-agent\",\"startingCapitalUsd\":10000}'" },
  { method: 'GET', path: '/agents', description: 'List all registered agents (id, name, strategy, timestamps).', category: 'Agents', responseBody: '{ agents: [{ id, name, strategyId, createdAt }] }', curl: "curl $BASE/agents" },
  { method: 'GET', path: '/agents/:agentId', description: 'Get full agent details including positions, P&L, and risk limits.', category: 'Agents', responseBody: '{ id, name, cashUsd, realizedPnlUsd, positions, riskLimits, ... }', curl: "curl $BASE/agents/AGENT_ID" },
  { method: 'GET', path: '/agents/:agentId/portfolio', description: 'Agent portfolio with equity, inventory value, and market-priced positions.', category: 'Agents', responseBody: '{ cashUsd, inventoryValueUsd, equityUsd, positions }' },
  { method: 'PATCH', path: '/agents/:agentId/strategy', description: 'Hot-swap the agent\'s active trading strategy.', category: 'Agents', requestBody: '{ strategyId }', responseBody: '{ agentId, strategyId, updatedAt }' },
  { method: 'GET', path: '/agents/:agentId/risk', description: 'Real-time risk telemetry: drawdown, exposure, cooldowns, and limits.', category: 'Agents', responseBody: '{ agentId, equityUsd, drawdownPct, cooldown, limits, ... }' },

  // ─── Trading ──────────────────────────
  { method: 'POST', path: '/trade-intents', description: 'Submit a trade intent (buy/sell). Requires x-agent-api-key header. Goes through strategy → risk → execution pipeline.', category: 'Trading', auth: true, requestBody: '{ agentId, symbol, side, quantity?, notionalUsd?, requestedMode? }', responseBody: '{ message, replayed, intent }', curl: "curl -X POST $BASE/trade-intents -H 'Content-Type: application/json' -H 'x-agent-api-key: YOUR_KEY' -d '{\"agentId\":\"ID\",\"symbol\":\"SOL\",\"side\":\"buy\",\"quantity\":5}'" },
  { method: 'GET', path: '/trade-intents/:intentId', description: 'Get trade intent status and execution details.', category: 'Trading', responseBody: '{ id, agentId, symbol, side, status, executionId }' },
  { method: 'GET', path: '/executions', description: 'List execution records. Filter by agentId, limit results.', category: 'Trading', responseBody: '{ executions: [{ id, symbol, side, quantity, priceUsd, mode, ... }] }', curl: "curl '$BASE/executions?agentId=ID&limit=10'" },
  { method: 'GET', path: '/executions/:id/receipt', description: 'Get verifiable execution receipt with SHA-256 hash chain. Supports ?redacted=true.', category: 'Trading', responseBody: '{ executionId, receipt: { version, payload, receiptHash, ... } }' },
  { method: 'GET', path: '/receipts/verify/:executionId', description: 'Verify receipt hash chain integrity for a given execution.', category: 'Trading', responseBody: '{ valid, receipt, ... }' },
  { method: 'GET', path: '/executions/:id/pipeline', description: 'Introspect the staged execution pipeline (Validate → Strategy → Execute).', category: 'Trading', responseBody: '{ pipeline: { stages, status, ... } }' },
  { method: 'POST', path: '/market/prices', description: 'Update market price for a symbol. Triggers price.updated event.', category: 'Trading', requestBody: '{ symbol, priceUsd }', responseBody: '{ ok, marketPricesUsd }' },

  // ─── Strategies ───────────────────────
  { method: 'GET', path: '/strategies', description: 'List all available trading strategies with descriptions.', category: 'Strategies', responseBody: '{ strategies: [{ id, name, description }] }', curl: "curl $BASE/strategies" },
  { method: 'POST', path: '/strategies/compare', description: 'Compare multiple strategies head-to-head against the same price history.', category: 'Strategies', requestBody: '{ strategyIds, priceHistory, capitalUsd }', responseBody: '{ results: [{ strategyId, totalReturnPct, sharpeRatio, ... }] }' },
  { method: 'POST', path: '/backtest', description: 'Run a full backtest of a strategy against historical price data.', category: 'Strategies', requestBody: '{ strategyId, symbol, priceHistory, startingCapitalUsd, riskOverrides? }', responseBody: '{ totalReturnPct, maxDrawdownPct, sharpeRatio, tradeCount, winRate, trades }', curl: "curl -X POST $BASE/backtest -H 'Content-Type: application/json' -d '{\"strategyId\":\"momentum-v1\",\"symbol\":\"SOL\",\"priceHistory\":[100,101,102,103,104],\"startingCapitalUsd\":10000}'" },

  // ─── Sandbox ──────────────────────────
  { method: 'POST', path: '/sandbox', description: 'Create an isolated sandbox environment with virtual capital and custom configuration.', category: 'Sandbox', requestBody: '{ name?, virtualCapitalUsd?, symbol?, startPriceUsd?, timeAcceleration?, strategyConfig? }', responseBody: '{ id, config, status, createdAt }', curl: "curl -X POST $BASE/sandbox -H 'Content-Type: application/json' -d '{\"name\":\"test-sandbox\",\"virtualCapitalUsd\":50000}'" },
  { method: 'POST', path: '/sandbox/:id/run', description: 'Run a predefined market scenario against the sandbox. Returns P&L, trades, drawdown, risk breaches.', category: 'Sandbox', requestBody: '{ scenarioId }', responseBody: '{ scenarioId, pnlUsd, pnlPct, tradeCount, maxDrawdownPct, recoveryTicks, riskBreaches, trades, equityCurve }', curl: "curl -X POST $BASE/sandbox/SANDBOX_ID/run -H 'Content-Type: application/json' -d '{\"scenarioId\":\"flash-crash\"}'" },
  { method: 'GET', path: '/sandbox/:id', description: 'Get sandbox details and results (after running a scenario).', category: 'Sandbox', responseBody: '{ id, config, status, results }', curl: "curl $BASE/sandbox/SANDBOX_ID" },
  { method: 'GET', path: '/sandbox/scenarios', description: 'List all built-in market scenarios with descriptions.', category: 'Sandbox', responseBody: '{ scenarios: [{ id, name, description, category, ticks }] }', curl: "curl $BASE/sandbox/scenarios" },
  { method: 'DELETE', path: '/sandbox/:id', description: 'Destroy a sandbox and clean up resources.', category: 'Sandbox', responseBody: '{ ok: true }' },

  // ─── Simulation ───────────────────────
  { method: 'POST', path: '/simulate', description: 'Dry-run a trade against current state without executing. Shows hypothetical outcome.', category: 'Simulation', requestBody: '{ agentId, symbol, side, quantity?, notionalUsd?, hypotheticalPriceUsd? }', responseBody: '{ hypothetical outcome }' },

  // ─── Advanced Orders ──────────────────
  { method: 'POST', path: '/orders/limit', description: 'Place a limit order that executes when price reaches target.', category: 'Orders', requestBody: '{ agentId, symbol, side, price, notionalUsd, expiry? }', responseBody: '{ order }' },
  { method: 'POST', path: '/orders/stop-loss', description: 'Place a stop-loss order that triggers at a price threshold.', category: 'Orders', requestBody: '{ agentId, symbol, triggerPrice, notionalUsd }', responseBody: '{ order }' },
  { method: 'GET', path: '/orders/:agentId', description: 'Get all orders for an agent (limit + stop-loss).', category: 'Orders', responseBody: '{ limitOrders, stopLossOrders }' },
  { method: 'DELETE', path: '/orders/:orderId', description: 'Cancel an existing order.', category: 'Orders', responseBody: '{ ok, cancelled }' },

  // ─── Autonomous Loop ──────────────────
  { method: 'GET', path: '/autonomous/status', description: 'Get autonomous trading loop status: enabled, interval, loop count.', category: 'Autonomous', responseBody: '{ enabled, intervalMs, loopCount, lastRunAt }', curl: "curl $BASE/autonomous/status" },
  { method: 'POST', path: '/autonomous/toggle', description: 'Enable or disable the autonomous trading loop.', category: 'Autonomous', requestBody: '{ enabled: boolean }', responseBody: '{ ok, autonomous }' },

  // ─── Squads ───────────────────────────
  { method: 'POST', path: '/squads', description: 'Create a multi-agent squad for coordinated trading.', category: 'Squads', requestBody: '{ name, leaderId, sharedLimits? }', responseBody: '{ squad }' },
  { method: 'GET', path: '/squads', description: 'List all squads.', category: 'Squads', responseBody: '{ squads }' },
  { method: 'GET', path: '/squads/:id', description: 'Get squad details.', category: 'Squads', responseBody: '{ squad }' },
  { method: 'POST', path: '/squads/:id/join', description: 'Join an existing squad.', category: 'Squads', requestBody: '{ agentId }', responseBody: '{ squad }' },
  { method: 'GET', path: '/squads/:id/positions', description: 'Get aggregated positions for all squad members.', category: 'Squads', responseBody: '{ squadId, positions }' },

  // ─── Messaging ────────────────────────
  { method: 'POST', path: '/messages', description: 'Send a message between agents (trade-signal, risk-alert, etc.).', category: 'Messaging', requestBody: '{ from, to, type, payload }', responseBody: '{ message }' },
  { method: 'GET', path: '/messages/:agentId', description: 'Get agent inbox messages.', category: 'Messaging', responseBody: '{ messages }' },
  { method: 'POST', path: '/squads/:id/messages', description: 'Broadcast a message to all squad members.', category: 'Messaging', requestBody: '{ from, type, payload }', responseBody: '{ message }' },
  { method: 'GET', path: '/squads/:id/messages', description: 'Get squad message history.', category: 'Messaging', responseBody: '{ messages }' },

  // ─── Marketplace ──────────────────────
  { method: 'POST', path: '/marketplace/listings', description: 'Create a strategy listing in the marketplace.', category: 'Marketplace', requestBody: '{ agentId, strategyId, description, performanceStats, fee }', responseBody: '{ listing }' },
  { method: 'GET', path: '/marketplace/listings', description: 'Browse all marketplace strategy listings.', category: 'Marketplace', responseBody: '{ listings }', curl: "curl $BASE/marketplace/listings" },
  { method: 'GET', path: '/marketplace/listings/:id', description: 'Get listing details with subscriber stats.', category: 'Marketplace', responseBody: '{ listing }' },
  { method: 'POST', path: '/marketplace/listings/:id/subscribe', description: 'Subscribe to a strategy listing.', category: 'Marketplace', requestBody: '{ subscriberId }', responseBody: '{ subscription }' },

  // ─── Reputation ───────────────────────
  { method: 'GET', path: '/agents/:agentId/reputation', description: 'Get agent reputation score breakdown.', category: 'Reputation', responseBody: '{ score, breakdown, ... }' },
  { method: 'GET', path: '/reputation/leaderboard', description: 'Reputation leaderboard. Optional ?limit=N.', category: 'Reputation', responseBody: '{ leaderboard: [{ agentId, score, rank }] }', curl: "curl $BASE/reputation/leaderboard" },

  // ─── Governance ───────────────────────
  { method: 'POST', path: '/governance/proposals', description: 'Create a governance proposal (strategy change, risk parameter, etc.).', category: 'Governance', requestBody: '{ proposerId, type, title, description, params, expiresInMs? }', responseBody: '{ proposal }' },
  { method: 'POST', path: '/governance/proposals/:id/vote', description: 'Cast a vote on a proposal.', category: 'Governance', requestBody: '{ agentId, value: "for" | "against" }', responseBody: '{ proposal }' },
  { method: 'GET', path: '/governance/proposals', description: 'List proposals. Optional ?status=active|approved|rejected|expired.', category: 'Governance', responseBody: '{ proposals }' },

  // ─── Analytics ────────────────────────
  { method: 'GET', path: '/agents/:agentId/analytics', description: 'Compute analytics: equity curve, Sharpe ratio, trade distribution.', category: 'Analytics', responseBody: '{ analytics }' },
  { method: 'GET', path: '/agents/:agentId/trades', description: 'Paginated trade history with filters (symbol, side, date range).', category: 'Analytics', responseBody: '{ trades, total, offset, limit }' },
  { method: 'GET', path: '/agents/:agentId/performance', description: 'Performance summary: total return, best/worst trades, win rate.', category: 'Analytics', responseBody: '{ summary }' },
  { method: 'GET', path: '/agents/:agentId/streaks', description: 'Win/loss streak analysis.', category: 'Analytics', responseBody: '{ streaks }' },

  // ─── Risk & MEV ───────────────────────
  { method: 'POST', path: '/mev/analyze', description: 'Analyze a trade for MEV vulnerability (front-running, sandwich attack risk).', category: 'Risk & MEV', requestBody: '{ symbol, side, notionalUsd, slippageTolerance?, poolLiquidityUsd? }', responseBody: '{ report }' },
  { method: 'GET', path: '/mev/stats', description: 'Global MEV protection statistics.', category: 'Risk & MEV', responseBody: '{ stats }' },
  { method: 'GET', path: '/rate-limit/metrics', description: 'Rate limiter metrics and current state.', category: 'Risk & MEV', responseBody: '{ metrics }' },
  { method: 'GET', path: '/pipeline/metrics', description: 'Execution pipeline stage timing metrics.', category: 'Risk & MEV', responseBody: '{ stageMetrics }' },

  // ─── Price Oracles ────────────────────
  { method: 'GET', path: '/oracle/prices', description: 'Get all current oracle prices.', category: 'Oracles', responseBody: '{ prices }', curl: "curl $BASE/oracle/prices" },
  { method: 'GET', path: '/oracle/prices/:symbol', description: 'Get price and history for a specific symbol.', category: 'Oracles', responseBody: '{ price, history }' },
  { method: 'GET', path: '/oracle/status', description: 'Oracle service status.', category: 'Oracles', responseBody: '{ status }' },
  { method: 'POST', path: '/oracle/pyth/start', description: 'Start Pyth oracle price feed for specified symbols.', category: 'Oracles', requestBody: '{ symbols, intervalMs? }', responseBody: '{ ok, status }' },
  { method: 'POST', path: '/oracle/pyth/stop', description: 'Stop Pyth oracle feed.', category: 'Oracles', responseBody: '{ ok, status }' },
  { method: 'GET', path: '/oracle/pyth/status', description: 'Pyth oracle feed status.', category: 'Oracles', responseBody: '{ status }' },
  { method: 'GET', path: '/oracle/pyth/prices', description: 'Get all Pyth-sourced prices.', category: 'Oracles', responseBody: '{ prices, supportedSymbols }' },

  // ─── Order Book & Arbitrage ───────────
  { method: 'GET', path: '/orderbook/:symbol', description: 'Get order book depth for a trading pair.', category: 'Order Book', responseBody: '{ bids, asks, spread }' },
  { method: 'GET', path: '/orderbook/flow', description: 'Get order flow analysis.', category: 'Order Book', responseBody: '{ flow }' },
  { method: 'GET', path: '/arbitrage/opportunities', description: 'Get detected arbitrage opportunities.', category: 'Order Book', responseBody: '{ opportunities }', curl: "curl $BASE/arbitrage/opportunities" },
  { method: 'GET', path: '/arbitrage/status', description: 'Arbitrage scanner status.', category: 'Order Book', responseBody: '{ status }' },

  // ─── Self-Improvement ─────────────────
  { method: 'POST', path: '/agents/:agentId/improve/analyze', description: 'Analyze agent performance and generate improvement recommendations.', category: 'Self-Improvement', responseBody: '{ analysis }' },
  { method: 'GET', path: '/agents/:agentId/improve/recommendations', description: 'Get pending improvement recommendations.', category: 'Self-Improvement', responseBody: '{ recommendations }' },
  { method: 'POST', path: '/agents/:agentId/improve/apply/:recId', description: 'Apply a specific recommendation to the agent.', category: 'Self-Improvement', responseBody: '{ improvement }' },
  { method: 'POST', path: '/agents/:agentId/improve/cycle', description: 'Run a full improvement cycle (analyze → recommend → apply).', category: 'Self-Improvement', responseBody: '{ cycle }' },
  { method: 'GET', path: '/agents/:agentId/improve/history', description: 'Get history of applied improvements.', category: 'Self-Improvement', responseBody: '{ history }' },
  { method: 'GET', path: '/agents/:agentId/improve/status', description: 'Get improvement loop status.', category: 'Self-Improvement', responseBody: '{ status }' },
  { method: 'GET', path: '/agents/:agentId/inference/budget', description: 'Get inference budget allocation and usage.', category: 'Self-Improvement', responseBody: '{ budget }' },
  { method: 'GET', path: '/agents/:agentId/inference/history', description: 'Get inference invocation history.', category: 'Self-Improvement', responseBody: '{ history }' },
  { method: 'GET', path: '/agents/:agentId/inference/roi', description: 'Get return on inference investment metrics.', category: 'Self-Improvement', responseBody: '{ roi }' },

  // ─── Tournaments ──────────────────────
  { method: 'POST', path: '/tournaments', description: 'Create a strategy tournament. Multiple strategies compete against the same price data.', category: 'Tournaments', requestBody: '{ name, strategyIds, symbol?, priceHistory, startingCapitalUsd }', responseBody: '{ tournament }' },
  { method: 'POST', path: '/tournaments/:id/run', description: 'Execute a tournament — run all strategies and rank results.', category: 'Tournaments', responseBody: '{ tournament }' },
  { method: 'GET', path: '/tournaments/:id', description: 'Get tournament results and rankings.', category: 'Tournaments', responseBody: '{ tournament }' },
  { method: 'GET', path: '/tournaments', description: 'List all tournaments.', category: 'Tournaments', responseBody: '{ tournaments }' },

  // ─── Social Trading ───────────────────
  { method: 'POST', path: '/agents/:agentId/social/follow/:targetId', description: 'Follow another agent to see their trades in your feed.', category: 'Social', responseBody: '{ relation }' },
  { method: 'DELETE', path: '/agents/:agentId/social/follow/:targetId', description: 'Unfollow an agent.', category: 'Social', responseBody: '{ ok }' },
  { method: 'GET', path: '/agents/:agentId/social/followers', description: 'Get agent followers list.', category: 'Social', responseBody: '{ followers }' },
  { method: 'GET', path: '/agents/:agentId/social/following', description: 'Get agents this agent follows.', category: 'Social', responseBody: '{ following }' },
  { method: 'GET', path: '/agents/:agentId/social/feed', description: 'Get social trade feed from followed agents.', category: 'Social', responseBody: '{ feed }' },

  // ─── Copy Trading ─────────────────────
  { method: 'POST', path: '/agents/:agentId/follow', description: 'Set up copy-trading: auto-copy another agent\'s trades.', category: 'Copy Trading', requestBody: '{ targetAgentId, copyRatio, maxNotionalUsd }', responseBody: '{ relation }' },
  { method: 'DELETE', path: '/agents/:agentId/follow/:targetId', description: 'Stop copy-trading an agent.', category: 'Copy Trading', responseBody: '{ ok }' },
  { method: 'GET', path: '/agents/:agentId/followers', description: 'Get agents copy-trading this agent.', category: 'Copy Trading', responseBody: '{ followers }' },
  { method: 'GET', path: '/agents/:agentId/following', description: 'Get agents this agent is copy-trading.', category: 'Copy Trading', responseBody: '{ following }' },

  // ─── Credit & Alerts ──────────────────
  { method: 'GET', path: '/agents/:agentId/credit-rating', description: 'Get agent credit rating breakdown.', category: 'Credit & Alerts', responseBody: '{ rating, breakdown }' },
  { method: 'GET', path: '/credit-ratings', description: 'Get all agent credit ratings.', category: 'Credit & Alerts', responseBody: '{ ratings }' },
  { method: 'POST', path: '/alerts', description: 'Create a price or risk alert.', category: 'Credit & Alerts', requestBody: '{ agentId, type, config }', responseBody: '{ alert }' },
  { method: 'GET', path: '/alerts/:agentId', description: 'Get all alerts for an agent.', category: 'Credit & Alerts', responseBody: '{ alerts }' },
  { method: 'DELETE', path: '/alerts/:alertId', description: 'Delete an alert.', category: 'Credit & Alerts', responseBody: '{ ok }' },
  { method: 'GET', path: '/alerts/:agentId/history', description: 'Get alert trigger history.', category: 'Credit & Alerts', responseBody: '{ history }' },

  // ─── Watchlist ────────────────────────
  { method: 'POST', path: '/agents/:agentId/watchlist', description: 'Add a symbol to agent watchlist.', category: 'Watchlist', requestBody: '{ symbol, notes? }', responseBody: '{ entry }' },
  { method: 'DELETE', path: '/agents/:agentId/watchlist/:symbol', description: 'Remove symbol from watchlist.', category: 'Watchlist', responseBody: '{ ok }' },
  { method: 'GET', path: '/agents/:agentId/watchlist', description: 'Get agent watchlist.', category: 'Watchlist', responseBody: '{ watchlist }' },
  { method: 'GET', path: '/watchlist/trending', description: 'Get trending symbols across all watchlists.', category: 'Watchlist', responseBody: '{ trending }' },

  // ─── Rebalance ────────────────────────
  { method: 'POST', path: '/agents/:agentId/rebalance/target', description: 'Set target portfolio allocation percentages.', category: 'Rebalance', requestBody: '{ allocations: { SOL: 0.5, USDC: 0.5 } }', responseBody: '{ agentId, allocation }' },
  { method: 'GET', path: '/agents/:agentId/rebalance/status', description: 'Get current vs target allocation drift.', category: 'Rebalance', responseBody: '{ status }' },
  { method: 'POST', path: '/agents/:agentId/rebalance/execute', description: 'Execute rebalancing trades to reach target allocation.', category: 'Rebalance', responseBody: '{ result }' },

  // ─── Journal ──────────────────────────
  { method: 'GET', path: '/agents/:agentId/journal', description: 'Get agent trade journal entries. Filter by type, paginate.', category: 'Journal', responseBody: '{ entries, total }' },
  { method: 'GET', path: '/agents/:agentId/journal/stats', description: 'Get journal statistics.', category: 'Journal', responseBody: '{ stats }' },
  { method: 'GET', path: '/agents/:agentId/journal/export', description: 'Export full journal.', category: 'Journal', responseBody: '{ entries }' },

  // ─── Webhooks ─────────────────────────
  { method: 'GET', path: '/agents/:agentId/webhook-deliveries', description: 'Get webhook delivery history for an agent.', category: 'Webhooks', responseBody: '{ agentId, deliveries }' },

  // ─── Diagnostics ──────────────────────
  { method: 'GET', path: '/diagnostics/health', description: 'Detailed system health check across all services.', category: 'Diagnostics', responseBody: '{ health }', curl: "curl $BASE/diagnostics/health" },
  { method: 'GET', path: '/diagnostics/services', description: 'Get status of all registered services.', category: 'Diagnostics', responseBody: '{ services }' },
  { method: 'GET', path: '/diagnostics/errors', description: 'Get recent error log. Optional ?limit=N.', category: 'Diagnostics', responseBody: '{ errors }' },
  { method: 'POST', path: '/diagnostics/self-test', description: 'Run a comprehensive self-test of all systems.', category: 'Diagnostics', responseBody: '{ results }' },

  // ─── Privacy & Proofs ─────────────────
  { method: 'GET', path: '/privacy/policy', description: 'Get privacy policy: encryption algorithm, key derivation, redaction support.', category: 'Privacy & Proofs', responseBody: '{ encryptionEnabled, algorithm, ... }' },
  { method: 'GET', path: '/proofs/anchors', description: 'List on-chain proof anchors.', category: 'Privacy & Proofs', responseBody: '{ anchors }' },
  { method: 'POST', path: '/proofs/anchor', description: 'Create a new on-chain proof anchor from recent receipts.', category: 'Privacy & Proofs', responseBody: '{ anchor }' },
  { method: 'GET', path: '/proofs/verify/:receiptId', description: 'Verify a receipt against on-chain proof anchors.', category: 'Privacy & Proofs', responseBody: '{ verified, proof }' },

  // ─── Lending ──────────────────────────
  { method: 'GET', path: '/lending/positions', description: 'Get all monitored lending positions.', category: 'Lending', responseBody: '{ positions }' },
  { method: 'POST', path: '/lending/positions', description: 'Register a lending position for health monitoring.', category: 'Lending', requestBody: '{ agentId, protocol, market, suppliedUsd, borrowedUsd, healthFactor, ltv, wallet }', responseBody: '{ position }' },
  { method: 'GET', path: '/lending/alerts', description: 'Get lending health alerts.', category: 'Lending', responseBody: '{ alerts }' },

  // ─── Integrations ─────────────────────
  { method: 'GET', path: '/integrations/clawpump/health', description: 'ClawPump integration health check.', category: 'Integrations', responseBody: '{ status }' },
  { method: 'POST', path: '/integrations/clawpump/launch', description: 'Launch a new token via ClawPump.', category: 'Integrations', requestBody: '{ name, symbol, description, website?, twitter?, telegram?, imagePath? }', responseBody: '{ launched }' },
  { method: 'GET', path: '/integrations/clawpump/earnings', description: 'Get ClawPump earnings for an agent.', category: 'Integrations', responseBody: '{ earnings }' },
  { method: 'GET', path: '/integrations/clawpump/launch-attempts', description: 'List token launch attempts.', category: 'Integrations', responseBody: '{ attempts }' },

  // ─── Skills & Payment ─────────────────
  { method: 'GET', path: '/skills', description: 'List all registered agent skills.', category: 'Skills & Payment', responseBody: '{ skills }' },
  { method: 'GET', path: '/agents/:agentId/skills', description: 'Get skills for a specific agent.', category: 'Skills & Payment', responseBody: '{ agentId, skills }' },
  { method: 'GET', path: '/paid-plan/policy', description: 'Get x402 payment policy and paid endpoint configuration.', category: 'Skills & Payment', responseBody: '{ version, paidEndpoints, ... }' },
];

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const METHOD_COLORS: Record<string, string> = {
  GET: '#4ade80',
  POST: '#60a5fa',
  PATCH: '#fbbf24',
  DELETE: '#f87171',
  PUT: '#a78bfa',
};

export function renderDocsPage(): string {
  // Group endpoints by category
  const categories = new Map<string, EndpointDoc[]>();
  for (const ep of API_ENDPOINTS) {
    if (!categories.has(ep.category)) {
      categories.set(ep.category, []);
    }
    categories.get(ep.category)!.push(ep);
  }

  const categoryIcons: Record<string, string> = {
    'Core': '🏠',
    'Agents': '🤖',
    'Trading': '💹',
    'Strategies': '📈',
    'Sandbox': '🧪',
    'Simulation': '🔮',
    'Orders': '📋',
    'Autonomous': '🔄',
    'Squads': '👥',
    'Messaging': '💬',
    'Marketplace': '🏪',
    'Reputation': '🏆',
    'Governance': '🗳️',
    'Analytics': '📊',
    'Risk & MEV': '🛡️',
    'Oracles': '🔗',
    'Order Book': '📉',
    'Self-Improvement': '🧠',
    'Tournaments': '⚔️',
    'Social': '🌐',
    'Copy Trading': '📋',
    'Credit & Alerts': '🔔',
    'Watchlist': '👀',
    'Rebalance': '⚖️',
    'Journal': '📝',
    'Webhooks': '📡',
    'Diagnostics': '🔧',
    'Privacy & Proofs': '🔒',
    'Lending': '💸',
    'Integrations': '🔌',
    'Skills & Payment': '💳',
  };

  // Build sidebar nav
  const navItems = [...categories.keys()].map((cat) => {
    const icon = categoryIcons[cat] || '📌';
    const count = categories.get(cat)!.length;
    const slug = cat.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    return `<a href="#cat-${slug}" class="nav-item" onclick="setActive(this)"><span class="nav-icon">${icon}</span><span class="nav-label">${escapeHtml(cat)}</span><span class="nav-count">${count}</span></a>`;
  }).join('\n');

  // Build endpoint cards
  const sections = [...categories.entries()].map(([cat, endpoints]) => {
    const icon = categoryIcons[cat] || '📌';
    const slug = cat.toLowerCase().replace(/[^a-z0-9]+/g, '-');

    const cards = endpoints.map((ep, i) => {
      const methodColor = METHOD_COLORS[ep.method] || '#888';
      const authBadge = ep.auth ? '<span class="auth-badge">🔑 Auth</span>' : '';
      const curlBlock = ep.curl
        ? `<div class="curl-section"><div class="curl-label">Example</div><code class="curl-code">${escapeHtml(ep.curl)}</code></div>`
        : '';
      const reqBody = ep.requestBody
        ? `<div class="schema-row"><span class="schema-label">Request</span><code class="schema-code">${escapeHtml(ep.requestBody)}</code></div>`
        : '';
      const resBody = ep.responseBody
        ? `<div class="schema-row"><span class="schema-label">Response</span><code class="schema-code">${escapeHtml(ep.responseBody)}</code></div>`
        : '';
      const tryLink = ep.method === 'GET'
        ? `<a href="${escapeHtml(ep.path.replace(/:(\w+)/g, 'EXAMPLE'))}" target="_blank" class="try-link">Try it →</a>`
        : '';

      return `
        <div class="endpoint-card fade-in" style="animation-delay:${i * 0.03}s">
          <div class="endpoint-header">
            <span class="method-badge" style="background:${methodColor}20;color:${methodColor};border:1px solid ${methodColor}40">${ep.method}</span>
            <span class="endpoint-path">${escapeHtml(ep.path)}</span>
            ${authBadge}
            ${tryLink}
          </div>
          <div class="endpoint-desc">${escapeHtml(ep.description)}</div>
          ${reqBody}
          ${resBody}
          ${curlBlock}
        </div>`;
    }).join('\n');

    return `
      <div class="category-section" id="cat-${slug}">
        <div class="category-header">
          <span class="category-icon">${icon}</span>
          <h2 class="category-title">${escapeHtml(cat)}</h2>
          <span class="category-count">${endpoints.length} endpoint${endpoints.length === 1 ? '' : 's'}</span>
        </div>
        ${cards}
      </div>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>API Documentation — Timmy Agent Trading API</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
:root{--bg:#06060e;--bg2:#0c0c18;--bg3:#12121f;--card:#0f0f1c;--border:#1a1a30;--red:#e94560;--cyan:#00d4ff;--green:#4ade80;--yellow:#fbbf24;--purple:#a78bfa;--pink:#f472b6;--text:#e0e0e0;--muted:#888;--mono:'SF Mono',Monaco,Consolas,'Liberation Mono',monospace}
html{scroll-behavior:smooth}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);min-height:100vh;display:flex}

@keyframes fadeInUp{from{opacity:0;transform:translateY(20px)}to{opacity:1;transform:translateY(0)}}
@keyframes gradientShift{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
.fade-in{animation:fadeInUp .4s ease-out both}

/* ─── Sidebar ─── */
.sidebar{width:260px;height:100vh;position:fixed;top:0;left:0;background:var(--bg2);border-right:1px solid var(--border);overflow-y:auto;z-index:10;display:flex;flex-direction:column}
.sidebar-header{padding:1.5rem 1.2rem 1rem;border-bottom:1px solid var(--border)}
.sidebar-logo{font-size:1.1rem;font-weight:800;background:linear-gradient(135deg,#fff,var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text}
.sidebar-sub{font-size:.72rem;color:var(--muted);margin-top:4px}
.sidebar-nav{flex:1;padding:.8rem 0;overflow-y:auto}
.nav-item{display:flex;align-items:center;gap:10px;padding:8px 1.2rem;color:var(--muted);text-decoration:none;font-size:.82rem;font-weight:500;transition:all .2s;border-left:3px solid transparent}
.nav-item:hover{color:var(--text);background:rgba(255,255,255,.03)}
.nav-item.active{color:var(--cyan);background:rgba(0,212,255,.06);border-left-color:var(--cyan)}
.nav-icon{font-size:1rem;flex-shrink:0}
.nav-label{flex:1}
.nav-count{font-size:.7rem;background:rgba(255,255,255,.06);border:1px solid var(--border);padding:1px 6px;border-radius:8px;color:var(--muted)}
.sidebar-footer{padding:1rem 1.2rem;border-top:1px solid var(--border);font-size:.72rem;color:var(--muted)}
.sidebar-footer a{color:var(--red);text-decoration:none}
.sidebar-footer a:hover{text-decoration:underline}

/* ─── Main ─── */
.main{margin-left:260px;flex:1;min-height:100vh}

/* ─── Header ─── */
.docs-header{background:linear-gradient(160deg,#0a0a1a,#111132,#1a0a2e);padding:3rem 3rem 2rem;border-bottom:1px solid var(--border);position:relative;overflow:hidden}
.docs-header::before{content:'';position:absolute;top:0;left:0;right:0;bottom:0;background:radial-gradient(ellipse at 30% 0%,rgba(233,69,96,.1),transparent 60%);pointer-events:none}
.docs-header h1{font-size:2.2rem;font-weight:800;background:linear-gradient(135deg,#fff,#e0e0e0,var(--cyan));-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;margin-bottom:.5rem;position:relative}
.docs-header p{color:var(--muted);font-size:.95rem;line-height:1.6;max-width:650px;position:relative}
.stats-row{display:flex;gap:1.5rem;margin-top:1.2rem;flex-wrap:wrap;position:relative}
.stat-chip{background:rgba(255,255,255,.05);border:1px solid var(--border);padding:6px 14px;border-radius:10px;font-size:.78rem;font-weight:600;color:var(--text)}
.stat-chip .num{color:var(--cyan)}

/* ─── Search ─── */
.search-bar{padding:1rem 3rem;border-bottom:1px solid var(--border);background:var(--bg2);position:sticky;top:0;z-index:5}
.search-input{width:100%;max-width:500px;background:var(--bg);border:1px solid var(--border);border-radius:10px;padding:10px 16px 10px 40px;color:var(--text);font-size:.88rem;outline:none;transition:border-color .2s;background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' fill='%23888' viewBox='0 0 16 16'%3E%3Cpath d='M11.742 10.344a6.5 6.5 0 1 0-1.397 1.398h-.001l3.85 3.85a1 1 0 0 0 1.415-1.414l-3.85-3.85zm-5.242.156a5 5 0 1 1 0-10 5 5 0 0 1 0 10z'/%3E%3C/svg%3E");background-repeat:no-repeat;background-position:14px center}
.search-input:focus{border-color:var(--cyan)}
.search-input::placeholder{color:var(--muted)}

/* ─── Content ─── */
.content{padding:2rem 3rem 4rem}

/* ─── Category ─── */
.category-section{margin-bottom:3rem}
.category-header{display:flex;align-items:center;gap:10px;margin-bottom:1.2rem;padding-bottom:.8rem;border-bottom:1px solid var(--border)}
.category-icon{font-size:1.4rem}
.category-title{font-size:1.3rem;font-weight:700;flex:1}
.category-count{font-size:.75rem;color:var(--muted);background:rgba(255,255,255,.06);padding:3px 10px;border-radius:10px}

/* ─── Endpoint Card ─── */
.endpoint-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:1.2rem 1.5rem;margin-bottom:.8rem;transition:all .2s}
.endpoint-card:hover{border-color:rgba(233,69,96,.25);box-shadow:0 4px 20px rgba(0,0,0,.2)}
.endpoint-header{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:.5rem}
.method-badge{font-family:var(--mono);font-size:.72rem;font-weight:700;padding:3px 8px;border-radius:6px;letter-spacing:.5px;flex-shrink:0}
.endpoint-path{font-family:var(--mono);font-size:.88rem;font-weight:600;color:var(--text)}
.auth-badge{font-size:.68rem;background:rgba(251,191,36,.12);color:var(--yellow);border:1px solid rgba(251,191,36,.3);padding:2px 8px;border-radius:6px;font-weight:600}
.try-link{margin-left:auto;font-size:.75rem;color:var(--cyan);text-decoration:none;font-weight:600;opacity:.7;transition:opacity .2s}
.try-link:hover{opacity:1}
.endpoint-desc{color:var(--muted);font-size:.82rem;line-height:1.5;margin-bottom:.6rem}
.schema-row{display:flex;align-items:flex-start;gap:8px;margin-bottom:.4rem}
.schema-label{font-size:.7rem;font-weight:700;color:var(--purple);text-transform:uppercase;letter-spacing:.5px;min-width:60px;padding-top:3px;flex-shrink:0}
.schema-code{font-family:var(--mono);font-size:.75rem;color:#9ca3af;background:rgba(255,255,255,.03);padding:3px 8px;border-radius:6px;word-break:break-all;flex:1}
.curl-section{margin-top:.5rem;border-top:1px solid rgba(255,255,255,.04);padding-top:.5rem}
.curl-label{font-size:.68rem;font-weight:700;color:var(--green);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}
.curl-code{display:block;font-family:var(--mono);font-size:.72rem;color:#9ca3af;background:var(--bg);border:1px solid var(--border);padding:8px 12px;border-radius:8px;overflow-x:auto;white-space:pre;cursor:pointer;transition:border-color .2s}
.curl-code:hover{border-color:var(--cyan)}

/* ─── Responsive ─── */
@media(max-width:900px){
  .sidebar{display:none}
  .main{margin-left:0}
  .docs-header,.search-bar,.content{padding-left:1.5rem;padding-right:1.5rem}
}

/* ─── Scrollbar ─── */
::-webkit-scrollbar{width:6px}
::-webkit-scrollbar-track{background:var(--bg)}
::-webkit-scrollbar-thumb{background:var(--border);border-radius:3px}
::-webkit-scrollbar-thumb:hover{background:var(--muted)}
</style>
</head>
<body>

<!-- Sidebar -->
<aside class="sidebar">
  <div class="sidebar-header">
    <div class="sidebar-logo">🏛️ Timmy API</div>
    <div class="sidebar-sub">v0.4.0 — ${API_ENDPOINTS.length} Endpoints</div>
  </div>
  <nav class="sidebar-nav">
    ${navItems}
  </nav>
  <div class="sidebar-footer">
    <a href="/experiment">← Experiment Dashboard</a><br/>
    <a href="https://github.com/tomi204/colosseum-ai-agent-trading-api" target="_blank">GitHub ↗</a>
  </div>
</aside>

<!-- Main Content -->
<main class="main">
  <div class="docs-header">
    <h1>API Documentation</h1>
    <p>Complete reference for the Timmy Autonomous AI Agent Trading API. Every endpoint with schemas, examples, and interactive links.</p>
    <div class="stats-row">
      <span class="stat-chip"><span class="num">${API_ENDPOINTS.length}</span> Endpoints</span>
      <span class="stat-chip"><span class="num">${categories.size}</span> Categories</span>
      <span class="stat-chip"><span class="num">${API_ENDPOINTS.filter((e) => e.auth).length}</span> Authenticated</span>
      <span class="stat-chip"><span class="num">${API_ENDPOINTS.filter((e) => e.curl).length}</span> Examples</span>
      <span class="stat-chip">Base URL: <span class="num">$BASE</span></span>
    </div>
  </div>

  <div class="search-bar">
    <input type="text" class="search-input" id="search-input" placeholder="Search endpoints... (path, method, description)" oninput="filterEndpoints(this.value)"/>
  </div>

  <div class="content" id="content">
    ${sections}
  </div>
</main>

<script>
function setActive(el) {
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  el.classList.add('active');
}

// Highlight active nav on scroll
var observer = new IntersectionObserver(function(entries) {
  entries.forEach(function(entry) {
    if (entry.isIntersecting) {
      var id = entry.target.id;
      document.querySelectorAll('.nav-item').forEach(function(n) {
        n.classList.toggle('active', n.getAttribute('href') === '#' + id);
      });
    }
  });
}, { threshold: 0.3, rootMargin: '-80px 0px -60% 0px' });

document.querySelectorAll('.category-section').forEach(function(s) { observer.observe(s); });

// Copy curl on click
document.querySelectorAll('.curl-code').forEach(function(el) {
  el.title = 'Click to copy';
  el.addEventListener('click', function() {
    navigator.clipboard.writeText(el.textContent).then(function() {
      var orig = el.style.borderColor;
      el.style.borderColor = 'var(--green)';
      setTimeout(function() { el.style.borderColor = orig; }, 800);
    });
  });
});

// Search filter
function filterEndpoints(query) {
  var q = query.toLowerCase().trim();
  document.querySelectorAll('.endpoint-card').forEach(function(card) {
    var text = card.textContent.toLowerCase();
    card.style.display = !q || text.includes(q) ? '' : 'none';
  });
  document.querySelectorAll('.category-section').forEach(function(section) {
    var visible = section.querySelectorAll('.endpoint-card[style=""], .endpoint-card:not([style])');
    var allCards = section.querySelectorAll('.endpoint-card');
    var hasVisible = false;
    allCards.forEach(function(c) { if (c.style.display !== 'none') hasVisible = true; });
    section.style.display = hasVisible ? '' : 'none';
  });
}

// Replace $BASE in curls with actual origin
document.querySelectorAll('.curl-code').forEach(function(el) {
  el.textContent = el.textContent.replace(/\\$BASE/g, location.origin);
});
</script>
</body>
</html>`;
}
