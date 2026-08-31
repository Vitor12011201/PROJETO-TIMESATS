import { describe, expect, it } from "vitest";
import { createXpublessV2PlanState } from "@/bitcoin/xpubless-v2-plan-state";
import { createVaultPlan, issueNextDeposit } from "@/bitcoin/vault-plan";
import type { VaultPlan } from "@/domain/vault-plan";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import {
  XPUBLESS_V2_LEGACY_STORAGE_KEYS,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  XpublessV2LocalStateSchema,
  createInitialXpublessV2LocalState,
  type XpublessV2LocalState,
} from "./xpubless-v2-local-state";
import {
  commitArchiveXpublessV2Plan,
  commitCreateXpublessV2Plan,
  commitHideXpublessV2Deposit,
  commitImportXpublessV2Plan,
  commitRemoveXpublessV2Plan,
  commitRenameXpublessV2Plan,
  commitRestoreArchivedXpublessV2Plan,
  commitRestoreHiddenXpublessV2Deposit,
  type XpublessV2CommittedMutationDependencies,
  type XpublessV2CommittedMutationExclusiveWriter,
} from "./xpubless-v2-committed-mutations";

const STATE_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_A_ID = "22222222-2222-4222-8222-222222222222";
const PLAN_B_ID = "33333333-3333-4333-8333-333333333333";
const PLAN_C_ID = "44444444-4444-4444-8444-444444444444";
const INITIAL_AUTHORITY_BLOCKING_KEYS = [
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  ...XPUBLESS_V2_LEGACY_STORAGE_KEYS,
] as const;

class MemoryStorage {
  readonly values = new Map<string, string>();
  readonly operations: Array<{ kind: "get" | "set"; key: string }> = [];
  private throwAfterTargetSet = false;
  private mismatchReadAfterNextTargetSet = false;
  private mismatchNextTargetRead = false;

  getItem(key: string): string | null {
    this.operations.push({ kind: "get", key });
    if (key === XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY && this.mismatchNextTargetRead) {
      this.mismatchNextTargetRead = false;
      return "read-back-mismatch";
    }
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.operations.push({ kind: "set", key });
    this.values.set(key, value);
    if (key === XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY && this.mismatchReadAfterNextTargetSet) {
      this.mismatchReadAfterNextTargetSet = false;
      this.mismatchNextTargetRead = true;
    }
    if (key === XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY && this.throwAfterTargetSet) {
      this.throwAfterTargetSet = false;
      throw new Error("Injected after-set failure.");
    }
  }

  seed(key: string, value: string): void {
    this.values.set(key, value);
  }

  failAfterNextTargetSet(): void {
    this.throwAfterTargetSet = true;
  }

  mismatchNextTargetReadBack(): void {
    this.mismatchReadAfterNextTargetSet = true;
  }

  targetSetCount(): number {
    return this.operations.filter((entry) => entry.kind === "set" && entry.key === XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY).length;
  }
}

const acquiredWriter: XpublessV2CommittedMutationExclusiveWriter = {
  runExclusive<T>(operation: () => T): { acquired: true; value: T } {
    return { acquired: true, value: operation() };
  },
};

const refusedWriter: XpublessV2CommittedMutationExclusiveWriter = {
  runExclusive<T>(operation: () => T): { acquired: false } {
    void operation;
    return { acquired: false };
  },
};

function dependencies(storage: MemoryStorage, writer = acquiredWriter): XpublessV2CommittedMutationDependencies {
  return { storage, exclusiveWriter: writer };
}

function plan(label = "Plan A", issuedIndex = 0, unlockHeight = 700): VaultPlan {
  let current = createVaultPlan({
    label,
    network: "regtest",
    unlockHeight,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  while (current.lastIssuedIndex < issuedIndex) current = issueNextDeposit(current).plan;
  return current;
}

function legacyV1Plan(): VaultPlan {
  return createVaultPlan({
    label: "Legacy V1",
    network: "regtest",
    unlockHeight: 700,
    extendedPublicKey: validTestTpub,
    policyVersion: 1,
  });
}

function stateWithPlans(plans: Array<{ plan: VaultPlan; localInstanceId: string }>, revision = 0): XpublessV2LocalState {
  const initial = createInitialXpublessV2LocalState({
    stateId: STATE_ID,
    plans: plans.map((entry) => createXpublessV2PlanState(entry.plan, entry.localInstanceId)),
    archivedLocalInstanceIds: [],
    hiddenDepositIndexes: {},
  });
  return revision === 0 ? initial : XpublessV2LocalStateSchema.parse({ ...initial, revision });
}

function seedTarget(storage: MemoryStorage, state: XpublessV2LocalState): void {
  storage.seed(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, JSON.stringify(state));
}

function readTarget(storage: MemoryStorage): XpublessV2LocalState {
  return XpublessV2LocalStateSchema.parse(JSON.parse(storage.values.get(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY) ?? "null"));
}

function expectNoDurablePublicSource(serialized: string): void {
  expect(serialized).not.toContain(validTestTpub);
  expect(serialized).not.toMatch(/extendedPublicKey|vaultPlanIdentity|witnessScript|descriptor|address|publicKey/);
}

describe("P3E2 committed xpubless local mutations", () => {
  it("creates the initial state directly, persists no public source, and replays without a second write", () => {
    const storage = new MemoryStorage();
    const request = { kind: "INITIAL" as const, stateId: STATE_ID, localInstanceId: PLAN_A_ID, plan: plan() };
    const requestSnapshot = structuredClone(request);

    expect(commitCreateXpublessV2Plan(dependencies(storage), request)).toEqual({ status: "COMMITTED", stateId: STATE_ID, revision: 0, localInstanceId: PLAN_A_ID });
    const serialized = storage.values.get(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY) ?? "";
    expectNoDurablePublicSource(serialized);
    expect(request).toEqual(requestSnapshot);
    expect(commitCreateXpublessV2Plan(dependencies(storage), request)).toEqual({ status: "COMMITTED", stateId: STATE_ID, revision: 0, localInstanceId: PLAN_A_ID });
    expect(storage.targetSetCount()).toBe(1);
  });

  it("recovers initial creation after a mutation succeeded but its caller saw failure", () => {
    const storage = new MemoryStorage();
    const request = { kind: "INITIAL" as const, stateId: STATE_ID, localInstanceId: PLAN_A_ID, plan: plan() };
    storage.failAfterNextTargetSet();

    expect(commitCreateXpublessV2Plan(dependencies(storage), request)).toEqual({ status: "FAILED_RECOVERABLE" });
    expect(readTarget(storage)).toMatchObject({ stateId: STATE_ID, revision: 0 });
    expect(commitCreateXpublessV2Plan(dependencies(storage), request)).toMatchObject({ status: "COMMITTED", revision: 0 });
    expect(storage.targetSetCount()).toBe(1);
  });

  it.each(INITIAL_AUTHORITY_BLOCKING_KEYS)("blocks initial creation when %s establishes another storage authority", (blockingKey) => {
    const storage = new MemoryStorage();
    storage.seed(blockingKey, "present");

    expect(commitCreateXpublessV2Plan(dependencies(storage), {
      kind: "INITIAL",
      stateId: STATE_ID,
      localInstanceId: PLAN_A_ID,
      plan: plan(),
    })).toEqual({ status: "BLOCKED_STORAGE_NOT_READY" });
    expect(storage.values.has(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)).toBe(false);
    expect(storage.targetSetCount()).toBe(0);
  });

  it("never treats an arbitrary existing target as empty state", () => {
    const storage = new MemoryStorage();
    seedTarget(storage, stateWithPlans([{ plan: plan("Other"), localInstanceId: PLAN_B_ID }]));

    expect(commitCreateXpublessV2Plan(dependencies(storage), {
      kind: "INITIAL",
      stateId: STATE_ID,
      localInstanceId: PLAN_A_ID,
      plan: plan(),
    })).toEqual({ status: "BLOCKED_STALE_STATE" });
    expect(storage.targetSetCount()).toBe(0);
  });

  it("rejects V1 create and import inputs before any write", () => {
    for (const operation of [commitCreateXpublessV2Plan, commitImportXpublessV2Plan]) {
      const storage = new MemoryStorage();
      expect(operation(dependencies(storage), {
        kind: "INITIAL",
        stateId: STATE_ID,
        localInstanceId: PLAN_A_ID,
        plan: legacyV1Plan(),
      })).toEqual({ status: "FAILED_RECOVERABLE" });
      expect(storage.targetSetCount()).toBe(0);
      expect(storage.values.has(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)).toBe(false);
    }
  });

  it("imports an initial V2 plan directly without legacy staging or durable public source", () => {
    const storage = new MemoryStorage();
    const request = { kind: "INITIAL" as const, stateId: "55555555-5555-4555-8555-555555555555", localInstanceId: PLAN_A_ID, plan: plan("Imported") };
    const result = commitImportXpublessV2Plan(dependencies(storage), request);
    expect(result).toMatchObject({ status: "COMMITTED", revision: 0 });
    expect(result).not.toHaveProperty("address");
    expectNoDurablePublicSource(storage.values.get(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY) ?? "");
    expect(XPUBLESS_V2_LEGACY_STORAGE_KEYS.every((key) => !storage.values.has(key))).toBe(true);
  });

  it("adds/imports V2 plans as full envelope revisions without merge or identity regeneration", () => {
    const storage = new MemoryStorage();
    const base = createInitialXpublessV2LocalState({
      stateId: STATE_ID,
      plans: [createXpublessV2PlanState(plan("Plan A"), PLAN_A_ID)],
      archivedLocalInstanceIds: [PLAN_A_ID],
      hiddenDepositIndexes: { [PLAN_A_ID]: [0] },
    });
    seedTarget(storage, base);
    const create = { kind: "ADD" as const, expectedState: base, localInstanceId: PLAN_B_ID, plan: plan("Plan B", 0, 701) };
    expect(commitCreateXpublessV2Plan(dependencies(storage), create)).toMatchObject({ status: "COMMITTED", revision: 1, localInstanceId: PLAN_B_ID });
    expect(readTarget(storage)).toMatchObject({ stateId: STATE_ID, revision: 1, plans: expect.arrayContaining([expect.objectContaining({ localInstanceId: PLAN_A_ID }), expect.objectContaining({ localInstanceId: PLAN_B_ID })]), archivedLocalInstanceIds: [PLAN_A_ID], hiddenDepositIndexes: { [PLAN_A_ID]: [0] } });
    const writesAfterCreate = storage.targetSetCount();
    expect(commitCreateXpublessV2Plan(dependencies(storage), create)).toMatchObject({ status: "COMMITTED", revision: 1 });
    expect(storage.targetSetCount()).toBe(writesAfterCreate);

    const current = readTarget(storage);
    const imported = { kind: "ADD" as const, expectedState: current, localInstanceId: PLAN_C_ID, plan: plan("Plan C", 2, 702) };
    expect(commitImportXpublessV2Plan(dependencies(storage), imported)).toMatchObject({ status: "COMMITTED", revision: 2, localInstanceId: PLAN_C_ID });
    expect(readTarget(storage).plans.find((entry) => entry.localInstanceId === PLAN_C_ID)?.issuedOutputs.map((output) => output.index)).toEqual([0, 1, 2]);
    const writesAfterImport = storage.targetSetCount();
    expect(commitImportXpublessV2Plan(dependencies(storage), imported)).toMatchObject({ status: "COMMITTED", revision: 2, localInstanceId: PLAN_C_ID });
    expect(storage.targetSetCount()).toBe(writesAfterImport);
  });

  it("blocks duplicate historical policies, duplicate local IDs, and import histories instead of merging", () => {
    const storage = new MemoryStorage();
    const existing = stateWithPlans([{ plan: plan("Original", 5), localInstanceId: PLAN_A_ID }]);
    seedTarget(storage, existing);

    expect(commitCreateXpublessV2Plan(dependencies(storage), { kind: "ADD", expectedState: existing, localInstanceId: PLAN_B_ID, plan: plan("Different label", 0) })).toEqual({ status: "BLOCKED_DUPLICATE_PLAN" });
    expect(commitCreateXpublessV2Plan(dependencies(storage), { kind: "ADD", expectedState: existing, localInstanceId: PLAN_A_ID, plan: plan("Other", 3) })).toEqual({ status: "BLOCKED_DUPLICATE_PLAN" });
    expect(commitImportXpublessV2Plan(dependencies(storage), { kind: "ADD", expectedState: existing, localInstanceId: PLAN_C_ID, plan: plan("Older recovery", 3) })).toEqual({ status: "BLOCKED_DUPLICATE_PLAN" });
    expect(readTarget(storage)).toEqual(existing);

    const lowerExistingStorage = new MemoryStorage();
    const lowerExisting = stateWithPlans([{ plan: plan("Original", 3), localInstanceId: PLAN_A_ID }]);
    seedTarget(lowerExistingStorage, lowerExisting);
    expect(commitImportXpublessV2Plan(dependencies(lowerExistingStorage), {
      kind: "ADD",
      expectedState: lowerExisting,
      localInstanceId: PLAN_C_ID,
      plan: plan("Newer recovery", 5),
    })).toEqual({ status: "BLOCKED_DUPLICATE_PLAN" });
    expect(readTarget(lowerExistingStorage)).toEqual(lowerExisting);
  });

  it("distinguishes archive/restore replays from new no-ops and canonicalizes hidden indexes", () => {
    const storage = new MemoryStorage();
    const base = stateWithPlans([{ plan: plan("Plan A", 3), localInstanceId: PLAN_A_ID }]);
    seedTarget(storage, base);
    const archive = { expectedState: base, localInstanceId: PLAN_A_ID };
    expect(commitArchiveXpublessV2Plan(dependencies(storage), archive)).toMatchObject({ status: "COMMITTED", revision: 1 });
    expect(commitArchiveXpublessV2Plan(dependencies(storage), archive)).toMatchObject({ status: "COMMITTED", revision: 1 });
    const archived = readTarget(storage);
    const writesAfterArchiveReplay = storage.targetSetCount();
    expect(commitArchiveXpublessV2Plan(dependencies(storage), { expectedState: archived, localInstanceId: PLAN_A_ID })).toEqual({ status: "BLOCKED_INVALID_TRANSITION" });
    expect(storage.targetSetCount()).toBe(writesAfterArchiveReplay);
    expect(commitRestoreArchivedXpublessV2Plan(dependencies(storage), { expectedState: archived, localInstanceId: PLAN_A_ID })).toMatchObject({ status: "COMMITTED", revision: 2 });
    expect(commitRestoreArchivedXpublessV2Plan(dependencies(storage), { expectedState: archived, localInstanceId: PLAN_A_ID })).toMatchObject({ status: "COMMITTED", revision: 2 });

    const restored = readTarget(storage);
    expect(commitRestoreArchivedXpublessV2Plan(dependencies(storage), { expectedState: restored, localInstanceId: PLAN_A_ID })).toEqual({ status: "BLOCKED_INVALID_TRANSITION" });
    const withHidden = XpublessV2LocalStateSchema.parse({
      ...restored,
      hiddenDepositIndexes: { [PLAN_A_ID]: [0, 3] },
    });
    seedTarget(storage, withHidden);
    const hide = { expectedState: withHidden, localInstanceId: PLAN_A_ID, depositIndex: 2 };
    expect(commitHideXpublessV2Deposit(dependencies(storage), hide)).toMatchObject({ status: "COMMITTED", revision: 3 });
    const writesAfterHide = storage.targetSetCount();
    expect(commitHideXpublessV2Deposit(dependencies(storage), hide)).toMatchObject({ status: "COMMITTED", revision: 3 });
    expect(storage.targetSetCount()).toBe(writesAfterHide);
    const hidden = readTarget(storage);
    expect(hidden.hiddenDepositIndexes[PLAN_A_ID]).toEqual([0, 2, 3]);
    expect(commitHideXpublessV2Deposit(dependencies(storage), { expectedState: hidden, localInstanceId: PLAN_A_ID, depositIndex: 2 })).toEqual({ status: "BLOCKED_INVALID_TRANSITION" });
    expect(commitRestoreHiddenXpublessV2Deposit(dependencies(storage), { expectedState: hidden, localInstanceId: PLAN_A_ID, depositIndex: 2 })).toMatchObject({ status: "COMMITTED", revision: 4 });
    expect(commitRestoreHiddenXpublessV2Deposit(dependencies(storage), { expectedState: hidden, localInstanceId: PLAN_A_ID, depositIndex: 2 })).toMatchObject({ status: "COMMITTED", revision: 4 });
    const afterRestore = readTarget(storage);
    expect(commitRestoreHiddenXpublessV2Deposit(dependencies(storage), { expectedState: afterRestore, localInstanceId: PLAN_A_ID, depositIndex: 2 })).toEqual({ status: "BLOCKED_INVALID_TRANSITION" });
    expect(commitRestoreHiddenXpublessV2Deposit(dependencies(storage), { expectedState: afterRestore, localInstanceId: PLAN_A_ID, depositIndex: 0 })).toMatchObject({ status: "COMMITTED", revision: 5 });
    const afterFirstRestore = readTarget(storage);
    expect(commitRestoreHiddenXpublessV2Deposit(dependencies(storage), { expectedState: afterFirstRestore, localInstanceId: PLAN_A_ID, depositIndex: 3 })).toMatchObject({ status: "COMMITTED", revision: 6 });
    const afterLastRestore = readTarget(storage);
    expect(afterLastRestore.hiddenDepositIndexes).toEqual({});
    expect(commitHideXpublessV2Deposit(dependencies(storage), { expectedState: afterLastRestore, localInstanceId: PLAN_A_ID, depositIndex: 4 })).toEqual({ status: "BLOCKED_INVALID_INDEX" });
    expect(commitRestoreHiddenXpublessV2Deposit(dependencies(storage), { expectedState: afterLastRestore, localInstanceId: PLAN_A_ID, depositIndex: -1 })).toEqual({ status: "BLOCKED_INVALID_INDEX" });
  });

  it("recovers an archive preference after a write that persisted before its error", () => {
    const storage = new MemoryStorage();
    const state = stateWithPlans([{ plan: plan(), localInstanceId: PLAN_A_ID }]);
    seedTarget(storage, state);
    const request = { expectedState: state, localInstanceId: PLAN_A_ID };
    storage.failAfterNextTargetSet();
    expect(commitArchiveXpublessV2Plan(dependencies(storage), request)).toEqual({ status: "FAILED_RECOVERABLE" });
    expect(readTarget(storage)).toMatchObject({ revision: 1, archivedLocalInstanceIds: [PLAN_A_ID] });
    expect(commitArchiveXpublessV2Plan(dependencies(storage), request)).toMatchObject({ status: "COMMITTED", revision: 1 });
    expect(storage.targetSetCount()).toBe(1);
  });

  it("fails closed on target read-back mismatch and replays the persisted expected transition", () => {
    const storage = new MemoryStorage();
    const state = stateWithPlans([{ plan: plan(), localInstanceId: PLAN_A_ID }]);
    seedTarget(storage, state);
    const request = { expectedState: state, localInstanceId: PLAN_A_ID };
    storage.mismatchNextTargetReadBack();

    expect(commitArchiveXpublessV2Plan(dependencies(storage), request)).toEqual({ status: "FAILED_RECOVERABLE" });
    expect(readTarget(storage)).toMatchObject({ revision: 1, archivedLocalInstanceIds: [PLAN_A_ID] });
    expect(commitArchiveXpublessV2Plan(dependencies(storage), request)).toMatchObject({ status: "COMMITTED", revision: 1 });
    expect(storage.targetSetCount()).toBe(1);
  });

  it("removes a plan and all preferences atomically, including replay and uncertain-write recovery", () => {
    const storage = new MemoryStorage();
    const state = createInitialXpublessV2LocalState({
      stateId: STATE_ID,
      plans: [createXpublessV2PlanState(plan("A"), PLAN_A_ID), createXpublessV2PlanState(plan("B"), PLAN_B_ID)],
      archivedLocalInstanceIds: [PLAN_A_ID, PLAN_B_ID],
      hiddenDepositIndexes: { [PLAN_A_ID]: [0], [PLAN_B_ID]: [0] },
    });
    seedTarget(storage, state);
    const request = { expectedState: state, localInstanceId: PLAN_A_ID };
    storage.failAfterNextTargetSet();
    expect(commitRemoveXpublessV2Plan(dependencies(storage), request)).toEqual({ status: "FAILED_RECOVERABLE" });
    expect(readTarget(storage)).toMatchObject({
      revision: 1,
      plans: [expect.objectContaining({ localInstanceId: PLAN_B_ID })],
      archivedLocalInstanceIds: [PLAN_B_ID],
      hiddenDepositIndexes: { [PLAN_B_ID]: [0] },
    });
    expect(commitRemoveXpublessV2Plan(dependencies(storage), request)).toMatchObject({ status: "COMMITTED", revision: 1 });
    expect(commitRemoveXpublessV2Plan(dependencies(storage), request)).toMatchObject({ status: "COMMITTED", revision: 1 });
    expect(storage.targetSetCount()).toBe(1);
  });

  it("renames only metadata, replays exactly, and rejects same-label transitions", () => {
    const storage = new MemoryStorage();
    const state = stateWithPlans([{ plan: plan("Before"), localInstanceId: PLAN_A_ID }]);
    seedTarget(storage, state);
    const request = { expectedState: state, localInstanceId: PLAN_A_ID, label: "After" };
    expect(commitRenameXpublessV2Plan(dependencies(storage), request)).toMatchObject({ status: "COMMITTED", revision: 1 });
    const writesAfterRename = storage.targetSetCount();
    expect(commitRenameXpublessV2Plan(dependencies(storage), request)).toMatchObject({ status: "COMMITTED", revision: 1 });
    expect(storage.targetSetCount()).toBe(writesAfterRename);
    const renamed = readTarget(storage);
    expect(renamed.plans[0]?.metadata.label).toBe("After");
    expect(commitRenameXpublessV2Plan(dependencies(storage), { expectedState: renamed, localInstanceId: PLAN_A_ID, label: "After" })).toEqual({ status: "BLOCKED_INVALID_TRANSITION" });
    const writesBeforeInvalidLabel = storage.targetSetCount();
    expect(commitRenameXpublessV2Plan(dependencies(storage), { expectedState: renamed, localInstanceId: PLAN_A_ID, label: "   " })).toEqual({ status: "FAILED_RECOVERABLE" });
    expect(storage.targetSetCount()).toBe(writesBeforeInvalidLabel);
  });

  it("uses full-envelope stale checks and blocks missing plans, journal, legacy, corrupt target, and writer refusal", () => {
    const storage = new MemoryStorage();
    const state = stateWithPlans([{ plan: plan(), localInstanceId: PLAN_A_ID }]);
    seedTarget(storage, state);
    const changed = XpublessV2LocalStateSchema.parse({ ...state, hiddenDepositIndexes: { [PLAN_A_ID]: [0] } });
    seedTarget(storage, changed);
    expect(commitArchiveXpublessV2Plan(dependencies(storage), { expectedState: state, localInstanceId: PLAN_A_ID })).toEqual({ status: "BLOCKED_STALE_STATE" });
    seedTarget(storage, state);
    expect(commitArchiveXpublessV2Plan(dependencies(storage), { expectedState: state, localInstanceId: PLAN_B_ID })).toEqual({ status: "BLOCKED_PLAN_NOT_FOUND" });

    for (const key of [XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY, ...XPUBLESS_V2_LEGACY_STORAGE_KEYS]) {
      const blocked = new MemoryStorage();
      seedTarget(blocked, state);
      blocked.seed(key, "present");
      expect(commitArchiveXpublessV2Plan(dependencies(blocked), { expectedState: state, localInstanceId: PLAN_A_ID })).toEqual({ status: "BLOCKED_STORAGE_NOT_READY" });
      expect(blocked.targetSetCount()).toBe(0);
      expect(XPUBLESS_V2_LEGACY_STORAGE_KEYS.every((legacyKey) => (
        blocked.operations.some((operation) => operation.kind === "get" && operation.key === legacyKey)
      ))).toBe(true);
    }
    const corrupt = new MemoryStorage();
    corrupt.seed(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, "{");
    expect(commitArchiveXpublessV2Plan(dependencies(corrupt), { expectedState: state, localInstanceId: PLAN_A_ID })).toEqual({ status: "FAILED_RECOVERABLE" });
    const absent = new MemoryStorage();
    expect(commitArchiveXpublessV2Plan(dependencies(absent), { expectedState: state, localInstanceId: PLAN_A_ID })).toEqual({ status: "NO_XPUBLESS_STATE" });
    expect(absent.targetSetCount()).toBe(0);
    const refused = new MemoryStorage();
    expect(commitCreateXpublessV2Plan(dependencies(refused, refusedWriter), { kind: "INITIAL", stateId: STATE_ID, localInstanceId: PLAN_A_ID, plan: plan() })).toEqual({ status: "BLOCKED_CONCURRENT_WRITER" });
    expect(refused.operations).toEqual([]);
  });

  it("does not mutate caller expected state or unrelated preferences", () => {
    const storage = new MemoryStorage();
    const state = createInitialXpublessV2LocalState({
      stateId: STATE_ID,
      plans: [createXpublessV2PlanState(plan("A"), PLAN_A_ID), createXpublessV2PlanState(plan("B"), PLAN_B_ID)],
      archivedLocalInstanceIds: [PLAN_B_ID],
      hiddenDepositIndexes: { [PLAN_B_ID]: [0] },
    });
    seedTarget(storage, state);
    const snapshot = JSON.stringify(state);
    expect(commitArchiveXpublessV2Plan(dependencies(storage), { expectedState: state, localInstanceId: PLAN_A_ID })).toMatchObject({ status: "COMMITTED" });
    expect(JSON.stringify(state)).toBe(snapshot);
    expect(readTarget(storage)).toMatchObject({ archivedLocalInstanceIds: [PLAN_B_ID, PLAN_A_ID], hiddenDepositIndexes: { [PLAN_B_ID]: [0] } });
  });
});
