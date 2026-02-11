import { v4 as uuid } from 'uuid';
import { isoNow } from '../../utils/time.js';

// ─── Stage definitions ──────────────────────────────────────────────────────

export type PipelineStage = 'quote' | 'validate' | 'build' | 'simulate' | 'send' | 'confirm';

export type ErrorClassification = 'transient' | 'permanent' | 'timeout';

export type StageStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

export interface StageConfig {
  timeoutMs: number;
  maxRetries: number;
  retryDelayMs: number;
}

export interface StageMetrics {
  attempts: number;
  durationMs: number | null;
  successCount: number;
  failureCount: number;
}

export interface StageRecord {
  stage: PipelineStage;
  status: StageStatus;
  startedAt: string | null;
  completedAt: string | null;
  errorMessage: string | null;
  errorClassification: ErrorClassification | null;
  metrics: StageMetrics;
  result: unknown | null;
}

export interface PipelineRecord {
  id: string;
  intentId: string;
  agentId: string;
  stages: StageRecord[];
  currentStage: PipelineStage | null;
  status: 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt: string | null;
  totalDurationMs: number | null;
}

// ─── Default stage configs ──────────────────────────────────────────────────

const DEFAULT_STAGE_CONFIGS: Record<PipelineStage, StageConfig> = {
  quote: { timeoutMs: 10_000, maxRetries: 3, retryDelayMs: 200 },
  validate: { timeoutMs: 5_000, maxRetries: 1, retryDelayMs: 0 },
  build: { timeoutMs: 10_000, maxRetries: 2, retryDelayMs: 300 },
  simulate: { timeoutMs: 15_000, maxRetries: 2, retryDelayMs: 500 },
  send: { timeoutMs: 30_000, maxRetries: 2, retryDelayMs: 1_000 },
  confirm: { timeoutMs: 60_000, maxRetries: 3, retryDelayMs: 2_000 },
};

const STAGE_ORDER: PipelineStage[] = ['quote', 'validate', 'build', 'simulate', 'send', 'confirm'];

// ─── Error classification ───────────────────────────────────────────────────

export function classifyError(error: unknown): ErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  // Timeout errors → retry with fresh blockhash
  if (lower.includes('timeout') || lower.includes('blockhash') || lower.includes('timed out')) {
    return 'timeout';
  }

  // Permanent errors → reject immediately
  if (
    lower.includes('insufficient') ||
    lower.includes('invalid_payload') ||
    lower.includes('invalid_price') ||
    lower.includes('unsupported') ||
    lower.includes('not_found') ||
    lower.includes('unauthorized')
  ) {
    return 'permanent';
  }

  // Everything else is transient → retry
  return 'transient';
}

// ─── Pipeline execution context ─────────────────────────────────────────────

export type StageHandler = (context: PipelineContext) => Promise<unknown>;

export interface PipelineContext {
  intentId: string;
  agentId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  priceUsd: number;
  notionalUsd: number;
  stageResults: Record<string, unknown>;
  /** Refresh blockhash callback for timeout retries */
  refreshBlockhash?: () => Promise<string>;
}

// ─── Staged pipeline ────────────────────────────────────────────────────────

export class StagedPipeline {
  private readonly stageConfigs: Record<PipelineStage, StageConfig>;
  private readonly handlers: Map<PipelineStage, StageHandler> = new Map();
  private readonly pipelines: Map<string, PipelineRecord> = new Map();

  /** Global stage-level metrics (aggregated across all pipeline runs) */
  private readonly globalStageMetrics: Record<PipelineStage, StageMetrics>;

  constructor(configOverrides?: Partial<Record<PipelineStage, Partial<StageConfig>>>) {
    this.stageConfigs = { ...DEFAULT_STAGE_CONFIGS };
    if (configOverrides) {
      for (const [stage, overrides] of Object.entries(configOverrides)) {
        const stageKey = stage as PipelineStage;
        this.stageConfigs[stageKey] = { ...DEFAULT_STAGE_CONFIGS[stageKey], ...overrides };
      }
    }

    this.globalStageMetrics = Object.fromEntries(
      STAGE_ORDER.map((stage) => [stage, { attempts: 0, durationMs: null, successCount: 0, failureCount: 0 }]),
    ) as Record<PipelineStage, StageMetrics>;
  }

  registerHandler(stage: PipelineStage, handler: StageHandler): void {
    this.handlers.set(stage, handler);
  }

  getPipeline(pipelineId: string): PipelineRecord | undefined {
    return this.pipelines.get(pipelineId);
  }

  getGlobalStageMetrics(): Record<PipelineStage, StageMetrics> {
    return structuredClone(this.globalStageMetrics);
  }

  async execute(context: PipelineContext): Promise<PipelineRecord> {
    const pipelineId = uuid();
    const startedAt = isoNow();
    const startMs = Date.now();

    const stages: StageRecord[] = STAGE_ORDER.map((stage) => ({
      stage,
      status: 'pending' as StageStatus,
      startedAt: null,
      completedAt: null,
      errorMessage: null,
      errorClassification: null,
      metrics: { attempts: 0, durationMs: null, successCount: 0, failureCount: 0 },
      result: null,
    }));

    const pipeline: PipelineRecord = {
      id: pipelineId,
      intentId: context.intentId,
      agentId: context.agentId,
      stages,
      currentStage: null,
      status: 'running',
      startedAt,
      completedAt: null,
      totalDurationMs: null,
    };

    this.pipelines.set(pipelineId, pipeline);

    for (const stageRecord of stages) {
      const handler = this.handlers.get(stageRecord.stage);
      if (!handler) {
        stageRecord.status = 'skipped';
        continue;
      }

      pipeline.currentStage = stageRecord.stage;
      const stageConfig = this.stageConfigs[stageRecord.stage];
      const stageStartMs = Date.now();
      stageRecord.startedAt = isoNow();
      stageRecord.status = 'running';

      let lastError: unknown = null;
      let succeeded = false;

      for (let attempt = 0; attempt <= stageConfig.maxRetries; attempt++) {
        stageRecord.metrics.attempts += 1;
        this.globalStageMetrics[stageRecord.stage].attempts += 1;

        try {
          const result = await this.executeWithTimeout(
            () => handler(context),
            stageConfig.timeoutMs,
          );

          stageRecord.result = result;
          context.stageResults[stageRecord.stage] = result;
          succeeded = true;
          break;
        } catch (error) {
          lastError = error;
          const classification = classifyError(error);

          if (classification === 'permanent') {
            stageRecord.errorClassification = 'permanent';
            break;
          }

          if (classification === 'timeout' && context.refreshBlockhash) {
            try {
              await context.refreshBlockhash();
            } catch {
              // ignore blockhash refresh failures
            }
          }

          stageRecord.errorClassification = classification;

          if (attempt < stageConfig.maxRetries) {
            await this.sleep(stageConfig.retryDelayMs * (attempt + 1));
          }
        }
      }

      const stageDurationMs = Date.now() - stageStartMs;
      stageRecord.metrics.durationMs = stageDurationMs;

      const globalMetric = this.globalStageMetrics[stageRecord.stage];
      globalMetric.durationMs = (globalMetric.durationMs ?? 0) + stageDurationMs;

      if (succeeded) {
        stageRecord.status = 'completed';
        stageRecord.completedAt = isoNow();
        stageRecord.metrics.successCount = 1;
        globalMetric.successCount += 1;
      } else {
        stageRecord.status = 'failed';
        stageRecord.completedAt = isoNow();
        stageRecord.errorMessage = lastError instanceof Error ? lastError.message : String(lastError);
        stageRecord.metrics.failureCount = 1;
        globalMetric.failureCount += 1;

        pipeline.status = 'failed';
        pipeline.completedAt = isoNow();
        pipeline.totalDurationMs = Date.now() - startMs;

        // Mark remaining stages as skipped
        for (const remaining of stages) {
          if (remaining.status === 'pending') {
            remaining.status = 'skipped';
          }
        }

        return pipeline;
      }
    }

    pipeline.status = 'completed';
    pipeline.currentStage = null;
    pipeline.completedAt = isoNow();
    pipeline.totalDurationMs = Date.now() - startMs;

    return pipeline;
  }

  private executeWithTimeout<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Stage timed out after ${timeoutMs}ms`)), timeoutMs);
      work()
        .then((result) => {
          clearTimeout(timer);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
