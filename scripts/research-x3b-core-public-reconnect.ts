/**
 * X3B research only: live Bitcoin Core Regtest public-source extraction for
 * the minimal X3A reconnect contract. It is not a production adapter, wallet,
 * ExternalSigner change, recovery format, or browser RPC integration.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { parseTestExtendedPublicKey } from "@/bitcoin/bip32";
import { regtestHarnessPorts, resolveHarnessExecutable } from "./regtest-harness";

const bitcoind = resolveHarnessExecutable(process.env.BITCOIND ?? "bitcoind", "bitcoind");
const bitcoinCli = resolveHarnessExecutable(process.env.BITCOINCLI ?? "bitcoin-cli", "bitcoin-cli");
// The helper uses rangeStart + (slot % 4,000) * 2. Limiting the slot to
// 0..1,999 reserves exactly 2,000 pairs: 16,000/16,001 through
// 19,998/19,999. Keep X3B below the legacy Jade family's 20,000+ range.
const X3B_PORT_RANGE_START = 16_000;
const X3B_PORT_PAIR_COUNT = 2_000;
const x3bPortSlot = process.pid % X3B_PORT_PAIR_COUNT;
const { rpcPort, p2pPort } = regtestHarnessPorts(
  process.env.BITCOIN_REGTEST_RPC_PORT,
  process.env.BITCOIN_REGTEST_P2P_PORT,
  x3bPortSlot,
  X3B_PORT_RANGE_START,
);
const expectedRpcPort = X3B_PORT_RANGE_START + x3bPortSlot * 2;
assert(
  rpcPort === expectedRpcPort && p2pPort === expectedRpcPort + 1,
  "X3B requires its exact 16000-19999 Regtest port pair; external overrides outside that deterministic pair are unsafe.",
);
const datadir = process.env.BITCOIN_REGTEST_DATADIR ?? mkdtempSync(join(tmpdir(), "timesats-regtest-x3b-core-reconnect-"));
const ownsDatadir = !process.env.BITCOIN_REGTEST_DATADIR;
const suffix = String(process.pid);
const sourceWallet = `timesats-x3b-source-${suffix}`;
const wrongWallet = `timesats-x3b-wrong-${suffix}`;
let daemonPid: number | undefined;

const CANDIDATE_FORMAT = "timesats-research-x3b-xpubless-v2-candidate";
const REQUEST_FORMAT = "timesats-research-x3a-wallet-public-reconnect-request";
const RESPONSE_FORMAT = "timesats-research-x3a-wallet-public-reconnect-response";
const IDENTITY_COMMITMENT_TAG = "timesats-research-x1a-historical-v2-identity-v1";
const MAX_NON_HARDENED_INDEX = 0x7fffffff;
const OUTPUT_SCRIPT = /^0020[0-9a-f]{64}$/;
const PRIVATE_MARKER = /(?:xprv|tprv|yprv|zprv|uprv|vprv)/i;

const OriginSchema = z.object({
  masterFingerprint: z.string().regex(/^[0-9a-f]{8}$/),
  sourcePath: z.string().regex(/^m(?:\/(?:0|[1-9]\d*)(?:')?)*$/),
}).strict();

const CandidateSchema = z.object({
  format: z.literal(CANDIDATE_FORMAT),
  experiment: z.literal("X3B"),
  policyVersion: z.literal(2),
  network: z.enum(allowedNetworks),
  unlockHeight: z.number().int().min(1).max(499_999_999),
  label: z.string().trim().min(1).max(80),
  derivation: z.object({ pathTemplate: z.literal("m/<index>"), hardened: z.literal(false) }).strict(),
  keyOrigin: OriginSchema,
  historicalIdentityCommitment: z.string().regex(/^[0-9a-f]{64}$/),
  lastIssuedIndex: z.number().int().min(0).max(MAX_NON_HARDENED_INDEX),
  issuedOutputs: z.array(z.object({ index: z.number().int().min(0).max(MAX_NON_HARDENED_INDEX), outputScript: z.string().regex(OUTPUT_SCRIPT) }).strict()).min(1),
}).strict().superRefine((candidate, context) => {
  if (candidate.issuedOutputs.length !== candidate.lastIssuedIndex + 1) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Outputs must cover exactly #0 through lastIssuedIndex." });
  }
  candidate.issuedOutputs.forEach((output, position) => {
    if (output.index !== position) context.addIssue({ code: z.ZodIssueCode.custom, message: "Output indexes must be contiguous and ordered.", path: ["issuedOutputs", position, "index"] });
  });
});

const PublicReconnectRequestSchema = z.object({
  format: z.literal(REQUEST_FORMAT),
  experiment: z.literal("X3A"),
  capability: z.literal("PUBLIC_KEY_SOURCE"),
  network: z.enum(allowedNetworks),
  sourcePathHint: z.string().regex(/^m(?:\/(?:0|[1-9]\d*)(?:['hH])?)*$/),
}).strict();

const PublicReconnectResponseSchema = z.object({
  format: z.literal(RESPONSE_FORMAT),
  experiment: z.literal("X3A"),
  capability: z.literal("PUBLIC_KEY_SOURCE"),
  extendedPublicKey: z.string().min(1),
}).strict();

type Candidate = z.infer<typeof CandidateSchema>;
type PublicReconnectRequest = z.infer<typeof PublicReconnectRequestSchema>;
type PublicReconnectResponse = z.infer<typeof PublicReconnectResponseSchema>;

interface CoreDescriptorRecord {
  desc: string;
  active: boolean;
  internal?: boolean;
}

interface AddressInfo {
  desc?: string;
  hdkeypath?: string;
  hdmasterfingerprint?: string;
  pubkey?: string;
  ischange?: boolean;
}

interface ParsedExternalWpkh {
  readonly canonicalDescriptor: string;
  readonly origin: VaultKeyOrigin;
  readonly accountTpub: string;
  readonly suffix: readonly number[];
  readonly sourcePath: string;
  readonly descriptorNodeDepth: number;
  readonly returnedSourceDepth: number;
}

interface SessionOneArtifact {
  readonly serializedCandidate: string;
  readonly canonicalIdentityDigest: string;
  readonly sourcePath: string;
  readonly descriptorNodeDepth: number;
  readonly returnedSourceDepth: number;
}

function cli(args: string[], wallet?: string): string {
  const common = [`-datadir=${datadir}`, "-regtest", `-rpcport=${rpcPort}`];
  if (wallet) common.push(`-rpcwallet=${wallet}`);
  return execFileSync(bitcoinCli, [...common, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function json<T>(args: string[], wallet?: string): T {
  return JSON.parse(cli(args, wallet)) as T;
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function waitForRpc(): void {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      cli(["getblockchaininfo"]);
      return;
    } catch {
      sleep(250);
    }
  }
  throw new Error("Timed out waiting for X3B's isolated Regtest RPC.");
}

function normalizePath(path: string): string {
  return path.replace(/(\d+)[hH]/g, "$1'");
}

function splitAbsolutePath(path: string): Array<{ index: number; hardened: boolean }> {
  const normalized = normalizePath(path);
  if (normalized === "m") return [];
  if (!/^m(?:\/(?:0|[1-9]\d*)(?:')?)*$/.test(normalized)) throw new Error("Invalid absolute BIP32 path.");
  return normalized.slice(2).split("/").map((component) => ({
    index: Number(component.replace("'", "")),
    hardened: component.endsWith("'"),
  }));
}

function sourcePath(originPath: string, suffix: readonly number[]): string {
  return `${normalizePath(originPath)}${suffix.map((index) => `/${index}`).join("")}`;
}

function fingerprintFromDescriptor(value: string): string {
  return value.toLowerCase();
}

function historicalIdentityCommitment(plan: VaultPlan): string {
  if (plan.policy.policyVersion !== 2) throw new Error("X3B supports only Policy V2.");
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
  if (plan.policy.policyVersion !== 2) throw new Error("X3B candidate requires V2.");
  return CandidateSchema.parse({
    format: CANDIDATE_FORMAT,
    experiment: "X3B",
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

function publiclyRehydrate(candidateInput: unknown, responseInput: unknown): VaultPlan {
  const candidate = CandidateSchema.parse(candidateInput);
  const response = PublicReconnectResponseSchema.parse(responseInput);
  parseTestExtendedPublicKey(response.extendedPublicKey);
  let plan = createVaultPlan({
    label: candidate.label,
    network: candidate.network,
    unlockHeight: candidate.unlockHeight,
    extendedPublicKey: response.extendedPublicKey,
    policyVersion: 2,
    keyOrigin: candidate.keyOrigin,
  });
  while (plan.lastIssuedIndex < candidate.lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  assert.deepEqual(deriveIssuedDeposits(plan).map(({ index, outputScript }) => ({ index, outputScript })), candidate.issuedOutputs);
  if (historicalIdentityCommitment(plan) !== candidate.historicalIdentityCommitment) {
    throw new Error("This wallet does not correspond to this plan.");
  }
  return plan;
}

function assertNoProhibitedFields(value: unknown): void {
  const prohibited = new Set(["extendedPublicKey", "publicKey", "witnessScript", "privateKey", "seed", "mnemonic", "wif", "xprv", "tprv"]);
  if (Array.isArray(value)) return value.forEach(assertNoProhibitedFields);
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    assert(!prohibited.has(key), `Candidate must not persist ${key}.`);
    assertNoProhibitedFields(child);
  }
}

function assertCandidateNoPublicSource(candidate: Candidate, plan: VaultPlan, known: { sourceTpub: string; accountTpub: string; descriptor: string }): void {
  const serialized = JSON.stringify(candidate);
  assertNoProhibitedFields(candidate);
  [known.sourceTpub, known.accountTpub, known.descriptor, vaultPlanIdentity(plan)].forEach((value) => {
    assert(!serialized.includes(value), "Candidate unexpectedly retained public source material.");
  });
  deriveIssuedDeposits(plan).forEach((deposit) => {
    assert(!serialized.includes(deposit.publicKey), "Candidate unexpectedly retained a child public key.");
    assert(!serialized.includes(deposit.witnessScript), "Candidate unexpectedly retained a witness script.");
  });
}

function assertPublicDescriptorOnly(descriptor: string): void {
  assert(!PRIVATE_MARKER.test(descriptor), "Public Core RPC unexpectedly returned a private extended-key marker.");
}

/** Supports only the exact external ranged wpkh shape observed by this experiment. */
function parseExternalWpkh(canonicalDescriptor: string, active: boolean, internal: boolean | undefined): ParsedExternalWpkh {
  if (!active || internal === true) throw new Error("Descriptor is not an active external descriptor.");
  assertPublicDescriptorOnly(canonicalDescriptor);
  const match = canonicalDescriptor.match(/^wpkh\(\[([0-9a-f]{8})(?:\/((?:\d+(?:['h])?)(?:\/\d+(?:['h])?)*))?\](tpub[1-9A-HJ-NP-Za-km-z]+)((?:\/\d+)*)\/\*\)(?:#[a-z0-9]+)?$/i);
  if (!match) throw new Error("Unsupported public descriptor shape; X3B supports only the observed external ranged wpkh form.");
  const originPath = match[2] ? `m/${normalizePath(match[2])}` : "m";
  const accountTpub = match[3];
  const suffix = (match[4].match(/\/\d+/g) ?? []).map((part) => Number(part.slice(1)));
  if (suffix.length === 0) throw new Error("Observed descriptor has no fixed external source suffix before wildcard.");
  const account = parseTestExtendedPublicKey(accountTpub);
  const derived = suffix.reduce((key, index) => key.deriveChild(index), account);
  if (derived.privateKey !== null || derived.publicKey === null) throw new Error("Public descriptor did not derive a public source node.");
  return {
    canonicalDescriptor,
    origin: { masterFingerprint: fingerprintFromDescriptor(match[1]), sourcePath: originPath },
    accountTpub: account.publicExtendedKey,
    suffix,
    sourcePath: sourcePath(originPath, suffix),
    descriptorNodeDepth: account.depth,
    returnedSourceDepth: derived.depth,
  };
}

function responseFromSourceTpub(sourceTpub: string): PublicReconnectResponse {
  return PublicReconnectResponseSchema.parse({
    format: RESPONSE_FORMAT,
    experiment: "X3A",
    capability: "PUBLIC_KEY_SOURCE",
    extendedPublicKey: sourceTpub,
  });
}

class CorePublicKeySourceAdapter {
  private observedAccountTpub: string | undefined;
  private observedDescriptor: string | undefined;

  constructor(private readonly wallet: string) {}

  private canonicalDescriptor(descriptor: string): string {
    assertPublicDescriptorOnly(descriptor);
    const info = json<{ descriptor: string }>(["getdescriptorinfo", descriptor]);
    assert(typeof info.descriptor === "string" && info.descriptor.length > 0, "Core did not return a canonical descriptor.");
    assertPublicDescriptorOnly(info.descriptor);
    return info.descriptor;
  }

  reconnect(requestInput: unknown): PublicReconnectResponse {
    const request = PublicReconnectRequestSchema.parse(requestInput);
    const chain = json<{ chain: string }>(["getblockchaininfo"]);
    if (chain.chain !== "regtest" || request.network !== "regtest") {
      throw new Error("X3B public reconnect accepts only an isolated Regtest request and chain.");
    }
    const records = json<{ descriptors: CoreDescriptorRecord[] }>(["listdescriptors", "false"], this.wallet).descriptors;
    records.forEach((record) => assertPublicDescriptorOnly(record.desc));
    const matches: ParsedExternalWpkh[] = [];
    for (const record of records) {
      try {
        const parsed = parseExternalWpkh(this.canonicalDescriptor(record.desc), record.active, record.internal);
        if (parsed.sourcePath === normalizePath(request.sourcePathHint)) matches.push(parsed);
      } catch (error) {
        // Unknown descriptor shapes are unsupported, never guessed. They can
        // only satisfy the request if this narrow parser proves an exact path.
        if (error instanceof Error && error.message.startsWith("Public Core RPC unexpectedly")) throw error;
      }
    }
    if (matches.length !== 1) throw new Error(`Core cannot satisfy this sourcePathHint unambiguously (matches=${matches.length}).`);
    const match = matches[0];
    const source = match.suffix.reduce((key, index) => key.deriveChild(index), parseTestExtendedPublicKey(match.accountTpub));
    if (source.privateKey !== null || source.publicKey === null) throw new Error("Core public source derivation did not remain public-only.");
    this.observedAccountTpub = match.accountTpub;
    this.observedDescriptor = match.canonicalDescriptor;
    return responseFromSourceTpub(source.publicExtendedKey);
  }

  assertCandidateDoesNotRetainTransientMaterial(candidate: Candidate, plan: VaultPlan, sourceTpub: string): void {
    assert(this.observedAccountTpub && this.observedDescriptor, "Adapter did not observe a public descriptor/source ancestor.");
    assertCandidateNoPublicSource(candidate, plan, {
      sourceTpub,
      accountTpub: this.observedAccountTpub,
      descriptor: this.observedDescriptor,
    });
  }

  discardTransientPublicMaterial(): void {
    this.observedAccountTpub = undefined;
    this.observedDescriptor = undefined;
  }
}

function deriveHardenedNegative(accountTpub: string, origin: VaultKeyOrigin): void {
  const account = parseTestExtendedPublicKey(accountTpub);
  const candidatePath = `${origin.sourcePath}/0'`;
  const suffix = splitAbsolutePath(candidatePath).slice(splitAbsolutePath(origin.sourcePath).length);
  assert.equal(suffix.length, 1);
  assert.equal(suffix[0].hardened, true);
  assert.throws(() => account.deriveChild(suffix[0].index + 0x80000000), /Cannot derive hardened child from public key|hardened/i);
}

function expectRejected(name: string, operation: () => unknown): void {
  assert.throws(operation, Error, name);
}

function inspectCoreRpcHelp(): void {
  const listHelp = cli(["help", "listdescriptors"]);
  const addressHelp = cli(["help", "getaddressinfo"]);
  const descriptorHelp = cli(["help", "getdescriptorinfo"]);
  assert(/private/i.test(listHelp), "Core listdescriptors help no longer describes its private selector.");
  assert(/getaddressinfo/i.test(addressHelp) && /getdescriptorinfo/i.test(descriptorHelp));
}

function sessionOne(): SessionOneArtifact {
  const address = cli(["getnewaddress", "x3b-public-source", "bech32"], sourceWallet);
  const info = json<AddressInfo>(["getaddressinfo", address], sourceWallet);
  if (!info.desc || !info.hdkeypath || !info.hdmasterfingerprint || !info.pubkey || info.ischange === true) {
    throw new Error("Core did not return complete external public key-origin metadata for X3B.");
  }
  assertPublicDescriptorOnly(info.desc);
  const records = json<{ descriptors: CoreDescriptorRecord[] }>(["listdescriptors", "false"], sourceWallet).descriptors;
  records.forEach((record) => assertPublicDescriptorOnly(record.desc));
  // getaddressinfo returns a concrete child descriptor, whereas
  // listdescriptors(false) preserves the ranged /* descriptor. Match the
  // public origin plus the concrete address path instead of string equality.
  const matching = records.flatMap((record) => {
    try {
      const parsed = parseExternalWpkh(json<{ descriptor: string }>(["getdescriptorinfo", record.desc]).descriptor, record.active, record.internal);
      return parsed.origin.masterFingerprint === info.hdmasterfingerprint!.toLowerCase()
        && normalizePath(info.hdkeypath!).startsWith(`${parsed.sourcePath}/`) ? [parsed] : [];
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Public Core RPC unexpectedly")) throw error;
      return [];
    }
  });
  if (matching.length !== 1) throw new Error(`Core public descriptors did not identify one external source for the address (matches=${matching.length}).`);
  const parsed = matching[0];
  const expectedAddressPath = `${parsed.sourcePath}/0`;
  assert.equal(normalizePath(info.hdkeypath), expectedAddressPath, "Observed Core address path does not equal sourcePath/0.");
  assert.equal(info.hdmasterfingerprint.toLowerCase(), parsed.origin.masterFingerprint, "Core fingerprint differs between descriptor and address info.");
  const sourceKey = parsed.suffix.reduce((key, index) => key.deriveChild(index), parseTestExtendedPublicKey(parsed.accountTpub));
  if (!sourceKey.publicKey || sourceKey.privateKey !== null) throw new Error("Could not derive the Core source tpub publicly.");
  const sourceTpub = sourceKey.publicExtendedKey;
  const sourcePublicKey = sourceKey.deriveChild(0).publicKey;
  if (!sourcePublicKey || Buffer.from(sourcePublicKey).toString("hex") !== info.pubkey.toLowerCase()) {
    throw new Error("Source tpub does not reproduce Core's first external public key.");
  }

  let plan = createVaultPlan({
    label: "X3B Core public reconnect",
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: sourceTpub,
    policyVersion: 2,
    keyOrigin: { masterFingerprint: parsed.origin.masterFingerprint, sourcePath: parsed.sourcePath },
  });
  while (plan.lastIssuedIndex < 3) plan = issueNextDeposit(plan).plan;
  const candidate = candidateFromPlan(plan);
  assertCandidateNoPublicSource(candidate, plan, { sourceTpub, accountTpub: parsed.accountTpub, descriptor: parsed.canonicalDescriptor });
  const artifact: SessionOneArtifact = {
    serializedCandidate: JSON.stringify(candidate),
    canonicalIdentityDigest: createHash("sha256").update(vaultPlanIdentity(plan), "utf8").digest("hex"),
    sourcePath: parsed.sourcePath,
    descriptorNodeDepth: parsed.descriptorNodeDepth,
    returnedSourceDepth: parsed.returnedSourceDepth,
  };
  // No plan, tpub, descriptor, child key, or canonical identity leaves Session 1.
  return artifact;
}

function main(): void {
  const daemon = spawn(bitcoind, [
    `-datadir=${datadir}`, "-regtest", "-server=1", `-port=${p2pPort}`, `-rpcport=${rpcPort}`,
    "-listen=0", "-connect=0", "-dnsseed=0", "-discover=0", "-printtoconsole=0",
  ], { detached: true, stdio: "ignore" });
  daemonPid = daemon.pid;
  daemon.unref();
  waitForRpc();

  const chain = json<{ chain: string; blocks: number }>(["getblockchaininfo"]);
  if (chain.chain !== "regtest") throw new Error(`Unsafe chain selected: ${chain.chain}`);
  const network = json<{ version: number; subversion: string }>(["getnetworkinfo"]);
  inspectCoreRpcHelp();
  console.log(`X3B CORE chain=${chain.chain} version=${network.version} subversion=${network.subversion} rpcPort=${rpcPort} p2pPort=${p2pPort}`);
  console.log("X3B RPC publicOnly=listdescriptors(false),getaddressinfo,getdescriptorinfo");

  cli(["createwallet", sourceWallet]);
  cli(["createwallet", wrongWallet]);
  const artifact = sessionOne();
  console.log(`X3B DESCRIPTOR shape=external-ranged-wpkh descriptorPublicNodeDepth=${artifact.descriptorNodeDepth} returnedSourceDepth=${artifact.returnedSourceDepth} sourcePath=${artifact.sourcePath}`);

  // Reload the normal descriptor wallet before the reconnect session.
  cli(["unloadwallet", sourceWallet]);
  cli(["loadwallet", sourceWallet]);

  const candidate = CandidateSchema.parse(JSON.parse(artifact.serializedCandidate));
  const request = requestFromCandidate(candidate);
  const adapter = new CorePublicKeySourceAdapter(sourceWallet);
  const response = adapter.reconnect(request);
  assert.deepEqual(Object.keys(response).sort(), ["capability", "experiment", "extendedPublicKey", "format"]);
  const rehydrated = publiclyRehydrate(candidate, response);
  assert.equal(createHash("sha256").update(vaultPlanIdentity(rehydrated), "utf8").digest("hex"), artifact.canonicalIdentityDigest);
  assert.equal(rehydrated.lastIssuedIndex, 3);
  adapter.assertCandidateDoesNotRetainTransientMaterial(candidate, rehydrated, response.extendedPublicKey);

  // Wrong Core wallet can answer syntactically, but TimeSats commitments reject it.
  cli(["getnewaddress", "x3b-wrong-source", "bech32"], wrongWallet);
  const wrongResponse = new CorePublicKeySourceAdapter(wrongWallet).reconnect(request);
  expectRejected("wrong Core wallet", () => publiclyRehydrate(candidate, wrongResponse));

  // Descriptor/path selection must not silently choose internal, another account, or malformed paths.
  const sourceParts = splitAbsolutePath(artifact.sourcePath);
  const basePath = sourceParts.length > 1 ? `m/${sourceParts.slice(0, -1).map((part) => `${part.index}${part.hardened ? "'" : ""}`).join("/")}` : "m";
  expectRejected("missing source path", () => adapter.reconnect({ ...request, sourcePathHint: `${artifact.sourcePath}/7` }));
  expectRejected("internal/change path", () => adapter.reconnect({ ...request, sourcePathHint: `${basePath}/1` }));
  expectRejected("malformed path", () => adapter.reconnect({ ...request, sourcePathHint: "m/not-a-path" }));
  expectRejected("wrong final child", () => adapter.reconnect({ ...request, sourcePathHint: `${basePath}/2` }));
  expectRejected("wrong network", () => adapter.reconnect({ ...request, network: "signet" }));

  // The observed account tpub can derive the requested non-hardened /0 source,
  // but cannot derive a hypothetical hardened child from that public node.
  const sourceRecords = json<{ descriptors: CoreDescriptorRecord[] }>(["listdescriptors", "false"], sourceWallet).descriptors;
  const publicRecord = sourceRecords.find((record) => record.active && record.internal !== true && /^wpkh\(/i.test(record.desc));
  if (!publicRecord) throw new Error("Observed Core wallet no longer has the expected external wpkh descriptor.");
  const parsedForNegative = parseExternalWpkh(json<{ descriptor: string }>(["getdescriptorinfo", publicRecord.desc]).descriptor, publicRecord.active, publicRecord.internal);
  deriveHardenedNegative(parsedForNegative.accountTpub, parsedForNegative.origin);
  expectRejected("hardened requested path", () => adapter.reconnect({ ...request, sourcePathHint: `${parsedForNegative.origin.sourcePath}/0'` }));

  // Ask Core to canonicalize a different public script type, then prove the
  // narrow adapter parser rejects it rather than claiming generic descriptors.
  const otherType = json<{ descriptor: string }>(["getdescriptorinfo", `tr([${parsedForNegative.origin.masterFingerprint}/${parsedForNegative.origin.sourcePath.slice(2)}]${parsedForNegative.accountTpub}/0/*)`]).descriptor;
  expectRejected("other script type", () => parseExternalWpkh(otherType, true, false));

  const issued = issueNextDeposit(rehydrated);
  assert.equal(issued.deposit.index, 4);
  const updatedCandidate = candidateFromPlan(issued.plan);
  assert.equal(updatedCandidate.lastIssuedIndex, 4);
  assert.equal(updatedCandidate.issuedOutputs[4].outputScript, issued.deposit.outputScript);
  adapter.assertCandidateDoesNotRetainTransientMaterial(updatedCandidate, issued.plan, response.extendedPublicKey);
  adapter.discardTransientPublicMaterial();
  const restartedCandidate = CandidateSchema.parse(JSON.parse(JSON.stringify(updatedCandidate)));
  assert.equal(restartedCandidate.lastIssuedIndex, 4);
  assert.equal(restartedCandidate.issuedOutputs.length, 5);
  expectRejected("Deposit #5 without reconnect", () => { throw new Error("Public wallet reconnect required before deriving Deposit #5."); });

  console.log("X3B PASS candidate=no-tpub,no-identity,no-descriptor correct-core=publicly-rehydrated wrong-core=commitment-rejected source-selection=exact external-only hardened-descendant=unsupported network=regtest-only response=minimal-tpub-only issue=#4 session-repersistence=no-tpub broader-adapter-material=observed v1=not-proven");
}

try {
  main();
} finally {
  try {
    cli(["stop"]);
  } catch {
    // X3B may have failed before RPC was ready or after Core stopped.
  }
  if (daemonPid) {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(daemonPid, 0);
        sleep(250);
      } catch {
        break;
      }
    }
    try {
      process.kill(daemonPid);
    } catch {
      // Only X3B's own daemon PID is used as a fallback.
    }
  }
  if (ownsDatadir && process.env.TIMESATS_KEEP_REGTEST_DATA !== "1") {
    try {
      rmSync(datadir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch {
      console.warn("X3B could not remove its temporary Regtest datadir.");
    }
  }
}
