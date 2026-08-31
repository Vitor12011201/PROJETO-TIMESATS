import { describe, expect, it } from "vitest";
import { createXpublessV2PlanState } from "@/bitcoin/xpubless-v2-plan-state";
import { createVaultPlan } from "@/bitcoin/vault-plan";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import {
  XPUBLESS_V2_LEGACY_STORAGE_KEYS,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  advanceXpublessV2MigrationJournal,
  createInitialXpublessV2LocalState,
  createPreparedXpublessV2MigrationJournal,
  type XpublessV2LegacyStorageKey,
  type XpublessV2MigrationPhase,
} from "./xpubless-v2-local-state";
import {
  classifyXpublessV2Authority,
  readXpublessV2AuthorityRawSnapshot,
  type XpublessV2AuthorityRawSnapshot,
} from "./xpubless-v2-authority";

const STATE_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";
const MIGRATION_ID = "33333333-3333-4333-8333-333333333333";

function validTargetRaw(): string {
  const plan = createVaultPlan({
    label: "Authority state",
    network: "regtest",
    unlockHeight: 700,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  return JSON.stringify(createInitialXpublessV2LocalState({
    stateId: STATE_ID,
    plans: [createXpublessV2PlanState(plan, PLAN_ID)],
    archivedLocalInstanceIds: [],
    hiddenDepositIndexes: {},
  }));
}

function validJournalRaw(phase: XpublessV2MigrationPhase): string {
  let journal = createPreparedXpublessV2MigrationJournal({
    migrationId: MIGRATION_ID,
    targetStateId: STATE_ID,
    remainingLegacyKeys: [],
  });
  if (phase !== "PREPARED") journal = advanceXpublessV2MigrationJournal(journal, "TARGET_VERIFIED");
  if (phase === "CLEANUP_PENDING" || phase === "COMPLETE") {
    journal = advanceXpublessV2MigrationJournal(journal, "CLEANUP_PENDING");
  }
  if (phase === "COMPLETE") journal = advanceXpublessV2MigrationJournal(journal, "COMPLETE");
  return JSON.stringify(journal);
}

function snapshot(input: Partial<XpublessV2AuthorityRawSnapshot> = {}): XpublessV2AuthorityRawSnapshot {
  return {
    target: input.target ?? null,
    journal: input.journal ?? null,
    legacy: Object.fromEntries(XPUBLESS_V2_LEGACY_STORAGE_KEYS.map((key) => [key, input.legacy?.[key] ?? null])) as Record<XpublessV2LegacyStorageKey, string | null>,
  };
}

function snapshotWithLegacy(keys: readonly XpublessV2LegacyStorageKey[], value = "legacy-present"): XpublessV2AuthorityRawSnapshot {
  const legacy = Object.fromEntries(XPUBLESS_V2_LEGACY_STORAGE_KEYS.map((key) => [key, keys.includes(key) ? value : null])) as Record<XpublessV2LegacyStorageKey, string | null>;
  return snapshot({ legacy });
}

class SnapshotStorage {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];

  getItem(key: string): string | null {
    this.reads.push(key);
    return this.values.get(key) ?? null;
  }
}

describe("P3E3A xpubless startup authority classification", () => {
  it.each([
    ["all absent", snapshot(), { status: "EMPTY_LOCAL_STATE" }],
    ["legacy V3 only", snapshotWithLegacy([XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]]), { status: "LEGACY_AUTHORITY", presentLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]] }],
    ["legacy V2 only", snapshotWithLegacy([XPUBLESS_V2_LEGACY_STORAGE_KEYS[1]]), { status: "LEGACY_AUTHORITY", presentLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[1]] }],
    ["archive only", snapshotWithLegacy([XPUBLESS_V2_LEGACY_STORAGE_KEYS[2]]), { status: "LEGACY_AUTHORITY", presentLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[2]] }],
    ["hidden only", snapshotWithLegacy([XPUBLESS_V2_LEGACY_STORAGE_KEYS[3]]), { status: "LEGACY_AUTHORITY", presentLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[3]] }],
    ["multiple legacy", snapshotWithLegacy([XPUBLESS_V2_LEGACY_STORAGE_KEYS[0], XPUBLESS_V2_LEGACY_STORAGE_KEYS[3]]), { status: "LEGACY_AUTHORITY", presentLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[0], XPUBLESS_V2_LEGACY_STORAGE_KEYS[3]] }],
    ["valid target only", snapshot({ target: validTargetRaw() }), { status: "XPUBLESS_AUTHORITY" }],
    ["valid target plus one legacy", snapshot({ target: validTargetRaw(), legacy: snapshotWithLegacy([XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]]).legacy }), { status: "AMBIGUOUS_BLOCKED", presentLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]] }],
    ["valid target plus all legacy", snapshot({ target: validTargetRaw(), legacy: snapshotWithLegacy(XPUBLESS_V2_LEGACY_STORAGE_KEYS).legacy }), { status: "AMBIGUOUS_BLOCKED", presentLegacyKeys: [...XPUBLESS_V2_LEGACY_STORAGE_KEYS] }],
    ["prepared journal without target", snapshot({ journal: validJournalRaw("PREPARED") }), { status: "MIGRATION_IN_PROGRESS_OR_RESUMABLE", phase: "PREPARED" }],
    ["prepared journal with target", snapshot({ target: validTargetRaw(), journal: validJournalRaw("PREPARED") }), { status: "MIGRATION_IN_PROGRESS_OR_RESUMABLE", phase: "PREPARED" }],
    ["cleanup journal", snapshot({ journal: validJournalRaw("CLEANUP_PENDING") }), { status: "MIGRATION_IN_PROGRESS_OR_RESUMABLE", phase: "CLEANUP_PENDING" }],
    ["complete journal still present", snapshot({ journal: validJournalRaw("COMPLETE") }), { status: "MIGRATION_IN_PROGRESS_OR_RESUMABLE", phase: "COMPLETE" }],
  ] as const)("classifies %s without inspecting legacy payload validity", (_name, raw, expected) => {
    expect(classifyXpublessV2Authority(raw)).toMatchObject(expected);
  });

  it.each([
    ["invalid target JSON", snapshot({ target: "{" }), { status: "BLOCKED_CORRUPT_TARGET" }],
    ["schema-invalid target", snapshot({ target: JSON.stringify({ format: "wrong" }) }), { status: "BLOCKED_CORRUPT_TARGET" }],
    ["invalid journal JSON", snapshot({ journal: "{" }), { status: "BLOCKED_CORRUPT_JOURNAL" }],
    ["schema-invalid journal", snapshot({ journal: JSON.stringify({ format: "wrong" }) }), { status: "BLOCKED_CORRUPT_JOURNAL" }],
  ] as const)("blocks %s", (_name, raw, expected) => {
    expect(classifyXpublessV2Authority(raw)).toEqual(expected);
  });

  it.each([
    ["malformed", "{"],
    ["schema-invalid", JSON.stringify({ format: "wrong" })],
  ] as const)("blocks a %s target even when a valid journal is present", (_name, target) => {
    expect(classifyXpublessV2Authority(snapshot({
      target,
      journal: validJournalRaw("PREPARED"),
    }))).toEqual({ status: "BLOCKED_CORRUPT_TARGET" });
  });

  it("gives corrupt target deterministic precedence over a corrupt journal", () => {
    expect(classifyXpublessV2Authority(snapshot({ target: "{", journal: "{" }))).toEqual({ status: "BLOCKED_CORRUPT_TARGET" });
  });

  it("treats arbitrary legacy bytes as presence only and never returns their raw content", () => {
    const marker = "legacy-tpub-marker-must-not-leak";
    const result = classifyXpublessV2Authority(snapshotWithLegacy([XPUBLESS_V2_LEGACY_STORAGE_KEYS[1]], marker));
    expect(result).toEqual({ status: "LEGACY_AUTHORITY", presentLegacyKeys: [XPUBLESS_V2_LEGACY_STORAGE_KEYS[1]] });
    expect(JSON.stringify(result)).not.toContain(marker);
  });

  it("returns only parsed xpubless state for target authority", () => {
    const result = classifyXpublessV2Authority(snapshot({ target: validTargetRaw() }));
    expect(result.status).toBe("XPUBLESS_AUTHORITY");
    if (result.status !== "XPUBLESS_AUTHORITY") throw new Error("Expected xpubless authority.");
    expect(JSON.stringify(result.state)).not.toContain(validTestTpub);
  });

  it("reads all six canonical surfaces before pure classification", () => {
    const storage = new SnapshotStorage();
    storage.values.set(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, validTargetRaw());
    const raw = readXpublessV2AuthorityRawSnapshot(storage);

    expect(storage.reads).toEqual([
      ...XPUBLESS_V2_LEGACY_STORAGE_KEYS,
      XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
      XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
    ]);
    expect(classifyXpublessV2Authority(raw)).toMatchObject({ status: "XPUBLESS_AUTHORITY" });
  });
});
