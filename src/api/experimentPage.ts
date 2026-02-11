export function renderExperimentPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Timmy Agent Trading API — Live Dashboard</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0a0a0f;color:#e0e0e0;min-height:100vh}
    .hero{background:linear-gradient(135deg,#1a1a2e 0%,#16213e 50%,#0f3460 100%);padding:3rem 2rem;text-align:center;border-bottom:2px solid #e94560}
    .hero h1{font-size:2.2rem;color:#fff;margin-bottom:.5rem;letter-spacing:-0.5px}
    .hero .tag{display:inline-block;background:#e94560;color:#fff;padding:4px 12px;border-radius:12px;font-size:.75rem;font-weight:600;margin:4px}
    .hero p{color:#aaa;margin-top:.8rem;font-size:.95rem}
    .container{max-width:1100px;margin:0 auto;padding:2rem}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:1.5rem;margin-bottom:2rem}
    .card{background:#12121a;border:1px solid #1e1e2e;border-radius:12px;padding:1.5rem;transition:border-color .2s}
    .card:hover{border-color:#e94560}
    .card h2{font-size:1.1rem;color:#e94560;margin-bottom:.8rem;display:flex;align-items:center;gap:.5rem}
    .card h2 span{font-size:1.2rem}
    .mono{font-family:'SF Mono',Monaco,Consolas,monospace;font-size:.85rem}
    .status{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
    .status.ok{background:#4ade80}
    .status.warn{background:#fbbf24}
    .status.err{background:#f87171}
    pre{background:#0d0d14;border:1px solid #1e1e2e;border-radius:8px;padding:1rem;overflow-x:auto;font-size:.8rem;line-height:1.5;color:#9ca3af;margin-top:.5rem}
    .btn{display:inline-block;background:#e94560;color:#fff;padding:8px 16px;border-radius:8px;text-decoration:none;font-size:.85rem;font-weight:600;cursor:pointer;border:none;transition:background .2s}
    .btn:hover{background:#c93550}
    .btn-outline{background:transparent;border:1px solid #e94560;color:#e94560}
    .btn-outline:hover{background:#e94560;color:#fff}
    .kv{display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #1a1a24}
    .kv:last-child{border-bottom:none}
    .kv .k{color:#888;font-size:.85rem}
    .kv .v{color:#e0e0e0;font-size:.85rem;font-weight:600}
    .link{color:#e94560;text-decoration:none}
    .link:hover{text-decoration:underline}
    .txproof{background:#0f1a0f;border:1px solid #22c55e33;border-radius:8px;padding:1rem;margin:.5rem 0}
    .txproof a{color:#4ade80;font-size:.8rem;word-break:break-all}
    .footer{text-align:center;padding:2rem;color:#555;font-size:.8rem;border-top:1px solid #1e1e2e;margin-top:2rem}
    #health-data,#agents-data,#metrics-data,#autonomous-data{min-height:40px}
    .loading{color:#555;font-style:italic}
  </style>
</head>
<body>
  <div class="hero">
    <h1>🏛️ Timmy Agent Trading API</h1>
    <div>
      <span class="tag">AUTONOMOUS</span>
      <span class="tag">SOLANA MAINNET</span>
      <span class="tag">VERIFIABLE RECEIPTS</span>
      <span class="tag">RISK TELEMETRY</span>
      <span class="tag">WEBSOCKET LIVE FEED</span>
      <span class="tag">MULTI-AGENT SQUADS</span>
      <span class="tag">PORTFOLIO ANALYTICS</span>
    </div>
    <p>Safe, auditable, monetizable trading infrastructure for autonomous AI agents</p>
  </div>

  <div class="container">
    <!-- Live Status -->
    <div class="grid">
      <div class="card">
        <h2><span>💚</span> System Health</h2>
        <div id="health-data" class="loading">Loading...</div>
      </div>
      <div class="card">
        <h2><span>🤖</span> Registered Agents</h2>
        <div id="agents-data" class="loading">Loading...</div>
      </div>
      <div class="card">
        <h2><span>🔄</span> Autonomous Loop</h2>
        <div id="autonomous-data" class="loading">Loading...</div>
      </div>
    </div>

    <!-- Mainnet Proof -->
    <div class="card" style="margin-bottom:1.5rem">
      <h2><span>⛓️</span> Live Mainnet Transaction Proof</h2>
      <p style="color:#aaa;font-size:.85rem;margin-bottom:.8rem">Both transactions executed through the full pipeline: register → price feed → strategy → risk check → Jupiter swap → receipt chain</p>
      <div class="txproof">
        <strong style="color:#4ade80">TX 1 — Sell (SOL→USDC)</strong><br/>
        <a href="https://solscan.io/tx/3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf" target="_blank">3XmPquLChzX9w7Sot9i9wiW5uJ91ibAtkGpwwFSqjeg9EuDXij5tmNtVTF7QyARMq2RJyMkCz6f9EEb2JJLsZdKf</a>
      </div>
      <div class="txproof">
        <strong style="color:#4ade80">TX 2 — Buy (USDC→SOL)</strong><br/>
        <a href="https://solscan.io/tx/5qZERks6yv1Rjhm5wHvuLRt36nofPrgrCdmeFP5xbVwkGoj4sAubdnXo6MoZUS3XsxYECcgL7ENBdMkoMjmx8kG7" target="_blank">5qZERks6yv1Rjhm5wHvuLRt36nofPrgrCdmeFP5xbVwkGoj4sAubdnXo6MoZUS3XsxYECcgL7ENBdMkoMjmx8kG7</a>
      </div>
      <p style="color:#888;font-size:.8rem;margin-top:.5rem">Wallet: <span class="mono">7GciqigwwRM8HANqDTF1GjAq6yKsS2odvorAaTUSaYkJ</span></p>
    </div>

    <!-- Metrics -->
    <div class="grid">
      <div class="card">
        <h2><span>📊</span> Platform Metrics</h2>
        <div id="metrics-data" class="loading">Loading...</div>
      </div>
      <div class="card">
        <h2><span>🧪</span> Try It</h2>
        <p style="color:#aaa;font-size:.85rem;margin-bottom:1rem">Register an agent and start trading in 3 API calls:</p>
        <pre>
# 1. Register agent
curl -X POST /agents/register \\
  -d '{"name":"my-agent","startingCapitalUsd":10000}'

# 2. Set market price
curl -X POST /market/prices \\
  -d '{"symbol":"SOL","priceUsd":148.50}'

# 3. Submit trade intent
curl -X POST /trade-intents \\
  -H "x-agent-api-key: YOUR_KEY" \\
  -d '{"agentId":"...","symbol":"SOL","side":"buy","notionalUsd":100}'</pre>
        <div style="margin-top:1rem;display:flex;gap:.5rem;flex-wrap:wrap">
          <a href="/health" class="btn btn-outline">Health</a>
          <a href="/agents" class="btn btn-outline">Agents</a>
          <a href="/strategies" class="btn btn-outline">Strategies</a>
          <a href="/metrics" class="btn btn-outline">Metrics</a>
          <a href="/autonomous/status" class="btn btn-outline">Autonomous</a>
          <a href="/state" class="btn btn-outline">Full State</a>
        </div>
      </div>
    </div>

    <!-- Live Event Feed -->
    <div class="card" style="margin-bottom:1.5rem">
      <h2><span>📡</span> Live Event Feed <span id="ws-status" style="font-size:.7rem;color:#888">(connecting...)</span></h2>
      <p style="color:#aaa;font-size:.85rem;margin-bottom:.5rem">Real-time events via WebSocket — <span class="mono">/ws</span></p>
      <div id="event-feed" style="max-height:280px;overflow-y:auto;background:#0d0d14;border:1px solid #1e1e2e;border-radius:8px;padding:.8rem;font-size:.78rem;font-family:'SF Mono',Monaco,Consolas,monospace;color:#9ca3af">
        <div style="color:#555">Waiting for events...</div>
      </div>
      <div style="margin-top:.5rem;display:flex;gap:.5rem;align-items:center">
        <span style="font-size:.8rem;color:#888">Connected clients: <strong id="ws-clients">0</strong></span>
        <button class="btn btn-outline" style="font-size:.75rem;padding:4px 10px" onclick="document.getElementById('event-feed').innerHTML=''">Clear</button>
      </div>
    </div>

    <!-- Squads & Coordination -->
    <div class="grid">
      <div class="card">
        <h2><span>👥</span> Squad Coordination</h2>
        <div id="squads-data" class="loading">Loading...</div>
        <div style="margin-top:.8rem;display:flex;gap:.5rem;flex-wrap:wrap">
          <a href="/squads" class="btn btn-outline" style="font-size:.75rem">All Squads</a>
        </div>
      </div>
      <div class="card">
        <h2><span>📈</span> Agent Analytics</h2>
        <p style="color:#aaa;font-size:.85rem;margin-bottom:.5rem">Per-agent Sharpe ratio, win rate, drawdown, and P&L summaries</p>
        <pre>
# Get analytics for an agent
GET /agents/:agentId/analytics

# Response includes:
# - sharpeRatio, sortinoRatio
# - winRate, avgWin, avgLoss
# - maxDrawdown + duration
# - daily & weekly P&L</pre>
      </div>
    </div>

    <!-- Architecture -->
    <div class="card" style="margin-top:1.5rem">
      <h2><span>🏗️</span> Architecture</h2>
      <pre style="color:#e0e0e0;font-size:.75rem">
  Agent ──► Register ──► Get API Key
                              │
  Price Feed ──► /market/prices ──► Strategy Engine
                                        │
                              ┌─────────┴─────────┐
                              │   momentum-v1      │
                              │   mean-reversion   │
                              └─────────┬─────────┘
                                        │
                              Autonomous Loop (optional)
                                        │
                              ┌─────────▼─────────┐
                              │   Trade Intent     │
                              └─────────┬─────────┘
                                        │
                              ┌─────────▼─────────┐
                              │   Risk Engine      │
                              │  • Position limits │
                              │  • Drawdown caps   │
                              │  • Cooldowns       │
                              │  • Exposure caps   │
                              └─────────┬─────────┘
                                        │
                              ┌─────────▼─────────┐
                              │  Execution Engine  │
                              │  paper │ live      │
                              └─────────┬─────────┘
                                        │ (live)
                              ┌─────────▼─────────┐
                              │  Jupiter Swap      │
                              │  quote → swap →    │
                              │  broadcast → confirm│
                              └─────────┬─────────┘
                                        │
                              ┌─────────▼─────────┐
                              │  Receipt Chain     │
                              │  SHA-256 hash link │
                              │  tamper-evident    │
                              └────────────────────┘</pre>
    </div>

    <!-- Feature Grid -->
    <div class="grid" style="margin-top:1.5rem">
      <div class="card">
        <h2><span>🛡️</span> Risk Management</h2>
        <div class="kv"><span class="k">Max position size</span><span class="v">25% of equity</span></div>
        <div class="kv"><span class="k">Max drawdown</span><span class="v">20% hard stop</span></div>
        <div class="kv"><span class="k">Cooldown</span><span class="v">Configurable per-agent</span></div>
        <div class="kv"><span class="k">Consecutive failure halt</span><span class="v">After N failures</span></div>
        <div class="kv"><span class="k">Exposure limit</span><span class="v">$7,500 default</span></div>
      </div>
      <div class="card">
        <h2><span>🔗</span> Verifiable Receipts</h2>
        <div class="kv"><span class="k">Hash algorithm</span><span class="v">SHA-256</span></div>
        <div class="kv"><span class="k">Chain type</span><span class="v">Linked (prev hash ref)</span></div>
        <div class="kv"><span class="k">Tamper detection</span><span class="v">Built-in verification</span></div>
        <div class="kv"><span class="k">Idempotency</span><span class="v">x-idempotency-key header</span></div>
        <div class="kv"><span class="k">Audit endpoint</span><span class="v">/receipts/verify/:id</span></div>
      </div>
      <div class="card">
        <h2><span>💰</span> Monetization</h2>
        <div class="kv"><span class="k">Platform fee</span><span class="v">8 bps per execution</span></div>
        <div class="kv"><span class="k">Jupiter referral</span><span class="v">Configurable</span></div>
        <div class="kv"><span class="k">x402 payment gate</span><span class="v">Optional USDC toll</span></div>
        <div class="kv"><span class="k">Token revenue</span><span class="v">Clawpump integration</span></div>
        <div class="kv"><span class="k">Treasury tracking</span><span class="v">Built-in</span></div>
      </div>
      <div class="card">
        <h2><span>🤖</span> Autonomous Mode</h2>
        <div class="kv"><span class="k">Loop interval</span><span class="v">Configurable (30s default)</span></div>
        <div class="kv"><span class="k">Strategies</span><span class="v">momentum + mean-reversion</span></div>
        <div class="kv"><span class="k">Guard layer</span><span class="v">Independent of risk engine</span></div>
        <div class="kv"><span class="k">Drawdown halt</span><span class="v">Automatic stop-loss</span></div>
        <div class="kv"><span class="k">API toggle</span><span class="v">POST /autonomous/toggle</span></div>
      </div>
    </div>

    <!-- SDK -->
    <div class="card" style="margin-top:1.5rem">
      <h2><span>📦</span> TypeScript SDK</h2>
      <p style="color:#aaa;font-size:.85rem;margin-bottom:.8rem">Import and use directly — zero external dependencies:</p>
      <pre>
import { TradingAPIClient } from 'colosseum-ai-agent-trading-api/sdk';

const client = new TradingAPIClient('https://your-api.com');
const { agent, apiKey } = await client.registerAgent({ name: 'my-bot' });
const intent = await client.submitIntent({
  agentId: agent.id, symbol: 'SOL', side: 'buy', notionalUsd: 50
}, apiKey);
const receipt = await client.getReceipt(intent.executionId);</pre>
      <p style="color:#888;font-size:.8rem;margin-top:.5rem">
        Full docs: <a class="link" href="https://github.com/tomi204/colosseum-ai-agent-trading-api/blob/main/docs/SDK.md" target="_blank">docs/SDK.md</a>
      </p>
    </div>
  </div>

  <div class="footer">
    <p>Timmy Agent Trading API — Colosseum Agent Hackathon 2026</p>
    <p style="margin-top:.3rem">
      <a class="link" href="https://github.com/tomi204/colosseum-ai-agent-trading-api" target="_blank">GitHub</a> ·
      61 Tests Passing · Built with TypeScript + Fastify + Jupiter + Solana
    </p>
  </div>

  <script>
    const BASE = window.location.origin;
    const H = (sel) => document.querySelector(sel);

    async function load(path) {
      try {
        const r = await fetch(BASE + path);
        return await r.json();
      } catch { return null; }
    }

    function kv(label, value) {
      return '<div class="kv"><span class="k">' + label + '</span><span class="v">' + value + '</span></div>';
    }

    async function init() {
      // Health
      const h = await load('/health');
      if (h) {
        H('#health-data').innerHTML =
          kv('Status', '<span class="status ok"></span>' + h.status) +
          kv('Uptime', Math.round(h.uptimeSeconds) + 's') +
          kv('Mode', h.defaultMode) +
          kv('Live enabled', h.liveModeEnabled ? 'Yes' : 'No') +
          kv('Agents', h.stateSummary?.agents ?? 0) +
          kv('Executions', h.stateSummary?.executions ?? 0) +
          kv('Receipts', h.stateSummary?.receipts ?? 0);
      }

      // Agents
      const a = await load('/agents');
      if (a && a.agents) {
        if (a.agents.length === 0) {
          H('#agents-data').innerHTML = '<p style="color:#555">No agents registered yet</p>';
        } else {
          H('#agents-data').innerHTML = a.agents.slice(0, 8).map(ag =>
            '<div class="kv"><span class="k mono">' + ag.id.substring(0,12) + '...</span><span class="v">' + ag.name + ' <span style="color:#888;font-size:.75rem">(' + ag.strategyId + ')</span></span></div>'
          ).join('');
        }
      }

      // Autonomous
      const au = await load('/autonomous/status');
      if (au) {
        H('#autonomous-data').innerHTML =
          kv('Enabled', au.enabled ? '<span class="status ok"></span>Active' : '<span class="status warn"></span>Disabled') +
          kv('Interval', (au.intervalMs / 1000) + 's') +
          kv('Loop count', au.loopCount ?? 0) +
          kv('Last run', au.lastRunAt ? new Date(au.lastRunAt).toLocaleTimeString() : 'Never');
      }

      // Metrics
      const m = await load('/metrics');
      if (m) {
        const met = m.metrics || {};
        const tr = m.treasury || {};
        H('#metrics-data').innerHTML =
          kv('Intents executed', met.intentsExecuted ?? 0) +
          kv('Intents rejected', met.intentsRejected ?? 0) +
          kv('Receipts generated', met.receiptCount ?? 0) +
          kv('Quote retries', met.quoteRetries ?? 0) +
          kv('Total fees collected', '$' + (tr.totalFeesUsd ?? 0).toFixed(4)) +
          kv('Treasury entries', (tr.entries?.length ?? 0));
      }
    }

    init();
    setInterval(init, 15000);

    // ─── WebSocket live feed ────────────────────────────────
    const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    let ws;
    const eventColors = {
      'intent.created': '#60a5fa',
      'intent.executed': '#4ade80',
      'intent.rejected': '#f87171',
      'price.updated': '#fbbf24',
      'autonomous.tick': '#a78bfa',
      'agent.registered': '#34d399',
      'squad.created': '#f472b6',
      'squad.joined': '#fb923c',
      'connected': '#888',
    };

    function connectWs() {
      ws = new WebSocket(wsProto + '//' + location.host + '/ws');
      ws.onopen = () => {
        H('#ws-status').textContent = '(connected)';
        H('#ws-status').style.color = '#4ade80';
      };
      ws.onclose = () => {
        H('#ws-status').textContent = '(disconnected)';
        H('#ws-status').style.color = '#f87171';
        setTimeout(connectWs, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'connected') {
            H('#ws-clients').textContent = msg.data?.clients ?? '?';
            return;
          }
          const feed = H('#event-feed');
          const color = eventColors[msg.type] || '#9ca3af';
          const time = msg.ts ? new Date(msg.ts).toLocaleTimeString() : '';
          const line = document.createElement('div');
          line.style.marginBottom = '3px';
          line.innerHTML = '<span style="color:#555">' + time + '</span> <span style="color:' + color + ';font-weight:600">' + msg.type + '</span> ' + JSON.stringify(msg.data ?? {});
          feed.prepend(line);
          // Keep feed bounded
          while (feed.children.length > 200) feed.removeChild(feed.lastChild);
        } catch {}
      };
    }
    connectWs();

    // Squads loader
    async function loadSquads() {
      const s = await load('/squads');
      if (s && s.squads) {
        if (s.squads.length === 0) {
          H('#squads-data').innerHTML = '<p style="color:#555">No squads created yet</p>';
        } else {
          H('#squads-data').innerHTML = s.squads.map(sq =>
            kv(sq.name, sq.memberIds.length + ' members')
          ).join('');
        }
      }
    }
    loadSquads();
    setInterval(loadSquads, 15000);
  </script>
</body>
</html>`;
}
