import { createXpublessV2PlanState } from "@/bitcoin/xpubless-v2-plan-state";
import type { VaultPlan } from "@/domain/vault-plan";
import type { XpublessV2PlanState } from "@/domain/xpubless-v2-plan-state";
import {
  XPUBLESS_V2_LEGACY_STORAGE_KEYS,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  XpublessV2LocalStateSchema,
  buildNextXpublessV2LocalState,
  createInitialXpublessV2LocalState,
  type XpublessV2LocalState,
} from "./xpubless-v2-local-state";

/** Minimal injected persistence boundary; P3E2 never accesses browser globals. */
export interface XpublessV2CommittedMutationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export type XpublessV2CommittedMutationWriterResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

/** Injected coordination only; browser locking remains in P3D1/P3E browser wrappers. */
export interface XpublessV2CommittedMutationExclusiveWriter {
  runExclusive<T>(operation: () => T): XpublessV2CommittedMutationWriterResult<T>;
}

export interface XpublessV2CommittedMutationDependencies {
  storage: XpublessV2CommittedMutationStorage;
  exclusiveWriter: XpublessV2CommittedMutationExclusiveWriter;
}

export interface XpublessV2InitialPlanMutationRequest {
  kind: "INITIAL";
  stateId: string;
  localInstanceId: string;
  /**
   * A validated, transient public-policy input. Mutations intentionally know
   * nothing about the wallet that supplied it: a future first-party wallet
   * must satisfy this same generic contract without a storage-side branch.
   */
  plan: VaultPlan;
}

export interface XpublessV2AddPlanMutationRequest {
  kind: "ADD";
  expectedState: unknown;
  localInstanceId: string;
  plan: VaultPlan;
}

export type XpublessV2CreatePlanRequest =
  | XpublessV2InitialPlanMutationRequest
  | XpublessV2AddPlanMutationRequest;

/** Import is intentionally a separate API, despite sharing its request shape with create. */
export type XpublessV2ImportPlanRequest =
  | XpublessV2InitialPlanMutationRequest
  | XpublessV2AddPlanMutationRequest;

export interface XpublessV2PlanMutationRequest {
  expectedState: unknown;
  localInstanceId: string;
}

export interface XpublessV2HiddenDepositMutationRequest extends XpublessV2PlanMutationRequest {
  depositIndex: number;
}

export interface XpublessV2RenamePlanMutationRequest extends XpublessV2PlanMutationRequest {
  label: string;
}

export type XpublessV2CommittedMutationStatus =
  | "COMMITTED"
  | "NO_XPUBLESS_STATE"
  | "BLOCKED_STORAGE_NOT_READY"
  | "BLOCKED_CONCURRENT_WRITER"
  | "BLOCKED_STALE_STATE"
  | "BLOCKED_PLAN_NOT_FOUND"
  | "BLOCKED_DUPLICATE_PLAN"
  | "BLOCKED_INVALID_INDEX"
  | "BLOCKED_INVALID_TRANSITION"
  | "FAILED_RECOVERABLE";

export type XpublessV2CommittedMutationResult =
  | { status: "COMMITTED"; stateId: string; revision: number; localInstanceId?: string }
  | { status: Exclude<XpublessV2CommittedMutationStatus, "COMMITTED"> };

type FailureStatus = Exclude<XpublessV2CommittedMutationStatus, "COMMITTED">;

class MutationStatusError extends Error {
  constructor(readonly status: FailureStatus) {
    super(status);
  }
}

function fail(status: FailureStatus): never {
  throw new MutationStatusError(status);
}

function canonicalJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJsonValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalJsonValue(entry)]),
    );
  }
  return value;
}

function stateEquals(left: XpublessV2LocalState, right: XpublessV2LocalState): boolean {
  return JSON.stringify(canonicalJsonValue(left)) === JSON.stringify(canonicalJsonValue(right));
}

function parseState(raw: string | null): XpublessV2LocalState | null {
  return raw === null ? null : XpublessV2LocalStateSchema.parse(JSON.parse(raw));
}

function readAuthority(storage: XpublessV2CommittedMutationStorage): XpublessV2LocalState | null {
  let stored: XpublessV2LocalState | null;
  try {
    stored = parseState(storage.getItem(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY));
  } catch {
    fail("FAILED_RECOVERABLE");
  }
  const journalPresent = storage.getItem(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY) !== null;
  // Inspect every known legacy surface: startup/authority gates must not rely
  // on a convenient loader-style fallback or a first-match shortcut.
  const legacyValues = XPUBLESS_V2_LEGACY_STORAGE_KEYS.map((key) => storage.getItem(key));
  const legacyPresent = legacyValues.some((value) => value !== null);
  if (journalPresent || legacyPresent) fail("BLOCKED_STORAGE_NOT_READY");
  return stored;
}

function writeAndReadBack(
  storage: XpublessV2CommittedMutationStorage,
  nextState: XpublessV2LocalState,
): XpublessV2LocalState {
  const serialized = JSON.stringify(nextState);
  storage.setItem(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, serialized);
  const readBack = storage.getItem(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY);
  if (readBack !== serialized) throw new Error("Persisted xpubless mutation state did not match its write/read-back value.");
  const parsed = XpublessV2LocalStateSchema.parse(JSON.parse(readBack));
  if (!stateEquals(parsed, nextState)) throw new Error("Persisted xpubless mutation state did not match its expected transition.");
  return parsed;
}

function committed(state: XpublessV2LocalState, localInstanceId?: string): XpublessV2CommittedMutationResult {
  return { status: "COMMITTED", stateId: state.stateId, revision: state.revision, ...(localInstanceId ? { localInstanceId } : {}) };
}

function sameHistoricalPolicy(left: XpublessV2PlanState, right: XpublessV2PlanState): boolean {
  // HIC equality is local duplicate/binding material only, never authentication.
  return left.policyVersion === right.policyVersion
    && left.network === right.network
    && left.unlockHeight === right.unlockHeight
    && JSON.stringify(canonicalJsonValue(left.derivation)) === JSON.stringify(canonicalJsonValue(right.derivation))
    && JSON.stringify(canonicalJsonValue(left.keyOrigin)) === JSON.stringify(canonicalJsonValue(right.keyOrigin))
    && JSON.stringify(canonicalJsonValue(left.historicalIdentityCommitment)) === JSON.stringify(canonicalJsonValue(right.historicalIdentityCommitment));
}

function candidatePlan(plan: VaultPlan, localInstanceId: string): XpublessV2PlanState {
  try {
    return createXpublessV2PlanState(plan, localInstanceId);
  } catch {
    fail("FAILED_RECOVERABLE");
  }
}

function buildInsertion(
  expectedState: XpublessV2LocalState,
  localInstanceId: string,
  plan: VaultPlan,
): XpublessV2LocalState {
  const candidate = candidatePlan(plan, localInstanceId);
  if (expectedState.plans.some((existing) => (
    existing.localInstanceId === localInstanceId || sameHistoricalPolicy(existing, candidate)
  ))) fail("BLOCKED_DUPLICATE_PLAN");
  return buildNextXpublessV2LocalState(expectedState, {
    plans: [...expectedState.plans, candidate],
    archivedLocalInstanceIds: [...expectedState.archivedLocalInstanceIds],
    hiddenDepositIndexes: Object.fromEntries(Object.entries(expectedState.hiddenDepositIndexes).map(([id, indexes]) => [id, [...indexes]])),
  });
}

function requireExpectedState(input: unknown): XpublessV2LocalState {
  try {
    return XpublessV2LocalStateSchema.parse(input);
  } catch {
    fail("FAILED_RECOVERABLE");
  }
}

function commitInitialOrAdd(
  dependencies: XpublessV2CommittedMutationDependencies,
  request: XpublessV2CreatePlanRequest,
): XpublessV2CommittedMutationResult {
  const stored = readAuthority(dependencies.storage);
  if (request.kind === "INITIAL") {
    const initial = createInitialXpublessV2LocalState({
      stateId: request.stateId,
      plans: [candidatePlan(request.plan, request.localInstanceId)],
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
    });
    if (stored && stateEquals(stored, initial)) return committed(stored, request.localInstanceId);
    if (stored) fail("BLOCKED_STALE_STATE");
    try {
      return committed(writeAndReadBack(dependencies.storage, initial), request.localInstanceId);
    } catch {
      fail("FAILED_RECOVERABLE");
    }
  }

  const expected = requireExpectedState(request.expectedState);
  if (!stored) fail("NO_XPUBLESS_STATE");
  const next = buildInsertion(expected, request.localInstanceId, request.plan);
  if (stateEquals(stored, next)) return committed(stored, request.localInstanceId);
  if (!stateEquals(stored, expected)) fail("BLOCKED_STALE_STATE");
  try {
    return committed(writeAndReadBack(dependencies.storage, next), request.localInstanceId);
  } catch {
    fail("FAILED_RECOVERABLE");
  }
}

function withExistingState(
  dependencies: XpublessV2CommittedMutationDependencies,
  expectedInput: unknown,
  localInstanceId: string,
  calculateNext: (expected: XpublessV2LocalState) => XpublessV2LocalState,
): XpublessV2CommittedMutationResult {
  const expected = requireExpectedState(expectedInput);
  const stored = readAuthority(dependencies.storage);
  if (!stored) fail("NO_XPUBLESS_STATE");
  const next = calculateNext(expected);
  if (stateEquals(stored, next)) return committed(stored, localInstanceId);
  if (!stateEquals(stored, expected)) fail("BLOCKED_STALE_STATE");
  try {
    return committed(writeAndReadBack(dependencies.storage, next), localInstanceId);
  } catch {
    fail("FAILED_RECOVERABLE");
  }
}

function requirePlan(state: XpublessV2LocalState, localInstanceId: string): XpublessV2PlanState {
  const plan = state.plans.find((candidate) => candidate.localInstanceId === localInstanceId);
  if (!plan) fail("BLOCKED_PLAN_NOT_FOUND");
  return plan;
}

function nextBody(state: XpublessV2LocalState, changes: {
  plans?: XpublessV2PlanState[];
  archivedLocalInstanceIds?: string[];
  hiddenDepositIndexes?: Record<string, number[]>;
}): XpublessV2LocalState {
  return buildNextXpublessV2LocalState(state, {
    plans: changes.plans ?? state.plans.map((plan) => ({ ...plan, issuedOutputs: plan.issuedOutputs.map((output) => ({ ...output })) })),
    archivedLocalInstanceIds: changes.archivedLocalInstanceIds ?? [...state.archivedLocalInstanceIds],
    hiddenDepositIndexes: changes.hiddenDepositIndexes ?? Object.fromEntries(Object.entries(state.hiddenDepositIndexes).map(([id, indexes]) => [id, [...indexes]])),
  });
}

function runMutation(
  dependencies: XpublessV2CommittedMutationDependencies,
  operation: () => XpublessV2CommittedMutationResult,
): XpublessV2CommittedMutationResult {
  try {
    const writerResult = dependencies.exclusiveWriter.runExclusive(operation);
    if (!writerResult.acquired) return { status: "BLOCKED_CONCURRENT_WRITER" };
    return writerResult.value;
  } catch (cause) {
    if (cause instanceof MutationStatusError) return { status: cause.status };
    return { status: "FAILED_RECOVERABLE" };
  }
}

/** Commits either direct initial creation or a later typed V2 plan insertion. */
export function commitCreateXpublessV2Plan(
  dependencies: XpublessV2CommittedMutationDependencies,
  request: XpublessV2CreatePlanRequest,
): XpublessV2CommittedMutationResult {
  return runMutation(dependencies, () => commitInitialOrAdd(dependencies, request));
}

/** Import is distinct at the API boundary; caller already reconstructed/validated the recovery plan. */
export function commitImportXpublessV2Plan(
  dependencies: XpublessV2CommittedMutationDependencies,
  request: XpublessV2ImportPlanRequest,
): XpublessV2CommittedMutationResult {
  return runMutation(dependencies, () => commitInitialOrAdd(dependencies, request));
}

export function commitArchiveXpublessV2Plan(dependencies: XpublessV2CommittedMutationDependencies, request: XpublessV2PlanMutationRequest): XpublessV2CommittedMutationResult {
  return runMutation(dependencies, () => withExistingState(dependencies, request.expectedState, request.localInstanceId, (state) => {
    requirePlan(state, request.localInstanceId);
    if (state.archivedLocalInstanceIds.includes(request.localInstanceId)) fail("BLOCKED_INVALID_TRANSITION");
    return nextBody(state, { archivedLocalInstanceIds: [...state.archivedLocalInstanceIds, request.localInstanceId] });
  }));
}

export function commitRestoreArchivedXpublessV2Plan(dependencies: XpublessV2CommittedMutationDependencies, request: XpublessV2PlanMutationRequest): XpublessV2CommittedMutationResult {
  return runMutation(dependencies, () => withExistingState(dependencies, request.expectedState, request.localInstanceId, (state) => {
    requirePlan(state, request.localInstanceId);
    if (!state.archivedLocalInstanceIds.includes(request.localInstanceId)) fail("BLOCKED_INVALID_TRANSITION");
    return nextBody(state, { archivedLocalInstanceIds: state.archivedLocalInstanceIds.filter((id) => id !== request.localInstanceId) });
  }));
}

function mutateHidden(state: XpublessV2LocalState, localInstanceId: string, depositIndex: number, add: boolean): XpublessV2LocalState {
  const plan = requirePlan(state, localInstanceId);
  if (!Number.isInteger(depositIndex) || depositIndex < 0 || depositIndex > plan.lastIssuedIndex) fail("BLOCKED_INVALID_INDEX");
  const current = state.hiddenDepositIndexes[localInstanceId] ?? [];
  if (add && current.includes(depositIndex)) fail("BLOCKED_INVALID_TRANSITION");
  if (!add && !current.includes(depositIndex)) fail("BLOCKED_INVALID_TRANSITION");
  const hidden = Object.fromEntries(Object.entries(state.hiddenDepositIndexes).map(([id, indexes]) => [id, [...indexes]])) as Record<string, number[]>;
  const nextIndexes = add
    ? [...current, depositIndex].sort((left, right) => left - right)
    : current.filter((index) => index !== depositIndex);
  if (nextIndexes.length === 0) delete hidden[localInstanceId];
  else hidden[localInstanceId] = nextIndexes;
  return nextBody(state, { hiddenDepositIndexes: hidden });
}

export function commitHideXpublessV2Deposit(dependencies: XpublessV2CommittedMutationDependencies, request: XpublessV2HiddenDepositMutationRequest): XpublessV2CommittedMutationResult {
  return runMutation(dependencies, () => withExistingState(dependencies, request.expectedState, request.localInstanceId, (state) => mutateHidden(state, request.localInstanceId, request.depositIndex, true)));
}

export function commitRestoreHiddenXpublessV2Deposit(dependencies: XpublessV2CommittedMutationDependencies, request: XpublessV2HiddenDepositMutationRequest): XpublessV2CommittedMutationResult {
  return runMutation(dependencies, () => withExistingState(dependencies, request.expectedState, request.localInstanceId, (state) => mutateHidden(state, request.localInstanceId, request.depositIndex, false)));
}

export function commitRemoveXpublessV2Plan(dependencies: XpublessV2CommittedMutationDependencies, request: XpublessV2PlanMutationRequest): XpublessV2CommittedMutationResult {
  return runMutation(dependencies, () => withExistingState(dependencies, request.expectedState, request.localInstanceId, (state) => {
    requirePlan(state, request.localInstanceId);
    const hidden = Object.fromEntries(Object.entries(state.hiddenDepositIndexes).filter(([id]) => id !== request.localInstanceId)) as Record<string, number[]>;
    return nextBody(state, {
      plans: state.plans.filter((plan) => plan.localInstanceId !== request.localInstanceId),
      archivedLocalInstanceIds: state.archivedLocalInstanceIds.filter((id) => id !== request.localInstanceId),
      hiddenDepositIndexes: hidden,
    });
  }));
}

export function commitRenameXpublessV2Plan(dependencies: XpublessV2CommittedMutationDependencies, request: XpublessV2RenamePlanMutationRequest): XpublessV2CommittedMutationResult {
  return runMutation(dependencies, () => withExistingState(dependencies, request.expectedState, request.localInstanceId, (state) => {
    const plan = requirePlan(state, request.localInstanceId);
    if (plan.metadata.label === request.label) fail("BLOCKED_INVALID_TRANSITION");
    return nextBody(state, {
      plans: state.plans.map((candidate) => candidate.localInstanceId === request.localInstanceId
        ? { ...candidate, metadata: { ...candidate.metadata, label: request.label } }
        : { ...candidate, issuedOutputs: candidate.issuedOutputs.map((output) => ({ ...output })) }),
    });
  }));
}
