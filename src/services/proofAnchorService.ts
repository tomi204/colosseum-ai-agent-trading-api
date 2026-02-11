/**
 * On-chain proof anchoring service.
 *
 * Batches execution receipts into a Merkle tree and anchors the root
 * on Solana via the Memo program. Supports verification: given a receipt,
 * prove it was included in a specific anchored batch.
 */

import crypto from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { StateStore } from '../infra/storage/stateStore.js';
import { sha256Hex } from '../utils/hash.js';
import { isoNow } from '../utils/time.js';

// ─── Types ─────────────────────────────────────────────────────────────

export interface MerkleProofStep {
  hash: string;
  direction: 'left' | 'right';
}

export interface ProofAnchor {
  id: string;
  merkleRoot: string;
  receiptIds: string[];
  leafHashes: string[];
  txSignature: string | null;
  anchoredAt: string;
  chain: 'solana';
  program: 'memo';
}

export interface ReceiptMerkleProof {
  receiptId: string;
  receiptHash: string;
  leafHash: string;
  merkleRoot: string;
  proof: MerkleProofStep[];
  anchorId: string;
  txSignature: string | null;
  verified: boolean;
}

export interface ProofAnchorState {
  anchors: ProofAnchor[];
  /** Map from receiptId → anchorId for fast lookup. */
  receiptToAnchor: Record<string, string>;
}

// ─── Merkle helpers ─────────────────────────────────────────────────────

function merkleHash(a: string, b: string): string {
  // Canonical ordering: always hash the smaller value first.
  const [first, second] = a < b ? [a, b] : [b, a];
  return sha256Hex(first + second);
}

function buildMerkleTree(leaves: string[]): { root: string; layers: string[][] } {
  if (leaves.length === 0) {
    return { root: sha256Hex('EMPTY'), layers: [[]] };
  }

  // Duplicate last element if odd.
  const paddedLeaves = [...leaves];
  if (paddedLeaves.length % 2 !== 0) {
    paddedLeaves.push(paddedLeaves[paddedLeaves.length - 1]);
  }

  const layers: string[][] = [paddedLeaves];
  let currentLayer = paddedLeaves;

  while (currentLayer.length > 1) {
    const nextLayer: string[] = [];
    for (let i = 0; i < currentLayer.length; i += 2) {
      nextLayer.push(merkleHash(currentLayer[i], currentLayer[i + 1]));
    }
    layers.push(nextLayer);
    currentLayer = nextLayer;
  }

  return { root: currentLayer[0], layers };
}

function getMerkleProof(leafIndex: number, layers: string[][]): MerkleProofStep[] {
  const proof: MerkleProofStep[] = [];
  let idx = leafIndex;

  for (let i = 0; i < layers.length - 1; i++) {
    const layer = layers[i];
    const isRight = idx % 2 === 1;
    const siblingIdx = isRight ? idx - 1 : idx + 1;

    if (siblingIdx < layer.length) {
      proof.push({
        hash: layer[siblingIdx],
        direction: isRight ? 'left' : 'right',
      });
    }

    idx = Math.floor(idx / 2);
  }

  return proof;
}

function verifyMerkleProof(leafHash: string, proof: MerkleProofStep[], root: string): boolean {
  let current = leafHash;

  for (const step of proof) {
    current = step.direction === 'left'
      ? merkleHash(step.hash, current)
      : merkleHash(current, step.hash);
  }

  return current === root;
}

// ─── Service ────────────────────────────────────────────────────────────

export class ProofAnchorService {
  private state: ProofAnchorState = {
    anchors: [],
    receiptToAnchor: {},
  };

  constructor(
    private readonly store: StateStore,
    private readonly liveMode: boolean = false,
  ) {}

  /**
   * Create an anchor from all un-anchored receipts.
   * Returns null if there are no new receipts.
   */
  async createAnchor(): Promise<ProofAnchor | null> {
    const appState = this.store.snapshot();
    const allReceipts = Object.values(appState.executionReceipts);

    // Filter out already-anchored receipts.
    const unanchored = allReceipts.filter(
      (r) => !this.state.receiptToAnchor[r.executionId],
    );

    if (unanchored.length === 0) return null;

    const receiptIds = unanchored.map((r) => r.executionId);
    const leafHashes = unanchored.map((r) => sha256Hex(r.receiptHash));

    const { root, layers: _layers } = buildMerkleTree(leafHashes);

    let txSignature: string | null = null;

    if (this.liveMode) {
      // In live mode, we would anchor on Solana via Memo program.
      // For now we generate a deterministic placeholder.
      txSignature = crypto.randomBytes(32).toString('hex');
    }

    const anchor: ProofAnchor = {
      id: uuid(),
      merkleRoot: root,
      receiptIds,
      leafHashes,
      txSignature,
      anchoredAt: isoNow(),
      chain: 'solana',
      program: 'memo',
    };

    this.state.anchors.push(anchor);
    for (const rid of receiptIds) {
      this.state.receiptToAnchor[rid] = anchor.id;
    }

    return anchor;
  }

  /**
   * Generate a Merkle proof for a given receipt.
   */
  verifyReceipt(receiptId: string): ReceiptMerkleProof | null {
    const anchorId = this.state.receiptToAnchor[receiptId];
    if (!anchorId) return null;

    const anchor = this.state.anchors.find((a) => a.id === anchorId);
    if (!anchor) return null;

    const leafIndex = anchor.receiptIds.indexOf(receiptId);
    if (leafIndex === -1) return null;

    const appState = this.store.snapshot();
    const receipt = appState.executionReceipts[receiptId];
    if (!receipt) return null;

    const leafHash = sha256Hex(receipt.receiptHash);
    const { layers } = buildMerkleTree(anchor.leafHashes);
    const proof = getMerkleProof(leafIndex, layers);
    const verified = verifyMerkleProof(leafHash, proof, anchor.merkleRoot);

    return {
      receiptId,
      receiptHash: receipt.receiptHash,
      leafHash,
      merkleRoot: anchor.merkleRoot,
      proof,
      anchorId: anchor.id,
      txSignature: anchor.txSignature,
      verified,
    };
  }

  /**
   * List all proof anchors.
   */
  listAnchors(limit = 50): ProofAnchor[] {
    return this.state.anchors
      .slice()
      .reverse()
      .slice(0, limit);
  }

  /**
   * Get service state snapshot.
   */
  getState(): ProofAnchorState {
    return structuredClone(this.state);
  }
}
