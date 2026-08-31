import {
  appendIssuedDepositToXpublessV2PlanState,
  rehydrateXpublessV2PlanState,
} from "@/bitcoin/xpubless-v2-plan-state";
import { deriveDeposit } from "@/bitcoin/vault-plan";
import { MAX_NON_HARDENED_INDEX } from "@/domain/vault-plan";
import {
  XPUBLESS_V2_LEGACY_STORAGE_KEYS,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  XpublessV2LocalStateSchema,
  buildNextXpublessV2LocalState,
  type XpublessV2LocalState,
} from "./xpubless-v2-local-state";

/** Minimal injected persistence boundary. P3C never accesses browser globals. */
export interface XpublessV2CommittedIssuanceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type XpublessV2CommittedIssuanceWriterResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

/** Injected coordination only; this module does not implement a browser lock. */
export interface XpublessV2CommittedIssuanceExclusiveWriter {
  runExclusive<T>(operation: () => T): XpublessV2CommittedIssuanceWriterResult<T>;
}

export interface XpublessV2CommittedIssuanceRequest {
  expectedState: unknown;
  localInstanceId: string;
  presentedExtendedPublicKey: string;
}

export interface XpublessV2CommittedDeposit {
  localInstanceId: string;
  index: number;
  address: string;
  outputScript: string;
}

export type XpublessV2CommittedIssuanceResult =
  | {
    status: "COMMITTED";
    stateId: string;
    revision: number;
    deposit: XpublessV2CommittedDeposit;
  }
  | {
    status:
      | "NO_XPUBLESS_STATE"
      | "BLOCKED_STORAGE_NOT_READY"
      | "BLOCKED_CONCURRENT_WRITER"
      | "BLOCKED_PLAN_NOT_FOUND"
      | "BLOCKED_PUBLIC_SOURCE_MISMATCH"
      | "BLOCKED_INDEX_EXHAUSTED"
      | "BLOCKED_STALE_STATE"
      | "FAILED_RECOVERABLE";
  };

type XpublessV2CommittedIssuanceFailureStatus = Exclude<XpublessV2CommittedIssuanceResult["status"], "COMMITTED">;

export interface XpublessV2CommittedIssuanceDependencies {
  storage: XpublessV2CommittedIssuanceStorage;
  exclusiveWriter: XpublessV2CommittedIssuanceExclusiveWriter;
}

class IssuanceStatusError extends Error {
  constructor(readonly status: XpublessV2CommittedIssuanceFailureStatus) {
    super(status);
  }
}

function fail(status: XpublessV2CommittedIssuanceFailureStatus): never {
  throw new IssuanceStatusError(status);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

/** Object-key order is not semantic; array order remains part of the state. */
function stateEquals(left: XpublessV2LocalState, right: XpublessV2LocalState): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function parsePersistedState(raw: string | null): XpublessV2LocalState | null {
  return raw === null ? null : XpublessV2LocalStateSchema.parse(JSON.parse(raw));
}

/**
 * Low-level storage-infrastructure boundary, exported for direct exhaustion
 * testing only. It is not part of the Bitcoin public facade. P1 guarantees
 * the input is a valid issued index; null means no next index exists.
 */
export function nextXpublessV2DepositIndex(lastIssuedIndex: number): number | null {
  return lastIssuedIndex >= MAX_NON_HARDENED_INDEX ? null : lastIssuedIndex + 1;
}

interface ExpectedIssuance {
  nextState: XpublessV2LocalState;
  deposit: XpublessV2CommittedDeposit;
}

/**
 * Calculates the one allowed envelope transition without persistence. P2
 * rehydration verifies every known output, so this operation remains O(N).
 */
function calculateExpectedIssuance(
  expectedState: XpublessV2LocalState,
  localInstanceId: string,
  presentedExtendedPublicKey: string,
): ExpectedIssuance {
  const currentPlanState = expectedState.plans.find((plan) => plan.localInstanceId === localInstanceId);
  if (!currentPlanState) fail("BLOCKED_PLAN_NOT_FOUND");
  const nextIndex = nextXpublessV2DepositIndex(currentPlanState.lastIssuedIndex);
  if (nextIndex === null) fail("BLOCKED_INDEX_EXHAUSTED");

  let rehydratedPlan;
  try {
    rehydratedPlan = rehydrateXpublessV2PlanState(currentPlanState, presentedExtendedPublicKey);
  } catch {
    fail("BLOCKED_PUBLIC_SOURCE_MISMATCH");
  }

  const nextDeposit = deriveDeposit(rehydratedPlan, nextIndex);
  let nextPlanState;
  try {
    nextPlanState = appendIssuedDepositToXpublessV2PlanState(
      currentPlanState,
      rehydratedPlan,
      { index: nextDeposit.index, outputScript: nextDeposit.outputScript },
    );
  } catch {
    fail("BLOCKED_PUBLIC_SOURCE_MISMATCH");
  }

  const nextState = buildNextXpublessV2LocalState(expectedState, {
    plans: expectedState.plans.map((plan) => (
      plan.localInstanceId === localInstanceId ? nextPlanState : plan
    )),
    archivedLocalInstanceIds: expectedState.archivedLocalInstanceIds,
    hiddenDepositIndexes: expectedState.hiddenDepositIndexes,
  });

  return {
    nextState,
    deposit: {
      localInstanceId,
      index: nextDeposit.index,
      address: nextDeposit.address,
      outputScript: nextDeposit.outputScript,
    },
  };
}

function committedResult(state: XpublessV2LocalState, deposit: XpublessV2CommittedDeposit): XpublessV2CommittedIssuanceResult {
  return { status: "COMMITTED", stateId: state.stateId, revision: state.revision, deposit };
}

function writeAndReadBack(
  storage: XpublessV2CommittedIssuanceStorage,
  nextState: XpublessV2LocalState,
): XpublessV2LocalState {
  const serialized = JSON.stringify(nextState);
  storage.setItem(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, serialized);
  const readBack = storage.getItem(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY);
  if (readBack !== serialized) throw new Error("Persisted xpubless issuance state did not match its write/read-back value.");
  const parsed = XpublessV2LocalStateSchema.parse(JSON.parse(readBack));
  if (!stateEquals(parsed, nextState)) throw new Error("Persisted xpubless issuance state did not match its expected transition.");
  return parsed;
}

function runUnderExclusiveWriter(
  dependencies: XpublessV2CommittedIssuanceDependencies,
  request: XpublessV2CommittedIssuanceRequest,
): XpublessV2CommittedIssuanceResult {
  let expectedState: XpublessV2LocalState;
  let storedState: XpublessV2LocalState | null;
  try {
    expectedState = XpublessV2LocalStateSchema.parse(request.expectedState);
    storedState = parsePersistedState(dependencies.storage.getItem(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY));
  } catch {
    fail("FAILED_RECOVERABLE");
  }

  const journalPresent = dependencies.storage.getItem(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY) !== null;
  const legacyPresent = XPUBLESS_V2_LEGACY_STORAGE_KEYS.some((key) => dependencies.storage.getItem(key) !== null);
  if (journalPresent || legacyPresent) fail("BLOCKED_STORAGE_NOT_READY");
  if (!storedState) fail("NO_XPUBLESS_STATE");

  const expectedIssuance = calculateExpectedIssuance(
    expectedState,
    request.localInstanceId,
    request.presentedExtendedPublicKey,
  );

  if (stateEquals(storedState, expectedIssuance.nextState)) {
    return committedResult(storedState, expectedIssuance.deposit);
  }
  if (!stateEquals(storedState, expectedState)) fail("BLOCKED_STALE_STATE");

  let committedState: XpublessV2LocalState;
  try {
    committedState = writeAndReadBack(dependencies.storage, expectedIssuance.nextState);
  } catch {
    fail("FAILED_RECOVERABLE");
  }
  return committedResult(committedState, expectedIssuance.deposit);
}

/**
 * Commits exactly one next deposit only after injected-storage write/read-back
 * verification. It never discloses an address before that boundary succeeds.
 */
export function commitNextXpublessV2Deposit(
  dependencies: XpublessV2CommittedIssuanceDependencies,
  request: XpublessV2CommittedIssuanceRequest,
): XpublessV2CommittedIssuanceResult {
  try {
    const writerResult = dependencies.exclusiveWriter.runExclusive(() => runUnderExclusiveWriter(dependencies, request));
    if (!writerResult.acquired) return { status: "BLOCKED_CONCURRENT_WRITER" };
    return writerResult.value;
  } catch (cause) {
    if (cause instanceof IssuanceStatusError) return { status: cause.status };
    return { status: "FAILED_RECOVERABLE" };
  }
}
