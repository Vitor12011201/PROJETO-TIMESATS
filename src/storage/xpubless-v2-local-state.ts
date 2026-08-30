import { z } from "zod";
import { MAX_NON_HARDENED_INDEX } from "@/domain/vault-plan";
import { XpublessV2PlanStateSchema, type XpublessV2PlanState } from "@/domain/xpubless-v2-plan-state";

/** Contract identifiers only. P3A does not read or write browser storage. */
export const XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY = "timesats.xpubless-local-state.v1" as const;
export const XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY = "timesats.xpubless-migration-journal.v1" as const;

export const XPUBLESS_V2_LOCAL_STATE_FORMAT = "timesats-xpubless-local-state" as const;
export const XPUBLESS_V2_LOCAL_STATE_VERSION = 1 as const;
export const XPUBLESS_V2_MIGRATION_JOURNAL_FORMAT = "timesats-xpubless-migration-journal" as const;
export const XPUBLESS_V2_MIGRATION_JOURNAL_VERSION = 1 as const;

export const XPUBLESS_V2_LEGACY_STORAGE_KEYS = [
  "timesats.vault-plans.v3",
  "timesats.vault-plans.v2",
  "timesats.archived-plan-identities.v1",
  "timesats.hidden-deposit-indexes.v1",
] as const;

export type XpublessV2LegacyStorageKey = typeof XPUBLESS_V2_LEGACY_STORAGE_KEYS[number];

const CanonicalUuidSchema = z.string()
  .uuid("ID must be a UUID.")
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "ID must use lowercase canonical UUID text.");
const RevisionSchema = z.number()
  .int("Revision must be an integer.")
  .min(0, "Revision must be non-negative.")
  .max(Number.MAX_SAFE_INTEGER, "Revision exceeds Number.MAX_SAFE_INTEGER.");
const HiddenDepositIndexSchema = z.number()
  .int("Hidden deposit index must be an integer.")
  .min(0, "Hidden deposit index must be non-negative.")
  .max(MAX_NON_HARDENED_INDEX, "Hidden deposit index exceeds the BIP32 non-hardened range.");
const LegacyStorageKeySchema = z.enum(XPUBLESS_V2_LEGACY_STORAGE_KEYS);

function hasNoDuplicates(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

function hasCanonicalLegacyKeyOrder(keys: readonly XpublessV2LegacyStorageKey[]): boolean {
  let previousPosition = -1;
  for (const key of keys) {
    const position = XPUBLESS_V2_LEGACY_STORAGE_KEYS.indexOf(key);
    if (position <= previousPosition) return false;
    previousPosition = position;
  }
  return true;
}

function requireSameHistoricalPlanFields(
  currentPlan: XpublessV2PlanState,
  nextPlan: XpublessV2PlanState,
): void {
  const hasSameImmutableFields = currentPlan.format === nextPlan.format
    && currentPlan.version === nextPlan.version
    && currentPlan.localInstanceId === nextPlan.localInstanceId
    && currentPlan.policyVersion === nextPlan.policyVersion
    && currentPlan.network === nextPlan.network
    && currentPlan.unlockHeight === nextPlan.unlockHeight
    && JSON.stringify(currentPlan.derivation) === JSON.stringify(nextPlan.derivation)
    && JSON.stringify(currentPlan.keyOrigin) === JSON.stringify(nextPlan.keyOrigin)
    && JSON.stringify(currentPlan.historicalIdentityCommitment) === JSON.stringify(nextPlan.historicalIdentityCommitment);

  if (!hasSameImmutableFields) {
    throw new Error("A persisted local plan instance cannot change its historical policy or commitment.");
  }
  if (nextPlan.lastIssuedIndex < currentPlan.lastIssuedIndex) {
    throw new Error("A persisted local plan instance cannot decrease lastIssuedIndex.");
  }
  for (let index = 0; index <= currentPlan.lastIssuedIndex; index += 1) {
    const currentOutput = currentPlan.issuedOutputs[index];
    const nextOutput = nextPlan.issuedOutputs[index];
    if (!currentOutput || !nextOutput
      || currentOutput.index !== nextOutput.index
      || currentOutput.outputScript !== nextOutput.outputScript) {
      throw new Error("A persisted local plan instance cannot alter issued output commitments.");
    }
  }
}

function validateCrossRevisionPlanContinuity(
  currentPlans: readonly XpublessV2PlanState[],
  nextPlans: readonly XpublessV2PlanState[],
): void {
  const nextByLocalInstanceId = new Map(nextPlans.map((plan) => [plan.localInstanceId, plan]));
  currentPlans.forEach((currentPlan) => {
    const nextPlan = nextByLocalInstanceId.get(currentPlan.localInstanceId);
    if (nextPlan) requireSameHistoricalPlanFields(currentPlan, nextPlan);
  });
}

/**
 * One local-only preference body. It deliberately contains no envelope identity
 * or revision so the next-revision helper, rather than its caller, owns both.
 */
export const XpublessV2LocalStateBodySchema = z.object({
  plans: z.array(XpublessV2PlanStateSchema),
  archivedLocalInstanceIds: z.array(CanonicalUuidSchema),
  hiddenDepositIndexes: z.record(z.string(), z.array(HiddenDepositIndexSchema)),
}).strict();

export const XpublessV2LocalStateSchema = z.object({
  format: z.literal(XPUBLESS_V2_LOCAL_STATE_FORMAT),
  version: z.literal(XPUBLESS_V2_LOCAL_STATE_VERSION),
  stateId: CanonicalUuidSchema,
  revision: RevisionSchema,
  plans: z.array(XpublessV2PlanStateSchema),
  archivedLocalInstanceIds: z.array(CanonicalUuidSchema),
  hiddenDepositIndexes: z.record(z.string(), z.array(HiddenDepositIndexSchema)),
}).strict().superRefine((state, context) => {
  const planIds = state.plans.map((plan) => plan.localInstanceId);
  const planIdSet = new Set(planIds);

  if (!hasNoDuplicates(planIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["plans"],
      message: "Plan localInstanceId values must be unique within an envelope.",
    });
  }

  if (!hasNoDuplicates(state.archivedLocalInstanceIds)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["archivedLocalInstanceIds"],
      message: "Archived local instance IDs must not be duplicated.",
    });
  }

  state.archivedLocalInstanceIds.forEach((localInstanceId, index) => {
    if (!planIdSet.has(localInstanceId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["archivedLocalInstanceIds", index],
        message: "Archived local instance ID must reference a plan in this envelope.",
      });
    }
  });

  Object.entries(state.hiddenDepositIndexes).forEach(([localInstanceId, indexes]) => {
    const plan = state.plans.find((candidate) => candidate.localInstanceId === localInstanceId);
    if (!CanonicalUuidSchema.safeParse(localInstanceId).success) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hiddenDepositIndexes", localInstanceId],
        message: "Hidden deposit preference keys must be lowercase canonical UUIDs.",
      });
      return;
    }
    if (!plan) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hiddenDepositIndexes", localInstanceId],
        message: "Hidden deposit preferences must reference a plan in this envelope.",
      });
      return;
    }
    indexes.forEach((index, position) => {
      if (index > plan.lastIssuedIndex) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hiddenDepositIndexes", localInstanceId, position],
          message: "Hidden deposit index cannot exceed the plan lastIssuedIndex.",
        });
      }
      if (position > 0 && indexes[position - 1] >= index) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["hiddenDepositIndexes", localInstanceId, position],
          message: "Hidden deposit indexes must be strictly increasing.",
        });
      }
    });
  });
});

export const XpublessV2MigrationPhaseSchema = z.enum([
  "PREPARED",
  "TARGET_VERIFIED",
  "CLEANUP_PENDING",
  "COMPLETE",
]);

/**
 * Coordination metadata only. Journal values do not authenticate an envelope
 * or provide a trust anchor; P3B will verify actual target/key existence.
 */
export const XpublessV2MigrationJournalSchema = z.object({
  format: z.literal(XPUBLESS_V2_MIGRATION_JOURNAL_FORMAT),
  version: z.literal(XPUBLESS_V2_MIGRATION_JOURNAL_VERSION),
  migrationId: CanonicalUuidSchema,
  targetStateId: CanonicalUuidSchema,
  targetRevision: z.literal(0),
  phase: XpublessV2MigrationPhaseSchema,
  remainingLegacyKeys: z.array(LegacyStorageKeySchema),
}).strict().superRefine((journal, context) => {
  if (!hasNoDuplicates(journal.remainingLegacyKeys)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["remainingLegacyKeys"],
      message: "Remaining legacy keys must not be duplicated.",
    });
  }
  if (!hasCanonicalLegacyKeyOrder(journal.remainingLegacyKeys)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["remainingLegacyKeys"],
      message: "Remaining legacy keys must use canonical cleanup order.",
    });
  }
  if (journal.phase === "COMPLETE" && journal.remainingLegacyKeys.length !== 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["remainingLegacyKeys"],
      message: "A complete migration journal cannot retain legacy keys.",
    });
  }
});

export const CreateInitialXpublessV2LocalStateInputSchema = z.object({
  stateId: CanonicalUuidSchema,
  plans: z.array(XpublessV2PlanStateSchema),
  archivedLocalInstanceIds: z.array(CanonicalUuidSchema),
  hiddenDepositIndexes: z.record(z.string(), z.array(HiddenDepositIndexSchema)),
}).strict();

export const CreatePreparedXpublessV2MigrationJournalInputSchema = z.object({
  migrationId: CanonicalUuidSchema,
  targetStateId: CanonicalUuidSchema,
  remainingLegacyKeys: z.array(LegacyStorageKeySchema),
}).strict();

export type XpublessV2LocalState = z.infer<typeof XpublessV2LocalStateSchema>;
export type XpublessV2LocalStateBody = z.infer<typeof XpublessV2LocalStateBodySchema>;
export type CreateInitialXpublessV2LocalStateInput = z.infer<typeof CreateInitialXpublessV2LocalStateInputSchema>;
export type XpublessV2MigrationPhase = z.infer<typeof XpublessV2MigrationPhaseSchema>;
export type XpublessV2MigrationJournal = z.infer<typeof XpublessV2MigrationJournalSchema>;
export type CreatePreparedXpublessV2MigrationJournalInput = z.infer<typeof CreatePreparedXpublessV2MigrationJournalInputSchema>;

/** Builds revision 0 in memory. The caller supplies the stable opaque stateId. */
export function createInitialXpublessV2LocalState(
  input: CreateInitialXpublessV2LocalStateInput,
): XpublessV2LocalState {
  const initial = CreateInitialXpublessV2LocalStateInputSchema.parse(input);
  return XpublessV2LocalStateSchema.parse({
    format: XPUBLESS_V2_LOCAL_STATE_FORMAT,
    version: XPUBLESS_V2_LOCAL_STATE_VERSION,
    stateId: initial.stateId,
    revision: 0,
    plans: initial.plans,
    archivedLocalInstanceIds: initial.archivedLocalInstanceIds,
    hiddenDepositIndexes: initial.hiddenDepositIndexes,
  });
}

/**
 * Builds, but does not commit or persist, the next revision. A later layer must
 * coordinate exclusive writing and read-back validation before treating it as durable.
 */
export function buildNextXpublessV2LocalState(
  currentStateInput: unknown,
  nextBodyInput: XpublessV2LocalStateBody,
): XpublessV2LocalState {
  const currentState = XpublessV2LocalStateSchema.parse(currentStateInput);
  const nextBody = XpublessV2LocalStateBodySchema.parse(nextBodyInput);
  if (currentState.revision === Number.MAX_SAFE_INTEGER) {
    throw new Error("Cannot build a local-state revision above Number.MAX_SAFE_INTEGER.");
  }
  validateCrossRevisionPlanContinuity(currentState.plans, nextBody.plans);
  return XpublessV2LocalStateSchema.parse({
    format: XPUBLESS_V2_LOCAL_STATE_FORMAT,
    version: XPUBLESS_V2_LOCAL_STATE_VERSION,
    stateId: currentState.stateId,
    revision: currentState.revision + 1,
    plans: nextBody.plans,
    archivedLocalInstanceIds: nextBody.archivedLocalInstanceIds,
    hiddenDepositIndexes: nextBody.hiddenDepositIndexes,
  });
}

/** Builds a PREPARED coordination journal only; it performs no target/key I/O. */
export function createPreparedXpublessV2MigrationJournal(
  input: CreatePreparedXpublessV2MigrationJournalInput,
): XpublessV2MigrationJournal {
  const prepared = CreatePreparedXpublessV2MigrationJournalInputSchema.parse(input);
  return XpublessV2MigrationJournalSchema.parse({
    format: XPUBLESS_V2_MIGRATION_JOURNAL_FORMAT,
    version: XPUBLESS_V2_MIGRATION_JOURNAL_VERSION,
    migrationId: prepared.migrationId,
    targetStateId: prepared.targetStateId,
    targetRevision: 0,
    phase: "PREPARED",
    remainingLegacyKeys: prepared.remainingLegacyKeys,
  });
}

const ALLOWED_JOURNAL_TRANSITIONS: Readonly<Record<XpublessV2MigrationPhase, readonly XpublessV2MigrationPhase[]>> = {
  PREPARED: ["TARGET_VERIFIED"],
  TARGET_VERIFIED: ["CLEANUP_PENDING"],
  CLEANUP_PENDING: ["COMPLETE"],
  COMPLETE: [],
};

/** Advances only the declared coordination phase; P3B verifies external facts. */
export function advanceXpublessV2MigrationJournal(
  journalInput: unknown,
  nextPhase: XpublessV2MigrationPhase,
): XpublessV2MigrationJournal {
  const journal = XpublessV2MigrationJournalSchema.parse(journalInput);
  const phase = XpublessV2MigrationPhaseSchema.parse(nextPhase);
  if (!ALLOWED_JOURNAL_TRANSITIONS[journal.phase].includes(phase)) {
    throw new Error("Migration journal phase transition is not allowed.");
  }
  return XpublessV2MigrationJournalSchema.parse({
    ...journal,
    phase,
  });
}

/**
 * Records a legacy key removal only after a future storage layer removed and
 * verified that key. This helper never removes anything itself.
 */
export function markLegacyKeyRemovedFromJournal(
  journalInput: unknown,
  legacyKey: XpublessV2LegacyStorageKey,
): XpublessV2MigrationJournal {
  const journal = XpublessV2MigrationJournalSchema.parse(journalInput);
  const key = LegacyStorageKeySchema.parse(legacyKey);
  if (journal.phase !== "CLEANUP_PENDING") {
    throw new Error("Legacy key removal can be recorded only during cleanup.");
  }
  if (journal.remainingLegacyKeys[0] !== key) {
    throw new Error("Only the first pending legacy key may be recorded as removed.");
  }
  return XpublessV2MigrationJournalSchema.parse({
    ...journal,
    remainingLegacyKeys: journal.remainingLegacyKeys.slice(1),
  });
}
