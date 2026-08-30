/**
 * X1B research only: Bitcoin Core watch-only discovery from explicit P2WSH
 * output commitments. It is not a recovery format, product runtime path, or
 * claim about mainnet, post-quantum security, or signing interoperability.
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Psbt, Transaction } from "bitcoinjs-lib";
import {
  createVaultPlan,
  deriveDeposit,
  deriveIssuedDeposits,
  issueNextDeposit,
  type DerivedDeposit,
  type VaultPlan,
} from "@/bitcoin";
import { bytesToHex } from "@/bitcoin/encoding";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import { regtestHarnessPorts, resolveHarnessExecutable } from "./regtest-harness";

const bitcoind = resolveHarnessExecutable(process.env.BITCOIND ?? "bitcoind", "bitcoind");
const bitcoinCli = resolveHarnessExecutable(process.env.BITCOINCLI ?? "bitcoin-cli", "bitcoin-cli");
const { rpcPort, p2pPort } = regtestHarnessPorts(process.env.BITCOIN_REGTEST_RPC_PORT, process.env.BITCOIN_REGTEST_P2P_PORT, process.pid, 8_000);
const datadir = process.env.BITCOIN_REGTEST_DATADIR ?? mkdtempSync(join(tmpdir(), "timesats-regtest-x1b-"));
const ownsDatadir = !process.env.BITCOIN_REGTEST_DATADIR;
const suffix = String(process.pid);
const funderWallet = `timesats-x1b-funder-${suffix}`;
const watcherWallet = `timesats-x1b-watcher-${suffix}`;
let daemonPid: number | undefined;

interface XpublessWatcherCommitment {
  index: number;
  outputScript: string;
}

interface CoreNetworkInfo {
  version: number;
  subversion: string;
}

interface CoreScanUnspent {
  txid: string;
  vout: number;
  scriptPubKey: string;
  amount: number;
}

interface CoreScanResult {
  success: boolean;
  unspents: CoreScanUnspent[];
}

interface CoreWalletUtxo {
  txid: string;
  vout: number;
  amount: number;
  scriptPubKey: string;
  spendable: boolean;
}

interface CoreWalletInfo {
  private_keys_enabled: boolean;
  descriptors: boolean;
}

interface CoreDescriptorList {
  descriptors: Array<{ desc: string }>;
}

interface CorePsbtResult {
  complete: boolean;
  psbt: string;
}

interface FundedCommitment extends XpublessWatcherCommitment {
  txid: string;
  vout: number;
  valueSats: number;
}

interface ScaleObservation {
  outputCount: number;
  serializedBytes: number;
  buildMilliseconds: number;
  canonicalizeMilliseconds: number;
  scanMilliseconds: number;
  accepted: boolean;
}

function cli(args: string[], walletName?: string): string {
  const common = [`-datadir=${datadir}`, "-regtest", `-rpcport=${rpcPort}`];
  if (walletName) common.push(`-rpcwallet=${walletName}`);
  return execFileSync(bitcoinCli, [...common, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function json<T>(args: string[], walletName?: string): T {
  return JSON.parse(cli(args, walletName)) as T;
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
  throw new Error("Timed out waiting for isolated X1B Regtest RPC.");
}

function mine(blocks: number, address: string): void {
  if (!Number.isInteger(blocks) || blocks < 1) throw new Error("X1B refuses an invalid mine count.");
  cli(["generatetoaddress", String(blocks), address]);
}

function elapsed<T>(operation: () => T): { value: T; milliseconds: number } {
  const started = process.hrtime.bigint();
  const value = operation();
  return { value, milliseconds: Number(process.hrtime.bigint() - started) / 1_000_000 };
}

/** RESEARCH FIXTURE / PRODUCER: this side may derive the public V2 plan. */
function issuedFixturePlan(lastIssuedIndex: number): VaultPlan {
  let plan = createVaultPlan({
    label: "X1B public V2 fixture",
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

/** XPUBLESS WATCHER INPUT: only explicit index/outputScript commitments cross this boundary. */
function watcherInput(plan: VaultPlan): XpublessWatcherCommitment[] {
  return deriveIssuedDeposits(plan).map(({ index, outputScript }) => ({ index, outputScript }));
}

function assertWatcherInput(commitments: XpublessWatcherCommitment[], forbiddenValues: string[]): void {
  for (const [position, commitment] of commitments.entries()) {
    assert.deepEqual(Object.keys(commitment).sort(), ["index", "outputScript"]);
    assert.equal(commitment.index, position);
    assert.match(commitment.outputScript, /^0020[0-9a-f]{64}$/);
    for (const value of forbiddenValues) {
      assert(!commitment.outputScript.includes(value), "Watcher commitment unexpectedly contains producer material.");
    }
  }
}

function checkedRawDescriptor(outputScript: string): string {
  return json<{ descriptor: string }>(["getdescriptorinfo", `raw(${outputScript})`]).descriptor;
}

function canonicalDescriptors(commitments: XpublessWatcherCommitment[]): string[] {
  return commitments.map(({ outputScript }) => checkedRawDescriptor(outputScript));
}

function assertRawOnlyDescriptors(descriptors: string[], commitments: XpublessWatcherCommitment[], forbiddenValues: string[]): void {
  assert.equal(descriptors.length, commitments.length);
  for (const [position, descriptor] of descriptors.entries()) {
    const outputScript = commitments[position].outputScript;
    assert.match(descriptor, new RegExp(`^raw\\(${outputScript}\\)#[a-z0-9]{8}$`));
    for (const value of forbiddenValues) {
      assert(!descriptor.includes(value), "Watcher descriptor unexpectedly contains producer material.");
    }
  }
}

function scan(descriptors: string[]): CoreScanResult {
  return json<CoreScanResult>(["scantxoutset", "start", JSON.stringify(descriptors)]);
}

function assertMatchesFunding(found: CoreScanUnspent[] | CoreWalletUtxo[], expected: FundedCommitment[]): void {
  assert.equal(found.length, expected.length);
  for (const commitment of expected) {
    const observed = found.find((utxo) => utxo.txid === commitment.txid && utxo.vout === commitment.vout);
    assert(observed, `Missing funded Deposit #${commitment.index}.`);
    assert.equal(Math.round(observed.amount * 100_000_000), commitment.valueSats);
    assert.equal(observed.scriptPubKey, commitment.outputScript);
  }
}

function fundCommitment(commitment: XpublessWatcherCommitment, deposit: DerivedDeposit, amountBtc: string, miner: string): FundedCommitment {
  const txid = cli(["sendtoaddress", deposit.address, amountBtc], funderWallet);
  mine(1, miner);
  const funding = json<{ hex: string }>(["gettransaction", txid], funderWallet);
  const transaction = Transaction.fromHex(funding.hex);
  const vout = transaction.outs.findIndex((output) => bytesToHex(output.script) === commitment.outputScript);
  if (vout < 0) throw new Error(`Funding transaction does not contain Deposit #${commitment.index}.`);
  return { ...commitment, txid, vout, valueSats: Number(transaction.outs[vout].value) };
}

function importRawDescriptors(descriptors: string[]): void {
  const results = json<Array<{ success: boolean; error?: { message?: string } }>>(
    ["importdescriptors", JSON.stringify(descriptors.map((desc) => ({ desc, timestamp: 0, active: false })) )],
    watcherWallet,
  );
  results.forEach((result, index) => {
    if (!result.success) throw new Error(`X1B could not import raw descriptor #${index}: ${result.error?.message ?? "unknown error"}`);
  });
}

function walletUtxos(): CoreWalletUtxo[] {
  return json<CoreWalletUtxo[]>(["listunspent", "1", "9999999"], watcherWallet);
}

function assertWatcherCannotSign(funding: FundedCommitment, destination: string): void {
  let walletFundingRejected = false;
  try {
    json<{ psbt: string }>([
      "walletcreatefundedpsbt",
      JSON.stringify([{ txid: funding.txid, vout: funding.vout }]),
      JSON.stringify([{ [destination]: "0.00090000" }]),
      "0",
      JSON.stringify({ add_inputs: false, includeWatching: true, subtractFeeFromOutputs: [0] }),
      "true",
    ], watcherWallet);
  } catch {
    walletFundingRejected = true;
  }
  assert(walletFundingRejected, "Raw-only watch wallet unexpectedly considered the P2WSH input solvable.");

  const barePsbt = cli([
    "createpsbt",
    JSON.stringify([{ txid: funding.txid, vout: funding.vout }]),
    JSON.stringify([{ [destination]: "0.00090000" }]),
  ]);
  const processed = json<CorePsbtResult>(["walletprocesspsbt", barePsbt, "true", "ALL", "true", "false"], watcherWallet);
  const psbt = Psbt.fromBase64(processed.psbt);
  if (processed.complete || psbt.data.inputs[0].partialSig?.length || psbt.data.inputs[0].finalScriptWitness) {
    throw new Error("X1B watch-only wallet unexpectedly signed or finalized a PSBT.");
  }
}

function scaleObservations(): ScaleObservation[] {
  return [1, 10, 100, 1000].map((outputCount) => {
    const built = elapsed(() => watcherInput(issuedFixturePlan(outputCount - 1)));
    const serializedBytes = Buffer.byteLength(JSON.stringify(built.value), "utf8");
    const canonicalized = elapsed(() => canonicalDescriptors(built.value));
    const scanned = elapsed(() => scan(canonicalized.value));
    if (!scanned.value.success) throw new Error(`Core rejected X1B scantxoutset descriptor set of ${outputCount}.`);
    return {
      outputCount,
      serializedBytes,
      buildMilliseconds: built.milliseconds,
      canonicalizeMilliseconds: canonicalized.milliseconds,
      scanMilliseconds: scanned.milliseconds,
      accepted: scanned.value.success,
    };
  });
}

try {
  const daemon = spawn(bitcoind, [
    `-datadir=${datadir}`, "-regtest", "-server=1", `-port=${p2pPort}`, `-rpcport=${rpcPort}`, "-listen=0", "-connect=0", "-dnsseed=0", "-discover=0", "-fallbackfee=0.0001", "-printtoconsole=0",
  ], { detached: true, stdio: "ignore" });
  daemonPid = daemon.pid;
  daemon.unref();
  waitForRpc();

  const chain = json<{ chain: string; blocks: number }>(["getblockchaininfo"]);
  if (chain.chain !== "regtest") throw new Error(`Unsafe chain selected: ${chain.chain}`);
  const networkInfo = json<CoreNetworkInfo>(["getnetworkinfo"]);
  console.log(`X1B CORE chain=regtest initialHeight=${chain.blocks} version=${networkInfo.version} subversion=${networkInfo.subversion} rpcPort=${rpcPort} p2pPort=${p2pPort}`);

  cli(["createwallet", funderWallet]);
  cli(["createwallet", watcherWallet, "true"]);
  const miner = cli(["getnewaddress", "x1b-miner", "bech32"], funderWallet);
  mine(101, miner);

  const planAtThree = issuedFixturePlan(3);
  const producerDeposits = deriveIssuedDeposits(planAtThree);
  const commitments = watcherInput(planAtThree);
  const wrongDeposit = deriveDeposit(createVaultPlan({
    label: "X1B wrong P2WSH control",
    network: "regtest",
    unlockHeight: 251,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  }), 0);
  const forbiddenValues = [
    validTestTpub,
    validTestTpubOrigin.masterFingerprint,
    validTestTpubOrigin.sourcePath,
    ...producerDeposits.flatMap((deposit) => [deposit.publicKey, deposit.witnessScript]),
  ];
  assertWatcherInput(commitments, forbiddenValues);
  const descriptors = canonicalDescriptors(commitments);
  const wrongDescriptor = checkedRawDescriptor(wrongDeposit.outputScript);
  assertRawOnlyDescriptors(descriptors, commitments, forbiddenValues);
  assert.match(wrongDescriptor, new RegExp(`^raw\\(${wrongDeposit.outputScript}\\)#[a-z0-9]{8}$`));

  const fundedZero = fundCommitment(commitments[0], producerDeposits[0], "0.00100000", miner);
  const fundedOne = fundCommitment(commitments[1], producerDeposits[1], "0.00200000", miner);
  const initiallyFunded = [fundedZero, fundedOne];

  const scanBeforeImport = scan([...descriptors, wrongDescriptor]);
  assert(scanBeforeImport.success, "X1B scantxoutset did not complete.");
  assertMatchesFunding(scanBeforeImport.unspents, initiallyFunded);
  assert.equal(scanBeforeImport.unspents.some((utxo) => utxo.scriptPubKey === commitments[2].outputScript || utxo.scriptPubKey === commitments[3].outputScript || utxo.scriptPubKey === wrongDeposit.outputScript), false);
  console.log("X1B SCANTXOUTSET funded=#0,#1 currentUtxosOnly=true unfunded=#2,#3,falseControl=absent");

  importRawDescriptors(descriptors);
  const walletInfo = json<CoreWalletInfo>(["getwalletinfo"], watcherWallet);
  assert.equal(walletInfo.private_keys_enabled, false);
  assert.equal(walletInfo.descriptors, true);
  const watcherDescriptors = json<CoreDescriptorList>(["listdescriptors", "false"], watcherWallet).descriptors.map(({ desc }) => desc);
  const importedDescriptors = descriptors.map((descriptor) => {
    const found = watcherDescriptors.find((watcherDescriptor) => watcherDescriptor === descriptor);
    assert(found, "Watcher is missing an imported raw descriptor.");
    return found;
  });
  assertRawOnlyDescriptors(importedDescriptors, commitments, forbiddenValues);
  const watchedInitially = walletUtxos();
  assertMatchesFunding(watchedInitially, initiallyFunded);
  assert.equal(watchedInitially.some((utxo) => utxo.scriptPubKey === commitments[2].outputScript || utxo.scriptPubKey === commitments[3].outputScript), false);
  console.log("X1B WATCHER rescan=true privateKeysEnabled=false descriptors=raw-only listunspent=#0,#1");

  const destination = cli(["getnewaddress", "x1b-watch-only-negative", "bech32"], funderWallet);
  assertWatcherCannotSign(fundedZero, destination);
  console.log("X1B WATCHER_SIGNING privateKeys=false partialSignature=false finalized=false");

  const fundedTwo = fundCommitment(commitments[2], producerDeposits[2], "0.00300000", miner);
  assertMatchesFunding(walletUtxos(), [...initiallyFunded, fundedTwo]);
  console.log("X1B POST_IMPORT funded=#2 detectedWithoutTpub=true");

  const planAtFour = issueNextDeposit(planAtThree).plan;
  const depositFour = deriveDeposit(planAtFour, 4);
  const commitmentFour: XpublessWatcherCommitment = { index: 4, outputScript: depositFour.outputScript };
  const fundedFour = fundCommitment(commitmentFour, depositFour, "0.00400000", miner);
  assert.equal(walletUtxos().some((utxo) => utxo.txid === fundedFour.txid && utxo.vout === fundedFour.vout), false, "Watcher learned stale Deposit #4 without a commitment update.");
  const staleScan = scan(descriptors);
  assert.equal(staleScan.unspents.some((utxo) => utxo.txid === fundedFour.txid && utxo.vout === fundedFour.vout), false, "Stale descriptor set found Deposit #4.");
  const descriptorFour = checkedRawDescriptor(commitmentFour.outputScript);
  importRawDescriptors([descriptorFour]);
  assertMatchesFunding(walletUtxos(), [...initiallyFunded, fundedTwo, fundedFour]);
  console.log("X1B STALE #4=not-detected-until-explicit-raw-commitment-imported");

  const observations = scaleObservations();
  assert(observations.every((observation) => observation.accepted));
  console.log(`X1B SCALE ${JSON.stringify(observations)}`);
  console.log("X1B SPENT_HISTORY status=not-proven reason=deferred-to-avoid-duplicating-a-signing-harness-or-exposing-private-material");
} finally {
  try {
    cli(["stop"]);
  } catch {
    // The daemon may not have started or may already be stopped.
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
      // The X1B daemon has already stopped.
    }
  }
  if (ownsDatadir && process.env.TIMESATS_KEEP_REGTEST_DATA !== "1") {
    try {
      rmSync(datadir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch {
      console.warn("Could not remove temporary X1B Regtest datadir.");
    }
  }
}
