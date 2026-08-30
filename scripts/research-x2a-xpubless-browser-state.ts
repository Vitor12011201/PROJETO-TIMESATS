/**
 * X2A research only: xpubless browser-state, local-instance isolation, and
 * crash-safe/idempotent migration modelling. Not production storage or recovery.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { HDKey } from "@scure/bip32";
import { z } from "zod";
import {
  allowedNetworks,
  createVaultPlan,
  deriveIssuedDeposits,
  issueNextDeposit,
  parseVaultPlan,
  vaultPlanIdentity,
  type VaultKeyOrigin,
  type VaultPlan,
} from "@/bitcoin";
import { testnetBip32Versions } from "@/bitcoin/bip32";
import {
  ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY,
  HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY,
  saveArchivedPlanIdentities,
  saveHiddenDepositIndexes,
  saveVaultPlans,
  VAULT_PLAN_STORAGE_KEY,
} from "@/storage/vault-plan-storage";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";

const FORMAT = "timesats-research-x2a-xpubless-browser-state";
const RESEARCH_STATE_KEY = "timesats-research-x2a-xpubless-state.v1";
const LEGACY_V2_KEY = "timesats.vault-plans.v2";
const DETERMINISTIC_REFERENCE_TAG = "timesats-research-x2a-deterministic-output-reference-v1";
const HISTORICAL_IDENTITY_TAG = "timesats-research-x1a-historical-v2-identity-v1";
const MAX_NON_HARDENED_INDEX = 0x7fffffff;
const OUTPUT_SCRIPT = /^0020[0-9a-f]{64}$/;

const IssuedOutputSchema = z.object({
  index: z.number().int().min(0).max(MAX_NON_HARDENED_INDEX),
  outputScript: z.string().regex(OUTPUT_SCRIPT),
}).strict();

const CandidatePlanSchema = z.object({
  policyVersion: z.literal(2),
  network: z.enum(allowedNetworks),
  unlockHeight: z.number().int().min(1).max(499_999_999),
  label: z.string().trim().min(1).max(80),
  derivation: z.object({ pathTemplate: z.literal("m/<index>"), hardened: z.literal(false) }).strict(),
  keyOrigin: z.object({
    masterFingerprint: z.string().regex(/^[0-9a-f]{8}$/),
    sourcePath: z.string().regex(/^m(?:\/(?:0|[1-9]\d*)(?:')?)*$/),
  }).strict(),
  historicalIdentityCommitment: z.string().regex(/^[0-9a-f]{64}$/),
  localInstanceId: z.string().uuid(),
  lastIssuedIndex: z.number().int().min(0).max(MAX_NON_HARDENED_INDEX),
  issuedOutputs: z.array(IssuedOutputSchema).min(1),
}).strict().superRefine((candidate, context) => {
  if (candidate.issuedOutputs.length !== candidate.lastIssuedIndex + 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Issued outputs must cover exactly #0 through lastIssuedIndex." });
  }
  candidate.issuedOutputs.forEach((output, position) => {
    if (output.index !== position) context.addIssue({ code: z.ZodIssueCode.custom, path: ["issuedOutputs", position, "index"], message: "Issued outputs must be contiguous and ordered." });
  });
});

const PersistentStateSchema = z.object({
  format: z.literal(FORMAT),
  experiment: z.literal("X2A"),
  plans: z.array(CandidatePlanSchema).min(1),
  archivedPlanInstanceIds: z.array(z.string().uuid()),
  hiddenDepositIndexes: z.record(z.string().uuid(), z.array(z.number().int().min(0).max(MAX_NON_HARDENED_INDEX))),
}).strict().superRefine((state, context) => {
  const instances = new Set(state.plans.map((plan) => plan.localInstanceId));
  if (instances.size !== state.plans.length) context.addIssue({ code: z.ZodIssueCode.custom, path: ["plans"], message: "Each candidate requires a distinct local instance ID." });
  for (const instanceId of state.archivedPlanInstanceIds) {
    if (!instances.has(instanceId)) context.addIssue({ code: z.ZodIssueCode.custom, path: ["archivedPlanInstanceIds"], message: "Archive preference must reference a candidate instance." });
  }
  for (const [instanceId, indexes] of Object.entries(state.hiddenDepositIndexes)) {
    const plan = state.plans.find((candidate) => candidate.localInstanceId === instanceId);
    if (!plan) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["hiddenDepositIndexes", instanceId], message: "Hidden preferences must reference a candidate instance." });
    } else if (new Set(indexes).size !== indexes.length || indexes.some((index) => index > plan.lastIssuedIndex)) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["hiddenDepositIndexes", instanceId], message: "Hidden indexes must be unique issued indexes." });
    }
  }
});

const StoredPlansSchema = z.object({
  format: z.literal("timesats-local-vault-plans"),
  version: z.union([z.literal(2), z.literal(3)]),
  plans: z.array(z.unknown()).min(1),
}).strict();

type X2aCandidatePlan = z.infer<typeof CandidatePlanSchema>;
type X2aPersistentState = z.infer<typeof PersistentStateSchema>;

interface PresentedWalletSource {
  extendedPublicKey: string;
  keyOrigin: VaultKeyOrigin;
}

type MigrationPhase = 1 | 2 | 3 | 4 | 5 | 6 | 7;

class SimulatedCrash extends Error {}

class MemoryStorage {
  private readonly values = new Map<string, string>();
  private failNextRemovalOf: string | null = null;

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  removeItem(key: string): void {
    if (this.failNextRemovalOf === key) {
      this.failNextRemovalOf = null;
      throw new Error(`Simulated remove failure for ${key}.`);
    }
    this.values.delete(key);
  }
  failNextRemove(key: string): void { this.failNextRemovalOf = key; }
  entries(): Array<[string, string]> { return [...this.values.entries()].sort(([left], [right]) => left.localeCompare(right)); }
}

function issuedPlan(lastIssuedIndex: number, label = "X2A public V2 fixture", keyOrigin: VaultKeyOrigin = validTestTpubOrigin): VaultPlan {
  let plan = createVaultPlan({ label, network: "regtest", unlockHeight: 250, extendedPublicKey: validTestTpub, policyVersion: 2, keyOrigin });
  while (plan.lastIssuedIndex < lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  return plan;
}

/** X1A's conditional binding/integrity digest, not an independent trust anchor. */
function historicalIdentityCommitment(plan: VaultPlan): string {
  if (plan.policy.policyVersion !== 2) throw new Error("X2A supports only Policy V2 rehydration research.");
  return createHash("sha256").update(JSON.stringify({
    tag: HISTORICAL_IDENTITY_TAG,
    policyVersion: plan.policy.policyVersion,
    network: plan.policy.network,
    unlockHeight: plan.policy.unlockHeight,
    keySource: { type: plan.policy.keySource.type, extendedPublicKey: plan.policy.keySource.extendedPublicKey, keyOrigin: plan.policy.keySource.keyOrigin },
    derivation: plan.policy.derivation,
  }), "utf8").digest("hex");
}

/** Retained only to demonstrate why deterministic output-only local keys alias. */
function deterministicOutputReference(plan: VaultPlan): string {
  const first = deriveIssuedDeposits(plan)[0];
  if (!first) throw new Error("X2A requires historically issued Deposit #0.");
  return createHash("sha256").update(JSON.stringify({
    tag: DETERMINISTIC_REFERENCE_TAG,
    policyVersion: plan.policy.policyVersion,
    network: plan.policy.network,
    unlockHeight: plan.policy.unlockHeight,
    firstOutputScript: first.outputScript,
  }), "utf8").digest("hex");
}

/** Opaque random ID is an instance key, not canonical plan identity or dedupe key. */
function newLocalInstanceId(): string {
  return randomUUID();
}

function createCandidatePlan(plan: VaultPlan, localInstanceId = newLocalInstanceId()): X2aCandidatePlan {
  if (plan.policy.policyVersion !== 2) throw new Error("X2A does not claim Policy V1 full rehydration.");
  return CandidatePlanSchema.parse({
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

function createPersistentState(plan: VaultPlan, archived: boolean, hiddenIndexes: number[], localInstanceId?: string): X2aPersistentState {
  const candidate = createCandidatePlan(plan, localInstanceId);
  return PersistentStateSchema.parse({
    format: FORMAT,
    experiment: "X2A",
    plans: [candidate],
    archivedPlanInstanceIds: archived ? [candidate.localInstanceId] : [],
    hiddenDepositIndexes: hiddenIndexes.length === 0 ? {} : { [candidate.localInstanceId]: [...new Set(hiddenIndexes)].sort((left, right) => left - right) },
  });
}

function assertNoProhibitedFields(value: unknown): void {
  const prohibited = new Set(["extendedPublicKey", "publicKey", "witnessScript", "privateKey", "seed", "mnemonic", "wif", "xprv", "tprv", "vaultPlanIdentity"]);
  if (Array.isArray(value)) return void value.forEach(assertNoProhibitedFields);
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    assert(!prohibited.has(key), `X2A state must not retain ${key}.`);
    assertNoProhibitedFields(child);
  }
}

function assertCandidateDoesNotExposePlan(state: X2aPersistentState, plan: VaultPlan): void {
  const serialized = JSON.stringify(state);
  assertNoProhibitedFields(state);
  assert(!serialized.includes(plan.policy.keySource.extendedPublicKey), "X2A state unexpectedly retains the source tpub.");
  assert(!serialized.includes(vaultPlanIdentity(plan)), "X2A state unexpectedly retains canonical VaultPlan identity.");
  deriveIssuedDeposits(plan).forEach((deposit) => {
    assert(!serialized.includes(deposit.publicKey), `X2A state unexpectedly retains Deposit #${deposit.index} public key.`);
    assert(!serialized.includes(deposit.witnessScript), `X2A state unexpectedly retains Deposit #${deposit.index} witness script.`);
  });
}

function loadPersistentState(serialized: string): X2aPersistentState {
  return PersistentStateSchema.parse(JSON.parse(serialized));
}

function watcherInput(candidate: X2aCandidatePlan): Array<{ index: number; outputScript: string }> {
  return candidate.issuedOutputs.map(({ index, outputScript }) => ({ index, outputScript }));
}

function rehydrate(candidate: X2aCandidatePlan, presented: PresentedWalletSource): VaultPlan {
  if (presented.keyOrigin.masterFingerprint.toLowerCase() !== candidate.keyOrigin.masterFingerprint || presented.keyOrigin.sourcePath.replace(/(\d+)[hH]/g, "$1'") !== candidate.keyOrigin.sourcePath) throw new Error("Presented public origin does not match the X2A candidate.");
  let plan = createVaultPlan({ label: candidate.label, network: candidate.network, unlockHeight: candidate.unlockHeight, extendedPublicKey: presented.extendedPublicKey, policyVersion: 2, keyOrigin: presented.keyOrigin });
  while (plan.lastIssuedIndex < candidate.lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  const deposits = deriveIssuedDeposits(plan);
  assert.equal(deposits.length, candidate.issuedOutputs.length, "Rehydration produced a different issued range.");
  candidate.issuedOutputs.forEach((commitment, position) => {
    assert.equal(deposits[position]?.index, commitment.index, `Rehydration index mismatch for Deposit #${commitment.index}.`);
    assert.equal(deposits[position]?.outputScript, commitment.outputScript, `Presented source does not reproduce Deposit #${commitment.index}.`);
  });
  assert.equal(historicalIdentityCommitment(plan), candidate.historicalIdentityCommitment, "Presented source does not reproduce preserved historical identity commitment.");
  return plan;
}

function updateAfterIssuance(state: X2aPersistentState, plan: VaultPlan): X2aPersistentState {
  const previous = state.plans[0];
  return PersistentStateSchema.parse({ ...state, plans: [createCandidatePlan(plan, previous.localInstanceId)] });
}

function unavailableWithoutWallet(operation: string): never { throw new Error(`${operation} requires a wallet/signer to re-present public derivation material; X2A persistent state has no tpub.`); }
function expectUnavailable(operation: () => unknown): void { assert.throws(operation, /requires a wallet\/signer to re-present public derivation material/); }

function unrelatedPublicTpub(): string {
  const original = HDKey.fromExtendedKey(validTestTpub, testnetBip32Versions);
  const unrelatedChild = original.deriveChild(1);
  assert(unrelatedChild.publicKey !== null && unrelatedChild.chainCode !== null, "Expected public-only BIP32 material.");
  return new HDKey({ versions: testnetBip32Versions, publicKey: unrelatedChild.publicKey, chainCode: unrelatedChild.chainCode, depth: original.depth, index: original.index, parentFingerprint: original.parentFingerprint }).publicExtendedKey;
}

function countOccurrences(value: string, needle: string): number { return value.split(needle).length - 1; }

function inspectCurrentPersistence(plan: VaultPlan): { entryCount: number; tpubOccurrences: number } {
  const storage = new MemoryStorage();
  const identity = vaultPlanIdentity(plan);
  saveVaultPlans(storage, [plan]);
  saveArchivedPlanIdentities(storage, [identity]);
  saveHiddenDepositIndexes(storage, { [identity]: [2] });
  const entries = storage.entries();
  assert.equal(entries.filter(([, value]) => value.includes(validTestTpub)).length, 3);
  const tpubOccurrences = entries.reduce((total, [, value]) => total + countOccurrences(value, validTestTpub), 0);
  assert.equal(tpubOccurrences, 3);
  return { entryCount: entries.length, tpubOccurrences };
}

function writeLegacyFixture(storage: MemoryStorage, plan: VaultPlan): void {
  const identity = vaultPlanIdentity(plan);
  saveVaultPlans(storage, [plan]);
  storage.setItem(LEGACY_V2_KEY, JSON.stringify({ format: "timesats-local-vault-plans", version: 2, plans: [plan] }));
  saveArchivedPlanIdentities(storage, [identity]);
  saveHiddenDepositIndexes(storage, { [identity]: [2] });
}

function readLegacyPlan(storage: MemoryStorage): VaultPlan | null {
  const rawEntries = [storage.getItem(VAULT_PLAN_STORAGE_KEY), storage.getItem(LEGACY_V2_KEY)].filter((raw): raw is string => raw !== null);
  if (rawEntries.length === 0) return null;
  const plans = rawEntries.flatMap((raw) => StoredPlansSchema.parse(JSON.parse(raw)).plans.map(parseVaultPlan));
  const identity = vaultPlanIdentity(plans[0]);
  assert(plans.every((plan) => vaultPlanIdentity(plan) === identity), "Research migration accepts only duplicate legacy copies of the same canonical plan.");
  return plans.reduce((latest, plan) => (plan.lastIssuedIndex > latest.lastIssuedIndex ? plan : latest));
}

function readLegacyPreferences(storage: MemoryStorage, plan: VaultPlan): { archived: boolean; hidden: number[] } {
  const identity = vaultPlanIdentity(plan);
  const archived = JSON.parse(storage.getItem(ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY) ?? "[]") as unknown;
  const hidden = JSON.parse(storage.getItem(HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY) ?? "{}") as unknown;
  return {
    archived: Array.isArray(archived) && archived.includes(identity),
    hidden: typeof hidden === "object" && hidden !== null && !Array.isArray(hidden) && Array.isArray((hidden as Record<string, unknown>)[identity]) ? (hidden as Record<string, number[]>)[identity] : [],
  };
}

function existingResearchState(storage: MemoryStorage): X2aPersistentState | null {
  const raw = storage.getItem(RESEARCH_STATE_KEY);
  return raw === null ? null : loadPersistentState(raw);
}

function crashAfter(requested: MigrationPhase | undefined, phase: MigrationPhase): void {
  if (requested === phase) throw new SimulatedCrash(`Simulated crash after migration phase ${phase}.`);
}

/** Research model only: durable ordering is crash-safe and idempotent, not multi-key atomic. */
function migrateLegacyState(storage: MemoryStorage, simulatedCrashAfter?: MigrationPhase): X2aPersistentState {
  const legacyPlan = readLegacyPlan(storage); // 1. Read + validate old entries.
  crashAfter(simulatedCrashAfter, 1);
  let state = existingResearchState(storage);
  if (!state) {
    if (!legacyPlan) throw new Error("No legacy state exists from which to create the X2A candidate.");
    state = createPersistentState(legacyPlan, false, []); // 2. Construct without deleting old state.
  }
  crashAfter(simulatedCrashAfter, 2);
  if (storage.getItem(RESEARCH_STATE_KEY) === null) storage.setItem(RESEARCH_STATE_KEY, JSON.stringify(state)); // 3. Write candidate.
  crashAfter(simulatedCrashAfter, 3);
  state = existingResearchState(storage)!; // 4. Read back and validate before cleanup.
  crashAfter(simulatedCrashAfter, 4);
  if (legacyPlan) {
    const preferences = readLegacyPreferences(storage, legacyPlan);
    const candidate = state.plans[0];
    state = PersistentStateSchema.parse({
      ...state,
      archivedPlanInstanceIds: preferences.archived ? [candidate.localInstanceId] : [],
      hiddenDepositIndexes: preferences.hidden.length === 0 ? {} : { [candidate.localInstanceId]: [...new Set(preferences.hidden)].sort((left, right) => left - right) },
    });
    storage.setItem(RESEARCH_STATE_KEY, JSON.stringify(state)); // 5. Rewrite preferences under local instance ID.
  }
  crashAfter(simulatedCrashAfter, 5);
  [VAULT_PLAN_STORAGE_KEY, LEGACY_V2_KEY, ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY, HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY].forEach((key) => storage.removeItem(key)); // 6. Cleanup may be partial.
  crashAfter(simulatedCrashAfter, 6);
  state = existingResearchState(storage)!;
  assertResearchStorageNoTpub(storage, legacyPlan ?? rehydrate(state.plans[0], { extendedPublicKey: validTestTpub, keyOrigin: validTestTpubOrigin })); // 7. Final inventory.
  crashAfter(simulatedCrashAfter, 7);
  return state;
}

function assertResearchStorageNoTpub(storage: MemoryStorage, plan: VaultPlan): void {
  const canonicalIdentity = vaultPlanIdentity(plan);
  for (const [, value] of storage.entries()) {
    assert(!value.includes(validTestTpub), "Research migration left a tpub-bearing entry.");
    assert(!value.includes(canonicalIdentity), "Research migration left a canonical-identity-bearing entry.");
    deriveIssuedDeposits(plan).forEach((deposit) => {
      assert(!value.includes(deposit.publicKey), "Research migration left a child public key.");
      assert(!value.includes(deposit.witnessScript), "Research migration left a witness script.");
    });
  }
}

function assertMigrationCrashSafety(plan: VaultPlan): void {
  for (const phase of [1, 2, 3, 4, 5, 6] as const) {
    const storage = new MemoryStorage();
    writeLegacyFixture(storage, plan);
    assert.throws(() => migrateLegacyState(storage, phase), SimulatedCrash);
    if (phase < 6) assert(storage.getItem(VAULT_PLAN_STORAGE_KEY) !== null, `Old v3 state disappeared before phase 6 after crash ${phase}.`);
    const completed = migrateLegacyState(storage);
    assert.equal(completed.plans.length, 1);
    assert.equal(storage.getItem(VAULT_PLAN_STORAGE_KEY), null);
    assert.equal(storage.getItem(LEGACY_V2_KEY), null);
  }
}

function main(): void {
  const original = issuedPlan(3);
  const originalIdentity = vaultPlanIdentity(original);
  const currentExposure = inspectCurrentPersistence(original);

  // Same descendant tpub and outputs, but a distinct historically declared ancestor.
  const planA = original;
  const planB = issuedPlan(3, "X2A altered historical origin", { masterFingerprint: validTestTpubOrigin.masterFingerprint, sourcePath: "m/84'/1'/0'" });
  assert.deepEqual(deriveIssuedDeposits(planA).map(({ outputScript }) => outputScript), deriveIssuedDeposits(planB).map(({ outputScript }) => outputScript));
  assert.notEqual(vaultPlanIdentity(planA), vaultPlanIdentity(planB));
  assert.notEqual(historicalIdentityCommitment(planA), historicalIdentityCommitment(planB));
  const aliasedOutputReference = deterministicOutputReference(planA);
  assert.equal(aliasedOutputReference, deterministicOutputReference(planB));
  const aliasedPreferences = { archived: [aliasedOutputReference], hidden: { [aliasedOutputReference]: [2] } };
  assert(aliasedPreferences.archived.includes(deterministicOutputReference(planA)) && aliasedPreferences.archived.includes(deterministicOutputReference(planB)), "Output-only reference aliases archive state.");
  assert.deepEqual(aliasedPreferences.hidden[deterministicOutputReference(planA)], aliasedPreferences.hidden[deterministicOutputReference(planB)]);

  // Session 1/2: random local instance ID isolates lifecycle state without claiming canonical identity.
  const sessionOne = createPersistentState(original, true, [2]);
  assertCandidateDoesNotExposePlan(sessionOne, original);
  const serialized = JSON.stringify(sessionOne);
  let sessionPlan: VaultPlan | undefined = original;
  sessionPlan = undefined;
  assert.equal(sessionPlan, undefined);
  const restarted = loadPersistentState(serialized);
  const candidate = restarted.plans[0];
  assert.equal(candidate.lastIssuedIndex, 3);
  assert.deepEqual(watcherInput(candidate), candidate.issuedOutputs.map(({ index, outputScript }) => ({ index, outputScript })));
  assert.deepEqual(restarted.archivedPlanInstanceIds, [candidate.localInstanceId]);
  assert.deepEqual(restarted.hiddenDepositIndexes, { [candidate.localInstanceId]: [2] });
  ["Deriving Deposit #N+1", "Reconstructing a witnessScript", "Recovering a child public key", "Calculating vaultPlanIdentity", "Preparing a complete spend"].forEach((operation) => expectUnavailable(() => unavailableWithoutWallet(operation)));

  const rehydrated = rehydrate(candidate, { extendedPublicKey: validTestTpub, keyOrigin: validTestTpubOrigin });
  assert.equal(vaultPlanIdentity(rehydrated), originalIdentity);
  const issued = issueNextDeposit(rehydrated);
  const updated = updateAfterIssuance(restarted, issued.plan);
  assert.equal(updated.plans[0].localInstanceId, candidate.localInstanceId);
  assert.equal(updated.plans[0].lastIssuedIndex, 4);
  assert.deepEqual(updated.archivedPlanInstanceIds, [candidate.localInstanceId]);
  assert.deepEqual(updated.hiddenDepositIndexes, { [candidate.localInstanceId]: [2] });
  assertCandidateDoesNotExposePlan(updated, issued.plan);
  assert.throws(() => rehydrate(candidate, { extendedPublicKey: unrelatedPublicTpub(), keyOrigin: validTestTpubOrigin }), /does not reproduce Deposit/);
  const renamedCandidate = createCandidatePlan(issuedPlan(3, "Outro label"), candidate.localInstanceId);
  assert.equal(renamedCandidate.localInstanceId, candidate.localInstanceId);

  const externallyAdvanced = issueNextDeposit(issuedPlan(3)).plan;
  assert.equal(watcherInput(restarted.plans[0]).some((output) => output.outputScript === deriveIssuedDeposits(externallyAdvanced)[4].outputScript), false);

  // v2 + v3 coexist; every crash phase reruns safely. This is not atomic across keys.
  assertMigrationCrashSafety(original);
  const migrationStorage = new MemoryStorage();
  writeLegacyFixture(migrationStorage, original);
  const migrated = migrateLegacyState(migrationStorage);
  assert.deepEqual(migrated.archivedPlanInstanceIds, [migrated.plans[0].localInstanceId]);
  assert.deepEqual(migrated.hiddenDepositIndexes, { [migrated.plans[0].localInstanceId]: [2] });
  assert.deepEqual(migrationStorage.entries().map(([key]) => key), [RESEARCH_STATE_KEY]);
  assertResearchStorageNoTpub(migrationStorage, original);

  // Corrupt new candidate never triggers old-key deletion because read-back fails.
  const corruptStorage = new MemoryStorage();
  writeLegacyFixture(corruptStorage, original);
  assert.throws(() => migrateLegacyState(corruptStorage, 3), SimulatedCrash);
  corruptStorage.setItem(RESEARCH_STATE_KEY, "{corrupt");
  assert.throws(() => migrateLegacyState(corruptStorage));
  assert(corruptStorage.getItem(VAULT_PLAN_STORAGE_KEY) !== null && corruptStorage.getItem(LEGACY_V2_KEY) !== null, "Corrupt candidate must leave old recovery state intact.");

  // Failed remove leaves duplicated exposure temporarily; rerun completes cleanup.
  const removeFailureStorage = new MemoryStorage();
  writeLegacyFixture(removeFailureStorage, original);
  removeFailureStorage.failNextRemove(LEGACY_V2_KEY);
  assert.throws(() => migrateLegacyState(removeFailureStorage), /Simulated remove failure/);
  assert(removeFailureStorage.getItem(LEGACY_V2_KEY) !== null, "Failed cleanup must report incomplete no-tpub migration.");
  migrateLegacyState(removeFailureStorage);
  assert.deepEqual(removeFailureStorage.entries().map(([key]) => key), [RESEARCH_STATE_KEY]);

  console.log(`X2A PASS current-storage=tpub-in-${currentExposure.entryCount}-entries,occurrences=${currentExposure.tpubOccurrences} deterministic-output-reference=aliased random-local-instance=isolated restart=watch-state-only reconnect=identity-and-commitments-match migration=crash-safe-idempotent-not-atomic corrupt-new=old-preserved remove-failure=rerunnable`);
}

main();
