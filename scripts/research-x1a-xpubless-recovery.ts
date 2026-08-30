/**
 * X1A research only: tests whether emitted P2WSH output commitments can form
 * a durable recovery candidate without retaining a tpub or per-deposit keys.
 * It is not a production recovery format, policy, or application runtime path.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HDKey } from "@scure/bip32";
import { z } from "zod";
import {
  allowedNetworks,
  createVaultPlan,
  deriveIssuedDeposits,
  issueNextDeposit,
  vaultPlanIdentity,
  type VaultKeyOrigin,
  type VaultPlan,
} from "@/bitcoin";
import { testnetBip32Versions } from "@/bitcoin/bip32";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";

const EXPERIMENT_FORMAT = "timesats-research-x1a-reduced-xpub-recovery";
const MAX_NON_HARDENED_INDEX = 0x7fffffff;
const OUTPUT_SCRIPT = /^0020[0-9a-f]{64}$/;
const IDENTITY_COMMITMENT_TAG = "timesats-research-x1a-historical-v2-identity-v1";

const CandidateOutputSchema = z.object({
  index: z.number().int().min(0).max(MAX_NON_HARDENED_INDEX),
  outputScript: z.string().regex(OUTPUT_SCRIPT),
}).strict();

const CandidateSchema = z.object({
  format: z.literal(EXPERIMENT_FORMAT),
  experiment: z.literal("X1A"),
  network: z.enum(allowedNetworks),
  policyVersion: z.literal(2),
  unlockHeight: z.number().int().min(1).max(499_999_999),
  derivation: z.object({ pathTemplate: z.literal("m/<index>"), hardened: z.literal(false) }).strict(),
  keyOrigin: z.object({
    masterFingerprint: z.string().regex(/^[0-9a-f]{8}$/),
    sourcePath: z.string().regex(/^m(?:\/(?:0|[1-9]\d*)(?:')?)*$/),
  }).strict(),
  historicalIdentityCommitment: z.string().regex(/^[0-9a-f]{64}$/),
  lastIssuedIndex: z.number().int().min(0).max(MAX_NON_HARDENED_INDEX),
  issuedOutputs: z.array(CandidateOutputSchema).min(1),
}).strict().superRefine((candidate, context) => {
  if (candidate.issuedOutputs.length !== candidate.lastIssuedIndex + 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Issued outputs must cover exactly #0 through lastIssuedIndex." });
  }
  candidate.issuedOutputs.forEach((output, position) => {
    if (output.index !== position) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["issuedOutputs", position, "index"], message: "Issued output indexes must be contiguous and ordered from #0." });
    }
  });
});

type X1aCandidate = z.infer<typeof CandidateSchema>;

interface RehydrationInput {
  extendedPublicKey: string;
  keyOrigin: VaultKeyOrigin;
}

function issuedPlan(lastIssuedIndex: number): VaultPlan {
  let plan = createVaultPlan({
    label: "X1A public V2 fixture",
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  while (plan.lastIssuedIndex < lastIssuedIndex) {
    plan = issueNextDeposit(plan).plan;
  }
  return plan;
}

/**
 * Research-only binding and integrity check for a preserved original digest.
 * It is deliberately not SHA256 of the current display identity string and
 * does not authenticate a fully substituted candidate without an external
 * trust anchor. It does not define future product semantics.
 */
function historicalIdentityCommitment(plan: VaultPlan): string {
  if (plan.policy.policyVersion !== 2) throw new Error("X1A historical identity commitment supports only Policy V2.");
  const preimage = JSON.stringify({
    tag: IDENTITY_COMMITMENT_TAG,
    policyVersion: plan.policy.policyVersion,
    network: plan.policy.network,
    unlockHeight: plan.policy.unlockHeight,
    keySource: {
      type: plan.policy.keySource.type,
      extendedPublicKey: plan.policy.keySource.extendedPublicKey,
      keyOrigin: plan.policy.keySource.keyOrigin,
    },
    derivation: plan.policy.derivation,
  });
  return createHash("sha256").update(preimage, "utf8").digest("hex");
}

function createCandidate(plan: VaultPlan): X1aCandidate {
  if (plan.policy.policyVersion !== 2) throw new Error("X1A supports only Policy V2 because V1 lacks a legitimate recorded key origin.");
  const deposits = deriveIssuedDeposits(plan);
  return CandidateSchema.parse({
    format: EXPERIMENT_FORMAT,
    experiment: "X1A",
    network: plan.policy.network,
    policyVersion: plan.policy.policyVersion,
    unlockHeight: plan.policy.unlockHeight,
    derivation: plan.policy.derivation,
    keyOrigin: plan.policy.keySource.keyOrigin,
    historicalIdentityCommitment: historicalIdentityCommitment(plan),
    lastIssuedIndex: plan.lastIssuedIndex,
    issuedOutputs: deposits.map((deposit) => ({ index: deposit.index, outputScript: deposit.outputScript })),
  });
}

function assertNoProhibitedFields(value: unknown): void {
  const prohibited = new Set(["extendedPublicKey", "publicKey", "witnessScript", "privateKey", "seed", "mnemonic", "wif", "xprv", "tprv"]);
  if (Array.isArray(value)) {
    value.forEach(assertNoProhibitedFields);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    assert(!prohibited.has(key), `X1A candidate must not retain ${key}.`);
    assertNoProhibitedFields(child);
  }
}

function assertCandidateDoesNotExposeSource(candidate: X1aCandidate, plan: VaultPlan): void {
  const serialized = JSON.stringify(candidate);
  const deposits = deriveIssuedDeposits(plan);
  assertNoProhibitedFields(candidate);
  assert(!serialized.includes(plan.policy.keySource.extendedPublicKey), "Candidate unexpectedly retains the source tpub.");
  for (const deposit of deposits) {
    assert(!serialized.includes(deposit.publicKey), `Candidate unexpectedly retains Deposit #${deposit.index} public key.`);
    assert(!serialized.includes(deposit.witnessScript), `Candidate unexpectedly retains Deposit #${deposit.index} witness script.`);
  }
}

function planFromPresentedSource(candidate: X1aCandidate, presented: RehydrationInput): VaultPlan {
  if (presented.keyOrigin.masterFingerprint.toLowerCase() !== candidate.keyOrigin.masterFingerprint || presented.keyOrigin.sourcePath.replace(/(\d+)[hH]/g, "$1'") !== candidate.keyOrigin.sourcePath) {
    throw new Error("Presented public origin does not match the X1A candidate.");
  }

  let plan = createVaultPlan({
    label: "X1A rehydrated public policy",
    network: candidate.network,
    unlockHeight: candidate.unlockHeight,
    extendedPublicKey: presented.extendedPublicKey,
    policyVersion: 2,
    keyOrigin: presented.keyOrigin,
  });
  while (plan.lastIssuedIndex < candidate.lastIssuedIndex) {
    plan = issueNextDeposit(plan).plan;
  }
  return plan;
}

function assertOutputCommitments(candidate: X1aCandidate, plan: VaultPlan): void {
  const derived = deriveIssuedDeposits(plan);
  for (const [position, commitment] of candidate.issuedOutputs.entries()) {
    if (derived[position]?.index !== commitment.index || derived[position]?.outputScript !== commitment.outputScript) {
      throw new Error(`Presented public source does not reproduce X1A output commitment for Deposit #${commitment.index}.`);
    }
  }
}

function rehydrateCandidate(candidateInput: unknown, presented: RehydrationInput): VaultPlan {
  const candidate = CandidateSchema.parse(candidateInput);
  const plan = planFromPresentedSource(candidate, presented);
  assertOutputCommitments(candidate, plan);
  if (historicalIdentityCommitment(plan) !== candidate.historicalIdentityCommitment) {
    throw new Error("Presented public source does not reproduce the X1A historical identity commitment.");
  }
  return plan;
}

function expectRejected(name: string, operation: () => unknown): void {
  assert.throws(operation, Error, name);
}

/** Builds a syntactically valid but commitment-incompatible tpub using public BIP32 material only. */
function unrelatedPublicTpub(): string {
  const original = HDKey.fromExtendedKey(validTestTpub, testnetBip32Versions);
  const unrelatedChild = original.deriveChild(1);
  assert(unrelatedChild.publicKey !== null && unrelatedChild.chainCode !== null, "Expected a public-only BIP32 child.");
  const unrelated = new HDKey({
    versions: testnetBip32Versions,
    publicKey: unrelatedChild.publicKey,
    chainCode: unrelatedChild.chainCode,
    depth: original.depth,
    index: original.index,
    parentFingerprint: original.parentFingerprint,
  });
  assert(HDKey.fromExtendedKey(unrelated.publicExtendedKey, testnetBip32Versions).publicKey !== null, "Expected a valid public tpub.");
  return unrelated.publicExtendedKey;
}

function rehydratedPlanWithTamperedOrigin(candidate: X1aCandidate, keyOrigin: VaultKeyOrigin): VaultPlan {
  return planFromPresentedSource(candidate, { extendedPublicKey: validTestTpub, keyOrigin });
}

function candidateSizeBytes(outputCount: number): number {
  return Buffer.byteLength(JSON.stringify(createCandidate(issuedPlan(outputCount - 1))), "utf8");
}

function main(): void {
  const planAtThree = issuedPlan(3);
  const originalIdentity = vaultPlanIdentity(planAtThree);
  const candidate = createCandidate(planAtThree);
  const serialized = JSON.stringify(candidate);

  // Proof 1: the durable JSON retains P2WSH commitments, not the family source or deposit keys.
  assertCandidateDoesNotExposeSource(candidate, planAtThree);
  assert(!serialized.includes("archive") && !serialized.includes("hidden"), "UI lifecycle preferences must not enter X1A recovery.");

  // Proof 2: commitments retain exactly the outputs emitted by the original plan.
  const originalDeposits = deriveIssuedDeposits(planAtThree);
  assert.deepEqual(candidate.issuedOutputs, originalDeposits.map(({ index, outputScript }) => ({ index, outputScript })));

  // Proof 3: supplied watch material can rehydrate and prove the historical V2 identity.
  const rehydrated = rehydrateCandidate(candidate, { extendedPublicKey: validTestTpub, keyOrigin: validTestTpubOrigin });
  assert.equal(vaultPlanIdentity(rehydrated), originalIdentity);
  assert.equal(rehydrated.lastIssuedIndex, 3);

  // A descendant tpub can prove depth and its final child number, not its complete historical origin.
  const fingerprintTampered = CandidateSchema.parse({
    ...candidate,
    keyOrigin: { ...candidate.keyOrigin, masterFingerprint: "00000000" },
  });
  const fingerprintTamperedPlan = rehydratedPlanWithTamperedOrigin(fingerprintTampered, fingerprintTampered.keyOrigin);
  assertOutputCommitments(fingerprintTampered, fingerprintTamperedPlan);
  assert.notEqual(vaultPlanIdentity(fingerprintTamperedPlan), originalIdentity);
  assert.notEqual(historicalIdentityCommitment(fingerprintTamperedPlan), candidate.historicalIdentityCommitment);
  expectRejected("tampered master fingerprint fails X1A identity commitment", () => rehydrateCandidate(fingerprintTampered, { extendedPublicKey: validTestTpub, keyOrigin: fingerprintTampered.keyOrigin }));
  expectRejected("candidate origin differs from the actual presented origin", () => rehydrateCandidate(fingerprintTampered, { extendedPublicKey: validTestTpub, keyOrigin: validTestTpubOrigin }));

  const sourcePathTampered = CandidateSchema.parse({
    ...candidate,
    keyOrigin: { ...candidate.keyOrigin, sourcePath: "m/84'/1'/0'" },
  });
  const sourcePathTamperedPlan = rehydratedPlanWithTamperedOrigin(sourcePathTampered, sourcePathTampered.keyOrigin);
  assertOutputCommitments(sourcePathTampered, sourcePathTamperedPlan);
  assert.notEqual(vaultPlanIdentity(sourcePathTamperedPlan), originalIdentity);
  assert.notEqual(historicalIdentityCommitment(sourcePathTamperedPlan), candidate.historicalIdentityCommitment);
  expectRejected("tampered source path fails X1A identity commitment", () => rehydrateCandidate(sourcePathTampered, { extendedPublicKey: validTestTpub, keyOrigin: sourcePathTampered.keyOrigin }));

  // Proof 4: a different syntactically valid public tpub with the same visible V2 origin fails on commitments.
  expectRejected("wrong tpub must fail output-commitment comparison", () => rehydrateCandidate(candidate, { extendedPublicKey: unrelatedPublicTpub(), keyOrigin: validTestTpubOrigin }));

  // Proof 5: parse strictly and require the contiguous issuance history #0..#N.
  expectRejected("altered output script", () => rehydrateCandidate({ ...candidate, issuedOutputs: [{ ...candidate.issuedOutputs[0], outputScript: "0020" + "00".repeat(32) }, ...candidate.issuedOutputs.slice(1)] }, { extendedPublicKey: validTestTpub, keyOrigin: validTestTpubOrigin }));
  expectRejected("duplicate index", () => CandidateSchema.parse({ ...candidate, issuedOutputs: [{ ...candidate.issuedOutputs[0] }, { ...candidate.issuedOutputs[0] }, ...candidate.issuedOutputs.slice(2)] }));
  expectRejected("missing index", () => CandidateSchema.parse({ ...candidate, issuedOutputs: candidate.issuedOutputs.filter((output) => output.index !== 1) }));
  expectRejected("extra index", () => CandidateSchema.parse({ ...candidate, issuedOutputs: [...candidate.issuedOutputs, { index: 4, outputScript: candidate.issuedOutputs[0].outputScript }] }));
  expectRejected("out-of-order index", () => CandidateSchema.parse({ ...candidate, issuedOutputs: [candidate.issuedOutputs[1], candidate.issuedOutputs[0], ...candidate.issuedOutputs.slice(2)] }));
  expectRejected("inconsistent lastIssuedIndex", () => CandidateSchema.parse({ ...candidate, lastIssuedIndex: 4 }));
  expectRejected("mainnet network", () => CandidateSchema.parse({ ...candidate, network: "mainnet" }));
  expectRejected("unsupported network", () => CandidateSchema.parse({ ...candidate, network: "testnet" }));
  expectRejected("incompatible policy version", () => CandidateSchema.parse({ ...candidate, policyVersion: 1 }));

  // Proof 6: an older candidate remains internally valid but cannot discover outputs issued after its export.
  const planAtFive = issueNextDeposit(issueNextDeposit(planAtThree).plan).plan;
  const currentDeposits = deriveIssuedDeposits(planAtFive);
  assert.equal(planAtFive.lastIssuedIndex, 5);
  assert.equal(candidate.lastIssuedIndex, 3);
  assert.equal(candidate.issuedOutputs.length, 4);
  assert.equal(candidate.issuedOutputs.some((output) => output.index === 4 || output.index === 5), false);
  assert.equal(currentDeposits.length, 6);
  assert.equal(rehydrateCandidate(candidate, { extendedPublicKey: validTestTpub, keyOrigin: validTestTpubOrigin }).lastIssuedIndex, 3);

  const candidateSizes = Object.fromEntries([1, 10, 100, 1000].map((outputCount) => [outputCount, candidateSizeBytes(outputCount)]));
  assert(candidateSizes[10] > candidateSizes[1] && candidateSizes[100] > candidateSizes[10] && candidateSizes[1000] > candidateSizes[100], "X1A candidate size must grow with emitted outputs.");

  console.log(`X1A PASS candidate=no-tpub,no-child-public-keys,no-witness-scripts commitments=exact correct-tpub=identity-match wrong-tpub=rejected origin-tampering=output-match-but-identity-commitment-rejected corruption=fail-closed stale-backup=detects-only-its-issued-range bytes=${JSON.stringify(candidateSizes)}`);
}

main();
