import { HDKey } from "@scure/bip32";
import { describe, expect, it } from "vitest";
import {
  createXpublessV2PlanState,
  rehydrateXpublessV2PlanState,
  appendIssuedDepositToXpublessV2PlanState,
} from "@/bitcoin/xpubless-v2-plan-state";
import { testnetBip32Versions } from "@/bitcoin/bip32";
import { createVaultPlan, deriveDeposit, issueNextDeposit } from "@/bitcoin/vault-plan";
import { MAX_NON_HARDENED_INDEX } from "@/domain/vault-plan";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import {
  XPUBLESS_V2_LEGACY_STORAGE_KEYS,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  XpublessV2LocalStateSchema,
  buildNextXpublessV2LocalState,
  createInitialXpublessV2LocalState,
  type XpublessV2LocalState,
} from "./xpubless-v2-local-state";
import {
  commitNextXpublessV2Deposit,
  nextXpublessV2DepositIndex,
  type XpublessV2CommittedIssuanceDependencies,
  type XpublessV2CommittedIssuanceExclusiveWriter,
  type XpublessV2CommittedIssuanceStorage,
  type XpublessV2CommittedIssuanceWriterResult,
} from "./xpubless-v2-committed-issuance";

const STATE_ID = "13d5e9b0-11c2-4d3e-8f40-1234567890ab";
const FIRST_PLAN_ID = "23d5e9b0-11c2-4d3e-8f40-1234567890ab";
const SECOND_PLAN_ID = "33d5e9b0-11c2-4d3e-8f40-1234567890ab";
const THIRD_PLAN_ID = "53d5e9b0-11c2-4d3e-8f40-1234567890ab";

type Operation = "get" | "set";

class FakeExclusiveWriter implements XpublessV2CommittedIssuanceExclusiveWriter {
  active = false;
  calls = 0;

  constructor(private readonly acquired = true) {}

  runExclusive<T>(operation: () => T): XpublessV2CommittedIssuanceWriterResult<T> {
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

class FakeStorage implements XpublessV2CommittedIssuanceStorage {
  readonly values = new Map<string, string>();
  readonly operations: Array<{ operation: Operation; key: string }> = [];
  private failSetBefore = false;
  private failSetAfter = false;
  private failReadbackAfterSet = false;
  private failTargetRead = false;

  constructor(private writer?: FakeExclusiveWriter) {}

  bindWriter(writer: FakeExclusiveWriter): void {
    this.writer = writer;
  }

  getItem(key: string): string | null {
    this.assertInsideWriter();
    this.operations.push({ operation: "get", key });
    if (key === XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY && this.failTargetRead) {
      this.failTargetRead = false;
      throw new Error("Injected target read-back failure.");
    }
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.assertInsideWriter();
    this.operations.push({ operation: "set", key });
    if (key === XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY && this.failSetBefore) {
      this.failSetBefore = false;
      throw new Error("Injected target write failure before mutation.");
    }
    this.values.set(key, value);
    if (key === XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY && this.failReadbackAfterSet) {
      this.failReadbackAfterSet = false;
      this.failTargetRead = true;
    }
    if (key === XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY && this.failSetAfter) {
      this.failSetAfter = false;
      throw new Error("Injected target write failure after mutation.");
    }
  }

  put(key: string, value: string): void {
    this.values.set(key, value);
  }

  failNextTargetSetBeforeMutation(): void {
    this.failSetBefore = true;
  }

  failNextTargetSetAfterMutation(): void {
    this.failSetAfter = true;
  }

  failNextTargetReadbackAfterSet(): void {
    this.failReadbackAfterSet = true;
  }

  setCount(): number {
    return this.operations.filter((operation) => operation.operation === "set").length;
  }

  private assertInsideWriter(): void {
    if (this.writer && !this.writer.active) throw new Error("Storage was accessed outside the injected exclusive writer.");
  }
}

function v2Plan(lastIssuedIndex = 0, label = "Committed issuance") {
  let plan = createVaultPlan({
    label,
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  while (plan.lastIssuedIndex < lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  return plan;
}

function envelope(lastIssuedIndex = 0, withSecondPlan = false): XpublessV2LocalState {
  const firstPlan = v2Plan(lastIssuedIndex, "Primary");
  const plans = [createXpublessV2PlanState(firstPlan, FIRST_PLAN_ID)];
  if (withSecondPlan) plans.push(createXpublessV2PlanState(v2Plan(0, "Secondary"), SECOND_PLAN_ID));
  return createInitialXpublessV2LocalState({
    stateId: STATE_ID,
    plans,
    archivedLocalInstanceIds: withSecondPlan ? [SECOND_PLAN_ID] : [],
    hiddenDepositIndexes: withSecondPlan ? { [SECOND_PLAN_ID]: [0] } : {},
  });
}

function envelopeWithTwoHiddenPreferences(): XpublessV2LocalState {
  return createInitialXpublessV2LocalState({
    stateId: STATE_ID,
    plans: [
      createXpublessV2PlanState(v2Plan(0, "Primary"), FIRST_PLAN_ID),
      createXpublessV2PlanState(v2Plan(0, "Secondary"), SECOND_PLAN_ID),
      createXpublessV2PlanState(v2Plan(0, "Tertiary"), THIRD_PLAN_ID),
    ],
    archivedLocalInstanceIds: [],
    hiddenDepositIndexes: { [SECOND_PLAN_ID]: [0], [THIRD_PLAN_ID]: [0] },
  });
}

function dependencies(storage: FakeStorage, writer = new FakeExclusiveWriter()): XpublessV2CommittedIssuanceDependencies {
  storage.bindWriter(writer);
  return { storage, exclusiveWriter: writer };
}

function storeTarget(storage: FakeStorage, state: XpublessV2LocalState): void {
  storage.put(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, JSON.stringify(state));
}

function persistedTarget(storage: FakeStorage): XpublessV2LocalState {
  return XpublessV2LocalStateSchema.parse(JSON.parse(storage.values.get(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)!));
}

function request(expectedState: XpublessV2LocalState, localInstanceId = FIRST_PLAN_ID, presentedExtendedPublicKey = validTestTpub) {
  return { expectedState, localInstanceId, presentedExtendedPublicKey };
}

function unrelatedPublicTpub(): string {
  const original = HDKey.fromExtendedKey(validTestTpub, testnetBip32Versions);
  const child = original.deriveChild(1);
  if (child.publicKey === null || child.chainCode === null) throw new Error("Expected public BIP32 child material.");
  return new HDKey({
    versions: testnetBip32Versions,
    publicKey: child.publicKey,
    chainCode: child.chainCode,
    depth: original.depth,
    index: original.index,
    parentFingerprint: original.parentFingerprint,
  }).publicExtendedKey;
}

function mainnetPublicXpub(): string {
  const original = HDKey.fromExtendedKey(validTestTpub, testnetBip32Versions);
  if (original.publicKey === null || original.chainCode === null) throw new Error("Expected public BIP32 material.");
  return new HDKey({
    versions: { public: 0x0488b21e, private: 0x0488ade4 },
    publicKey: original.publicKey,
    chainCode: original.chainCode,
    depth: original.depth,
    index: original.index,
    parentFingerprint: original.parentFingerprint,
  }).publicExtendedKey;
}

function advanceState(state: XpublessV2LocalState): XpublessV2LocalState {
  const currentPlan = state.plans[0];
  if (!currentPlan) throw new Error("Expected primary plan.");
  const rehydrated = rehydrateXpublessV2PlanState(currentPlan, validTestTpub);
  const nextDeposit = deriveDeposit(rehydrated, currentPlan.lastIssuedIndex + 1);
  const nextPlan = appendIssuedDepositToXpublessV2PlanState(
    currentPlan,
    rehydrated,
    { index: nextDeposit.index, outputScript: nextDeposit.outputScript },
  );
  return buildNextXpublessV2LocalState(state, {
    plans: [nextPlan, ...state.plans.slice(1)],
    archivedLocalInstanceIds: state.archivedLocalInstanceIds,
    hiddenDepositIndexes: state.hiddenDepositIndexes,
  });
}

describe("injected committed xpubless V2 deposit issuance", () => {
  it("treats the maximum non-hardened index as exhausted without allocating a maximal state fixture", () => {
    expect(nextXpublessV2DepositIndex(MAX_NON_HARDENED_INDEX - 1)).toBe(MAX_NON_HARDENED_INDEX);
    expect(nextXpublessV2DepositIndex(MAX_NON_HARDENED_INDEX)).toBeNull();
  });

  it("reads only after writer acquisition, commits #1 from #0, and discloses only committed data", () => {
    const writer = new FakeExclusiveWriter();
    const storage = new FakeStorage(writer);
    const expected = envelope(0);
    storeTarget(storage, expected);

    const result = commitNextXpublessV2Deposit(dependencies(storage, writer), request(expected));

    expect(result.status).toBe("COMMITTED");
    if (result.status !== "COMMITTED") throw new Error("Expected committed issuance.");
    const canonical = deriveDeposit(v2Plan(0), 1);
    expect(result.deposit).toEqual({ localInstanceId: FIRST_PLAN_ID, index: 1, address: canonical.address, outputScript: canonical.outputScript });
    expect(result.stateId).toBe(STATE_ID);
    expect(result.revision).toBe(1);
    expect(writer.calls).toBe(1);
    expect(storage.operations[0]).toEqual({ operation: "get", key: XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY });
    expect(persistedTarget(storage).plans[0]?.issuedOutputs[1]).toEqual({ index: 1, outputScript: canonical.outputScript });
  });

  it("commits #4 from #3 while preserving state identity, HIC, preferences, label, and other plans", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const expected = envelope(3, true);
    const expectedSnapshot = structuredClone(expected);
    const primaryHic = expected.plans[0]?.historicalIdentityCommitment;
    const secondaryPlan = expected.plans[1];
    storeTarget(storage, expected);

    const result = commitNextXpublessV2Deposit(dependencies(storage), request(expected));

    expect(result.status).toBe("COMMITTED");
    const persisted = persistedTarget(storage);
    expect(persisted.revision).toBe(1);
    expect(persisted.stateId).toBe(STATE_ID);
    expect(persisted.plans[0]?.lastIssuedIndex).toBe(4);
    expect(persisted.plans[0]?.historicalIdentityCommitment).toEqual(primaryHic);
    expect(persisted.plans[0]?.metadata).toEqual(expected.plans[0]?.metadata);
    expect(persisted.plans[1]).toEqual(secondaryPlan);
    expect(persisted.archivedLocalInstanceIds).toEqual(expected.archivedLocalInstanceIds);
    expect(persisted.hiddenDepositIndexes).toEqual(expected.hiddenDepositIndexes);
    expect(expected).toEqual(expectedSnapshot);
  });

  it("does not persist the presented source or derived public material", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const expected = envelope(0);
    storeTarget(storage, expected);
    const result = commitNextXpublessV2Deposit(dependencies(storage), request(expected));
    if (result.status !== "COMMITTED") throw new Error("Expected committed issuance.");

    const rehydrated = rehydrateXpublessV2PlanState(expected.plans[0]!, validTestTpub);
    const deposit = deriveDeposit(rehydrated, result.deposit.index);
    const serialized = storage.values.get(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)!;
    expect(serialized).not.toContain(validTestTpub);
    expect(serialized).not.toContain(deposit.publicKey);
    expect(serialized).not.toContain(deposit.witnessScript);
    expect(serialized).not.toContain(deposit.descriptor);
    expect(serialized).not.toContain(deposit.address);
  });

  it("is idempotent after a successful request and performs no additional write", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const expected = envelope(0);
    storeTarget(storage, expected);
    const first = commitNextXpublessV2Deposit(dependencies(storage), request(expected));
    const writesAfterFirst = storage.setCount();
    const retry = commitNextXpublessV2Deposit(dependencies(storage), request(expected));

    expect(first).toEqual(retry);
    expect(retry.status).toBe("COMMITTED");
    expect(storage.setCount()).toBe(writesAfterFirst);
    expect(persistedTarget(storage).plans[0]?.lastIssuedIndex).toBe(1);
  });

  it("requires the public source and storage-authority gate again before replay disclosure", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const expected = envelope(0);
    storeTarget(storage, expected);
    expect(commitNextXpublessV2Deposit(dependencies(storage), request(expected)).status).toBe("COMMITTED");
    const writesAfterCommit = storage.setCount();

    expect(commitNextXpublessV2Deposit(
      dependencies(storage),
      request(expected, FIRST_PLAN_ID, unrelatedPublicTpub()),
    )).toEqual({ status: "BLOCKED_PUBLIC_SOURCE_MISMATCH" });
    expect(storage.setCount()).toBe(writesAfterCommit);

    storage.put(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY, "{}");
    expect(commitNextXpublessV2Deposit(dependencies(storage), request(expected))).toEqual({ status: "BLOCKED_STORAGE_NOT_READY" });
    expect(storage.setCount()).toBe(writesAfterCommit);
  });

  it("replays #4 after a lost successful result without issuing #5", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const expected = envelope(3);
    storeTarget(storage, expected);
    const first = commitNextXpublessV2Deposit(dependencies(storage), request(expected));
    if (first.status !== "COMMITTED") throw new Error("Expected #4 to commit.");
    const writesAfterFirst = storage.setCount();

    const replay = commitNextXpublessV2Deposit(dependencies(storage), request(expected));
    expect(replay).toEqual(first);
    expect(replay.status === "COMMITTED" && replay.deposit.index).toBe(4);
    expect(persistedTarget(storage).plans[0]?.lastIssuedIndex).toBe(4);
    expect(storage.setCount()).toBe(writesAfterFirst);
  });

  it("does not classify a semantically equal hidden-preference map as stale solely because object keys were inserted differently", () => {
    const expected = envelopeWithTwoHiddenPreferences();
    const storage = new FakeStorage(new FakeExclusiveWriter());
    storeTarget(storage, {
      ...expected,
      hiddenDepositIndexes: { [THIRD_PLAN_ID]: [0], [SECOND_PLAN_ID]: [0] },
    });

    expect(commitNextXpublessV2Deposit(dependencies(storage), request(expected)).status).toBe("COMMITTED");
    expect(persistedTarget(storage).plans[0]?.lastIssuedIndex).toBe(1);
  });

  it.each([
    ["read-back", (storage: FakeStorage) => storage.failNextTargetReadbackAfterSet()],
    ["set after mutation", (storage: FakeStorage) => storage.failNextTargetSetAfterMutation()],
  ])("does not disclose after %s uncertainty and retries as the same #N+1 without a new write", (_name, fail) => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const expected = envelope(0);
    storeTarget(storage, expected);
    fail(storage);

    expect(commitNextXpublessV2Deposit(dependencies(storage), request(expected))).toEqual({ status: "FAILED_RECOVERABLE" });
    expect(persistedTarget(storage).plans[0]?.lastIssuedIndex).toBe(1);
    const writesBeforeRetry = storage.setCount();
    const retry = commitNextXpublessV2Deposit(dependencies(storage), request(expected));
    expect(retry.status).toBe("COMMITTED");
    if (retry.status === "COMMITTED") expect(retry.deposit.index).toBe(1);
    expect(storage.setCount()).toBe(writesBeforeRetry);
  });

  it("retries normally when failure occurs before the target write", () => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const expected = envelope(0);
    storeTarget(storage, expected);
    storage.failNextTargetSetBeforeMutation();

    expect(commitNextXpublessV2Deposit(dependencies(storage), request(expected))).toEqual({ status: "FAILED_RECOVERABLE" });
    expect(persistedTarget(storage)).toEqual(expected);
    expect(commitNextXpublessV2Deposit(dependencies(storage), request(expected)).status).toBe("COMMITTED");
    expect(persistedTarget(storage).plans[0]?.lastIssuedIndex).toBe(1);
  });

  it.each([
    ["label", (state: XpublessV2LocalState) => buildNextXpublessV2LocalState(state, {
      plans: state.plans.map((plan) => plan.localInstanceId === FIRST_PLAN_ID ? { ...plan, metadata: { label: "Renamed" } } : plan),
      archivedLocalInstanceIds: state.archivedLocalInstanceIds,
      hiddenDepositIndexes: state.hiddenDepositIndexes,
    })],
    ["archive", (state: XpublessV2LocalState) => {
      return buildNextXpublessV2LocalState(state, {
        plans: state.plans,
        archivedLocalInstanceIds: [],
        hiddenDepositIndexes: state.hiddenDepositIndexes,
      });
    }],
    ["hidden", (state: XpublessV2LocalState) => {
      return buildNextXpublessV2LocalState(state, {
        plans: state.plans,
        archivedLocalInstanceIds: state.archivedLocalInstanceIds,
        hiddenDepositIndexes: {},
      });
    }],
    ["other plan", (state: XpublessV2LocalState) => {
      return buildNextXpublessV2LocalState(state, {
        plans: state.plans.map((plan) => plan.localInstanceId === SECOND_PLAN_ID ? { ...plan, metadata: { label: "Other renamed" } } : plan),
        archivedLocalInstanceIds: state.archivedLocalInstanceIds,
        hiddenDepositIndexes: state.hiddenDepositIndexes,
      });
    }],
    ["target plan ahead", (state: XpublessV2LocalState) => advanceState(advanceState(state))],
    ["state ID", (state: XpublessV2LocalState) => ({ ...state, stateId: "43d5e9b0-11c2-4d3e-8f40-1234567890ab" })],
  ])("blocks stale state changed by %s without writing", (_name, mutate) => {
    const expected = envelope(0, true);
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const stale = mutate(expected);
    storeTarget(storage, stale);

    expect(commitNextXpublessV2Deposit(dependencies(storage), request(expected))).toEqual({ status: "BLOCKED_STALE_STATE" });
    expect(storage.setCount()).toBe(0);
  });

  it.each([
    ["journal", (storage: FakeStorage) => storage.put(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY, "{}")],
    ["legacy v3", (storage: FakeStorage) => storage.put(XPUBLESS_V2_LEGACY_STORAGE_KEYS[0], "{}")],
    ["legacy v2", (storage: FakeStorage) => storage.put(XPUBLESS_V2_LEGACY_STORAGE_KEYS[1], "{}")],
    ["legacy archive", (storage: FakeStorage) => storage.put(XPUBLESS_V2_LEGACY_STORAGE_KEYS[2], "{}")],
    ["legacy hidden", (storage: FakeStorage) => storage.put(XPUBLESS_V2_LEGACY_STORAGE_KEYS[3], "{}")],
  ])("blocks issuance while %s exists", (_name, prepare) => {
    const storage = new FakeStorage(new FakeExclusiveWriter());
    const expected = envelope(0);
    storeTarget(storage, expected);
    prepare(storage);

    expect(commitNextXpublessV2Deposit(dependencies(storage), request(expected))).toEqual({ status: "BLOCKED_STORAGE_NOT_READY" });
    expect(storage.setCount()).toBe(0);
  });

  it("blocks absent or malformed targets, missing plans, public-source mismatches, and writer refusal before writing", () => {
    const absent = new FakeStorage(new FakeExclusiveWriter());
    const expected = envelope(0);
    expect(commitNextXpublessV2Deposit(dependencies(absent), request(expected))).toEqual({ status: "NO_XPUBLESS_STATE" });

    const malformed = new FakeStorage(new FakeExclusiveWriter());
    malformed.put(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, "{invalid");
    expect(commitNextXpublessV2Deposit(dependencies(malformed), request(expected))).toEqual({ status: "FAILED_RECOVERABLE" });

    const missingPlan = new FakeStorage(new FakeExclusiveWriter());
    storeTarget(missingPlan, expected);
    expect(commitNextXpublessV2Deposit(dependencies(missingPlan), request(expected, SECOND_PLAN_ID))).toEqual({ status: "BLOCKED_PLAN_NOT_FOUND" });

    const wrongSource = new FakeStorage(new FakeExclusiveWriter());
    storeTarget(wrongSource, expected);
    expect(commitNextXpublessV2Deposit(dependencies(wrongSource), request(expected, FIRST_PLAN_ID, unrelatedPublicTpub()))).toEqual({ status: "BLOCKED_PUBLIC_SOURCE_MISMATCH" });

    const malformedSource = new FakeStorage(new FakeExclusiveWriter());
    storeTarget(malformedSource, expected);
    expect(commitNextXpublessV2Deposit(dependencies(malformedSource), request(expected, FIRST_PLAN_ID, "tprv8ZgxMBicQKsPe"))).toEqual({ status: "BLOCKED_PUBLIC_SOURCE_MISMATCH" });

    const mainnetSource = new FakeStorage(new FakeExclusiveWriter());
    storeTarget(mainnetSource, expected);
    expect(commitNextXpublessV2Deposit(dependencies(mainnetSource), request(expected, FIRST_PLAN_ID, mainnetPublicXpub()))).toEqual({ status: "BLOCKED_PUBLIC_SOURCE_MISMATCH" });

    const locked = new FakeStorage();
    storeTarget(locked, expected);
    const writer = new FakeExclusiveWriter(false);
    expect(commitNextXpublessV2Deposit(dependencies(locked, writer), request(expected))).toEqual({ status: "BLOCKED_CONCURRENT_WRITER" });
    expect(locked.operations).toEqual([]);
  });

  it("fails closed when the expected plan commitments are incompatible with the presented source", () => {
    const expected = envelope(0);
    const tampered = structuredClone(expected);
    tampered.plans[0]!.issuedOutputs[0]!.outputScript = "0020" + "00".repeat(32);
    const storage = new FakeStorage(new FakeExclusiveWriter());
    storeTarget(storage, tampered);

    expect(commitNextXpublessV2Deposit(dependencies(storage), request(tampered))).toEqual({ status: "BLOCKED_PUBLIC_SOURCE_MISMATCH" });
    expect(storage.setCount()).toBe(0);
  });

  it("fails closed for malformed expected state and tampered HIC without writing", () => {
    const valid = envelope(0);
    const malformedExpectedStorage = new FakeStorage(new FakeExclusiveWriter());
    storeTarget(malformedExpectedStorage, valid);
    expect(commitNextXpublessV2Deposit(
      dependencies(malformedExpectedStorage),
      { ...request(valid), expectedState: { format: "invalid" } },
    )).toEqual({ status: "FAILED_RECOVERABLE" });
    expect(malformedExpectedStorage.setCount()).toBe(0);

    const tampered = structuredClone(valid);
    tampered.plans[0]!.historicalIdentityCommitment.digest = "00".repeat(32);
    const hicStorage = new FakeStorage(new FakeExclusiveWriter());
    storeTarget(hicStorage, tampered);
    expect(commitNextXpublessV2Deposit(dependencies(hicStorage), request(tampered))).toEqual({ status: "BLOCKED_PUBLIC_SOURCE_MISMATCH" });
    expect(hicStorage.setCount()).toBe(0);
  });
});
