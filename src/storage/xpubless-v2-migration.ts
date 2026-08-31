import { z } from "zod";
import { createXpublessV2PlanState } from "@/bitcoin/xpubless-v2-plan-state";
import { parseVaultPlan, vaultPlanIdentity } from "@/bitcoin/vault-plan";
import { MAX_NON_HARDENED_INDEX, VaultPlanSchema, type VaultPlan } from "@/domain/vault-plan";
import {
  XPUBLESS_V2_LEGACY_STORAGE_KEYS,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  XpublessV2LocalStateSchema,
  XpublessV2MigrationJournalSchema,
  advanceXpublessV2MigrationJournal,
  createInitialXpublessV2LocalState,
  createPreparedXpublessV2MigrationJournal,
  markLegacyKeyRemovedFromJournal,
  type XpublessV2LegacyStorageKey,
  type XpublessV2LocalState,
  type XpublessV2MigrationJournal,
} from "./xpubless-v2-local-state";

const [LEGACY_V3_KEY, LEGACY_V2_KEY, LEGACY_ARCHIVE_KEY, LEGACY_HIDDEN_KEY] = XPUBLESS_V2_LEGACY_STORAGE_KEYS;

/** Minimal injected persistence boundary. P3B never accesses browser globals. */
export interface XpublessV2MigrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type XpublessV2ExclusiveWriterResult<T> =
  | { acquired: true; value: T }
  | { acquired: false };

/** An injected coordination boundary; P3B does not implement a browser lock. */
export interface XpublessV2MigrationExclusiveWriter {
  runExclusive<T>(operation: () => T): XpublessV2ExclusiveWriterResult<T>;
}

/** IDs are caller-provided so tests are deterministic and resume never invents identity. */
export interface XpublessV2MigrationUuidSource {
  nextMigrationId(): string;
  nextStateId(): string;
  nextLocalInstanceId(): string;
}

export interface XpublessV2LegacyMigrationDependencies {
  storage: XpublessV2MigrationStorage;
  exclusiveWriter: XpublessV2MigrationExclusiveWriter;
  uuidSource: XpublessV2MigrationUuidSource;
}

export type XpublessV2LegacyMigrationStatus =
  | "COMPLETE_XPUBLESS"
  | "NO_LEGACY_STATE"
  | "BLOCKED_UNSUPPORTED_V1"
  | "BLOCKED_DUPLICATE_SEMANTICS"
  | "BLOCKED_ORPHAN_LEGACY_PREFERENCES"
  | "BLOCKED_HIDDEN_INDEX_OUTSIDE_ISSUANCE"
  | "BLOCKED_AMBIGUOUS_COEXISTENCE"
  | "BLOCKED_CONCURRENT_WRITER"
  | "FAILED_RECOVERABLE";

export interface XpublessV2LegacyMigrationResult {
  status: XpublessV2LegacyMigrationStatus;
}

const LegacyStoredPlansSchema = z.object({
  format: z.literal("timesats-local-vault-plans"),
  // This intentionally matches the current loader's envelope flexibility for either physical key.
  version: z.union([z.literal(2), z.literal(3)]),
  plans: z.array(VaultPlanSchema),
}).strict();
const LegacyArchiveSchema = z.array(z.string().min(1));
const LegacyHiddenIndexSchema = z.number().int().min(0).max(MAX_NON_HARDENED_INDEX);
const LegacyHiddenSchema = z.record(z.array(LegacyHiddenIndexSchema));

interface RelevantRawState {
  target: string | null;
  journal: string | null;
  legacy: Record<XpublessV2LegacyStorageKey, string | null>;
}

interface ReconciledLegacyPlan {
  identity: string;
  plan: VaultPlan;
}

interface LegacyPreflight {
  plans: ReconciledLegacyPlan[];
  archivedIdentities: string[];
  hiddenIndexes: Record<string, number[]>;
  presentLegacyKeys: XpublessV2LegacyStorageKey[];
}

class MigrationStatusError extends Error {
  constructor(readonly status: XpublessV2LegacyMigrationStatus) {
    super(status);
  }
}

function fail(status: XpublessV2LegacyMigrationStatus): never {
  throw new MigrationStatusError(status);
}

function readRelevantRawState(storage: XpublessV2MigrationStorage): RelevantRawState {
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

function parseJson<T>(raw: string, schema: { parse(input: unknown): T }): T {
  return schema.parse(JSON.parse(raw));
}

function parseTarget(raw: string | null): XpublessV2LocalState | null {
  return raw === null ? null : parseJson(raw, XpublessV2LocalStateSchema);
}

function parseJournal(raw: string | null): XpublessV2MigrationJournal | null {
  return raw === null ? null : parseJson(raw, XpublessV2MigrationJournalSchema);
}

function parseLegacyPlans(raw: string | null): VaultPlan[] {
  if (raw === null) return [];
  return parseJson(raw, LegacyStoredPlansSchema).plans.map(parseVaultPlan);
}

function parseLegacyArchive(raw: string | null): string[] {
  return raw === null ? [] : parseJson(raw, LegacyArchiveSchema);
}

function parseLegacyHidden(raw: string | null): Record<string, number[]> {
  return raw === null ? {} : parseJson(raw, LegacyHiddenSchema);
}

function requireNoDuplicateCanonicalIdentity(plans: VaultPlan[]): void {
  const identities = plans.map(vaultPlanIdentity);
  if (new Set(identities).size !== identities.length) fail("BLOCKED_DUPLICATE_SEMANTICS");
}

function reconcilePlans(v3Plans: VaultPlan[], v2Plans: VaultPlan[]): ReconciledLegacyPlan[] {
  const v2ByIdentity = new Map(v2Plans.map((plan) => [vaultPlanIdentity(plan), plan]));
  const reconciled: ReconciledLegacyPlan[] = v3Plans.map((v3Plan) => {
    const identity = vaultPlanIdentity(v3Plan);
    const v2Plan = v2ByIdentity.get(identity);
    const lastIssuedIndex = Math.max(v3Plan.lastIssuedIndex, v2Plan?.lastIssuedIndex ?? 0);
    return { identity, plan: parseVaultPlan({ ...v3Plan, lastIssuedIndex }) };
  });
  const v3Identities = new Set(v3Plans.map(vaultPlanIdentity));
  v2Plans.forEach((v2Plan) => {
    const identity = vaultPlanIdentity(v2Plan);
    if (!v3Identities.has(identity)) reconciled.push({ identity, plan: v2Plan });
  });
  return reconciled;
}

function preflightLegacy(raw: RelevantRawState): LegacyPreflight {
  let v3Plans: VaultPlan[];
  let v2Plans: VaultPlan[];
  let archive: string[];
  let hidden: Record<string, number[]>;
  try {
    v3Plans = parseLegacyPlans(raw.legacy[LEGACY_V3_KEY]);
    v2Plans = parseLegacyPlans(raw.legacy[LEGACY_V2_KEY]);
    archive = parseLegacyArchive(raw.legacy[LEGACY_ARCHIVE_KEY]);
    hidden = parseLegacyHidden(raw.legacy[LEGACY_HIDDEN_KEY]);
  } catch {
    fail("FAILED_RECOVERABLE");
  }

  if ([...v3Plans, ...v2Plans].some((plan) => plan.policy.policyVersion !== 2)) {
    fail("BLOCKED_UNSUPPORTED_V1");
  }
  requireNoDuplicateCanonicalIdentity(v3Plans);
  requireNoDuplicateCanonicalIdentity(v2Plans);

  const plans = reconcilePlans(v3Plans, v2Plans);
  const byIdentity = new Map(plans.map((entry) => [entry.identity, entry]));
  const archivedIdentities = [...new Set(archive)];
  if (archivedIdentities.some((identity) => !byIdentity.has(identity))) {
    fail("BLOCKED_ORPHAN_LEGACY_PREFERENCES");
  }

  const hiddenIndexes: Record<string, number[]> = {};
  for (const [identity, indexes] of Object.entries(hidden)) {
    const plan = byIdentity.get(identity)?.plan;
    if (!plan) fail("BLOCKED_ORPHAN_LEGACY_PREFERENCES");
    const canonicalIndexes = [...new Set(indexes)].sort((left, right) => left - right);
    if (canonicalIndexes.some((index) => index > plan.lastIssuedIndex)) {
      fail("BLOCKED_HIDDEN_INDEX_OUTSIDE_ISSUANCE");
    }
    if (canonicalIndexes.length > 0) hiddenIndexes[identity] = canonicalIndexes;
  }

  return {
    plans,
    archivedIdentities,
    hiddenIndexes,
    presentLegacyKeys: XPUBLESS_V2_LEGACY_STORAGE_KEYS.filter((key) => raw.legacy[key] !== null),
  };
}

function writeAndReadBack<T>(
  storage: XpublessV2MigrationStorage,
  key: string,
  value: T,
  schema: { parse(input: unknown): T },
): T {
  const serialized = JSON.stringify(value);
  storage.setItem(key, serialized);
  const readBack = storage.getItem(key);
  if (readBack !== serialized) throw new Error("Persisted migration data did not match its write/read-back value.");
  return parseJson(readBack, schema);
}

function writeJournal(storage: XpublessV2MigrationStorage, journal: XpublessV2MigrationJournal): XpublessV2MigrationJournal {
  return writeAndReadBack(storage, XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY, journal, XpublessV2MigrationJournalSchema);
}

function writeTarget(storage: XpublessV2MigrationStorage, target: XpublessV2LocalState): XpublessV2LocalState {
  return writeAndReadBack(storage, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY, target, XpublessV2LocalStateSchema);
}

function requireJournalTargetBinding(journal: XpublessV2MigrationJournal, target: XpublessV2LocalState | null): XpublessV2LocalState {
  if (!target || target.stateId !== journal.targetStateId || target.revision !== journal.targetRevision) {
    fail("FAILED_RECOVERABLE");
  }
  return target;
}

function requireLegacyKeysExactly(raw: RelevantRawState, expectedPresent: readonly XpublessV2LegacyStorageKey[]): void {
  const expected = new Set(expectedPresent);
  if (XPUBLESS_V2_LEGACY_STORAGE_KEYS.some((key) => (raw.legacy[key] !== null) !== expected.has(key))) {
    fail("FAILED_RECOVERABLE");
  }
}

function buildTarget(
  preflight: LegacyPreflight,
  stateId: string,
  localInstanceIds: readonly string[],
): XpublessV2LocalState {
  if (localInstanceIds.length !== preflight.plans.length) fail("FAILED_RECOVERABLE");
  const localInstanceIdByIdentity = new Map<string, string>();
  const plans = preflight.plans.map((entry, index) => {
    const localInstanceId = localInstanceIds[index];
    localInstanceIdByIdentity.set(entry.identity, localInstanceId);
    return createXpublessV2PlanState(entry.plan, localInstanceId);
  });
  const archivedLocalInstanceIds = preflight.archivedIdentities.map((identity) => {
    const localInstanceId = localInstanceIdByIdentity.get(identity);
    if (!localInstanceId) fail("FAILED_RECOVERABLE");
    return localInstanceId;
  });
  const hiddenDepositIndexes = Object.fromEntries(Object.entries(preflight.hiddenIndexes).map(([identity, indexes]) => {
    const localInstanceId = localInstanceIdByIdentity.get(identity);
    if (!localInstanceId) fail("FAILED_RECOVERABLE");
    return [localInstanceId, indexes];
  }));
  return createInitialXpublessV2LocalState({
    stateId,
    plans,
    archivedLocalInstanceIds,
    hiddenDepositIndexes,
  });
}

function requireTargetMatchesPreflight(
  target: XpublessV2LocalState,
  journal: XpublessV2MigrationJournal,
  preflight: LegacyPreflight,
): void {
  const expected = buildTarget(preflight, journal.targetStateId, target.plans.map((plan) => plan.localInstanceId));
  if (JSON.stringify(expected) !== JSON.stringify(target)) fail("FAILED_RECOVERABLE");
}

function cleanupPending(storage: XpublessV2MigrationStorage, journalInput: XpublessV2MigrationJournal): XpublessV2LegacyMigrationResult {
  let journal = journalInput;
  requireJournalTargetBinding(journal, parseTarget(storage.getItem(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)));

  const presentKeys = new Map<XpublessV2LegacyStorageKey, boolean>();
  XPUBLESS_V2_LEGACY_STORAGE_KEYS.forEach((key) => presentKeys.set(key, storage.getItem(key) !== null));
  const remaining = new Set(journal.remainingLegacyKeys);
  if (XPUBLESS_V2_LEGACY_STORAGE_KEYS.some((key) => !remaining.has(key) && presentKeys.get(key))) {
    fail("FAILED_RECOVERABLE");
  }

  let sawPresent = false;
  for (const key of journal.remainingLegacyKeys) {
    if (presentKeys.get(key)) {
      sawPresent = true;
    } else if (sawPresent) {
      fail("FAILED_RECOVERABLE");
    }
  }

  while (journal.remainingLegacyKeys.length > 0 && storage.getItem(journal.remainingLegacyKeys[0]) === null) {
    journal = writeJournal(storage, markLegacyKeyRemovedFromJournal(journal, journal.remainingLegacyKeys[0]));
  }
  while (journal.remainingLegacyKeys.length > 0) {
    const key = journal.remainingLegacyKeys[0];
    storage.removeItem(key);
    if (storage.getItem(key) !== null) fail("FAILED_RECOVERABLE");
    journal = writeJournal(storage, markLegacyKeyRemovedFromJournal(journal, key));
  }

  requireJournalTargetBinding(journal, parseTarget(storage.getItem(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)));
  if (XPUBLESS_V2_LEGACY_STORAGE_KEYS.some((key) => storage.getItem(key) !== null)) fail("FAILED_RECOVERABLE");
  const completeJournal = writeJournal(storage, advanceXpublessV2MigrationJournal(journal, "COMPLETE"));
  storage.removeItem(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY);
  if (storage.getItem(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY) !== null) fail("FAILED_RECOVERABLE");
  requireJournalTargetBinding(completeJournal, parseTarget(storage.getItem(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)));
  if (XPUBLESS_V2_LEGACY_STORAGE_KEYS.some((key) => storage.getItem(key) !== null)) fail("FAILED_RECOVERABLE");
  return { status: "COMPLETE_XPUBLESS" };
}

function resumeJournal(
  storage: XpublessV2MigrationStorage,
  raw: RelevantRawState,
  journal: XpublessV2MigrationJournal,
  uuidSource: XpublessV2MigrationUuidSource,
): XpublessV2LegacyMigrationResult {
  const target = parseTarget(raw.target);
  if (journal.phase === "COMPLETE") {
    requireJournalTargetBinding(journal, target);
    if (XPUBLESS_V2_LEGACY_STORAGE_KEYS.some((key) => raw.legacy[key] !== null)) fail("FAILED_RECOVERABLE");
    storage.removeItem(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY);
    if (storage.getItem(XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY) !== null) fail("FAILED_RECOVERABLE");
    requireJournalTargetBinding(journal, parseTarget(storage.getItem(XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)));
    if (XPUBLESS_V2_LEGACY_STORAGE_KEYS.some((key) => storage.getItem(key) !== null)) fail("FAILED_RECOVERABLE");
    return { status: "COMPLETE_XPUBLESS" };
  }

  if (journal.phase === "CLEANUP_PENDING") return cleanupPending(storage, journal);

  requireLegacyKeysExactly(raw, journal.remainingLegacyKeys);
  const preflight = preflightLegacy(raw);
  if (JSON.stringify(preflight.presentLegacyKeys) !== JSON.stringify(journal.remainingLegacyKeys)) fail("FAILED_RECOVERABLE");

  if (!target) {
    if (journal.phase !== "PREPARED") fail("FAILED_RECOVERABLE");
    const nextTarget = buildTarget(preflight, journal.targetStateId, preflight.plans.map(() => uuidSource.nextLocalInstanceId()));
    writeTarget(storage, nextTarget);
    const verifiedJournal = writeJournal(storage, advanceXpublessV2MigrationJournal(journal, "TARGET_VERIFIED"));
    const cleanupJournal = writeJournal(storage, advanceXpublessV2MigrationJournal(verifiedJournal, "CLEANUP_PENDING"));
    return cleanupPending(storage, cleanupJournal);
  }

  requireJournalTargetBinding(journal, target);
  requireTargetMatchesPreflight(target, journal, preflight);
  if (journal.phase === "PREPARED") {
    const verifiedJournal = writeJournal(storage, advanceXpublessV2MigrationJournal(journal, "TARGET_VERIFIED"));
    const cleanupJournal = writeJournal(storage, advanceXpublessV2MigrationJournal(verifiedJournal, "CLEANUP_PENDING"));
    return cleanupPending(storage, cleanupJournal);
  }
  if (journal.phase === "TARGET_VERIFIED") {
    const cleanupJournal = writeJournal(storage, advanceXpublessV2MigrationJournal(journal, "CLEANUP_PENDING"));
    return cleanupPending(storage, cleanupJournal);
  }
  fail("FAILED_RECOVERABLE");
}

function runUnderExclusiveWriter(dependencies: XpublessV2LegacyMigrationDependencies): XpublessV2LegacyMigrationResult {
  const raw = readRelevantRawState(dependencies.storage);
  let target: XpublessV2LocalState | null;
  let journal: XpublessV2MigrationJournal | null;
  try {
    target = parseTarget(raw.target);
    journal = parseJournal(raw.journal);
  } catch {
    fail("FAILED_RECOVERABLE");
  }

  const anyLegacy = XPUBLESS_V2_LEGACY_STORAGE_KEYS.some((key) => raw.legacy[key] !== null);
  if (journal) return resumeJournal(dependencies.storage, raw, journal, dependencies.uuidSource);
  if (target) {
    if (anyLegacy) return { status: "BLOCKED_AMBIGUOUS_COEXISTENCE" };
    return { status: "COMPLETE_XPUBLESS" };
  }
  if (!anyLegacy) return { status: "NO_LEGACY_STATE" };

  const preflight = preflightLegacy(raw);
  const journalPrepared = writeJournal(dependencies.storage, createPreparedXpublessV2MigrationJournal({
    migrationId: dependencies.uuidSource.nextMigrationId(),
    targetStateId: dependencies.uuidSource.nextStateId(),
    remainingLegacyKeys: preflight.presentLegacyKeys,
  }));
  const targetInitial = buildTarget(
    preflight,
    journalPrepared.targetStateId,
    preflight.plans.map(() => dependencies.uuidSource.nextLocalInstanceId()),
  );
  writeTarget(dependencies.storage, targetInitial);
  const verifiedJournal = writeJournal(dependencies.storage, advanceXpublessV2MigrationJournal(journalPrepared, "TARGET_VERIFIED"));
  const cleanupJournal = writeJournal(dependencies.storage, advanceXpublessV2MigrationJournal(verifiedJournal, "CLEANUP_PENDING"));
  return cleanupPending(dependencies.storage, cleanupJournal);
}

/**
 * Runs a resumable migration only through injected dependencies. It is not wired
 * to browser storage or the application, and it provides no funding inference.
 */
export function runXpublessV2LegacyMigration(
  dependencies: XpublessV2LegacyMigrationDependencies,
): XpublessV2LegacyMigrationResult {
  try {
    const exclusiveResult = dependencies.exclusiveWriter.runExclusive(() => runUnderExclusiveWriter(dependencies));
    if (!exclusiveResult.acquired) return { status: "BLOCKED_CONCURRENT_WRITER" };
    return exclusiveResult.value;
  } catch (cause) {
    if (cause instanceof MigrationStatusError) return { status: cause.status };
    return { status: "FAILED_RECOVERABLE" };
  }
}
