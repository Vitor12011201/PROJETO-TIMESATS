import { describe, expect, it } from "vitest";
import { createVaultPlan, deriveIssuedDeposits, issueNextDeposit, vaultPlanIdentity } from "@/bitcoin/vault-plan";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import {
  XPUBLESS_V2_LEGACY_STORAGE_KEYS,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  XpublessV2LocalStateSchema,
  XpublessV2MigrationJournalSchema,
  type XpublessV2LegacyStorageKey,
} from "./xpubless-v2-local-state";
import {
  runXpublessV2LegacyMigration,
  type XpublessV2ExclusiveWriterResult,
  type XpublessV2LegacyMigrationDependencies,
  type XpublessV2MigrationExclusiveWriter,
  type XpublessV2MigrationStorage,
  type XpublessV2MigrationUuidSource,
} from "./xpubless-v2-migration";

const [V3_KEY, V2_KEY, ARCHIVE_KEY, HIDDEN_KEY] = XPUBLESS_V2_LEGACY_STORAGE_KEYS;
const MIGRATION_ID = "a1d5e9b0-11c2-4d3e-8f40-1234567890ab";
const STATE_ID = "b2d5e9b0-11c2-4d3e-8f40-1234567890ab";
const LOCAL_IDS = [
  "c3d5e9b0-11c2-4d3e-8f40-1234567890ab",
  "d4d5e9b0-11c2-4d3e-8f40-1234567890ab",
  "e5d5e9b0-11c2-4d3e-8f40-1234567890ab",
  "f6d5e9b0-11c2-4d3e-8f40-1234567890ab",
];

type Operation = "get" | "set" | "remove";

class FakeExclusiveWriter implements XpublessV2MigrationExclusiveWriter {
  active = false;
  calls = 0;

  constructor(private readonly acquired = true) {}

  runExclusive<T>(operation: () => T): XpublessV2ExclusiveWriterResult<T> {
    this.calls += 1;
    if (!this.acquired) return { acquired: false };
    this.active = true;
    try {
      return { acquired: true, value: operation() };
    } finally {
      this.active = false;
    }
  }
}

class FakeStorage implements XpublessV2MigrationStorage {
  readonly values = new Map<string, string>();
  readonly operations: Array<{ operation: Operation; key: string }> = [];
  private nextFailure: { operation: Operation; key: string; after: boolean } | null = null;
  private failJournalSetAfterRemoveKey: string | null = null;
  private failJournalPhase: { phase: string; after: boolean } | null = null;
  private failNextReadWhenPresentKey: string | null = null;
  private readonly removedKeys = new Set<string>();

  constructor(private writer?: FakeExclusiveWriter) {}

  bindWriter(writer: FakeExclusiveWriter): void {
    this.writer = writer;
  }

  getItem(key: string): string | null {
    this.assertInsideWriter();
    this.operations.push({ operation: "get", key });
    this.throwIfConfigured("get", key, false);
    const value = this.values.get(key) ?? null;
    if (key === this.failNextReadWhenPresentKey && value !== null) {
      this.failNextReadWhenPresentKey = null;
      throw new Error("Injected read failure after a value became present.");
    }
    this.throwIfConfigured("get", key, true);
    return value;
  }

  setItem(key: string, value: string): void {
    this.assertInsideWriter();
    this.operations.push({ operation: "set", key });
    this.throwIfConfigured("set", key, false);
    this.throwIfJournalPhase(key, value, false);
    this.values.set(key, value);
    if (key === XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY
      && this.failJournalSetAfterRemoveKey !== null
      && this.removedKeys.has(this.failJournalSetAfterRemoveKey)) {
      this.failJournalSetAfterRemoveKey = null;
      throw new Error("Injected crash after legacy removal before journal update.");
    }
    this.throwIfJournalPhase(key, value, true);
    this.throwIfConfigured("set", key, true);
  }

  removeItem(key: string): void {
    this.assertInsideWriter();
    this.operations.push({ operation: "remove", key });
    this.throwIfConfigured("remove", key, false);
    this.values.delete(key);
    this.removedKeys.add(key);
    this.throwIfConfigured("remove", key, true);
  }

  put(key: string, value: string): void {
    this.values.set(key, value);
  }

  deleteOutsideMigration(key: string): void {
    this.values.delete(key);
  }

  failNext(operation: Operation, key: string, after = false): void {
    this.nextFailure = { operation, key, after };
  }

  failJournalUpdateAfterRemoving(key: string): void {
    this.failJournalSetAfterRemoveKey = key;
  }

  failNextJournalPhase(phase: string, after = false): void {
    this.failJournalPhase = { phase, after };
  }

  failNextReadWhenPresent(key: string): void {
    this.failNextReadWhenPresentKey = key;
  }

  snapshot(): Array<[string, string]> {
    return [...this.values.entries()].sort(([left], [right]) => left.localeCompare(right));
  }

  private assertInsideWriter(): void {
    if (this.writer && !this.writer.active) throw new Error("Migration storage was accessed outside the exclusive writer.");
  }

  private throwIfConfigured(operation: Operation, key: string, after: boolean): void {
    if (this.nextFailure?.operation === operation && this.nextFailure.key === key && this.nextFailure.after === after) {
      this.nextFailure = null;
      throw new Error("Injected storage failure.");
    }
  }

  private throwIfJournalPhase(key: string, value: string, after: boolean): void {
    if (key === XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY
      && this.failJournalPhase?.after === after
      && value.includes(`"phase":"${this.failJournalPhase.phase}"`)) {
      this.failJournalPhase = null;
      throw new Error("Injected journal phase write failure.");
    }
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
    const value = LOCAL_IDS[this.localCalls];
    this.localCalls += 1;
    if (!value) throw new Error("Test UUID source exhausted.");
    return value;
  }
}

function v2Plan(label: string, lastIssuedIndex = 0, unlockHeight = 250) {
  let plan = createVaultPlan({
    label,
    network: "regtest",
    unlockHeight,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  while (plan.lastIssuedIndex < lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  return plan;
}

function v1Plan(label: string) {
  return createVaultPlan({
    label,
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: validTestTpub,
  });
}

function writeLegacyPlans(storage: FakeStorage, key: XpublessV2LegacyStorageKey, plans: unknown[], version: 2 | 3): void {
  storage.put(key, JSON.stringify({ format: "timesats-local-vault-plans", version, plans }));
}

function dependencies(
  storage: FakeStorage,
  writer = new FakeExclusiveWriter(),
  uuidSource: XpublessV2MigrationUuidSource = new DeterministicUuidSource(),
): XpublessV2LegacyMigrationDependencies {
  storage.bindWriter(writer);
  return { storage, exclusiveWriter: writer, uuidSource };
}

function target(storage: FakeStorage) {
  const raw = storage.values.get(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY);
  return raw === undefined ? null : XpublessV2LocalStateSchema.parse(JSON.parse(raw));
}

function journal(storage: FakeStorage) {
  const raw = storage.values.get(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY);
  return raw === undefined ? null : XpublessV2MigrationJournalSchema.parse(JSON.parse(raw));
}

function completeMigration(storage: FakeStorage, writer?: FakeExclusiveWriter, uuids?: XpublessV2MigrationUuidSource) {
  const selectedWriter = writer ?? new FakeExclusiveWriter();
  const selectedUuids = uuids ?? new DeterministicUuidSource();
  return { result: runXpublessV2LegacyMigration(dependencies(storage, selectedWriter, selectedUuids)), writer: selectedWriter, uuids: selectedUuids };
}

function expectLegacyUnchanged(storage: FakeStorage, before: Array<[string, string]>): void {
  expect(storage.snapshot()).toEqual(before);
}

describe("injected resumable xpubless V2 migration", () => {
  it("runs all storage access after acquisition of the injected writer and completes a V2 snapshot", () => {
    const writer = new FakeExclusiveWriter();
    const storage = new FakeStorage(writer);
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Current")], 3);
    const result = runXpublessV2LegacyMigration(dependencies(storage, writer));

    expect(result).toEqual({ status: "COMPLETE_XPUBLESS" });
    expect(writer.calls).toBe(1);
    expect(storage.operations[0]).toEqual({ operation: "get", key: V3_KEY });
  });

  it("returns no-op only when target, journal, and every legacy surface are absent", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    expect(completeMigration(storage).result).toEqual({ status: "NO_LEGACY_STATE" });
    expect(storage.snapshot()).toEqual([]);
  });

  it("migrates an explicit empty legacy plan snapshot into an empty target", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [], 3);
    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
    expect(target(storage)?.plans).toEqual([]);
    expect(storage.values.has(V3_KEY)).toBe(false);
  });

  it("accepts the current legacy envelope version flexibility independently of physical key", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("v3 physical version 2")], 2);
    writeLegacyPlans(storage, V2_KEY, [v2Plan("v2 physical version 3", 0, 251)], 3);

    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
    expect(target(storage)?.plans.map((plan) => plan.metadata.label)).toEqual(["v3 physical version 2", "v2 physical version 3"]);
  });

  it("uses the limited v2/v3 mirror rule: v3 metadata and maximum issuance", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V2_KEY, [v2Plan("old label", 5)], 2);
    writeLegacyPlans(storage, V3_KEY, [v2Plan("current label", 3)], 3);

    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
    expect(target(storage)?.plans).toHaveLength(1);
    expect(target(storage)?.plans[0].metadata.label).toBe("current label");
    expect(target(storage)?.plans[0].lastIssuedIndex).toBe(5);
    expect(target(storage)?.plans[0].issuedOutputs.map((output) => output.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("preserves v2-only plans after v3 plans in deterministic migration order", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const planA = v2Plan("A");
    const planB = v2Plan("B", 1, 251);
    writeLegacyPlans(storage, V3_KEY, [planA], 3);
    writeLegacyPlans(storage, V2_KEY, [planA, planB], 2);

    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
    expect(target(storage)?.plans.map((plan) => plan.metadata.label)).toEqual(["A", "B"]);
  });

  it("remaps archive and hidden preferences to local IDs without persisting legacy identities", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const plan = v2Plan("Preferences", 2);
    const identity = vaultPlanIdentity(plan);
    writeLegacyPlans(storage, V3_KEY, [plan], 3);
    storage.put(ARCHIVE_KEY, JSON.stringify([identity, identity]));
    storage.put(HIDDEN_KEY, JSON.stringify({ [identity]: [2, 0, 2] }));

    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
    const migrated = target(storage)!;
    expect(migrated.archivedLocalInstanceIds).toEqual([LOCAL_IDS[0]]);
    expect(migrated.hiddenDepositIndexes).toEqual({ [LOCAL_IDS[0]]: [0, 2] });
    const persisted = storage.values.get(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)!;
    expect(persisted).not.toContain(identity);
  });

  it("keeps the completed target free of legacy tpub, identity, child keys, witness scripts, and descriptors", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const plan = v2Plan("Exposure", 1);
    const identity = vaultPlanIdentity(plan);
    const deposits = deriveIssuedDeposits(plan);
    writeLegacyPlans(storage, V3_KEY, [plan], 3);

    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
    const persisted = storage.values.get(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)!;
    expect(persisted).not.toContain(validTestTpub);
    expect(persisted).not.toContain(identity);
    deposits.forEach((deposit) => {
      expect(persisted).not.toContain(deposit.publicKey);
      expect(persisted).not.toContain(deposit.witnessScript);
      expect(persisted).not.toContain(deposit.descriptor);
    });
  });

  it.each([
    ["V1 in v3", () => ({ v3: [v1Plan("V1")], v2: [] })],
    ["V1 in v2 beside V2", () => ({ v3: [v2Plan("V2")], v2: [v1Plan("V1")] })],
  ])("blocks %s before any mutation", (_name, setup) => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const fixture = setup();
    if (fixture.v3.length > 0) writeLegacyPlans(storage, V3_KEY, fixture.v3, 3);
    if (fixture.v2.length > 0) writeLegacyPlans(storage, V2_KEY, fixture.v2, 2);
    const before = storage.snapshot();

    expect(completeMigration(storage).result).toEqual({ status: "BLOCKED_UNSUPPORTED_V1" });
    expectLegacyUnchanged(storage, before);
  });

  it.each([
    ["inside v3", V3_KEY],
    ["inside v2", V2_KEY],
  ])("blocks duplicate canonical identity %s before any mutation", (_name, key) => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const plan = v2Plan("Duplicate");
    writeLegacyPlans(storage, key, [plan, plan], key === V3_KEY ? 3 : 2);
    const before = storage.snapshot();

    expect(completeMigration(storage).result).toEqual({ status: "BLOCKED_DUPLICATE_SEMANTICS" });
    expectLegacyUnchanged(storage, before);
  });

  it.each([
    ["archive orphan", ARCHIVE_KEY, JSON.stringify(["unknown legacy identity"])],
    ["hidden orphan", HIDDEN_KEY, JSON.stringify({ "unknown legacy identity": [0] })],
  ])("blocks %s before cleanup", (_name, key, value) => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Known")], 3);
    storage.put(key, value);
    const before = storage.snapshot();

    expect(completeMigration(storage).result).toEqual({ status: "BLOCKED_ORPHAN_LEGACY_PREFERENCES" });
    expectLegacyUnchanged(storage, before);
  });

  it("blocks a hidden index beyond issuance without deleting legacy", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const plan = v2Plan("Hidden");
    writeLegacyPlans(storage, V3_KEY, [plan], 3);
    storage.put(HIDDEN_KEY, JSON.stringify({ [vaultPlanIdentity(plan)]: [1] }));
    const before = storage.snapshot();

    expect(completeMigration(storage).result).toEqual({ status: "BLOCKED_HIDDEN_INDEX_OUTSIDE_ISSUANCE" });
    expectLegacyUnchanged(storage, before);
  });

  it.each([
    ["malformed v3", V3_KEY, "{invalid"],
    ["malformed archive", ARCHIVE_KEY, "{invalid"],
    ["malformed hidden", HIDDEN_KEY, "{invalid"],
  ])("fails closed for %s even if another legacy entry is valid", (_name, key, value) => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V2_KEY, [v2Plan("Valid v2")], 2);
    storage.put(key, value);
    const before = storage.snapshot();

    expect(completeMigration(storage).result).toEqual({ status: "FAILED_RECOVERABLE" });
    expectLegacyUnchanged(storage, before);
  });

  it("blocks valid target plus legacy without a journal and fails invalid target with intact legacy", () => {
    const ambiguous = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(ambiguous, V3_KEY, [v2Plan("Legacy")], 3);
    const source = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(source, V3_KEY, [v2Plan("Target")], 3);
    expect(completeMigration(source).result.status).toBe("COMPLETE_XPUBLESS");
    ambiguous.put(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, source.values.get(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)!);
    const ambiguousBefore = ambiguous.snapshot();

    expect(completeMigration(ambiguous).result).toEqual({ status: "BLOCKED_AMBIGUOUS_COEXISTENCE" });
    expectLegacyUnchanged(ambiguous, ambiguousBefore);

    const invalid = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(invalid, V3_KEY, [v2Plan("Legacy")], 3);
    invalid.put(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, "{invalid");
    const invalidBefore = invalid.snapshot();
    expect(completeMigration(invalid).result).toEqual({ status: "FAILED_RECOVERABLE" });
    expectLegacyUnchanged(invalid, invalidBefore);
  });

  it("fails closed for an invalid journal without deleting legacy", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Legacy")], 3);
    storage.put(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY, "{invalid");
    const before = storage.snapshot();
    expect(completeMigration(storage).result).toEqual({ status: "FAILED_RECOVERABLE" });
    expectLegacyUnchanged(storage, before);
  });

  it("returns concurrent-writer blocked with zero mutation", () => {
    const storage = new FakeStorage();
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Locked")], 3);
    const before = storage.snapshot();
    const writer = new FakeExclusiveWriter(false);

    expect(runXpublessV2LegacyMigration(dependencies(storage, writer))).toEqual({ status: "BLOCKED_CONCURRENT_WRITER" });
    expect(writer.calls).toBe(1);
    expectLegacyUnchanged(storage, before);
  });

  it.each([
    ["invalid", () => "not-a-uuid"],
    ["duplicate", () => LOCAL_IDS[0]],
  ])("fails closed when the UUID source returns %s local instance IDs", (_name, nextLocalInstanceId) => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("UUID A"), v2Plan("UUID B", 0, 251)], 3);
    const uuidSource: XpublessV2MigrationUuidSource = {
      nextMigrationId: () => MIGRATION_ID,
      nextStateId: () => STATE_ID,
      nextLocalInstanceId,
    };

    expect(runXpublessV2LegacyMigration(dependencies(storage, undefined, uuidSource)).status).toBe("FAILED_RECOVERABLE");
    expect(storage.values.has(V3_KEY)).toBe(true);
    expect(storage.values.has(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)).toBe(false);
  });

  it("keeps legacy intact when writing PREPARED fails, then can start cleanly on retry", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Prepared")], 3);
    const before = storage.snapshot();
    storage.failNext("set", XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY);

    expect(completeMigration(storage).result.status).toBe("FAILED_RECOVERABLE");
    expectLegacyUnchanged(storage, before);
    expect(storage.values.has(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)).toBe(false);
    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
  });

  it("resumes PREPARED with target absent without regenerating migration or state IDs", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const uuids = new DeterministicUuidSource();
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Prepared absent")], 3);
    storage.failNext("set", XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY);

    expect(completeMigration(storage, undefined, uuids).result.status).toBe("FAILED_RECOVERABLE");
    expect(journal(storage)?.phase).toBe("PREPARED");
    expect(target(storage)).toBeNull();
    expect(uuids.migrationCalls).toBe(1);
    expect(uuids.stateCalls).toBe(1);

    expect(completeMigration(storage, undefined, uuids).result.status).toBe("COMPLETE_XPUBLESS");
    expect(uuids.migrationCalls).toBe(1);
    expect(uuids.stateCalls).toBe(1);
  });

  it("validates and reuses a target written before PREPARED read-back verification", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const uuids = new DeterministicUuidSource();
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Prepared target")], 3);
    storage.failNextReadWhenPresent(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY);

    expect(completeMigration(storage, undefined, uuids).result.status).toBe("FAILED_RECOVERABLE");
    const persistedTarget = target(storage)!;
    expect(journal(storage)?.phase).toBe("PREPARED");
    expect(uuids.localCalls).toBe(1);

    expect(completeMigration(storage, undefined, uuids).result.status).toBe("COMPLETE_XPUBLESS");
    expect(uuids.localCalls).toBe(1);
    expect(target(storage)?.plans[0].localInstanceId).toBe(persistedTarget.plans[0].localInstanceId);
  });

  it("does not delete legacy before CLEANUP_PENDING is persisted and resumes TARGET_VERIFIED", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Target verified")], 3);
    storage.failNextJournalPhase("CLEANUP_PENDING");

    expect(completeMigration(storage).result.status).toBe("FAILED_RECOVERABLE");
    expect(journal(storage)?.phase).toBe("TARGET_VERIFIED");
    expect(storage.values.has(V3_KEY)).toBe(true);
    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
  });

  it("resumes CLEANUP_PENDING after a failure before the first delete", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Cleanup pending")], 3);
    storage.failNext("remove", V3_KEY);

    expect(completeMigration(storage).result.status).toBe("FAILED_RECOVERABLE");
    expect(journal(storage)?.phase).toBe("CLEANUP_PENDING");
    expect(storage.values.has(V3_KEY)).toBe(true);
    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
  });

  it.each(XPUBLESS_V2_LEGACY_STORAGE_KEYS)("resumes when %s was removed before its journal update", (legacyKey) => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("All surfaces")], 3);
    storage.put(ARCHIVE_KEY, JSON.stringify([]));
    storage.put(HIDDEN_KEY, JSON.stringify({}));
    storage.put(V2_KEY, JSON.stringify({ format: "timesats-local-vault-plans", version: 2, plans: [] }));
    storage.failJournalUpdateAfterRemoving(legacyKey);

    expect(completeMigration(storage).result.status).toBe("FAILED_RECOVERABLE");
    expect(storage.values.has(legacyKey)).toBe(false);
    expect(journal(storage)?.phase).toBe("CLEANUP_PENDING");
    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
  });

  it("resumes from the next key after a journal update has already recorded the previous removal", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Next removal")], 3);
    storage.put(V2_KEY, JSON.stringify({ format: "timesats-local-vault-plans", version: 2, plans: [] }));
    storage.failNext("remove", V2_KEY);

    expect(completeMigration(storage).result.status).toBe("FAILED_RECOVERABLE");
    expect(storage.values.has(V3_KEY)).toBe(false);
    expect(journal(storage)?.remainingLegacyKeys).toEqual([V2_KEY]);
    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
  });

  it("resumes after all legacy keys are gone before COMPLETE and removes a terminal COMPLETE journal", () => {
    const beforeComplete = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(beforeComplete, V3_KEY, [v2Plan("Before complete")], 3);
    beforeComplete.failNextJournalPhase("COMPLETE");

    expect(completeMigration(beforeComplete).result.status).toBe("FAILED_RECOVERABLE");
    expect(journal(beforeComplete)?.phase).toBe("CLEANUP_PENDING");
    expect(XPUBLESS_V2_LEGACY_STORAGE_KEYS.every((key) => !beforeComplete.values.has(key))).toBe(true);
    expect(completeMigration(beforeComplete).result.status).toBe("COMPLETE_XPUBLESS");

    const beforeJournalDelete = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(beforeJournalDelete, V3_KEY, [v2Plan("Before journal delete")], 3);
    beforeJournalDelete.failNext("remove", XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY);
    expect(completeMigration(beforeJournalDelete).result.status).toBe("FAILED_RECOVERABLE");
    expect(journal(beforeJournalDelete)?.phase).toBe("COMPLETE");
    expect(completeMigration(beforeJournalDelete).result.status).toBe("COMPLETE_XPUBLESS");
  });

  it("converges when terminal journal removal succeeded but the original caller observed failure", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Terminal delete")], 3);
    storage.failNext("remove", XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY, true);

    expect(completeMigration(storage).result.status).toBe("FAILED_RECOVERABLE");
    expect(storage.values.has(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY)).toBe(false);
    expect(target(storage)).not.toBeNull();
    expect(completeMigration(storage).result).toEqual({ status: "COMPLETE_XPUBLESS" });
  });

  it("fails closed for a corrupt target during cleanup without deleting additional legacy state", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Corrupt target")], 3);
    storage.failNext("remove", V3_KEY);
    expect(completeMigration(storage).result.status).toBe("FAILED_RECOVERABLE");
    storage.put(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, "{invalid");
    const v3Before = storage.values.get(V3_KEY);

    expect(completeMigration(storage).result).toEqual({ status: "FAILED_RECOVERABLE" });
    expect(storage.values.get(V3_KEY)).toBe(v3Before);
  });

  it("fails closed for out-of-order disappearance and resurrected legacy keys", () => {
    const outOfOrder = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(outOfOrder, V3_KEY, [v2Plan("Order")], 3);
    outOfOrder.put(V2_KEY, JSON.stringify({ format: "timesats-local-vault-plans", version: 2, plans: [] }));
    outOfOrder.failNext("remove", V3_KEY);
    expect(completeMigration(outOfOrder).result.status).toBe("FAILED_RECOVERABLE");
    outOfOrder.deleteOutsideMigration(V2_KEY);
    expect(completeMigration(outOfOrder).result).toEqual({ status: "FAILED_RECOVERABLE" });
    expect(outOfOrder.values.has(V3_KEY)).toBe(true);

    const resurrected = new FakeStorage(new FakeExclusiveWriter());
    const originalV3 = JSON.stringify({ format: "timesats-local-vault-plans", version: 3, plans: [v2Plan("Resurrected")] });
    resurrected.put(V3_KEY, originalV3);
    resurrected.put(V2_KEY, JSON.stringify({ format: "timesats-local-vault-plans", version: 2, plans: [] }));
    resurrected.failNext("remove", V2_KEY);
    expect(completeMigration(resurrected).result.status).toBe("FAILED_RECOVERABLE");
    expect(journal(resurrected)?.remainingLegacyKeys).toEqual([V2_KEY]);
    resurrected.put(V3_KEY, originalV3);
    expect(completeMigration(resurrected).result).toEqual({ status: "FAILED_RECOVERABLE" });
  });

  it("stops after quota-like target write failure without cleanup and resumes later", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    writeLegacyPlans(storage, V3_KEY, [v2Plan("Quota")], 3);
    storage.failNext("set", XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY);

    expect(completeMigration(storage).result.status).toBe("FAILED_RECOVERABLE");
    expect(storage.values.has(V3_KEY)).toBe(true);
    expect(storage.values.has(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)).toBe(false);
    expect(completeMigration(storage).result.status).toBe("COMPLETE_XPUBLESS");
  });
});
