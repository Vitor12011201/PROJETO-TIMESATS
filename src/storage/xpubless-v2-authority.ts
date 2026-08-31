import {
  XPUBLESS_V2_LEGACY_STORAGE_KEYS,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  XpublessV2LocalStateSchema,
  XpublessV2MigrationJournalSchema,
  type XpublessV2LegacyStorageKey,
  type XpublessV2LocalState,
  type XpublessV2MigrationPhase,
} from "./xpubless-v2-local-state";

/** Minimal injected read boundary; authority classification itself remains pure. */
export interface XpublessV2AuthoritySnapshotStorage {
  getItem(key: string): string | null;
}

/**
 * The complete canonical local authority surface, represented as raw bytes.
 * This is deliberately not a Storage object and is the only classifier input.
 */
export interface XpublessV2AuthorityRawSnapshot {
  target: string | null;
  journal: string | null;
  legacy: Record<XpublessV2LegacyStorageKey, string | null>;
}

export type XpublessV2AuthorityClassification =
  | { status: "EMPTY_LOCAL_STATE" }
  | { status: "LEGACY_AUTHORITY"; presentLegacyKeys: XpublessV2LegacyStorageKey[] }
  | { status: "XPUBLESS_AUTHORITY"; state: XpublessV2LocalState }
  | { status: "MIGRATION_IN_PROGRESS_OR_RESUMABLE"; phase: XpublessV2MigrationPhase }
  | { status: "AMBIGUOUS_BLOCKED"; presentLegacyKeys: XpublessV2LegacyStorageKey[] }
  | { status: "BLOCKED_CORRUPT_TARGET" }
  | { status: "BLOCKED_CORRUPT_JOURNAL" };

/** Reads every canonical authority surface without interpreting any value. */
export function readXpublessV2AuthorityRawSnapshot(
  storage: XpublessV2AuthoritySnapshotStorage,
): XpublessV2AuthorityRawSnapshot {
  const legacy = {} as Record<XpublessV2LegacyStorageKey, string | null>;
  XPUBLESS_V2_LEGACY_STORAGE_KEYS.forEach((key) => {
    legacy[key] = storage.getItem(key);
  });
  return {
    target: storage.getItem(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY),
    journal: storage.getItem(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY),
    legacy,
  };
}

function parseTarget(raw: string): XpublessV2LocalState | null {
  try {
    return XpublessV2LocalStateSchema.parse(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parseJournalPhase(raw: string): XpublessV2MigrationPhase | null {
  try {
    return XpublessV2MigrationJournalSchema.parse(JSON.parse(raw)).phase;
  } catch {
    return null;
  }
}

/**
 * Classifies authority only. P3B remains solely responsible for legacy
 * preflight, V1 detection, reconciliation, and journal-resume validation.
 *
 * Corrupt target precedes corrupt journal deterministically. Target is parsed
 * before journal can claim the transition, so invalid xpubless bytes are never
 * disguised as a resumable migration.
 */
export function classifyXpublessV2Authority(
  snapshot: XpublessV2AuthorityRawSnapshot,
): XpublessV2AuthorityClassification {
  const target = snapshot.target === null ? null : parseTarget(snapshot.target);
  if (snapshot.target !== null && target === null) return { status: "BLOCKED_CORRUPT_TARGET" };

  const journalPhase = snapshot.journal === null ? null : parseJournalPhase(snapshot.journal);
  if (snapshot.journal !== null && journalPhase === null) return { status: "BLOCKED_CORRUPT_JOURNAL" };

  if (journalPhase !== null) {
    return { status: "MIGRATION_IN_PROGRESS_OR_RESUMABLE", phase: journalPhase };
  }

  const presentLegacyKeys = XPUBLESS_V2_LEGACY_STORAGE_KEYS.filter((key) => snapshot.legacy[key] !== null);
  if (target && presentLegacyKeys.length > 0) {
    return { status: "AMBIGUOUS_BLOCKED", presentLegacyKeys };
  }
  if (target) return { status: "XPUBLESS_AUTHORITY", state: target };
  if (presentLegacyKeys.length > 0) return { status: "LEGACY_AUTHORITY", presentLegacyKeys };
  return { status: "EMPTY_LOCAL_STATE" };
}
