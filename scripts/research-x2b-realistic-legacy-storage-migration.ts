/**
 * X2B research only: realistic rehearsal of current localStorage formats into
 * a monolithic V2 xpubless candidate. It never changes production storage.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  createVaultPlan,
  deriveIssuedDeposits,
  issueNextDeposit,
  parseVaultPlan,
  vaultPlanIdentity,
  type VaultPlan,
} from "@/bitcoin";
import { VaultPlanSchema } from "@/domain/vault-plan";
import {
  ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY,
  HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY,
  saveVaultPlans,
  VAULT_PLAN_STORAGE_KEY,
} from "@/storage/vault-plan-storage";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";

const LEGACY_V2_KEY = "timesats.vault-plans.v2";
const RESEARCH_KEY = "timesats-research-x2b-monolithic-xpubless-state.v1";
const FORMAT = "timesats-research-x2b-monolithic-xpubless-state";
const IDENTITY_TAG = "timesats-research-x1a-historical-v2-identity-v1";
const MAX_INDEX = 0x7fffffff;
const OUTPUT_SCRIPT = /^0020[0-9a-f]{64}$/;

const CandidateSchema = z.object({
  policyVersion: z.literal(2),
  network: z.enum(["signet", "regtest"]),
  unlockHeight: z.number().int().min(1).max(499_999_999),
  label: z.string().min(1).max(80),
  derivation: z.object({ pathTemplate: z.literal("m/<index>"), hardened: z.literal(false) }).strict(),
  keyOrigin: z.object({ masterFingerprint: z.string().regex(/^[0-9a-f]{8}$/), sourcePath: z.string().min(1) }).strict(),
  historicalIdentityCommitment: z.string().regex(/^[0-9a-f]{64}$/),
  localInstanceId: z.string().uuid(),
  lastIssuedIndex: z.number().int().min(0).max(MAX_INDEX),
  issuedOutputs: z.array(z.object({ index: z.number().int().min(0).max(MAX_INDEX), outputScript: z.string().regex(OUTPUT_SCRIPT) }).strict()).min(1),
}).strict().superRefine((candidate, context) => {
  if (candidate.issuedOutputs.length !== candidate.lastIssuedIndex + 1) context.addIssue({ code: z.ZodIssueCode.custom, message: "Outputs must be contiguous through lastIssuedIndex." });
  candidate.issuedOutputs.forEach((output, index) => {
    if (output.index !== index) context.addIssue({ code: z.ZodIssueCode.custom, path: ["issuedOutputs", index], message: "Output indexes must be ordered." });
  });
});

const JournalSchema = z.enum(["CANDIDATE_WRITTEN", "CLEANUP_PENDING", "COMPLETE"]);
const NewStateSchema = z.object({
  format: z.literal(FORMAT),
  experiment: z.literal("X2B"),
  journal: JournalSchema,
  candidates: z.array(CandidateSchema).min(1),
  archivedLocalInstanceIds: z.array(z.string().uuid()),
  hiddenDepositIndexes: z.record(z.string().uuid(), z.array(z.number().int().min(0).max(MAX_INDEX))),
}).strict().superRefine((state, context) => {
  const ids = new Set(state.candidates.map((candidate) => candidate.localInstanceId));
  if (ids.size !== state.candidates.length) context.addIssue({ code: z.ZodIssueCode.custom, message: "Duplicate local instance ID." });
  state.archivedLocalInstanceIds.forEach((id) => {
    if (!ids.has(id)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["archivedLocalInstanceIds"], message: "Archive points to missing candidate." });
  });
  Object.entries(state.hiddenDepositIndexes).forEach(([id, indexes]) => {
    const candidate = state.candidates.find((item) => item.localInstanceId === id);
    if (!candidate || new Set(indexes).size !== indexes.length || indexes.some((index) => index > candidate.lastIssuedIndex)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["hiddenDepositIndexes", id], message: "Invalid hidden preference." });
    }
  });
});

const StoredPlansSchema = z.object({
  format: z.literal("timesats-local-vault-plans"),
  version: z.union([z.literal(2), z.literal(3)]),
  plans: z.array(VaultPlanSchema),
}).strict();
const ArchivedSchema = z.array(z.string().min(1));
const HiddenSchema = z.record(z.array(z.number().int().min(0).max(MAX_INDEX)));

type Candidate = z.infer<typeof CandidateSchema>;
type NewState = z.infer<typeof NewStateSchema>;
type SecurityStatus = "COMPLETE_XPUBLESS" | "PARTIAL_LEGACY_EXPOSURE" | "BLOCKED_UNSUPPORTED_V1" | "BLOCKED_DUPLICATE_SEMANTICS" | "FAILED_RECOVERABLE";
type CrashPoint = "read" | "construct" | "write-new" | "read-back" | "preferences" | "remove-v3" | "remove-v2" | "remove-archive" | "remove-hidden" | "final-verify";

class SimulatedCrash extends Error {}
class DuplicateSemanticsBlocked extends Error {}

class ResearchStorage {
  private readonly values = new Map<string, string>();
  private quota = Number.POSITIVE_INFINITY;
  private failRemoveKey: string | null = null;

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    const previous = this.values.get(key) ?? "";
    const projected = this.bytes() - Buffer.byteLength(previous, "utf8") + Buffer.byteLength(value, "utf8");
    if (projected > this.quota) throw new Error("QuotaExceededError: research storage quota.");
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    if (this.failRemoveKey === key) {
      this.failRemoveKey = null;
      throw new Error(`Simulated remove failure for ${key}.`);
    }
    this.values.delete(key);
  }
  setQuota(bytes: number): void { this.quota = bytes; }
  failNextRemove(key: string): void { this.failRemoveKey = key; }
  corrupt(key: string, value: string): void { this.values.set(key, value); }
  entries(): Array<[string, string]> { return [...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)); }
  bytes(): number { return this.entries().reduce((total, [key, value]) => total + Buffer.byteLength(key + value, "utf8"), 0); }
}

interface LegacyInspection {
  v2Plans: VaultPlan[];
  v1Plans: VaultPlan[];
  archived: string[];
  hidden: Record<string, number[]>;
  discardedPreferences: boolean;
}

interface MigrationOutcome {
  status: SecurityStatus;
  state: NewState | null;
  reason?: string;
}

function planV2(label: string, unlockHeight: number, lastIssuedIndex = 0): VaultPlan {
  let plan = createVaultPlan({ label, network: "regtest", unlockHeight, extendedPublicKey: validTestTpub, policyVersion: 2, keyOrigin: validTestTpubOrigin });
  while (plan.lastIssuedIndex < lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  return plan;
}

function planV1(label: string, unlockHeight: number, lastIssuedIndex = 0): VaultPlan {
  let plan = createVaultPlan({ label, network: "regtest", unlockHeight, extendedPublicKey: validTestTpub });
  while (plan.lastIssuedIndex < lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  return plan;
}

function historicalIdentityCommitment(plan: VaultPlan): string {
  if (plan.policy.policyVersion !== 2) throw new Error("X2B candidates support only V2.");
  return createHash("sha256").update(JSON.stringify({
    tag: IDENTITY_TAG,
    policyVersion: 2,
    network: plan.policy.network,
    unlockHeight: plan.policy.unlockHeight,
    keySource: { type: plan.policy.keySource.type, extendedPublicKey: plan.policy.keySource.extendedPublicKey, keyOrigin: plan.policy.keySource.keyOrigin },
    derivation: plan.policy.derivation,
  }), "utf8").digest("hex");
}

function candidateFromPlan(plan: VaultPlan, localInstanceId = randomUUID()): Candidate {
  if (plan.policy.policyVersion !== 2) throw new Error("V1 must never become an X2B candidate.");
  return CandidateSchema.parse({
    policyVersion: 2,
    network: plan.policy.network,
    unlockHeight: plan.policy.unlockHeight,
    label: plan.metadata.label,
    derivation: plan.policy.derivation,
    keyOrigin: plan.policy.keySource.keyOrigin,
    historicalIdentityCommitment: historicalIdentityCommitment(plan),
    localInstanceId,
    lastIssuedIndex: plan.lastIssuedIndex,
    issuedOutputs: deriveIssuedDeposits(plan).map(({ index, outputScript }) => ({ index, outputScript })),
  });
}

function writeV3(storage: ResearchStorage, plans: VaultPlan[]): void {
  saveVaultPlans(storage, plans);
}

function writeV2(storage: ResearchStorage, plans: VaultPlan[]): void {
  storage.setItem(LEGACY_V2_KEY, JSON.stringify({ format: "timesats-local-vault-plans", version: 2, plans }));
}

function writePreferences(storage: ResearchStorage, archived: string[], hidden: Record<string, number[]>): void {
  storage.setItem(ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY, JSON.stringify(archived));
  storage.setItem(HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY, JSON.stringify(hidden));
}

function parsePlanEntry(storage: ResearchStorage, key: string): VaultPlan[] {
  const raw = storage.getItem(key);
  if (raw === null) return [];
  return StoredPlansSchema.parse(JSON.parse(raw)).plans.map(parseVaultPlan);
}

function parsePreferences(storage: ResearchStorage): Pick<LegacyInspection, "archived" | "hidden" | "discardedPreferences"> {
  let archived: string[] = [];
  let hidden: Record<string, number[]> = {};
  let discardedPreferences = false;
  try {
    const raw = storage.getItem(ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY);
    archived = raw === null ? [] : [...new Set(ArchivedSchema.parse(JSON.parse(raw)))];
  } catch { discardedPreferences = true; }
  try {
    const raw = storage.getItem(HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY);
    hidden = raw === null ? {} : HiddenSchema.parse(JSON.parse(raw));
  } catch { discardedPreferences = true; }
  return { archived, hidden, discardedPreferences };
}

function inspectLegacy(storage: ResearchStorage): LegacyInspection {
  const v3 = parsePlanEntry(storage, VAULT_PLAN_STORAGE_KEY);
  const v2 = parsePlanEntry(storage, LEGACY_V2_KEY);
  for (const [source, plans] of [["v3", v3], ["v2", v2]] as const) {
    const identities = plans.map(vaultPlanIdentity);
    if (new Set(identities).size !== identities.length) throw new DuplicateSemanticsBlocked(`Duplicate canonical identity inside ${source} storage entry requires an explicit future dedupe policy.`);
  }
  const grouped = new Map<string, VaultPlan[]>();
  [...v3, ...v2].forEach((plan) => grouped.set(vaultPlanIdentity(plan), [...(grouped.get(vaultPlanIdentity(plan)) ?? []), plan]));
  const v1Plans: VaultPlan[] = [];
  const v2Plans: VaultPlan[] = [];
  grouped.forEach((copies) => {
    if (copies.some((plan) => plan.policy.policyVersion === 1)) {
      v1Plans.push(...copies);
      return;
    }
    const v3Copy = v3.find((plan) => vaultPlanIdentity(plan) === vaultPlanIdentity(copies[0]));
    const preferred = v3Copy ?? copies[0];
    const highest = Math.max(...copies.map((plan) => plan.lastIssuedIndex));
    v2Plans.push(parseVaultPlan({ ...preferred, lastIssuedIndex: highest }));
  });
  return { v1Plans, v2Plans, ...parsePreferences(storage) };
}

function stateFromPlans(plans: VaultPlan[]): NewState {
  return NewStateSchema.parse({
    format: FORMAT,
    experiment: "X2B",
    journal: "CANDIDATE_WRITTEN",
    candidates: plans.map((plan) => candidateFromPlan(plan)),
    archivedLocalInstanceIds: [],
    hiddenDepositIndexes: {},
  });
}

function loadNewState(storage: ResearchStorage): NewState | null {
  const raw = storage.getItem(RESEARCH_KEY);
  return raw === null ? null : NewStateSchema.parse(JSON.parse(raw));
}

function verifyNewState(state: NewState, plans: VaultPlan[]): void {
  assert.equal(state.candidates.length, plans.length, "Candidate count differs from reconciled V2 plans.");
  const expectedByCommitment = new Map(plans.map((plan) => [historicalIdentityCommitment(plan), plan]));
  state.candidates.forEach((candidate) => {
    const plan = expectedByCommitment.get(candidate.historicalIdentityCommitment);
    assert(plan, "Candidate does not match a reconciled V2 plan.");
    assert.equal(candidate.lastIssuedIndex, plan.lastIssuedIndex);
    assert.deepEqual(candidate.issuedOutputs, deriveIssuedDeposits(plan).map(({ index, outputScript }) => ({ index, outputScript })));
    assert.equal(candidate.label, plan.metadata.label);
  });
}

function mapPreferences(state: NewState, inspection: LegacyInspection): NewState {
  const byCommitment = new Map(state.candidates.map((candidate) => [candidate.historicalIdentityCommitment, candidate]));
  const byIdentity = new Map(inspection.v2Plans.map((plan) => [vaultPlanIdentity(plan), byCommitment.get(historicalIdentityCommitment(plan))!]));
  const archivedLocalInstanceIds = inspection.archived.flatMap((identity) => byIdentity.get(identity)?.localInstanceId ?? []);
  const hiddenDepositIndexes: Record<string, number[]> = {};
  Object.entries(inspection.hidden).forEach(([identity, indexes]) => {
    const candidate = byIdentity.get(identity);
    if (!candidate) return; // Unknown/V1 preferences are never allowed to affect V2 candidates.
    const valid = [...new Set(indexes.filter((index) => index <= candidate.lastIssuedIndex))].sort((left, right) => left - right);
    if (valid.length > 0) hiddenDepositIndexes[candidate.localInstanceId] = valid;
  });
  return NewStateSchema.parse({ ...state, journal: "CLEANUP_PENDING", archivedLocalInstanceIds: [...new Set(archivedLocalInstanceIds)], hiddenDepositIndexes });
}

function assertNoV2Exposure(storage: ResearchStorage, plans: VaultPlan[]): void {
  for (const [, value] of storage.entries()) {
    plans.forEach((plan) => {
      assert(!value.includes(plan.policy.keySource.extendedPublicKey), "X2B final state still contains V2 tpub.");
      assert(!value.includes(vaultPlanIdentity(plan)), "X2B final state still contains canonical identity.");
      deriveIssuedDeposits(plan).forEach((deposit) => {
        assert(!value.includes(deposit.publicKey), "X2B final state still contains child public key.");
        assert(!value.includes(deposit.witnessScript), "X2B final state still contains witness script.");
      });
    });
  }
}

function crashAt(requested: CrashPoint | undefined, point: CrashPoint): void {
  if (requested === point) throw new SimulatedCrash(`Simulated crash at ${point}.`);
}

function incomplete(state: NewState, reason: string): MigrationOutcome {
  return { status: "PARTIAL_LEGACY_EXPOSURE", state, reason };
}

/** Monolithic new-state migration. Existing V1 or ambiguous duplicates are blocked before any write. */
function migrate(storage: ResearchStorage, crash?: CrashPoint): MigrationOutcome {
  let inspection: LegacyInspection;
  try {
    crashAt(crash, "read");
    inspection = inspectLegacy(storage);
  } catch (cause) {
    if (cause instanceof DuplicateSemanticsBlocked) return { status: "BLOCKED_DUPLICATE_SEMANTICS", state: null, reason: cause.message };
    return { status: "FAILED_RECOVERABLE", state: null, reason: cause instanceof Error ? cause.message : "Legacy read failed." };
  }
  if (inspection.v1Plans.length > 0) return { status: "BLOCKED_UNSUPPORTED_V1", state: null, reason: "V1 legacy state remains intact; V1 xpubless rehydration is not proven." };
  if (inspection.v2Plans.length === 0) {
    try {
      const existing = loadNewState(storage);
      if (!existing || existing.journal !== "CLEANUP_PENDING") {
        return { status: "FAILED_RECOVERABLE", state: null, reason: "No valid V2 state to migrate." };
      }
      for (const key of [VAULT_PLAN_STORAGE_KEY, LEGACY_V2_KEY, ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY, HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY]) storage.removeItem(key);
      const complete = NewStateSchema.parse({ ...existing, journal: "COMPLETE" });
      storage.setItem(RESEARCH_KEY, JSON.stringify(complete));
      return { status: "COMPLETE_XPUBLESS", state: complete };
    } catch (cause) {
      return { status: "FAILED_RECOVERABLE", state: null, reason: cause instanceof Error ? cause.message : "Interrupted cleanup state is invalid." };
    }
  }

  let state: NewState;
  try {
    state = loadNewState(storage) ?? (() => {
      crashAt(crash, "construct");
      return stateFromPlans(inspection.v2Plans);
    })();
    verifyNewState(state, inspection.v2Plans);
  } catch (cause) {
    return { status: "FAILED_RECOVERABLE", state: null, reason: cause instanceof Error ? cause.message : "Candidate validation failed." };
  }

  try {
    if (storage.getItem(RESEARCH_KEY) === null) {
      crashAt(crash, "write-new");
      storage.setItem(RESEARCH_KEY, JSON.stringify(state));
    }
    crashAt(crash, "read-back");
    state = loadNewState(storage)!;
    verifyNewState(state, inspection.v2Plans);
    if (state.journal === "CANDIDATE_WRITTEN") {
      crashAt(crash, "preferences");
      state = mapPreferences(state, inspection);
      storage.setItem(RESEARCH_KEY, JSON.stringify(state));
    }
  } catch (cause) {
    return { status: "FAILED_RECOVERABLE", state: null, reason: cause instanceof Error ? cause.message : "New state was not written and validated." };
  }

  for (const [key, point] of [
    [VAULT_PLAN_STORAGE_KEY, "remove-v3"],
    [LEGACY_V2_KEY, "remove-v2"],
    [ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY, "remove-archive"],
    [HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY, "remove-hidden"],
  ] as const) {
    try {
      storage.removeItem(key);
      crashAt(crash, point);
    } catch (cause) {
      if (cause instanceof SimulatedCrash) throw cause;
      return incomplete(state, cause instanceof Error ? cause.message : "Legacy cleanup failed.");
    }
  }

  try {
    crashAt(crash, "final-verify");
    assertNoV2Exposure(storage, inspection.v2Plans);
    state = NewStateSchema.parse({ ...state, journal: "COMPLETE" });
    storage.setItem(RESEARCH_KEY, JSON.stringify(state));
    return { status: "COMPLETE_XPUBLESS", state };
  } catch (cause) {
    return { status: "FAILED_RECOVERABLE", state, reason: cause instanceof Error ? cause.message : "Final verification failed." };
  }
}

function expectComplete(storage: ResearchStorage): NewState {
  const outcome = migrate(storage);
  assert.equal(outcome.status, "COMPLETE_XPUBLESS", outcome.reason);
  assert(outcome.state !== null);
  assert.equal(outcome.state.journal, "COMPLETE");
  return outcome.state;
}

function legacyWith(planKey: "v2" | "v3", plans: VaultPlan[]): ResearchStorage {
  const storage = new ResearchStorage();
  if (planKey === "v2") writeV2(storage, plans); else writeV3(storage, plans);
  return storage;
}

function main(): void {
  const first = planV2("S1 atual", 250, 3);
  const second = planV2("S2 segundo", 251, 2);
  const firstIdentity = vaultPlanIdentity(first);

  // S1 through S7: actual accepted wrappers for one/multiple V2 states.
  const s1 = expectComplete(legacyWith("v3", [first]));
  assert.equal(s1.candidates.length, 1);
  const s2 = expectComplete(legacyWith("v3", [first, second]));
  assert.equal(s2.candidates.length, 2);
  assert.notEqual(s2.candidates[0].localInstanceId, s2.candidates[1].localInstanceId);
  const s3Storage = legacyWith("v3", [first]);
  writePreferences(s3Storage, [firstIdentity], { [firstIdentity]: [2] });
  const s3 = expectComplete(s3Storage);
  assert.deepEqual(s3.archivedLocalInstanceIds, [s3.candidates[0].localInstanceId]);
  assert.deepEqual(s3.hiddenDepositIndexes, { [s3.candidates[0].localInstanceId]: [2] });
  assert.equal(expectComplete(legacyWith("v2", [first])).candidates[0].lastIssuedIndex, 3); // S4
  assert.equal(expectComplete(legacyWith("v3", [first])).candidates[0].lastIssuedIndex, 3); // S5

  // S6 and monotonicity: v2/v3 duplicate copies reconcile only after canonical identity equality.
  const low = planV2("v2 label", 252, 3);
  const high = planV2("v3 label", 252, 5);
  const s6Storage = new ResearchStorage();
  writeV2(s6Storage, [low]);
  writeV3(s6Storage, [high]);
  const s6 = expectComplete(s6Storage);
  assert.equal(s6.candidates[0].lastIssuedIndex, 5);
  assert.equal(s6.candidates[0].label, "v3 label");
  const reverseStorage = new ResearchStorage();
  writeV2(reverseStorage, [high]);
  writeV3(reverseStorage, [low]);
  assert.equal(expectComplete(reverseStorage).candidates[0].lastIssuedIndex, 5);
  assert.equal(s2.candidates.length, 2); // S7: different labels/different canonical plans both survive.

  // S8: schema permits duplicates; migration blocks rather than inventing dedupe semantics.
  const s8Storage = legacyWith("v3", [first, { ...first, metadata: { label: "S8 duplicate label" } }]);
  const s8 = migrate(s8Storage);
  assert.equal(s8.status, "BLOCKED_DUPLICATE_SEMANTICS");
  assert.equal(s8Storage.getItem(RESEARCH_KEY), null);

  // S9: retained monolithic candidate survives interrupted cleanup with stable UUIDs.
  const s9Storage = legacyWith("v3", [first]);
  writePreferences(s9Storage, [firstIdentity], { [firstIdentity]: [2] });
  assert.throws(() => migrate(s9Storage, "remove-v3"), SimulatedCrash);
  const retained = loadNewState(s9Storage)!;
  const retainedId = retained.candidates[0].localInstanceId;
  const s9 = expectComplete(s9Storage);
  assert.equal(s9.candidates[0].localInstanceId, retainedId);

  // S10: partially corrupt current state blocks cleanup even if another key is valid.
  const s10Storage = legacyWith("v2", [first]);
  s10Storage.corrupt(VAULT_PLAN_STORAGE_KEY, "{invalid");
  const s10 = migrate(s10Storage);
  assert.equal(s10.status, "FAILED_RECOVERABLE");
  assert(s10Storage.getItem(LEGACY_V2_KEY) !== null);

  // S11-S13: block rather than diminish V1 recoverability or leave misleading status.
  const v1 = planV1("S11 V1", 300, 2);
  const s11Storage = legacyWith("v3", [v1]);
  assert.equal(migrate(s11Storage).status, "BLOCKED_UNSUPPORTED_V1");
  assert(s11Storage.getItem(VAULT_PLAN_STORAGE_KEY)?.includes(validTestTpub));
  const s12Storage = legacyWith("v3", [v1, first]);
  assert.equal(migrate(s12Storage).status, "BLOCKED_UNSUPPORTED_V1");
  const v1Identity = vaultPlanIdentity(v1);
  const s13Storage = legacyWith("v3", [v1]);
  writePreferences(s13Storage, [v1Identity], { [v1Identity]: [1] });
  assert.equal(migrate(s13Storage).status, "BLOCKED_UNSUPPORTED_V1");
  assert(s13Storage.getItem(ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY)?.includes(validTestTpub));

  // Preference conflicts are secondary: known valid V2 values merge; invalid/dangling values disappear, never plans.
  const conflictStorage = legacyWith("v3", [first]);
  writePreferences(conflictStorage, [firstIdentity, "missing-identity"], { [firstIdentity]: [2, 3, 99], "missing-identity": [0] });
  const conflictState = expectComplete(conflictStorage);
  assert.deepEqual(conflictState.archivedLocalInstanceIds, [conflictState.candidates[0].localInstanceId]);
  assert.deepEqual(conflictState.hiddenDepositIndexes, { [conflictState.candidates[0].localInstanceId]: [2, 3] });

  // Crash injection across all relevant phases; old state persists until cleanup and reruns converge.
  for (const point of ["read", "construct", "write-new", "read-back", "preferences", "remove-v3", "remove-v2", "remove-archive", "remove-hidden", "final-verify"] as const) {
    const storage = legacyWith("v3", [first]);
    writePreferences(storage, [firstIdentity], { [firstIdentity]: [2] });
    const before = storage.getItem(VAULT_PLAN_STORAGE_KEY);
    try { migrate(storage, point); } catch (cause) { assert(cause instanceof SimulatedCrash); }
    if (["read", "construct", "write-new", "read-back", "preferences"].includes(point)) assert.equal(storage.getItem(VAULT_PLAN_STORAGE_KEY), before);
    expectComplete(storage);
  }

  // Quota failure: setItem is all-or-nothing in this model, so legacy state remains when monolithic write cannot fit.
  const quotaStorage = legacyWith("v3", [first]);
  const baseline = quotaStorage.bytes();
  quotaStorage.setQuota(baseline + 1);
  const quota = migrate(quotaStorage);
  assert.equal(quota.status, "FAILED_RECOVERABLE");
  assert.equal(quotaStorage.getItem(RESEARCH_KEY), null);
  assert(quotaStorage.getItem(VAULT_PLAN_STORAGE_KEY) !== null);

  // Corrupt every material candidate field before cleanup; old state remains recoverable.
  for (const mutate of [
    (state: NewState) => ({ ...state, candidates: [{ ...state.candidates[0], localInstanceId: "not-a-uuid" }] }),
    (state: NewState) => ({ ...state, candidates: [{ ...state.candidates[0], lastIssuedIndex: 4 }] }),
    (state: NewState) => ({ ...state, candidates: [{ ...state.candidates[0], issuedOutputs: [{ ...state.candidates[0].issuedOutputs[0], outputScript: "0020" + "00".repeat(32) }, ...state.candidates[0].issuedOutputs.slice(1)] }] }),
    (state: NewState) => ({ ...state, candidates: [{ ...state.candidates[0], issuedOutputs: state.candidates[0].issuedOutputs.slice(1) }] }),
    (state: NewState) => ({ ...state, candidates: [{ ...state.candidates[0], historicalIdentityCommitment: "00".repeat(32) }] }),
    (state: NewState) => ({ ...state, archivedLocalInstanceIds: [randomUUID()] }),
    (state: NewState) => ({ ...state, candidates: [state.candidates[0], { ...state.candidates[0] }] }),
  ]) {
    const storage = legacyWith("v3", [first]);
    assert.equal(migrate(storage, "read-back").status, "FAILED_RECOVERABLE");
    const state = loadNewState(storage)!;
    storage.corrupt(RESEARCH_KEY, JSON.stringify(mutate(state)));
    assert.equal(migrate(storage).status, "FAILED_RECOVERABLE");
    assert(storage.getItem(VAULT_PLAN_STORAGE_KEY) !== null);
  }

  // Failed cleanup is explicitly partial until rerun; no complete claim while v2 remains.
  const removeFailure = new ResearchStorage();
  writeV3(removeFailure, [first]);
  writeV2(removeFailure, [first]);
  removeFailure.failNextRemove(LEGACY_V2_KEY);
  const partial = migrate(removeFailure);
  assert.equal(partial.status, "PARTIAL_LEGACY_EXPOSURE");
  assert(removeFailure.getItem(LEGACY_V2_KEY)?.includes(validTestTpub));
  assert.equal(expectComplete(removeFailure).journal, "COMPLETE");

  // Monolithic new state uses one write/read-back; equivalent separate candidate/archive/hidden payloads cost more bytes.
  const comparisonState = stateFromPlans([first, second]);
  const mono = JSON.stringify(comparisonState);
  const multi = [
    JSON.stringify({ format: "timesats-research-x2b-candidates", candidates: comparisonState.candidates }),
    JSON.stringify({ format: "timesats-research-x2b-archive", ids: comparisonState.archivedLocalInstanceIds }),
    JSON.stringify({ format: "timesats-research-x2b-hidden", indexes: comparisonState.hiddenDepositIndexes, journal: comparisonState.journal }),
  ].join("");
  assert(Buffer.byteLength(multi, "utf8") > Buffer.byteLength(mono, "utf8"));

  console.log("X2B PASS scenarios=S1-S13 v2=monolithic-complete v1=blocked-residual-tpub duplicates=blocked lastIssuedIndex=max-for-same-canonical preferences=secondary crash=rerunnable quota=old-intact corruption=old-intact remove-failure=partial-then-rerun");
}

main();
