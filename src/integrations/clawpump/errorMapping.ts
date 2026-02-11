import { DomainError, ErrorCode } from '../../errors/taxonomy.js';

export type ClawpumpOperation = 'launch' | 'health' | 'earnings';

export class ClawpumpConfigError extends Error {
  constructor(message: string, public readonly details?: Record<string, unknown>) {
    super(message);
    this.name = 'ClawpumpConfigError';
  }
}

export class ClawpumpHttpError extends Error {
  constructor(
    public readonly operation: ClawpumpOperation,
    public readonly statusCode: number,
    public readonly bodyText: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`clawpump ${operation} failed with status ${statusCode}`);
    this.name = 'ClawpumpHttpError';
  }
}

export class ClawpumpNetworkError extends Error {
  constructor(
    public readonly operation: ClawpumpOperation,
    message: string,
  ) {
    super(message);
    this.name = 'ClawpumpNetworkError';
  }
}

const summarizeUpstreamBody = (raw: string): string | undefined => {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const message = parsed.message ?? parsed.error ?? parsed.detail;
    if (typeof message === 'string' && message.trim()) {
      return message.slice(0, 300);
    }
    return trimmed.slice(0, 300);
  } catch {
    return trimmed.slice(0, 300);
  }
};

export const mapClawpumpError = (error: unknown, operation: ClawpumpOperation): DomainError => {
  if (error instanceof DomainError) {
    return error;
  }

  if (error instanceof ClawpumpConfigError) {
    return new DomainError(
      ErrorCode.IntegrationMisconfigured,
      503,
      'Token revenue integration is misconfigured.',
      {
        operation,
        action: 'Set CLAWPUMP_BASE_URL and CLAWPUMP_WALLET_ADDRESS, then retry.',
        ...(error.details ?? {}),
      },
    );
  }

  if (error instanceof ClawpumpHttpError) {
    const upstreamMessage = summarizeUpstreamBody(error.bodyText);

    if (error.statusCode === 429) {
      return new DomainError(
        ErrorCode.UpstreamRateLimited,
        429,
        'clawpump rate limit reached.',
        {
          operation,
          retryAfterSeconds: error.retryAfterSeconds,
          action: 'Back off and retry with exponential delay.',
          upstreamMessage,
        },
      );
    }

    if (error.statusCode === 400 || error.statusCode === 422) {
      return new DomainError(
        ErrorCode.InvalidPayload,
        400,
        `clawpump rejected the ${operation} payload.`,
        {
          operation,
          upstreamStatus: error.statusCode,
          upstreamMessage,
          action: 'Review required fields (name, symbol, description, walletAddress, and optional links/image).',
        },
      );
    }

    if (error.statusCode === 401 || error.statusCode === 403) {
      return new DomainError(
        ErrorCode.IntegrationMisconfigured,
        502,
        'clawpump authentication failed.',
        {
          operation,
          upstreamStatus: error.statusCode,
          action: 'Verify CLAWPUMP_API_KEY and upstream access policy.',
          upstreamMessage,
        },
      );
    }

    if (error.statusCode >= 500) {
      return new DomainError(
        ErrorCode.IntegrationUnavailable,
        503,
        'clawpump service is temporarily unavailable.',
        {
          operation,
          upstreamStatus: error.statusCode,
          action: 'Retry shortly or check upstream health endpoint.',
          upstreamMessage,
        },
      );
    }

    return new DomainError(
      ErrorCode.IntegrationUnavailable,
      502,
      'Unexpected clawpump upstream response.',
      {
        operation,
        upstreamStatus: error.statusCode,
        action: 'Inspect upstream response and request payload.',
        upstreamMessage,
      },
    );
  }

  if (error instanceof ClawpumpNetworkError) {
    return new DomainError(
      ErrorCode.IntegrationUnavailable,
      503,
      'Unable to reach clawpump service.',
      {
        operation,
        action: 'Check network connectivity and CLAWPUMP_BASE_URL.',
      },
    );
  }

  if (error instanceof Error && error.name === 'AbortError') {
    return new DomainError(
      ErrorCode.IntegrationUnavailable,
      504,
      'clawpump request timed out.',
      {
        operation,
        action: 'Retry request or increase CLAWPUMP_TIMEOUT_MS if upstream is slow.',
      },
    );
  }

  return new DomainError(
    ErrorCode.InternalError,
    500,
    'Unexpected token revenue integration error.',
    {
      operation,
      error: String(error),
    },
  );
};
