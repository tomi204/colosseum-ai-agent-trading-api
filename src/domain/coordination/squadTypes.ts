/**
 * Types for multi-agent squad coordination.
 */

export interface SharedRiskLimits {
  /** Maximum combined gross exposure across all squad members (USD). */
  maxSquadExposureUsd: number;
  /** Maximum per-member position size as a fraction of squad equity. */
  maxMemberPositionPct: number;
}

export interface Squad {
  id: string;
  name: string;
  leaderId: string;
  memberIds: string[];
  sharedLimits: SharedRiskLimits;
  createdAt: string;
  updatedAt: string;
}

export type CoordinationMessageType =
  | 'position_update'
  | 'risk_limit_change'
  | 'trade_signal'
  | 'collision_warning';

export interface CoordinationMessage {
  id: string;
  fromAgentId: string;
  toSquadId: string;
  type: CoordinationMessageType;
  payload: Record<string, unknown>;
  createdAt: string;
}
