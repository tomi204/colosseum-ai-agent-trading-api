// ─── TradingAPIClient ──────────────────────────────────────────────────────
// Lightweight, zero-dependency SDK client for the Colosseum AI-Agent Trading API.
// Works in Node.js 18+ (uses native fetch). Copy-paste friendly.
// ────────────────────────────────────────────────────────────────────────────

import type {
  Agent,
  APIErrorEnvelope,
  AutonomousStatus,
  ExecutionRecord,
  ExecutionReceipt,
  HealthResponse,
  MetricsResponse,
  Portfolio,
  ReceiptVerification,
  RegisterAgentOpts,
  RegisterAgentResponse,
  RiskTelemetry,
  TradeIntent,
  TradeIntentInput,
  TradeIntentResult,
} from './types.js';

export class TradingAPIError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'TradingAPIError';
  }
}

export interface TradingAPIClientOptions {
  /** Base URL of the API server (e.g. "http://localhost:3000"). */
  baseUrl: string;
  /** Agent API key (required for authenticated endpoints like trade-intents). */
  apiKey?: string;
  /** Optional custom fetch implementation (defaults to globalThis.fetch). */
  fetch?: typeof globalThis.fetch;
}

export class TradingAPIClient {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly _fetch: typeof globalThis.fetch;

  constructor(baseUrl: string, apiKey?: string);
  constructor(opts: TradingAPIClientOptions);
  constructor(baseUrlOrOpts: string | TradingAPIClientOptions, apiKey?: string) {
    if (typeof baseUrlOrOpts === 'string') {
      this.baseUrl = baseUrlOrOpts.replace(/\/+$/, '');
      this.apiKey = apiKey;
      this._fetch = globalThis.fetch;
    } else {
      this.baseUrl = baseUrlOrOpts.baseUrl.replace(/\/+$/, '');
      this.apiKey = baseUrlOrOpts.apiKey;
      this._fetch = baseUrlOrOpts.fetch ?? globalThis.fetch;
    }
  }

  // ─── Internal helpers ──────────────────────────────────────────────────

  private headers(extra?: Record<string, string>): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.apiKey) h['authorization'] = `Bearer ${this.apiKey}`;
    return { ...h, ...extra };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await this._fetch(url, {
      method,
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let errorBody: APIErrorEnvelope | undefined;
      try {
        errorBody = (await res.json()) as APIErrorEnvelope;
      } catch {
        // response body may not be JSON
      }
      throw new TradingAPIError(
        res.status,
        errorBody?.error?.code ?? `HTTP_${res.status}`,
        errorBody?.error?.message ?? `Request failed: ${method} ${path} → ${res.status}`,
        errorBody?.error?.details,
      );
    }

    // For 204 No Content
    if (res.status === 204) return undefined as T;

    return (await res.json()) as T;
  }

  private get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>('POST', path, body);
  }

  // ─── Agent Management ──────────────────────────────────────────────────

  /**
   * Register a new trading agent.
   * Returns the agent details and a one-time API key.
   */
  async registerAgent(opts: RegisterAgentOpts): Promise<RegisterAgentResponse> {
    return this.post<RegisterAgentResponse>('/agents/register', opts);
  }

  /** Get agent details by ID. */
  async getAgent(agentId: string): Promise<Agent> {
    return this.get<Agent>(`/agents/${encodeURIComponent(agentId)}`);
  }

  /** Get the full portfolio snapshot for an agent. */
  async getPortfolio(agentId: string): Promise<Portfolio> {
    return this.get<Portfolio>(`/agents/${encodeURIComponent(agentId)}/portfolio`);
  }

  /** Get live risk telemetry for an agent. */
  async getRiskTelemetry(agentId: string): Promise<RiskTelemetry> {
    return this.get<RiskTelemetry>(`/agents/${encodeURIComponent(agentId)}/risk-telemetry`);
  }

  // ─── Trading ───────────────────────────────────────────────────────────

  /**
   * Submit a trade intent. Requires API key authentication.
   * Supports idempotency via the `idempotencyKey` option.
   */
  async submitIntent(intent: TradeIntentInput, opts?: { idempotencyKey?: string }): Promise<TradeIntentResult> {
    const extra: Record<string, string> = {};
    if (opts?.idempotencyKey) extra['x-idempotency-key'] = opts.idempotencyKey;

    const url = `${this.baseUrl}/trade-intents`;
    const res = await this._fetch(url, {
      method: 'POST',
      headers: this.headers(extra),
      body: JSON.stringify(intent),
    });

    if (!res.ok) {
      let errorBody: APIErrorEnvelope | undefined;
      try {
        errorBody = (await res.json()) as APIErrorEnvelope;
      } catch {
        // ignore
      }
      throw new TradingAPIError(
        res.status,
        errorBody?.error?.code ?? `HTTP_${res.status}`,
        errorBody?.error?.message ?? `submitIntent failed: ${res.status}`,
        errorBody?.error?.details,
      );
    }

    return (await res.json()) as TradeIntentResult;
  }

  /** Get a trade intent by ID. */
  async getIntent(intentId: string): Promise<TradeIntent> {
    return this.get<TradeIntent>(`/trade-intents/${encodeURIComponent(intentId)}`);
  }

  // ─── Market Data ──────────────────────────────────────────────────────

  /** Update the market price for a symbol (used in paper-trading mode). */
  async updatePrice(symbol: string, priceUsd: number): Promise<void> {
    await this.post('/market/prices', { symbol, priceUsd });
  }

  // ─── Executions ───────────────────────────────────────────────────────

  /** List executions. Optionally filter by agentId and limit. */
  async getExecutions(opts?: { agentId?: string; limit?: number }): Promise<ExecutionRecord[]> {
    const params = new URLSearchParams();
    if (opts?.agentId) params.set('agentId', opts.agentId);
    if (opts?.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    const path = `/executions${qs ? `?${qs}` : ''}`;

    const result = await this.get<{ executions: ExecutionRecord[] }>(path);
    return result.executions;
  }

  /** Get the cryptographic receipt for an execution. */
  async getReceipt(executionId: string): Promise<ExecutionReceipt> {
    const result = await this.get<{ executionId: string; receipt: ExecutionReceipt }>(
      `/executions/${encodeURIComponent(executionId)}/receipt`,
    );
    return result.receipt;
  }

  /** Verify a receipt's integrity via the server-side verification endpoint. */
  async verifyReceipt(executionId: string): Promise<ReceiptVerification> {
    return this.get<ReceiptVerification>(
      `/receipts/verify/${encodeURIComponent(executionId)}`,
    );
  }

  // ─── Autonomous Loop ──────────────────────────────────────────────────

  /** Get the current autonomous trading loop status. */
  async getAutonomousStatus(): Promise<AutonomousStatus> {
    return this.get<AutonomousStatus>('/autonomous/status');
  }

  /** Enable or disable the autonomous trading loop. */
  async toggleAutonomous(enabled: boolean): Promise<AutonomousStatus> {
    const result = await this.post<{ ok: boolean; autonomous: AutonomousStatus }>(
      '/autonomous/toggle',
      { enabled },
    );
    return result.autonomous;
  }

  // ─── System ───────────────────────────────────────────────────────────

  /** Health check. */
  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/health');
  }

  /** Get runtime metrics, treasury, and monetization data. */
  async metrics(): Promise<MetricsResponse> {
    return this.get<MetricsResponse>('/metrics');
  }
}
