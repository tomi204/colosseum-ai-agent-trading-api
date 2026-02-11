/**
 * Strategy Tournament Service.
 *
 * Lets multiple strategies compete head-to-head against the same price history.
 * Each strategy runs an independent backtest; results are ranked side-by-side.
 */

import { v4 as uuid } from 'uuid';
import { BacktestService, BacktestResult } from './backtestService.js';
import { DomainError, ErrorCode } from '../errors/taxonomy.js';
import { eventBus } from '../infra/eventBus.js';
import { StateStore } from '../infra/storage/stateStore.js';
import { isoNow } from '../utils/time.js';

export type TournamentStatus = 'pending' | 'running' | 'completed' | 'failed';

export interface TournamentConfig {
  name: string;
  strategyIds: string[];
  symbol?: string;
  priceHistory: number[];
  startingCapitalUsd: number;
}

export interface TournamentEntry {
  strategyId: string;
  totalReturnPct: number;
  sharpeRatio: number;
  maxDrawdownPct: number;
  winRate: number;
  tradeCount: number;
  rank: number;
}

export interface Tournament {
  id: string;
  name: string;
  strategyIds: string[];
  symbol: string;
  priceHistory: number[];
  startingCapitalUsd: number;
  status: TournamentStatus;
  entries: TournamentEntry[];
  winner: TournamentEntry | null;
  createdAt: string;
  completedAt: string | null;
  error: string | null;
}

export class TournamentService {
  constructor(
    private readonly store: StateStore,
    private readonly backtestService: BacktestService,
  ) {}

  /**
   * Create a new tournament. Does not run it — call runTournament to execute.
   */
  async createTournament(config: TournamentConfig): Promise<Tournament> {
    if (!config.name || config.name.trim().length < 2) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Tournament name must be at least 2 characters.');
    }
    if (!config.strategyIds || config.strategyIds.length < 2) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'At least 2 strategyIds are required.');
    }
    if (!config.priceHistory || config.priceHistory.length < 2) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'priceHistory must contain at least 2 data points.');
    }
    if (!config.startingCapitalUsd || config.startingCapitalUsd <= 0) {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'startingCapitalUsd must be positive.');
    }

    const tournament: Tournament = {
      id: uuid(),
      name: config.name.trim(),
      strategyIds: [...config.strategyIds],
      symbol: (config.symbol ?? 'SOL').toUpperCase(),
      priceHistory: [...config.priceHistory],
      startingCapitalUsd: config.startingCapitalUsd,
      status: 'pending',
      entries: [],
      winner: null,
      createdAt: isoNow(),
      completedAt: null,
      error: null,
    };

    await this.store.transaction((state) => {
      state.tournaments[tournament.id] = tournament;
    });

    eventBus.emit('tournament.created', {
      tournamentId: tournament.id,
      name: tournament.name,
      strategyIds: tournament.strategyIds,
    });

    return structuredClone(tournament);
  }

  /**
   * Execute a tournament — run all strategies against the same price history.
   */
  async runTournament(tournamentId: string): Promise<Tournament> {
    const state = this.store.snapshot();
    const tournament = state.tournaments[tournamentId];

    if (!tournament) {
      throw new DomainError(ErrorCode.TournamentNotFound, 404, `Tournament '${tournamentId}' not found.`);
    }

    if (tournament.status === 'running') {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Tournament is already running.');
    }

    if (tournament.status === 'completed') {
      throw new DomainError(ErrorCode.InvalidPayload, 400, 'Tournament has already completed. Create a new one.');
    }

    // Mark as running
    await this.store.transaction((s) => {
      s.tournaments[tournamentId].status = 'running';
    });

    try {
      const entries: TournamentEntry[] = [];

      for (const strategyId of tournament.strategyIds) {
        const result: BacktestResult = this.backtestService.run({
          strategyId,
          symbol: tournament.symbol,
          priceHistory: tournament.priceHistory,
          startingCapitalUsd: tournament.startingCapitalUsd,
        });

        entries.push({
          strategyId,
          totalReturnPct: result.totalReturnPct,
          sharpeRatio: result.sharpeRatio,
          maxDrawdownPct: result.maxDrawdownPct,
          winRate: result.winRate,
          tradeCount: result.tradeCount,
          rank: 0, // will be set below
        });
      }

      // Rank by Sharpe ratio (desc), tiebreak by total return (desc)
      entries.sort((a, b) => {
        if (b.sharpeRatio !== a.sharpeRatio) return b.sharpeRatio - a.sharpeRatio;
        return b.totalReturnPct - a.totalReturnPct;
      });

      for (let i = 0; i < entries.length; i++) {
        entries[i].rank = i + 1;
      }

      const winner = entries.length > 0 ? structuredClone(entries[0]) : null;

      await this.store.transaction((s) => {
        s.tournaments[tournamentId].status = 'completed';
        s.tournaments[tournamentId].entries = entries;
        s.tournaments[tournamentId].winner = winner;
        s.tournaments[tournamentId].completedAt = isoNow();
      });

      eventBus.emit('tournament.completed', {
        tournamentId,
        winner: winner?.strategyId ?? null,
        entryCount: entries.length,
      });

      return structuredClone(this.store.snapshot().tournaments[tournamentId]);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      await this.store.transaction((s) => {
        s.tournaments[tournamentId].status = 'failed';
        s.tournaments[tournamentId].error = errorMessage;
      });

      throw err;
    }
  }

  /**
   * Get tournament results by ID.
   */
  getTournamentResults(tournamentId: string): Tournament | null {
    const state = this.store.snapshot();
    return state.tournaments[tournamentId] ?? null;
  }

  /**
   * List all tournaments.
   */
  listTournaments(): Tournament[] {
    const state = this.store.snapshot();
    return Object.values(state.tournaments)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
