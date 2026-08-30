import { describe, expect, it } from "vitest";
import { createVaultPlan, issueNextDeposit } from "@/bitcoin/vault-plan";
import { createXpublessV2PlanState } from "@/bitcoin/xpubless-v2-plan-state";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import {
  XPUBLESS_V2_LEGACY_STORAGE_KEYS,
  XPUBLESS_V2_LOCAL_STATE_FORMAT,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XPUBLESS_V2_LOCAL_STATE_VERSION,
  XPUBLESS_V2_MIGRATION_JOURNAL_FORMAT,
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  XPUBLESS_V2_MIGRATION_JOURNAL_VERSION,
  XpublessV2LocalStateSchema,
  XpublessV2MigrationJournalSchema,
  advanceXpublessV2MigrationJournal,
  buildNextXpublessV2LocalState,
  createInitialXpublessV2LocalState,
  createPreparedXpublessV2MigrationJournal,
  markLegacyKeyRemovedFromJournal,
} from "./xpubless-v2-local-state";

const STATE_ID = "a1d5e9b0-11c2-4d3e-8f40-1234567890ab";
const MIGRATION_ID = "b2d5e9b0-11c2-4d3e-8f40-1234567890ab";
const PLAN_A_ID = "c3d5e9b0-11c2-4d3e-8f40-1234567890ab";
const PLAN_B_ID = "d4d5e9b0-11c2-4d3e-8f40-1234567890ab";

function planState(localInstanceId = PLAN_A_ID, lastIssuedIndex = 0) {
  let plan = createVaultPlan({
    label: "P3A fixture",
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  while (plan.lastIssuedIndex < lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  return createXpublessV2PlanState(plan, localInstanceId);
}

function initialInput(overrides: Record<string, unknown> = {}) {
  return {
    stateId: STATE_ID,
    plans: [planState()],
    archivedLocalInstanceIds: [],
    hiddenDepositIndexes: {},
    ...overrides,
  };
}

function validEnvelope(overrides: Record<string, unknown> = {}) {
  return createInitialXpublessV2LocalState(initialInput(overrides));
}

function preparedJournal(overrides: Record<string, unknown> = {}) {
  return createPreparedXpublessV2MigrationJournal({
    migrationId: MIGRATION_ID,
    targetStateId: STATE_ID,
    remainingLegacyKeys: [...XPUBLESS_V2_LEGACY_STORAGE_KEYS],
    ...overrides,
  });
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("XpublessV2LocalState", () => {
  it("freezes the isolated P3A storage-key and format contracts", () => {
    expect(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY).toBe("timesats.xpubless-local-state.v1");
    expect(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY).toBe("timesats.xpubless-migration-journal.v1");
    expect(XPUBLESS_V2_LOCAL_STATE_FORMAT).toBe("timesats-xpubless-local-state");
    expect(XPUBLESS_V2_LOCAL_STATE_VERSION).toBe(1);
    expect(XPUBLESS_V2_MIGRATION_JOURNAL_FORMAT).toBe("timesats-xpubless-migration-journal");
    expect(XPUBLESS_V2_MIGRATION_JOURNAL_VERSION).toBe(1);
  });

  it("accepts an empty revision-0 envelope", () => {
    const state = createInitialXpublessV2LocalState(initialInput({ plans: [] }));
    expect(state).toEqual({
      format: "timesats-xpubless-local-state",
      version: 1,
      stateId: STATE_ID,
      revision: 0,
      plans: [],
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
    });
  });

  it("accepts multiple plans with unique local IDs and valid local preferences", () => {
    const first = planState(PLAN_A_ID, 3);
    const second = planState(PLAN_B_ID, 1);
    const state = createInitialXpublessV2LocalState(initialInput({
      plans: [first, second],
      archivedLocalInstanceIds: [PLAN_B_ID],
      hiddenDepositIndexes: { [PLAN_A_ID]: [0, 2, 3], [PLAN_B_ID]: [1] },
    }));

    expect(state.plans.map((plan) => plan.localInstanceId)).toEqual([PLAN_A_ID, PLAN_B_ID]);
    expect(state.archivedLocalInstanceIds).toEqual([PLAN_B_ID]);
    expect(state.hiddenDepositIndexes).toEqual({ [PLAN_A_ID]: [0, 2, 3], [PLAN_B_ID]: [1] });
  });

  it("round-trips a parsed envelope through JSON and accepts valid non-initial revisions", () => {
    const first = validEnvelope();
    const second = buildNextXpublessV2LocalState(first, {
      plans: first.plans,
      archivedLocalInstanceIds: [PLAN_A_ID],
      hiddenDepositIndexes: { [PLAN_A_ID]: [0] },
    });

    expect(second.revision).toBe(1);
    expect(XpublessV2LocalStateSchema.parse(JSON.parse(JSON.stringify(second)))).toEqual(second);
  });

  it("builds deterministic next revisions while keeping stateId stable", () => {
    const first = validEnvelope();
    const body = {
      plans: first.plans,
      archivedLocalInstanceIds: [PLAN_A_ID],
      hiddenDepositIndexes: { [PLAN_A_ID]: [0] },
    };
    const next = buildNextXpublessV2LocalState(first, body);
    const repeated = buildNextXpublessV2LocalState(first, body);
    const third = buildNextXpublessV2LocalState(next, body);

    expect(next).toEqual(repeated);
    expect(next.revision).toBe(1);
    expect(third.revision).toBe(2);
    expect([first.stateId, next.stateId, third.stateId]).toEqual([STATE_ID, STATE_ID, STATE_ID]);
  });

  it("allows an unchanged plan instance and a local label rename across revisions", () => {
    const first = validEnvelope();
    const unchanged = buildNextXpublessV2LocalState(first, {
      plans: first.plans,
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
    });
    const renamedPlan = { ...first.plans[0], metadata: { label: "Renamed locally" } };
    const renamed = buildNextXpublessV2LocalState(first, {
      plans: [renamedPlan],
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
    });

    expect(unchanged.plans).toEqual(first.plans);
    expect(renamed.plans[0].metadata.label).toBe("Renamed locally");
    expect(renamed.plans[0].historicalIdentityCommitment).toEqual(first.plans[0].historicalIdentityCommitment);
  });

  it("allows a same-instance output extension only when the current prefix is unchanged", () => {
    const currentPlan = planState(PLAN_A_ID, 3);
    const nextPlan = planState(PLAN_A_ID, 4);
    const first = createInitialXpublessV2LocalState(initialInput({ plans: [currentPlan] }));
    const next = buildNextXpublessV2LocalState(first, {
      plans: [nextPlan],
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
    });

    expect(next.plans[0].lastIssuedIndex).toBe(4);
    expect(next.plans[0].issuedOutputs.slice(0, 4)).toEqual(first.plans[0].issuedOutputs);
  });

  it("allows adding a new local instance and removing an old instance with its preferences", () => {
    const first = createInitialXpublessV2LocalState(initialInput({
      plans: [planState(PLAN_A_ID), planState(PLAN_B_ID)],
      archivedLocalInstanceIds: [PLAN_B_ID],
      hiddenDepositIndexes: { [PLAN_B_ID]: [0] },
    }));
    const withAdded = buildNextXpublessV2LocalState(first, {
      plans: [...first.plans, planState("e5d5e9b0-11c2-4d3e-8f40-1234567890ab")],
      archivedLocalInstanceIds: [PLAN_B_ID],
      hiddenDepositIndexes: { [PLAN_B_ID]: [0] },
    });
    const withRemoved = buildNextXpublessV2LocalState(first, {
      plans: [first.plans[0]],
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
    });

    expect(withAdded.plans).toHaveLength(3);
    expect(withRemoved.plans.map((plan) => plan.localInstanceId)).toEqual([PLAN_A_ID]);
  });

  it.each([
    ["network", (plan: ReturnType<typeof planState>) => ({ ...plan, network: "signet" as const })],
    ["unlock height", (plan: ReturnType<typeof planState>) => ({ ...plan, unlockHeight: 251 })],
    ["key origin", (plan: ReturnType<typeof planState>) => ({ ...plan, keyOrigin: { ...plan.keyOrigin, masterFingerprint: "00000000" } })],
    ["HIC digest", (plan: ReturnType<typeof planState>) => ({ ...plan, historicalIdentityCommitment: { ...plan.historicalIdentityCommitment, digest: "00".repeat(32) } })],
  ])("rejects a same-ID historical %s change across revisions", (_name, change) => {
    const first = validEnvelope();
    expect(() => buildNextXpublessV2LocalState(first, {
      plans: [change(first.plans[0])],
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
    })).toThrow(/historical policy or commitment/);
  });

  it.each([
    ["derivation", (plan: ReturnType<typeof planState>) => ({ ...plan, derivation: { pathTemplate: "m/0", hardened: false } })],
    ["HIC algorithm", (plan: ReturnType<typeof planState>) => ({ ...plan, historicalIdentityCommitment: { ...plan.historicalIdentityCommitment, algorithm: "sha512" } })],
    ["policy version", (plan: ReturnType<typeof planState>) => ({ ...plan, policyVersion: 1 })],
    ["plan format", (plan: ReturnType<typeof planState>) => ({ ...plan, format: "timesats-other" })],
    ["plan version", (plan: ReturnType<typeof planState>) => ({ ...plan, version: 2 })],
  ])("rejects structurally invalid same-ID %s changes before any transition", (_name, change) => {
    const first = validEnvelope();
    expect(() => buildNextXpublessV2LocalState(first, {
      plans: [change(first.plans[0])],
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
    } as never)).toThrow();
  });

  it.each([
    ["lastIssuedIndex regression", (plan: ReturnType<typeof planState>) => planState(plan.localInstanceId, 2)],
    ["first output change", (plan: ReturnType<typeof planState>) => ({ ...plan, issuedOutputs: [{ ...plan.issuedOutputs[0], outputScript: "0020" + "aa".repeat(32) }, ...plan.issuedOutputs.slice(1)] })],
    ["middle output change", (plan: ReturnType<typeof planState>) => ({ ...plan, issuedOutputs: [plan.issuedOutputs[0], { ...plan.issuedOutputs[1], outputScript: "0020" + "bb".repeat(32) }, ...plan.issuedOutputs.slice(2)] })],
    ["extended output with altered prefix", (plan: ReturnType<typeof planState>) => ({ ...planState(plan.localInstanceId, 4), issuedOutputs: [{ ...plan.issuedOutputs[0], outputScript: "0020" + "cc".repeat(32) }, ...planState(plan.localInstanceId, 4).issuedOutputs.slice(1)] })],
  ])("rejects same-ID %s across revisions", (_name, change) => {
    const currentPlan = planState(PLAN_A_ID, 3);
    const first = createInitialXpublessV2LocalState(initialInput({ plans: [currentPlan] }));
    expect(() => buildNextXpublessV2LocalState(first, {
      plans: [change(currentPlan)],
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
    })).toThrow();
  });

  it("does not permit a caller to choose an arbitrary next revision", () => {
    const first = validEnvelope();
    const bodyWithInjectedRevision: unknown = {
      plans: first.plans,
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
      revision: 999,
    };
    expect(() => buildNextXpublessV2LocalState(first, bodyWithInjectedRevision as Parameters<typeof buildNextXpublessV2LocalState>[1])).toThrow();
  });

  it("rejects revision overflow instead of wrapping", () => {
    const state = XpublessV2LocalStateSchema.parse({ ...validEnvelope(), revision: Number.MAX_SAFE_INTEGER });
    expect(() => buildNextXpublessV2LocalState(state, {
      plans: state.plans,
      archivedLocalInstanceIds: [],
      hiddenDepositIndexes: {},
    })).toThrow(/Number\.MAX_SAFE_INTEGER/);
  });

  it.each([
    ["wrong format", { format: "timesats-local-vault-plans" }],
    ["wrong version", { version: 2 }],
    ["uppercase state ID", { stateId: STATE_ID.toUpperCase() }],
    ["invalid state ID", { stateId: "not-a-uuid" }],
    ["negative revision", { revision: -1 }],
    ["fractional revision", { revision: 0.5 }],
    ["unsafe revision", { revision: Number.MAX_SAFE_INTEGER + 1 }],
    ["duplicate plan local ID", { plans: [planState(PLAN_A_ID), planState(PLAN_A_ID)] }],
    ["duplicate archive ID", { archivedLocalInstanceIds: [PLAN_A_ID, PLAN_A_ID] }],
    ["archive orphan", { archivedLocalInstanceIds: [PLAN_B_ID] }],
    ["uppercase archive ID", { archivedLocalInstanceIds: [PLAN_A_ID.toUpperCase()] }],
    ["hidden orphan", { hiddenDepositIndexes: { [PLAN_B_ID]: [0] } }],
    ["hidden invalid key", { hiddenDepositIndexes: { "not-a-uuid": [0] } }],
    ["hidden duplicate", { hiddenDepositIndexes: { [PLAN_A_ID]: [0, 0] } }],
    ["hidden unordered", { hiddenDepositIndexes: { [PLAN_A_ID]: [1, 0] } }],
    ["hidden negative", { hiddenDepositIndexes: { [PLAN_A_ID]: [-1] } }],
    ["hidden beyond issued range", { hiddenDepositIndexes: { [PLAN_A_ID]: [1] } }],
    ["malformed nested plan", { plans: [{ ...planState(), policyVersion: 1 }] }],
  ])("rejects %s", (_name, override) => {
    expect(() => XpublessV2LocalStateSchema.parse({ ...validEnvelope(), ...override })).toThrow();
  });

  it.each([
    "extendedPublicKey",
    "tpub",
    "xpub",
    "vaultPlanIdentity",
    "publicKey",
    "witnessScript",
    "descriptor",
    "VaultPlan",
    "recoveryBundle",
    "privateKey",
  ])("rejects prohibited or unexpected envelope field %s", (field) => {
    expect(() => XpublessV2LocalStateSchema.parse({ ...validEnvelope(), [field]: "injected" })).toThrow();
  });

  it("does not mutate envelope or body input while preparing a next revision", () => {
    const current = validEnvelope();
    const body = {
      plans: current.plans,
      archivedLocalInstanceIds: [PLAN_A_ID],
      hiddenDepositIndexes: { [PLAN_A_ID]: [0] },
    };
    const currentBefore = jsonClone(current);
    const bodyBefore = jsonClone(body);

    buildNextXpublessV2LocalState(current, body);

    expect(current).toEqual(currentBefore);
    expect(body).toEqual(bodyBefore);
  });

  it("does not mutate initial-envelope input", () => {
    const input = initialInput({ archivedLocalInstanceIds: [PLAN_A_ID] });
    const before = jsonClone(input);
    createInitialXpublessV2LocalState(input);
    expect(input).toEqual(before);
  });
});

describe("XpublessV2MigrationJournal", () => {
  it("creates a canonical PREPARED journal with target revision 0", () => {
    const journal = preparedJournal();
    expect(journal).toEqual({
      format: "timesats-xpubless-migration-journal",
      version: 1,
      migrationId: MIGRATION_ID,
      targetStateId: STATE_ID,
      targetRevision: 0,
      phase: "PREPARED",
      remainingLegacyKeys: [...XPUBLESS_V2_LEGACY_STORAGE_KEYS],
    });
  });

  it("advances only through verified cleanup and complete phases", () => {
    const verified = advanceXpublessV2MigrationJournal(preparedJournal({ remainingLegacyKeys: [] }), "TARGET_VERIFIED");
    const cleanup = advanceXpublessV2MigrationJournal(verified, "CLEANUP_PENDING");
    const complete = advanceXpublessV2MigrationJournal(cleanup, "COMPLETE");

    expect(verified.phase).toBe("TARGET_VERIFIED");
    expect(cleanup.phase).toBe("CLEANUP_PENDING");
    expect(complete.phase).toBe("COMPLETE");
    expect(complete.remainingLegacyKeys).toEqual([]);
  });

  it("records only pending cleanup keys and retains canonical remaining order", () => {
    let journal = advanceXpublessV2MigrationJournal(preparedJournal(), "TARGET_VERIFIED");
    journal = advanceXpublessV2MigrationJournal(journal, "CLEANUP_PENDING");
    for (const key of XPUBLESS_V2_LEGACY_STORAGE_KEYS) {
      journal = markLegacyKeyRemovedFromJournal(journal, key);
    }

    expect(journal.phase).toBe("CLEANUP_PENDING");
    expect(journal.remainingLegacyKeys).toEqual([]);
    expect(advanceXpublessV2MigrationJournal(journal, "COMPLETE").phase).toBe("COMPLETE");
  });

  it("requires removal of the first remaining key and supports canonical subsets", () => {
    let fullJournal = advanceXpublessV2MigrationJournal(preparedJournal(), "TARGET_VERIFIED");
    fullJournal = advanceXpublessV2MigrationJournal(fullJournal, "CLEANUP_PENDING");
    expect(() => markLegacyKeyRemovedFromJournal(fullJournal, XPUBLESS_V2_LEGACY_STORAGE_KEYS[2])).toThrow();

    const afterV3 = markLegacyKeyRemovedFromJournal(fullJournal, XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]);
    expect(afterV3.remainingLegacyKeys).toEqual(XPUBLESS_V2_LEGACY_STORAGE_KEYS.slice(1));
    expect(() => markLegacyKeyRemovedFromJournal(afterV3, XPUBLESS_V2_LEGACY_STORAGE_KEYS[2])).toThrow();

    let subset = advanceXpublessV2MigrationJournal(preparedJournal({
      remainingLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[1], XPUBLESS_V2_LEGACY_STORAGE_KEYS[3]],
    }), "TARGET_VERIFIED");
    subset = advanceXpublessV2MigrationJournal(subset, "CLEANUP_PENDING");
    subset = markLegacyKeyRemovedFromJournal(subset, XPUBLESS_V2_LEGACY_STORAGE_KEYS[1]);
    subset = markLegacyKeyRemovedFromJournal(subset, XPUBLESS_V2_LEGACY_STORAGE_KEYS[3]);

    expect(subset.remainingLegacyKeys).toEqual([]);
    expect(advanceXpublessV2MigrationJournal(subset, "COMPLETE").phase).toBe("COMPLETE");
  });

  it("round-trips a journal through JSON", () => {
    const journal = preparedJournal();
    expect(XpublessV2MigrationJournalSchema.parse(JSON.parse(JSON.stringify(journal)))).toEqual(journal);
  });

  it("does not mutate prepared-journal input", () => {
    const input = {
      migrationId: MIGRATION_ID,
      targetStateId: STATE_ID,
      remainingLegacyKeys: [...XPUBLESS_V2_LEGACY_STORAGE_KEYS],
    };
    const before = jsonClone(input);

    createPreparedXpublessV2MigrationJournal(input);

    expect(input).toEqual(before);
  });

  it.each([
    ["wrong format", { format: "timesats-xpubless-local-state" }],
    ["wrong version", { version: 2 }],
    ["uppercase migration ID", { migrationId: MIGRATION_ID.toUpperCase() }],
    ["invalid migration ID", { migrationId: "not-a-uuid" }],
    ["uppercase target state ID", { targetStateId: STATE_ID.toUpperCase() }],
    ["invalid target state ID", { targetStateId: "not-a-uuid" }],
    ["nonzero target revision", { targetRevision: 1 }],
    ["unknown phase", { phase: "WRITING" }],
    ["unknown legacy key", { remainingLegacyKeys: ["timesats.other"] }],
    ["duplicate legacy key", { remainingLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[0], XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]] }],
    ["legacy keys in wrong order", { remainingLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[3], XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]] }],
    ["complete journal with remaining key", { phase: "COMPLETE", remainingLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]] }],
  ])("rejects %s", (_name, override) => {
    expect(() => XpublessV2MigrationJournalSchema.parse({ ...preparedJournal(), ...override })).toThrow();
  });

  it.each([
    ["PREPARED to CLEANUP_PENDING", preparedJournal(), "CLEANUP_PENDING"],
    ["PREPARED to COMPLETE", preparedJournal({ remainingLegacyKeys: [] }), "COMPLETE"],
    ["TARGET_VERIFIED to COMPLETE", advanceXpublessV2MigrationJournal(preparedJournal({ remainingLegacyKeys: [] }), "TARGET_VERIFIED"), "COMPLETE"],
    ["COMPLETE to another phase", advanceXpublessV2MigrationJournal(advanceXpublessV2MigrationJournal(advanceXpublessV2MigrationJournal(preparedJournal({ remainingLegacyKeys: [] }), "TARGET_VERIFIED"), "CLEANUP_PENDING"), "COMPLETE"), "PREPARED"],
  ])("rejects journal transition %s", (_name, journal, target) => {
    expect(() => advanceXpublessV2MigrationJournal(journal, target as "PREPARED" | "TARGET_VERIFIED" | "CLEANUP_PENDING" | "COMPLETE")).toThrow();
  });

  it("rejects cleanup-key recording outside cleanup and for an absent key", () => {
    expect(() => markLegacyKeyRemovedFromJournal(preparedJournal(), XPUBLESS_V2_LEGACY_STORAGE_KEYS[0])).toThrow();
    const cleanup = advanceXpublessV2MigrationJournal(
      advanceXpublessV2MigrationJournal(preparedJournal({ remainingLegacyKeys: [] }), "TARGET_VERIFIED"),
      "CLEANUP_PENDING",
    );
    expect(() => markLegacyKeyRemovedFromJournal(cleanup, XPUBLESS_V2_LEGACY_STORAGE_KEYS[0])).toThrow();
  });

  it.each([
    "tpub",
    "extendedPublicKey",
    "vaultPlanIdentity",
    "publicKey",
    "witnessScript",
    "VaultPlan",
    "privateKey",
  ])("rejects prohibited or unexpected journal field %s", (field) => {
    expect(() => XpublessV2MigrationJournalSchema.parse({ ...preparedJournal(), [field]: "injected" })).toThrow();
  });

  it("does not mutate journal inputs during phase or key transitions", () => {
    const journal = preparedJournal();
    const before = jsonClone(journal);
    const verified = advanceXpublessV2MigrationJournal(journal, "TARGET_VERIFIED");
    const cleanup = advanceXpublessV2MigrationJournal(verified, "CLEANUP_PENDING");
    const cleanupBefore = jsonClone(cleanup);

    markLegacyKeyRemovedFromJournal(cleanup, XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]);

    expect(journal).toEqual(before);
    expect(cleanup).toEqual(cleanupBefore);
  });

  it("keeps journal coordination fields immutable across every helper transition", () => {
    const prepared = preparedJournal({
      remainingLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]],
    });
    const verified = advanceXpublessV2MigrationJournal(prepared, "TARGET_VERIFIED");
    const cleanup = advanceXpublessV2MigrationJournal(verified, "CLEANUP_PENDING");
    const removed = markLegacyKeyRemovedFromJournal(cleanup, XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]);
    const complete = advanceXpublessV2MigrationJournal(removed, "COMPLETE");

    [verified, cleanup, removed, complete].forEach((journal) => {
      expect(journal.format).toBe(prepared.format);
      expect(journal.version).toBe(prepared.version);
      expect(journal.migrationId).toBe(prepared.migrationId);
      expect(journal.targetStateId).toBe(prepared.targetStateId);
      expect(journal.targetRevision).toBe(0);
    });
  });
});
