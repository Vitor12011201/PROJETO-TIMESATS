import { describe, expect, it } from "vitest";
import { createXpublessV2PlanState, rehydrateXpublessV2PlanState } from "@/bitcoin/xpubless-v2-plan-state";
import { createVaultPlan, deriveDeposit } from "@/bitcoin/vault-plan";
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
  XPUBLESS_V2_BROWSER_LOCK_NAME,
  browserCommitArchiveXpublessV2Plan,
  browserCommitCreateXpublessV2Plan,
  browserCommitHideXpublessV2Deposit,
  browserCommitImportXpublessV2Plan,
  browserCommitNextXpublessV2Deposit,
  browserCommitRemoveXpublessV2Plan,
  browserCommitRenameXpublessV2Plan,
  browserCommitRestoreArchivedXpublessV2Plan,
  browserCommitRestoreHiddenXpublessV2Deposit,
  browserRunXpublessV2LegacyMigration,
  type XpublessV2BrowserLockManagerLike,
  type XpublessV2BrowserLockRequestOptions,
  type XpublessV2BrowserStorageLike,
} from "./xpubless-v2-browser";
import type { XpublessV2MigrationUuidSource } from "./xpubless-v2-migration";

const [V3_KEY] = XPUBLESS_V2_LEGACY_STORAGE_KEYS;
const MIGRATION_ID = "a1d5e9b0-11c2-4d3e-8f40-1234567890ab";
const STATE_ID = "b2d5e9b0-11c2-4d3e-8f40-1234567890ab";
const PLAN_ID = "c3d5e9b0-11c2-4d3e-8f40-1234567890ab";

type LockBehavior = "acquired" | "unavailable" | "throw" | "reject";
type StorageOperation = "get" | "set" | "remove";

class FakeLockManager implements XpublessV2BrowserLockManagerLike {
  active = false;
  callbackCalls = 0;
  readonly requests: Array<{ name: string; options: XpublessV2BrowserLockRequestOptions }> = [];

  constructor(private readonly behavior: LockBehavior = "acquired") {}

  async request<T>(
    name: string,
    options: XpublessV2BrowserLockRequestOptions,
    callback: (lock: object | null) => T | PromiseLike<T>,
  ): Promise<T> {
    this.requests.push({ name, options });
    if (this.behavior === "throw") throw new Error("Injected browser coordination throw.");
    if (this.behavior === "reject") return Promise.reject(new Error("Injected browser coordination rejection."));
    if (this.behavior === "unavailable") {
      this.callbackCalls += 1;
      return callback(null);
    }

    this.active = true;
    try {
      this.callbackCalls += 1;
      return await callback({});
    } finally {
      this.active = false;
    }
  }
}

class FakeStorage implements XpublessV2BrowserStorageLike {
  readonly values = new Map<string, string>();
  readonly operations: Array<{ operation: StorageOperation; key: string }> = [];
  private failNextRead = false;
  private failNextTargetSet = false;

  constructor(private readonly lockManager: FakeLockManager) {}

  getItem(key: string): string | null {
    this.assertInsideLock();
    this.operations.push({ operation: "get", key });
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error("Injected storage read failure.");
    }
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.assertInsideLock();
    this.operations.push({ operation: "set", key });
    if (key === XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY && this.failNextTargetSet) {
      this.failNextTargetSet = false;
      throw new Error("Injected storage write failure.");
    }
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.assertInsideLock();
    this.operations.push({ operation: "remove", key });
    this.values.delete(key);
  }

  put(key: string, value: string): void {
    this.values.set(key, value);
  }

  failNextTargetWrite(): void {
    this.failNextTargetSet = true;
  }

  failNextReadInsideLock(): void {
    this.failNextRead = true;
  }

  targetSetCount(): number {
    return this.operations.filter((entry) => (
      entry.operation === "set" && entry.key === XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY
    )).length;
  }

  private assertInsideLock(): void {
    if (!this.lockManager.active) throw new Error("Browser storage was accessed outside the injected lock callback.");
  }
}

class DeterministicUuidSource implements XpublessV2MigrationUuidSource {
  migrationCalls = 0;
  stateCalls = 0;
  localCalls = 0;

  nextMigrationId(): string {
    this.migrationCalls += 1;
    return MIGRATION_ID;
  }

  nextStateId(): string {
    this.stateCalls += 1;
    return STATE_ID;
  }

  nextLocalInstanceId(): string {
    this.localCalls += 1;
    return PLAN_ID;
  }
}

function v2Plan() {
  return createVaultPlan({
    label: "Browser boundary",
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
}

function initialState(): XpublessV2LocalState {
  return createInitialXpublessV2LocalState({
    stateId: STATE_ID,
    plans: [createXpublessV2PlanState(v2Plan(), PLAN_ID)],
    archivedLocalInstanceIds: [],
    hiddenDepositIndexes: {},
  });
}

function stateWithPreferences(
  archivedLocalInstanceIds: string[] = [],
  hiddenDepositIndexes: Record<string, number[]> = {},
): XpublessV2LocalState {
  return XpublessV2LocalStateSchema.parse({
    ...initialState(),
    archivedLocalInstanceIds,
    hiddenDepositIndexes,
  });
}

function storeTarget(storage: FakeStorage, state: XpublessV2LocalState): void {
  storage.put(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, JSON.stringify(state));
}

function persistedTarget(storage: FakeStorage): XpublessV2LocalState {
  return XpublessV2LocalStateSchema.parse(JSON.parse(storage.values.get(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)!));
}

function issuanceRequest(expectedState: XpublessV2LocalState) {
  return { expectedState, localInstanceId: PLAN_ID, presentedExtendedPublicKey: validTestTpub };
}

function initialPlanRequest() {
  return { kind: "INITIAL" as const, stateId: STATE_ID, localInstanceId: PLAN_ID, plan: v2Plan() };
}

function expectOneFailFastRequest(lockManager: FakeLockManager): void {
  expect(lockManager.requests).toEqual([{
    name: XPUBLESS_V2_BROWSER_LOCK_NAME,
    options: { mode: "exclusive", ifAvailable: true },
  }]);
}

describe("P3D1 browser xpubless orchestration (UNIT/MOCK ONLY)", () => {
  it("runs P3B only inside one injected fail-fast lock callback", async () => {
    const lockManager = new FakeLockManager();
    const storage = new FakeStorage(lockManager);
    const uuidSource = new DeterministicUuidSource();
    storage.put(V3_KEY, JSON.stringify({ format: "timesats-local-vault-plans", version: 3, plans: [v2Plan()] }));

    const result = await browserRunXpublessV2LegacyMigration({ lockManager, storage, uuidSource });

    expect(result).toEqual({ status: "COMPLETE_XPUBLESS" });
    expectOneFailFastRequest(lockManager);
    expect(lockManager.active).toBe(false);
    expect(storage.operations.length).toBeGreaterThan(0);
    expect(storage.values.has(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)).toBe(true);
    expect(storage.values.has(V3_KEY)).toBe(false);
    expect(storage.values.has(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY)).toBe(false);
  });

  it("runs P3C only inside the same lock domain and discloses only a committed deposit", async () => {
    const lockManager = new FakeLockManager();
    const storage = new FakeStorage(lockManager);
    const expected = initialState();
    storeTarget(storage, expected);

    const result = await browserCommitNextXpublessV2Deposit({ lockManager, storage }, issuanceRequest(expected));

    expect(result.status).toBe("COMMITTED");
    if (result.status !== "COMMITTED") throw new Error("Expected committed issuance.");
    const canonical = deriveDeposit(rehydrateXpublessV2PlanState(expected.plans[0]!, validTestTpub), 1);
    expect(result.deposit).toEqual({ localInstanceId: PLAN_ID, index: 1, address: canonical.address, outputScript: canonical.outputScript });
    expectOneFailFastRequest(lockManager);
    expect(lockManager.active).toBe(false);
    expect(persistedTarget(storage).revision).toBe(1);
    expect(persistedTarget(storage).plans[0]?.issuedOutputs[1]).toEqual({ index: 1, outputScript: canonical.outputScript });
  });

  it("uses the shared lock name for migration and issuance without a second lock request", async () => {
    const migrationLock = new FakeLockManager();
    const migrationStorage = new FakeStorage(migrationLock);
    migrationStorage.put(V3_KEY, JSON.stringify({ format: "timesats-local-vault-plans", version: 3, plans: [v2Plan()] }));
    await browserRunXpublessV2LegacyMigration({
      lockManager: migrationLock,
      storage: migrationStorage,
      uuidSource: new DeterministicUuidSource(),
    });

    const issuanceLock = new FakeLockManager();
    const issuanceStorage = new FakeStorage(issuanceLock);
    const expected = initialState();
    storeTarget(issuanceStorage, expected);
    await browserCommitNextXpublessV2Deposit({ lockManager: issuanceLock, storage: issuanceStorage }, issuanceRequest(expected));

    expectOneFailFastRequest(migrationLock);
    expectOneFailFastRequest(issuanceLock);
  });

  it("replays the same issuance request under a new outer lock without a second target write", async () => {
    const lockManager = new FakeLockManager();
    const storage = new FakeStorage(lockManager);
    const expected = initialState();
    const request = issuanceRequest(expected);
    storeTarget(storage, expected);

    const first = await browserCommitNextXpublessV2Deposit({ lockManager, storage }, request);
    const writesAfterFirst = storage.targetSetCount();
    const replay = await browserCommitNextXpublessV2Deposit({ lockManager, storage }, request);

    expect(first).toEqual(replay);
    expect(replay.status === "COMMITTED" && replay.deposit.index).toBe(1);
    expect(lockManager.requests).toHaveLength(2);
    expect(lockManager.requests.every((entry) => entry.name === XPUBLESS_V2_BROWSER_LOCK_NAME)).toBe(true);
    expect(storage.targetSetCount()).toBe(writesAfterFirst);
    expect(persistedTarget(storage).plans[0]?.lastIssuedIndex).toBe(1);
  });

  it("does not persist the presented source or derived material through the issuance wrapper", async () => {
    const lockManager = new FakeLockManager();
    const storage = new FakeStorage(lockManager);
    const expected = initialState();
    storeTarget(storage, expected);

    const result = await browserCommitNextXpublessV2Deposit({ lockManager, storage }, issuanceRequest(expected));
    if (result.status !== "COMMITTED") throw new Error("Expected committed issuance.");
    const deposit = deriveDeposit(rehydrateXpublessV2PlanState(expected.plans[0]!, validTestTpub), result.deposit.index);
    const serialized = storage.values.get(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)!;

    expect(serialized).not.toContain(validTestTpub);
    expect(serialized).not.toContain(deposit.publicKey);
    expect(serialized).not.toContain(deposit.witnessScript);
    expect(serialized).not.toContain(deposit.descriptor);
    expect(serialized).not.toContain(deposit.address);
  });

  it.each([
    ["migration", "migration"] as const,
    ["issuance", "issuance"] as const,
  ])("returns concurrent-writer blocked with zero storage access when %s lock is unavailable", async (_name, operation) => {
    const lockManager = new FakeLockManager("unavailable");
    const storage = new FakeStorage(lockManager);
    const uuidSource = new DeterministicUuidSource();
    const expected = initialState();

    const result = operation === "migration"
      ? await browserRunXpublessV2LegacyMigration({ lockManager, storage, uuidSource })
      : await browserCommitNextXpublessV2Deposit({ lockManager, storage }, issuanceRequest(expected));

    expect(result).toEqual({ status: "BLOCKED_CONCURRENT_WRITER" });
    expectOneFailFastRequest(lockManager);
    expect(storage.operations).toEqual([]);
    expect(uuidSource.migrationCalls).toBe(0);
    expect(uuidSource.stateCalls).toBe(0);
    expect(uuidSource.localCalls).toBe(0);
  });

  it.each([
    ["migration", "migration"] as const,
    ["issuance", "issuance"] as const,
  ])("returns unsupported with zero storage access when %s has no lock capability", async (_name, operation) => {
    const lockManager = new FakeLockManager();
    const storage = new FakeStorage(lockManager);
    const uuidSource = new DeterministicUuidSource();
    const expected = initialState();

    const result = operation === "migration"
      ? await browserRunXpublessV2LegacyMigration({ storage, uuidSource })
      : await browserCommitNextXpublessV2Deposit({ storage }, issuanceRequest(expected));

    expect(result).toEqual({ status: "UNSUPPORTED_EXCLUSIVE_WRITER" });
    expect(lockManager.requests).toEqual([]);
    expect(storage.operations).toEqual([]);
    expect(uuidSource.migrationCalls).toBe(0);
    expect(uuidSource.stateCalls).toBe(0);
    expect(uuidSource.localCalls).toBe(0);
  });

  it.each(["throw", "reject"] as const)("maps a lock-manager %s to browser coordination failure without storage mutation", async (behavior) => {
    const lockManager = new FakeLockManager(behavior);
    const storage = new FakeStorage(lockManager);
    const uuidSource = new DeterministicUuidSource();

    const result = await browserRunXpublessV2LegacyMigration({ lockManager, storage, uuidSource });

    expect(result).toEqual({ status: "FAILED_BROWSER_COORDINATION" });
    expectOneFailFastRequest(lockManager);
    expect(lockManager.callbackCalls).toBe(0);
    expect(storage.operations).toEqual([]);
    expect(uuidSource.migrationCalls).toBe(0);
  });

  it("preserves P3B storage-failure semantics inside the acquired lock", async () => {
    const lockManager = new FakeLockManager();
    const storage = new FakeStorage(lockManager);
    const uuidSource = new DeterministicUuidSource();
    storage.put(V3_KEY, JSON.stringify({ format: "timesats-local-vault-plans", version: 3, plans: [v2Plan()] }));
    storage.failNextReadInsideLock();

    const result = await browserRunXpublessV2LegacyMigration({ lockManager, storage, uuidSource });

    expect(result).toEqual({ status: "FAILED_RECOVERABLE" });
    expectOneFailFastRequest(lockManager);
    expect(lockManager.callbackCalls).toBe(1);
    expect(storage.operations).toEqual([{ operation: "get", key: V3_KEY }]);
  });

  it("preserves P3C storage-failure semantics inside the acquired lock", async () => {
    const lockManager = new FakeLockManager();
    const storage = new FakeStorage(lockManager);
    const expected = initialState();
    storeTarget(storage, expected);
    storage.failNextTargetWrite();

    const result = await browserCommitNextXpublessV2Deposit({ lockManager, storage }, issuanceRequest(expected));

    expect(result).toEqual({ status: "FAILED_RECOVERABLE" });
    expectOneFailFastRequest(lockManager);
    expect(persistedTarget(storage)).toEqual(expected);
  });

  it.each([
    "create",
    "import",
    "archive",
    "restore archive",
    "hide",
    "restore hidden",
    "remove",
    "rename",
  ] as const)("runs P3E2 %s through exactly one shared fail-fast lock", async (operation) => {
    const lockManager = new FakeLockManager();
    const storage = new FakeStorage(lockManager);
    const base = initialState();

    let result: { status: string };
    switch (operation) {
      case "create":
        result = await browserCommitCreateXpublessV2Plan({ lockManager, storage }, initialPlanRequest());
        break;
      case "import":
        result = await browserCommitImportXpublessV2Plan({ lockManager, storage }, initialPlanRequest());
        break;
      case "archive":
        storeTarget(storage, base);
        result = await browserCommitArchiveXpublessV2Plan({ lockManager, storage }, { expectedState: base, localInstanceId: PLAN_ID });
        break;
      case "restore archive": {
        const archived = stateWithPreferences([PLAN_ID]);
        storeTarget(storage, archived);
        result = await browserCommitRestoreArchivedXpublessV2Plan({ lockManager, storage }, { expectedState: archived, localInstanceId: PLAN_ID });
        break;
      }
      case "hide":
        storeTarget(storage, base);
        result = await browserCommitHideXpublessV2Deposit({ lockManager, storage }, { expectedState: base, localInstanceId: PLAN_ID, depositIndex: 0 });
        break;
      case "restore hidden": {
        const hidden = stateWithPreferences([], { [PLAN_ID]: [0] });
        storeTarget(storage, hidden);
        result = await browserCommitRestoreHiddenXpublessV2Deposit({ lockManager, storage }, { expectedState: hidden, localInstanceId: PLAN_ID, depositIndex: 0 });
        break;
      }
      case "remove":
        storeTarget(storage, base);
        result = await browserCommitRemoveXpublessV2Plan({ lockManager, storage }, { expectedState: base, localInstanceId: PLAN_ID });
        break;
      case "rename":
        storeTarget(storage, base);
        result = await browserCommitRenameXpublessV2Plan({ lockManager, storage }, { expectedState: base, localInstanceId: PLAN_ID, label: "Renamed" });
        break;
    }

    expect(result).toMatchObject({ status: "COMMITTED" });
    expectOneFailFastRequest(lockManager);
    expect(lockManager.callbackCalls).toBe(1);
    expect(lockManager.active).toBe(false);
    expect(storage.operations.length).toBeGreaterThan(0);
  });

  it("keeps P3E2 busy, unsupported, coordination, and engine failures distinct", async () => {
    const request = initialPlanRequest();

    const unavailableLock = new FakeLockManager("unavailable");
    const unavailableStorage = new FakeStorage(unavailableLock);
    expect(await browserCommitCreateXpublessV2Plan({ lockManager: unavailableLock, storage: unavailableStorage }, request)).toEqual({ status: "BLOCKED_CONCURRENT_WRITER" });
    expectOneFailFastRequest(unavailableLock);
    expect(unavailableStorage.operations).toEqual([]);

    const unsupportedLock = new FakeLockManager();
    const unsupportedStorage = new FakeStorage(unsupportedLock);
    expect(await browserCommitCreateXpublessV2Plan({ storage: unsupportedStorage }, request)).toEqual({ status: "UNSUPPORTED_EXCLUSIVE_WRITER" });
    expect(unsupportedLock.requests).toEqual([]);
    expect(unsupportedStorage.operations).toEqual([]);

    const rejectedLock = new FakeLockManager("reject");
    const rejectedStorage = new FakeStorage(rejectedLock);
    expect(await browserCommitCreateXpublessV2Plan({ lockManager: rejectedLock, storage: rejectedStorage }, request)).toEqual({ status: "FAILED_BROWSER_COORDINATION" });
    expectOneFailFastRequest(rejectedLock);
    expect(rejectedStorage.operations).toEqual([]);

    const engineLock = new FakeLockManager();
    const engineStorage = new FakeStorage(engineLock);
    const expected = initialState();
    storeTarget(engineStorage, expected);
    engineStorage.failNextTargetWrite();
    expect(await browserCommitArchiveXpublessV2Plan({ lockManager: engineLock, storage: engineStorage }, { expectedState: expected, localInstanceId: PLAN_ID })).toEqual({ status: "FAILED_RECOVERABLE" });
    expectOneFailFastRequest(engineLock);
    expect(engineLock.callbackCalls).toBe(1);
  });

  it("does not mutate the issuance request and exports no lock capability", async () => {
    const lockManager = new FakeLockManager();
    const storage = new FakeStorage(lockManager);
    const expected = initialState();
    const request = issuanceRequest(expected);
    const requestSnapshot = structuredClone(request);
    storeTarget(storage, expected);

    await browserCommitNextXpublessV2Deposit({ lockManager, storage }, request);

    expect(request).toEqual(requestSnapshot);
    const exported = await import("./xpubless-v2-browser");
    expect(Object.keys(exported)).not.toContain("createAlreadyHeldWriter");
    expect(Object.keys(exported)).not.toContain("runInsideBrowserLock");
  });
});
