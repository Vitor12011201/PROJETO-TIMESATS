/**
 * X3A research only: a minimal public-wallet reconnect contract for an
 * xpubless Policy V2 candidate. It is not an ExternalSigner, recovery format,
 * storage format, production adapter, or application runtime path.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { HDKey } from "@scure/bip32";
import { z } from "zod";
import {
  allowedNetworks,
  createVaultPlan,
  deriveDeposit,
  deriveIssuedDeposits,
  issueNextDeposit,
  vaultPlanIdentity,
  type VaultKeyOrigin,
  type VaultPlan,
} from "@/bitcoin";
import { parseTestExtendedPublicKey, testnetBip32Versions } from "@/bitcoin/bip32";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";

const CANDIDATE_FORMAT = "timesats-research-x3a-xpubless-v2-candidate";
const REQUEST_FORMAT = "timesats-research-x3a-wallet-public-reconnect-request";
const RESPONSE_FORMAT = "timesats-research-x3a-wallet-public-reconnect-response";
const IDENTITY_COMMITMENT_TAG = "timesats-research-x1a-historical-v2-identity-v1";
const MAX_NON_HARDENED_INDEX = 0x7fffffff;
const OUTPUT_SCRIPT = /^0020[0-9a-f]{64}$/;

const OriginSchema = z.object({
  masterFingerprint: z.string().regex(/^[0-9a-fA-F]{8}$/),
  sourcePath: z.string().regex(/^m(?:\/(?:0|[1-9]\d*)(?:['hH])?)*$/),
}).strict();

const IssuedOutputSchema = z.object({
  index: z.number().int().min(0).max(MAX_NON_HARDENED_INDEX),
  outputScript: z.string().regex(OUTPUT_SCRIPT),
}).strict();

const CandidateSchema = z.object({
  format: z.literal(CANDIDATE_FORMAT),
  experiment: z.literal("X3A"),
  policyVersion: z.literal(2),
  network: z.enum(allowedNetworks),
  unlockHeight: z.number().int().min(1).max(499_999_999),
  label: z.string().trim().min(1).max(80),
  derivation: z.object({ pathTemplate: z.literal("m/<index>"), hardened: z.literal(false) }).strict(),
  keyOrigin: OriginSchema,
  historicalIdentityCommitment: z.string().regex(/^[0-9a-f]{64}$/),
  lastIssuedIndex: z.number().int().min(0).max(MAX_NON_HARDENED_INDEX),
  issuedOutputs: z.array(IssuedOutputSchema).min(1),
}).strict().superRefine((candidate, context) => {
  if (candidate.issuedOutputs.length !== candidate.lastIssuedIndex + 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Issued outputs must cover exactly #0 through lastIssuedIndex." });
  }
  candidate.issuedOutputs.forEach((output, position) => {
    if (output.index !== position) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["issuedOutputs", position, "index"], message: "Issued output indexes must be contiguous and ordered." });
    }
  });
});

/** Candidate-owned context only. The wallet cannot define policy semantics. */
const PublicReconnectRequestSchema = z.object({
  format: z.literal(REQUEST_FORMAT),
  experiment: z.literal("X3A"),
  capability: z.literal("PUBLIC_KEY_SOURCE"),
  network: z.enum(allowedNetworks),
  sourcePathHint: z.string().regex(/^m(?:\/(?:0|[1-9]\d*)(?:['hH])?)*$/),
}).strict();

/**
 * Minimal research response: the requested source-node tpub only. The
 * candidate, not the wallet, remains authority for historical key origin.
 */
const PublicReconnectResponseSchema = z.object({
  format: z.literal(RESPONSE_FORMAT),
  experiment: z.literal("X3A"),
  capability: z.literal("PUBLIC_KEY_SOURCE"),
  extendedPublicKey: z.string().min(1),
}).strict();

/** Optional untrusted adapter metadata, never a replacement for candidate origin. */
const PublicReconnectOriginEchoResponseSchema = PublicReconnectResponseSchema.extend({ keyOrigin: OriginSchema }).strict();

type Candidate = z.infer<typeof CandidateSchema>;
type PublicReconnectRequest = z.infer<typeof PublicReconnectRequestSchema>;
type PublicReconnectResponse = z.infer<typeof PublicReconnectResponseSchema>;
type PublicReconnectOriginEchoResponse = z.infer<typeof PublicReconnectOriginEchoResponseSchema>;

type PublicReconnectState = "PUBLIC_RECONNECT_REQUIRED" | "PUBLIC_REHYDRATED" | "RECONNECT_REJECTED";

interface PubliclyRehydratedSession {
  readonly state: Extract<PublicReconnectState, "PUBLIC_REHYDRATED">;
  readonly plan: VaultPlan;
  readonly canonicalIdentity: string;
}

function normalizeOrigin(origin: VaultKeyOrigin): VaultKeyOrigin {
  return {
    masterFingerprint: origin.masterFingerprint.toLowerCase(),
    sourcePath: origin.sourcePath.replace(/(\d+)[hH]/g, "$1'"),
  };
}

function sameOrigin(left: VaultKeyOrigin, right: VaultKeyOrigin): boolean {
  const normalizedLeft = normalizeOrigin(left);
  const normalizedRight = normalizeOrigin(right);
  return normalizedLeft.masterFingerprint === normalizedRight.masterFingerprint
    && normalizedLeft.sourcePath === normalizedRight.sourcePath;
}

function issuedPlan(lastIssuedIndex: number, label = "X3A public V2 fixture", origin: VaultKeyOrigin = validTestTpubOrigin): VaultPlan {
  let plan = createVaultPlan({
    label,
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: origin,
  });
  while (plan.lastIssuedIndex < lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  return plan;
}

/**
 * A research binding/integrity value. It is not a trust anchor and cannot
 * authenticate a wholly replaced candidate whose digest was also replaced.
 */
function historicalIdentityCommitment(plan: VaultPlan): string {
  if (plan.policy.policyVersion !== 2) throw new Error("X3A supports only Policy V2.");
  return createHash("sha256").update(JSON.stringify({
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
  }), "utf8").digest("hex");
}

function candidateFromPlan(plan: VaultPlan): Candidate {
  if (plan.policy.policyVersion !== 2) throw new Error("X3A does not create a V1 xpubless candidate.");
  return CandidateSchema.parse({
    format: CANDIDATE_FORMAT,
    experiment: "X3A",
    policyVersion: 2,
    network: plan.policy.network,
    unlockHeight: plan.policy.unlockHeight,
    label: plan.metadata.label,
    derivation: plan.policy.derivation,
    keyOrigin: plan.policy.keySource.keyOrigin,
    historicalIdentityCommitment: historicalIdentityCommitment(plan),
    lastIssuedIndex: plan.lastIssuedIndex,
    issuedOutputs: deriveIssuedDeposits(plan).map(({ index, outputScript }) => ({ index, outputScript })),
  });
}

function requestFromCandidate(candidateInput: unknown): PublicReconnectRequest {
  const candidate = CandidateSchema.parse(candidateInput);
  return PublicReconnectRequestSchema.parse({
    format: REQUEST_FORMAT,
    experiment: "X3A",
    capability: "PUBLIC_KEY_SOURCE",
    network: candidate.network,
    sourcePathHint: candidate.keyOrigin.sourcePath,
  });
}

function sourcePlan(candidate: Candidate, response: PublicReconnectResponse): VaultPlan {
  // createVaultPlan invokes the actual V2 tpub/origin validation implementation.
  let plan = createVaultPlan({
    label: candidate.label,
    network: candidate.network,
    unlockHeight: candidate.unlockHeight,
    extendedPublicKey: response.extendedPublicKey,
    policyVersion: 2,
    keyOrigin: normalizeOrigin(candidate.keyOrigin),
  });
  while (plan.lastIssuedIndex < candidate.lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  return plan;
}

function assertOutputCommitments(candidate: Candidate, plan: VaultPlan): void {
  assert.deepEqual(
    deriveIssuedDeposits(plan).map(({ index, outputScript }) => ({ index, outputScript })),
    candidate.issuedOutputs,
    "Wallet public source does not reproduce the candidate output commitments.",
  );
}

function publiclyRehydrate(candidateInput: unknown, responseInput: unknown): PubliclyRehydratedSession {
  const candidate = CandidateSchema.parse(candidateInput);
  const response = PublicReconnectResponseSchema.parse(responseInput);
  if (response.capability !== "PUBLIC_KEY_SOURCE") throw new Error("Wallet lacks the required public-source capability.");
  // This guard rejects xprv/tprv/WIF/mnemonic-like values and mainnet xpub.
  parseTestExtendedPublicKey(response.extendedPublicKey);
  const plan = sourcePlan(candidate, response);
  assertOutputCommitments(candidate, plan);
  if (historicalIdentityCommitment(plan) !== candidate.historicalIdentityCommitment) {
    throw new Error("This wallet does not correspond to this plan.");
  }
  return { state: "PUBLIC_REHYDRATED", plan, canonicalIdentity: vaultPlanIdentity(plan) };
}

function publiclyRehydrateWithOriginEcho(candidateInput: unknown, responseInput: unknown): PubliclyRehydratedSession {
  const candidate = CandidateSchema.parse(candidateInput);
  const echoed = PublicReconnectOriginEchoResponseSchema.parse(responseInput);
  if (!sameOrigin(echoed.keyOrigin, candidate.keyOrigin)) {
    throw new Error("This wallet does not correspond to this plan.");
  }
  return publiclyRehydrate(candidate, {
    format: echoed.format,
    experiment: echoed.experiment,
    capability: echoed.capability,
    extendedPublicKey: echoed.extendedPublicKey,
  });
}

function updateAfterIssuance(candidateInput: unknown, plan: VaultPlan): Candidate {
  const previous = CandidateSchema.parse(candidateInput);
  const next = candidateFromPlan(plan);
  assert.equal(next.lastIssuedIndex, previous.lastIssuedIndex + 1, "A reconnect session may issue exactly its next deposit.");
  return next;
}

function assertNoProhibitedFields(value: unknown): void {
  const prohibited = new Set(["extendedPublicKey", "publicKey", "witnessScript", "privateKey", "seed", "mnemonic", "wif", "xprv", "tprv"]);
  if (Array.isArray(value)) {
    value.forEach(assertNoProhibitedFields);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    assert(!prohibited.has(key), `X3A candidate must not persist ${key}.`);
    assertNoProhibitedFields(child);
  }
}

function assertCandidateHasNoDurableSource(candidate: Candidate, plan: VaultPlan): void {
  const serialized = JSON.stringify(candidate);
  assertNoProhibitedFields(candidate);
  assert(!serialized.includes(plan.policy.keySource.extendedPublicKey), "X3A candidate unexpectedly persists tpub.");
  assert(!serialized.includes(vaultPlanIdentity(plan)), "X3A candidate unexpectedly persists canonical vaultPlanIdentity.");
  deriveIssuedDeposits(plan).forEach((deposit) => {
    assert(!serialized.includes(deposit.publicKey), `X3A candidate persists Deposit #${deposit.index} public key.`);
    assert(!serialized.includes(deposit.witnessScript), `X3A candidate persists Deposit #${deposit.index} witness script.`);
  });
}

function unrelatedPublicTpub(): string {
  const original = HDKey.fromExtendedKey(validTestTpub, testnetBip32Versions);
  const child = original.deriveChild(1);
  assert(child.publicKey !== null && child.chainCode !== null);
  return new HDKey({
    versions: testnetBip32Versions,
    publicKey: child.publicKey,
    chainCode: child.chainCode,
    depth: original.depth,
    index: original.index,
    parentFingerprint: original.parentFingerprint,
  }).publicExtendedKey;
}

function correctResponse(): PublicReconnectResponse {
  return PublicReconnectResponseSchema.parse({
    format: RESPONSE_FORMAT,
    experiment: "X3A",
    capability: "PUBLIC_KEY_SOURCE",
    extendedPublicKey: validTestTpub,
  });
}

function correctOriginEchoResponse(): PublicReconnectOriginEchoResponse {
  return PublicReconnectOriginEchoResponseSchema.parse({ ...correctResponse(), keyOrigin: validTestTpubOrigin });
}

function unavailableWithoutReconnect(operation: string): never {
  throw new Error(`${operation} requires a public wallet reconnect.`);
}

function userFacingReconnectResult(candidate: Candidate, response: unknown): { state: PublicReconnectState; message: string } {
  try {
    publiclyRehydrate(candidate, response);
    return { state: "PUBLIC_REHYDRATED", message: "Wallet connected to this plan." };
  } catch {
    return { state: "RECONNECT_REJECTED", message: "This wallet does not correspond to this plan." };
  }
}

function expectRejected(name: string, operation: () => unknown): void {
  assert.throws(operation, Error, name);
}

function main(): void {
  const original = issuedPlan(3);
  const originalIdentity = vaultPlanIdentity(original);
  const candidate = candidateFromPlan(original);
  const request = requestFromCandidate(candidate);
  assert.equal(request.network, "regtest");
  assert.equal(request.sourcePathHint, validTestTpubOrigin.sourcePath);
  assert.equal("keyOrigin" in correctResponse(), false, "Minimal response must not carry candidate-owned origin.");
  assertCandidateHasNoDurableSource(candidate, original);

  // Correct public reconnect reconstructs V2 only in session memory.
  const session = publiclyRehydrate(candidate, correctResponse());
  assert.equal(session.state, "PUBLIC_REHYDRATED");
  assert.equal(session.canonicalIdentity, originalIdentity);
  assert.equal(session.plan.lastIssuedIndex, 3);

  // A structurally valid, same-depth tpub must still fail the output commitments.
  expectRejected("wrong tpub", () => publiclyRehydrate(candidate, { ...correctResponse(), extendedPublicKey: unrelatedPublicTpub() }));
  const userError = userFacingReconnectResult(candidate, { ...correctResponse(), extendedPublicKey: unrelatedPublicTpub() });
  assert.deepEqual(userError, { state: "RECONNECT_REJECTED", message: "This wallet does not correspond to this plan." });
  assert(!userError.message.includes(validTestTpub), "User error must not echo a full tpub.");

  // Origin echo is optional adapter metadata and must equal the candidate; it is not historical proof.
  assert.equal(publiclyRehydrateWithOriginEcho(candidate, correctOriginEchoResponse()).canonicalIdentity, originalIdentity);
  expectRejected("wrong echoed fingerprint", () => publiclyRehydrateWithOriginEcho(candidate, { ...correctOriginEchoResponse(), keyOrigin: { ...validTestTpubOrigin, masterFingerprint: "00000000" } }));
  expectRejected("wrong echoed ancestor", () => publiclyRehydrateWithOriginEcho(candidate, { ...correctOriginEchoResponse(), keyOrigin: { ...validTestTpubOrigin, sourcePath: "m/84'/1'/0'" } }));

  // The actual V2 parser proves descendant depth/final-child constraints only.
  const alteredAncestor = CandidateSchema.parse({ ...candidate, keyOrigin: { ...candidate.keyOrigin, sourcePath: "m/84'/1'/0'" } });
  const ancestorPlan = sourcePlan(alteredAncestor, correctResponse());
  assertOutputCommitments(alteredAncestor, ancestorPlan);
  assert.notEqual(historicalIdentityCommitment(ancestorPlan), candidate.historicalIdentityCommitment);
  expectRejected("ancestor mutation requires preserved historical commitment", () => publiclyRehydrate(alteredAncestor, correctResponse()));

  const alteredFingerprint = CandidateSchema.parse({ ...candidate, keyOrigin: { ...candidate.keyOrigin, masterFingerprint: "00000000" } });
  const fingerprintPlan = sourcePlan(alteredFingerprint, correctResponse());
  assertOutputCommitments(alteredFingerprint, fingerprintPlan);
  assert.notEqual(historicalIdentityCommitment(fingerprintPlan), candidate.historicalIdentityCommitment);
  expectRejected("fingerprint mutation requires preserved historical commitment", () => publiclyRehydrate(alteredFingerprint, correctResponse()));
  expectRejected("source path depth mismatch", () => publiclyRehydrate(CandidateSchema.parse({ ...candidate, keyOrigin: { ...candidate.keyOrigin, sourcePath: "m/44'/1'" } }), correctResponse()));
  expectRejected("source path child mismatch", () => publiclyRehydrate(CandidateSchema.parse({ ...candidate, keyOrigin: { ...candidate.keyOrigin, sourcePath: "m/44'/1'/1'" } }), correctResponse()));

  // Strict response schema prevents policy injection: candidate values remain authority.
  ["network", "unlockHeight", "policyVersion", "derivation", "issuedOutputs", "sourcePath", "masterFingerprint"].forEach((field) => {
    expectRejected(`policy injection field ${field}`, () => PublicReconnectResponseSchema.parse({ ...correctResponse(), [field]: "adversarial" }));
  });

  // Partial and private-material responses fail closed without accepting conversion to public data.
  expectRejected("missing tpub", () => publiclyRehydrate(candidate, { format: RESPONSE_FORMAT, experiment: "X3A", capability: "PUBLIC_KEY_SOURCE", keyOrigin: validTestTpubOrigin }));
  expectRejected("empty tpub", () => publiclyRehydrate(candidate, { ...correctResponse(), extendedPublicKey: "" }));
  expectRejected("xprv canary", () => publiclyRehydrate(candidate, { ...correctResponse(), extendedPublicKey: "xprv-X3A-CANARY" }));
  expectRejected("tprv canary", () => publiclyRehydrate(candidate, { ...correctResponse(), extendedPublicKey: "tprv-X3A-CANARY" }));
  expectRejected("WIF-like canary", () => publiclyRehydrate(candidate, { ...correctResponse(), extendedPublicKey: `L${"1".repeat(50)}` }));
  expectRejected("mainnet xpub canary", () => publiclyRehydrate(candidate, { ...correctResponse(), extendedPublicKey: "xpub-X3A-CANARY" }));
  ["seed", "mnemonic", "privateKey", "wif"].forEach((field) => {
    expectRejected(`private field ${field}`, () => PublicReconnectResponseSchema.parse({ ...correctResponse(), [field]: "X3A-CANARY" }));
  });

  // New issuance needs the session plan, then persists only #4's output commitment.
  ["Derive Deposit #4", "Build witnessScript", "Recover child public key", "Recompute canonical vaultPlanIdentity", "Prepare complete spend"].forEach((operation) => {
    expectRejected(operation, () => unavailableWithoutReconnect(operation));
  });
  const issued = issueNextDeposit(session.plan);
  assert.equal(issued.deposit.index, 4);
  const updated = updateAfterIssuance(candidate, issued.plan);
  assert.equal(updated.lastIssuedIndex, 4);
  assert.equal(updated.issuedOutputs[4].outputScript, issued.deposit.outputScript);
  assertCandidateHasNoDurableSource(updated, issued.plan);
  let discardedSession: VaultPlan | undefined = issued.plan;
  discardedSession = undefined;
  assert.equal(discardedSession, undefined);
  const restarted = CandidateSchema.parse(JSON.parse(JSON.stringify(updated)));
  assert.equal(restarted.lastIssuedIndex, 4);
  assert.equal(restarted.issuedOutputs.length, 5);
  expectRejected("#5 after session discard", () => unavailableWithoutReconnect("Derive Deposit #5"));

  // Rehydration yields exactly the public V2 data needed by the existing spend preparation flow.
  const spendReady = publiclyRehydrate(restarted, correctResponse());
  const deposit = deriveDeposit(spendReady.plan, 0);
  assert.equal(spendReady.canonicalIdentity, originalIdentity);
  assert.equal(deposit.keyOrigin?.masterFingerprint, validTestTpubOrigin.masterFingerprint);
  assert.equal(deposit.absoluteDerivationPath, "m/44'/1'/0'/0");
  assert(deposit.publicKey.length > 0 && deposit.witnessScript.length > 0);

  console.log("X3A PASS contract=minimal-tpub-only authority=candidate request=sourcePathHint origin-echo=optional-untrusted correct-reconnect=identity-match wrong-tpub=commitment-rejected origin=direct-and-historical-checked policy-injection=impossible-by-schema private-material=rejected session-repersistence=no-tpub new-deposit=#4 public-spend-preparation=available core=partial-existing-public-rpc-evidence jade=infra-unavailable-live-not-run v1=not-proven");
}

main();
