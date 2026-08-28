import type { AllowedNetwork } from "@/domain/vault-policy";

/**
 * Public data sent to an external signing adapter. The returned value remains
 * untrusted and must pass validateSignedVaultPsbt before finalization.
 */
export interface ExternalSignerRequest {
  readonly network: AllowedNetwork;
  readonly unsignedPsbtBase64: string;
}

/** The adapter's untrusted claim that it produced a signed PSBT. */
export interface ExternalSignerResponse {
  readonly signedPsbtBase64: string;
}

/** I/O boundary only; implementations live outside timesats-core. */
export interface ExternalSigner {
  signPsbt(request: ExternalSignerRequest): Promise<ExternalSignerResponse>;
}

/** Minimum public identifier an observer needs to look for a vault deposit. */
export interface ChainObservationTarget {
  readonly depositIndex: number;
  readonly outputScript: string;
}

export interface FindFundingCandidatesRequest {
  readonly network: AllowedNetwork;
  readonly deposits: readonly ChainObservationTarget[];
}

/**
 * Untrusted observation data. It intentionally makes no claim that this
 * outpoint is unspent; callers must pass it to verifyFundingTransaction.
 */
export interface FundingCandidate {
  readonly depositIndex: number;
  readonly rawFundingTransaction: string;
  readonly vout: number;
}

/** I/O boundary only; implementations live outside timesats-core. */
export interface ChainObserver {
  findFundingCandidates(request: FindFundingCandidatesRequest): Promise<readonly FundingCandidate[]>;
}

/** A finalized transaction is passed through unchanged to an external transport. */
export interface TransactionBroadcastRequest {
  readonly network: AllowedNetwork;
  readonly rawTransaction: string;
}

/** Untrusted transport receipt; it has no role in policy or finalization. */
export interface TransactionBroadcastResult {
  readonly txid: string;
}

/** I/O boundary only; implementations live outside timesats-core. */
export interface TransactionBroadcaster {
  broadcast(request: TransactionBroadcastRequest): Promise<TransactionBroadcastResult>;
}
