import { v4 as uuid } from 'uuid';
import { AppConfig } from '../config.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { ClawpumpClient, ClawpumpLaunchInput } from '../integrations/clawpump/client.js';
import { mapClawpumpError } from '../integrations/clawpump/errorMapping.js';
import { WalletPublicMetadata, resolveRuntimeWalletPublicMetadata } from '../integrations/clawpump/wallet.js';
import { EventLogger } from '../infra/logger.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { ClawpumpLaunchAttempt } from '../types.js';
import { isoNow } from '../utils/time.js';

export interface LaunchTokenRequest {
  name: string;
  symbol: string;
  description: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  imagePath?: string;
}

const sanitizeLaunchInput = (input: LaunchTokenRequest): ClawpumpLaunchAttempt['request'] => ({
  name: input.name,
  symbol: input.symbol,
  description: input.description,
  website: input.website,
  twitter: input.twitter,
  telegram: input.telegram,
  imagePath: input.imagePath,
});

export class TokenRevenueService {
  constructor(
    private readonly store: StateStore,
    private readonly logger: EventLogger,
    private readonly client: ClawpumpClient,
    private readonly config: AppConfig,
  ) {}

  getWalletMetadata(): WalletPublicMetadata {
    return resolveRuntimeWalletPublicMetadata(process.env);
  }

  async health(): Promise<{
    integration: 'clawpump';
    status: 'ok';
    wallet: WalletPublicMetadata;
    upstream: unknown;
  }> {
    const wallet = this.getWalletMetadata();

    try {
      const upstream = await this.client.health();
      return {
        integration: 'clawpump',
        status: 'ok',
        wallet,
        upstream,
      };
    } catch (error) {
      throw mapClawpumpError(error, 'health');
    }
  }

  async earnings(agentId: string): Promise<{
    integration: 'clawpump';
    agentId: string;
    wallet: WalletPublicMetadata;
    upstream: unknown;
  }> {
    const normalizedAgentId = agentId.trim();
    if (!normalizedAgentId) {
      throw new DomainError(
        ErrorCode.InvalidPayload,
        400,
        'agentId query param is required.',
      );
    }

    try {
      const upstream = await this.client.earnings(normalizedAgentId);
      return {
        integration: 'clawpump',
        agentId: normalizedAgentId,
        wallet: this.getWalletMetadata(),
        upstream,
      };
    } catch (error) {
      throw mapClawpumpError(error, 'earnings');
    }
  }

  async launch(payload: LaunchTokenRequest): Promise<{
    integration: 'clawpump';
    wallet: WalletPublicMetadata;
    upstream: unknown;
    launchAttemptId: string;
  }> {
    const wallet = this.getWalletMetadata();

    if (!wallet.configured || !wallet.address) {
      throw new DomainError(
        ErrorCode.IntegrationMisconfigured,
        503,
        'CLAWPUMP_WALLET_ADDRESS must be configured before launching a token.',
        {
          action: 'Set CLAWPUMP_WALLET_ADDRESS in environment (public address only).',
        },
      );
    }

    const attemptId = uuid();
    const requestShape = sanitizeLaunchInput(payload);

    const launchPayload: ClawpumpLaunchInput = {
      ...payload,
      walletAddress: wallet.address,
    };

    try {
      const upstream = await this.client.launch(launchPayload);

      await this.persistLaunchAttempt({
        id: attemptId,
        ts: isoNow(),
        status: 'success',
        request: requestShape,
        walletAddress: wallet.address,
      });

      await this.logger.log('info', 'clawpump.launch.success', {
        integration: 'clawpump',
        launchAttemptId: attemptId,
        symbol: payload.symbol,
      });

      return {
        integration: 'clawpump',
        wallet,
        upstream,
        launchAttemptId: attemptId,
      };
    } catch (error) {
      const mapped = mapClawpumpError(error, 'launch');

      await this.persistLaunchAttempt({
        id: attemptId,
        ts: isoNow(),
        status: 'failed',
        request: requestShape,
        walletAddress: wallet.address,
        errorCode: mapped.code,
        errorMessage: mapped.message,
        errorDetails: mapped.details,
      });

      await this.logger.log('error', 'clawpump.launch.failed', {
        integration: 'clawpump',
        launchAttemptId: attemptId,
        errorCode: mapped.code,
        statusCode: mapped.statusCode,
      });

      throw mapped;
    }
  }

  listLaunchAttempts(limit = 20): ClawpumpLaunchAttempt[] {
    const safeLimit = Math.min(Math.max(limit, 1), 200);
    const snapshot = this.store.snapshot();
    return snapshot.tokenRevenue.clawpumpLaunchAttempts.slice(0, safeLimit);
  }

  private async persistLaunchAttempt(attempt: ClawpumpLaunchAttempt): Promise<void> {
    await this.store.transaction((state) => {
      const existing = state.tokenRevenue?.clawpumpLaunchAttempts ?? [];
      const next = [attempt, ...existing].slice(0, this.config.tokenRevenue.launchAttemptHistoryLimit);
      state.tokenRevenue = {
        clawpumpLaunchAttempts: next,
      };
      return undefined;
    });
  }
}
