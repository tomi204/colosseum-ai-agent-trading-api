import { ExecutionReceipt } from '../../types.js';
import { hashObject, sha256Hex } from '../../utils/hash.js';

const REDACTED = '[REDACTED]' as unknown as number;

export interface RedactedReceipt {
  version: ExecutionReceipt['version'];
  executionId: string;
  redacted: true;
  payload: {
    executionId: string;
    intentId: string;
    agentId: string;
    symbol: string;
    side: string;
    quantity: typeof REDACTED;
    priceUsd: typeof REDACTED;
    grossNotionalUsd: typeof REDACTED;
    feeUsd: typeof REDACTED;
    netUsd: typeof REDACTED;
    realizedPnlUsd: typeof REDACTED;
    pnlSnapshotUsd: typeof REDACTED;
    mode: string;
    status: string;
    timestamp: string;
  };
  payloadHash: string;
  prevReceiptHash?: string;
  receiptHash: string;
  createdAt: string;
}

/**
 * Produce a redacted version of an execution receipt.
 *
 * Sensitive numeric fields (quantity, priceUsd, grossNotionalUsd, feeUsd,
 * netUsd, realizedPnlUsd, pnlSnapshotUsd) are replaced with "[REDACTED]".
 *
 * The hash chain stays valid: receiptHash is recomputed over the redacted
 * payload + a `redacted:true` flag so verifiers can distinguish redacted
 * receipts from tampered ones.
 */
export const redactReceipt = (receipt: ExecutionReceipt): RedactedReceipt => {
  const redactedPayload: RedactedReceipt['payload'] = {
    executionId: receipt.payload.executionId,
    intentId: receipt.payload.intentId,
    agentId: receipt.payload.agentId,
    symbol: receipt.payload.symbol,
    side: receipt.payload.side,
    quantity: REDACTED,
    priceUsd: REDACTED,
    grossNotionalUsd: REDACTED,
    feeUsd: REDACTED,
    netUsd: REDACTED,
    realizedPnlUsd: REDACTED,
    pnlSnapshotUsd: REDACTED,
    mode: receipt.payload.mode,
    status: receipt.payload.status,
    timestamp: receipt.payload.timestamp,
  };

  const payloadHash = hashObject({ ...redactedPayload, redacted: true });
  const message = `${receipt.version}|${payloadHash}|${receipt.prevReceiptHash ?? 'GENESIS'}|redacted`;
  const receiptHash = sha256Hex(message);

  return {
    version: receipt.version,
    executionId: receipt.executionId,
    redacted: true,
    payload: redactedPayload,
    payloadHash,
    prevReceiptHash: receipt.prevReceiptHash,
    receiptHash,
    createdAt: receipt.createdAt,
  };
};
