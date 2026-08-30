import { crypto } from "bitcoinjs-lib";
import { VAULT_POLICY_V2 } from "@/domain/vault-policy";
import {
  HISTORICAL_IDENTITY_COMMITMENT_ALGORITHM,
  HISTORICAL_IDENTITY_COMMITMENT_SCHEME,
  HISTORICAL_IDENTITY_COMMITMENT_VERSION,
  HistoricalIdentityCommitmentV1Schema,
  XpublessV2PlanStateSchema,
  XPUBLESS_V2_KEY_SOURCE_TYPE,
  XPUBLESS_V2_PLAN_STATE_FORMAT,
  XPUBLESS_V2_PLAN_STATE_VERSION,
  serializeHistoricalIdentityPreimageV1,
  type HistoricalIdentityCommitmentV1,
  type HistoricalIdentityMaterialV1,
  type XpublessV2PlanState,
} from "@/domain/xpubless-v2-plan-state";
import { MAX_NON_HARDENED_INDEX, VAULT_PLAN_VERSION, type VaultPlan } from "@/domain/vault-plan";
import { bytesToHex } from "./encoding";
import {
  createVaultPlan,
  deriveDeposit,
  deriveIssuedDeposits,
  parseVaultPlan,
} from "./vault-plan";

type V2VaultPlan = Extract<VaultPlan, { version: 3 }>;

/** The only newly-derived deposit data P2 consumes for a durable append. */
export interface XpublessV2IssuedDepositCommitment {
  index: number;
  outputScript: string;
}

const PLAN_MISMATCH_ERROR = "Presented public key does not match this xpubless plan state.";

function requireV2Plan(planInput: VaultPlan): V2VaultPlan {
  const plan = parseVaultPlan(planInput);
  if (plan.version !== VAULT_PLAN_VERSION || plan.policy.policyVersion !== VAULT_POLICY_V2) {
    throw new Error("Xpubless plan state supports only Policy V2.");
  }
  return plan as V2VaultPlan;
}

function historicalIdentityMaterialFromV2Plan(plan: V2VaultPlan): HistoricalIdentityMaterialV1 {
  return {
    policyVersion: VAULT_POLICY_V2,
    network: plan.policy.network,
    unlockHeight: plan.policy.unlockHeight,
    keySource: {
      type: XPUBLESS_V2_KEY_SOURCE_TYPE,
      extendedPublicKey: plan.policy.keySource.extendedPublicKey,
    },
    keyOrigin: plan.policy.keySource.keyOrigin,
    derivation: plan.policy.derivation,
  };
}

function calculateHistoricalIdentityCommitmentV1(plan: V2VaultPlan): HistoricalIdentityCommitmentV1 {
  // Binding and conditional integrity only; HIC v1 is not authentication or a trust anchor.
  const preimage = serializeHistoricalIdentityPreimageV1(historicalIdentityMaterialFromV2Plan(plan));
  return HistoricalIdentityCommitmentV1Schema.parse({
    scheme: HISTORICAL_IDENTITY_COMMITMENT_SCHEME,
    version: HISTORICAL_IDENTITY_COMMITMENT_VERSION,
    algorithm: HISTORICAL_IDENTITY_COMMITMENT_ALGORITHM,
    digest: bytesToHex(crypto.sha256(new TextEncoder().encode(preimage))),
  });
}

function assertStateMatchesV2Plan(state: XpublessV2PlanState, plan: V2VaultPlan): void {
  if (plan.lastIssuedIndex !== state.lastIssuedIndex || plan.metadata.label !== state.metadata.label) {
    throw new Error(PLAN_MISMATCH_ERROR);
  }

  const derivedOutputs = deriveIssuedDeposits(plan).map(({ index, outputScript }) => ({ index, outputScript }));
  if (derivedOutputs.length !== state.issuedOutputs.length) {
    throw new Error(PLAN_MISMATCH_ERROR);
  }
  for (const [index, output] of derivedOutputs.entries()) {
    const commitment = state.issuedOutputs[index];
    if (commitment?.index !== output.index || commitment.outputScript !== output.outputScript) {
      throw new Error(PLAN_MISMATCH_ERROR);
    }
  }

  if (calculateHistoricalIdentityCommitmentV1(plan).digest !== state.historicalIdentityCommitment.digest) {
    throw new Error(PLAN_MISMATCH_ERROR);
  }
}

/**
 * Converts an already valid Policy V2 VaultPlan into isolated durable xpubless
 * state. The caller owns localInstanceId generation; this pure function never
 * creates randomness or performs persistence. It derives every issued output
 * #0..#N, so conversion is deliberately O(N).
 */
export function createXpublessV2PlanState(planInput: VaultPlan, localInstanceId: string): XpublessV2PlanState {
  const plan = requireV2Plan(planInput);
  return XpublessV2PlanStateSchema.parse({
    format: XPUBLESS_V2_PLAN_STATE_FORMAT,
    version: XPUBLESS_V2_PLAN_STATE_VERSION,
    localInstanceId,
    policyVersion: VAULT_POLICY_V2,
    network: plan.policy.network,
    unlockHeight: plan.policy.unlockHeight,
    derivation: plan.policy.derivation,
    keyOrigin: plan.policy.keySource.keyOrigin,
    metadata: plan.metadata,
    historicalIdentityCommitment: calculateHistoricalIdentityCommitmentV1(plan),
    lastIssuedIndex: plan.lastIssuedIndex,
    issuedOutputs: deriveIssuedDeposits(plan).map(({ index, outputScript }) => ({ index, outputScript })),
  });
}

/**
 * Reconstructs a Policy V2 plan in memory only after the candidate-owned
 * policy, output commitments, and HIC v1 all match the presented public tpub.
 * This deliberately verifies every issued output #0..#N and is therefore O(N).
 */
export function rehydrateXpublessV2PlanState(stateInput: unknown, presentedExtendedPublicKey: string): VaultPlan {
  const state = XpublessV2PlanStateSchema.parse(stateInput);
  const initialPlan = createVaultPlan({
    label: state.metadata.label,
    network: state.network,
    unlockHeight: state.unlockHeight,
    extendedPublicKey: presentedExtendedPublicKey,
    policyVersion: VAULT_POLICY_V2,
    keyOrigin: state.keyOrigin,
  });
  const plan = requireV2Plan({ ...initialPlan, lastIssuedIndex: state.lastIssuedIndex });
  assertStateMatchesV2Plan(state, plan);
  return plan;
}

/**
 * Appends exactly the next derived deposit after re-validating the supplied
 * session plan against the current state. Derivation is not disclosure: a
 * future persistence/UI layer must write and read-back this next state before
 * revealing the new address, and must never reuse a revealed index on failure.
 */
export function appendIssuedDepositToXpublessV2PlanState(
  stateInput: unknown,
  rehydratedPlanInput: VaultPlan,
  depositInput: XpublessV2IssuedDepositCommitment,
): XpublessV2PlanState {
  const state = XpublessV2PlanStateSchema.parse(stateInput);
  const plan = requireV2Plan(rehydratedPlanInput);
  assertStateMatchesV2Plan(state, plan);

  if (state.lastIssuedIndex >= MAX_NON_HARDENED_INDEX) {
    throw new Error("No more non-hardened deposit indexes are available for this plan.");
  }
  const nextIndex = state.lastIssuedIndex + 1;
  const expectedDeposit = deriveDeposit(plan, nextIndex);
  if (depositInput.index !== nextIndex || depositInput.outputScript !== expectedDeposit.outputScript) {
    throw new Error("Issued deposit does not match the next derived output for this xpubless plan state.");
  }

  return XpublessV2PlanStateSchema.parse({
    ...state,
    lastIssuedIndex: nextIndex,
    issuedOutputs: [
      ...state.issuedOutputs.map((output) => ({ ...output })),
      { index: nextIndex, outputScript: expectedDeposit.outputScript },
    ],
  });
}
