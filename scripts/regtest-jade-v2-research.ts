/**
 * Isolated Regtest research for a Blockstream Jade QEMU signer and TimeSats
 * Policy V2. This is not a product runtime path or a hardware compatibility
 * claim: it only exercises the QEMU endpoint specified by the research setup.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Psbt, Transaction } from "bitcoinjs-lib";
import { parseTestExtendedPublicKey } from "../src/bitcoin/bip32";
import { bytesToHex } from "../src/bitcoin/encoding";
import { bitcoinNetworkFor } from "../src/bitcoin/networks";
import { createVaultPlan, deriveDeposit } from "../src/bitcoin/vault-plan";
import {
  buildUnsignedVaultPsbt,
  createVaultSpendIntent,
  finalizeVaultPsbt,
  validateSignedVaultPsbt,
  verifyFundingTransaction,
} from "../src/bitcoin/vault-spend";

const bitcoind = process.env.BITCOIND ?? "bitcoind";
const bitcoinCli = process.env.BITCOINCLI ?? "bitcoin-cli";
const jadePython = process.env.TIMESATS_JADE_PYTHON ?? "python";
const jadePythonPath = process.env.TIMESATS_JADE_PYTHONPATH ?? join(process.env.HOME ?? "", "Jade");
const datadir = process.env.BITCOIN_REGTEST_DATADIR ?? mkdtempSync(join(tmpdir(), "timesats-regtest-jade-v2-"));
const ownsDatadir = !process.env.BITCOIN_REGTEST_DATADIR;
const suffix = String(process.pid);
const portBase = 20_000 + (process.pid % 10_000) * 2;
const funderWallet = `timesats-jade-funder-${suffix}`;
const watchWallet = `timesats-jade-watch-${suffix}`;
const wrongWallet = `timesats-jade-wrong-${suffix}`;
let daemonPid: number | undefined;

interface ProcessedPsbt {
  complete: boolean;
  psbt: string;
}

interface JadePublicInfo {
  network: string;
  rootTpub: string;
  deposit0Tpub: string;
}

function harnessPort(environmentName: string, fallback: number): number {
  const port = Number(process.env[environmentName] ?? fallback);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`${environmentName} must be a valid TCP port.`);
  }
  return port;
}

const rpcPort = harnessPort("BITCOIN_REGTEST_RPC_PORT", portBase);
const p2pPort = harnessPort("BITCOIN_REGTEST_P2P_PORT", portBase + 1);
if (rpcPort === p2pPort) throw new Error("Regtest RPC and P2P ports must differ.");

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
  throw new Error("Timed out waiting for isolated Regtest RPC.");
}

function mine(blocks: number, address: string): void {
  if (!Number.isInteger(blocks) || blocks < 0) throw new Error("Refusing to mine an invalid block count.");
  if (blocks > 0) cli(["generatetoaddress", String(blocks), address]);
}

function mempool(rawTransaction: string): { allowed: boolean; "reject-reason"?: string } {
  return json<Array<{ allowed: boolean; "reject-reason"?: string }>>(["testmempoolaccept", JSON.stringify([rawTransaction])])[0];
}

function checkedDescriptor(descriptor: string): string {
  return json<{ descriptor: string }>(["getdescriptorinfo", descriptor]).descriptor;
}

function importWatchDescriptor(descriptor: string): void {
  const result = json<Array<{ success: boolean; error?: { message?: string } }>>(
    ["importdescriptors", JSON.stringify([{ desc: checkedDescriptor(descriptor), timestamp: "now" }])],
    watchWallet,
  )[0];
  if (!result?.success) throw new Error(`Could not import V2 descriptor to watch-only wallet: ${result?.error?.message ?? "unknown error"}`);
}

function jadeEnvironment(): NodeJS.ProcessEnv {
  if (!jadePythonPath) throw new Error("Set TIMESATS_JADE_PYTHONPATH to the checked-out Blockstream Jade repository.");
  return { ...process.env, PYTHONPATH: jadePythonPath };
}

function readJadePublicInfo(): JadePublicInfo {
  const output = execFileSync(jadePython, ["scripts/jade-public-info.py"], {
    encoding: "utf8",
    env: jadeEnvironment(),
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  const info = JSON.parse(output) as JadePublicInfo;
  if (info.network !== "localtest" || typeof info.rootTpub !== "string" || typeof info.deposit0Tpub !== "string") {
    throw new Error("Jade public-info helper returned an unexpected localtest response.");
  }
  return info;
}

function signWithJade(unsignedBase64: string): string {
  return execFileSync(jadePython, ["scripts/jade-sign-psbt.py"], {
    input: unsignedBase64,
    encoding: "utf8",
    env: jadeEnvironment(),
    stdio: ["pipe", "pipe", "inherit"],
  }).trim();
}

function assertDoesNotSign(unsignedBase64: string): void {
  const result = json<ProcessedPsbt>(["walletprocesspsbt", unsignedBase64, "true", "ALL", "true", "false"], wrongWallet);
  const parsed = Psbt.fromBase64(result.psbt, { network: bitcoinNetworkFor("regtest") });
  if (result.complete || parsed.data.inputs[0].partialSig?.length) {
    throw new Error("Wrong Core wallet signed the Jade V2 PSBT.");
  }
  console.log("V2 NEGATIVE wrong-key-wallet=no-signature");
}

function fingerprintHex(fingerprint: number): string {
  if (!Number.isInteger(fingerprint) || fingerprint < 0 || fingerprint > 0xffffffff) {
    throw new Error("Jade root tpub did not provide a valid public BIP32 fingerprint.");
  }
  return fingerprint.toString(16).padStart(8, "0");
}

try {
  const jadePublicInfo = readJadePublicInfo();
  const rootKey = parseTestExtendedPublicKey(jadePublicInfo.rootTpub);
  const reportedDepositKey = parseTestExtendedPublicKey(jadePublicInfo.deposit0Tpub);
  const rootDepositPublicKey = rootKey.deriveChild(0).publicKey;
  if (!rootDepositPublicKey || !reportedDepositKey.publicKey || bytesToHex(rootDepositPublicKey) !== bytesToHex(reportedDepositKey.publicKey)) {
    throw new Error("Jade root tpub does not derive the reported m/0 public key.");
  }
  const masterFingerprint = fingerprintHex(rootKey.fingerprint);
  console.log(`JADE source=root path=m/0 fingerprint=${masterFingerprint} rootDerivesDeposit0=true publicOnly=true`);

  const daemon = spawn(bitcoind, [
    `-datadir=${datadir}`, "-regtest", "-server=1", `-port=${p2pPort}`, `-rpcport=${rpcPort}`, "-listen=0", "-connect=0", "-dnsseed=0", "-discover=0", "-fallbackfee=0.0001", "-printtoconsole=0",
  ], { detached: true, stdio: "ignore" });
  daemonPid = daemon.pid;
  daemon.unref();
  waitForRpc();

  const chain = json<{ blocks: number; chain: string }>(["getblockchaininfo"]);
  if (chain.chain !== "regtest") throw new Error(`Unsafe chain selected: ${chain.chain}`);
  console.log(`CORE chain=regtest initialHeight=${chain.blocks} version=${json<{ subversion: string }>(["getnetworkinfo"]).subversion}`);

  cli(["createwallet", funderWallet]);
  cli(["createwallet", watchWallet, "true"]);
  cli(["createwallet", wrongWallet]);
  const miner = cli(["getnewaddress", "jade-v2-research-miner", "bech32"], funderWallet);
  mine(101, miner);

  const unlockHeight = Number(cli(["getblockcount"])) + 6;
  const plan = createVaultPlan({
    label: "Regtest Jade signer research",
    network: "regtest",
    unlockHeight,
    extendedPublicKey: jadePublicInfo.rootTpub,
    policyVersion: 2,
    keyOrigin: { masterFingerprint, sourcePath: "m" },
  });
  const deposit = deriveDeposit(plan, 0);
  if (deposit.publicKey !== bytesToHex(reportedDepositKey.publicKey)) {
    throw new Error("TimeSats Policy V2 Deposit #0 does not match Jade m/0.");
  }
  if (deposit.absoluteDerivationPath !== "m/0") throw new Error("TimeSats Policy V2 changed the root-source derivation path.");

  const descriptor = `wsh(and_v(v:after(${unlockHeight}),pk(${deposit.publicKey})))`;
  const checked = checkedDescriptor(descriptor);
  const candidateAddress = json<string[]>(["deriveaddresses", checked])[0];
  if (candidateAddress !== deposit.address) throw new Error("Bitcoin Core V2 descriptor address does not match the TimeSats deposit.");
  importWatchDescriptor(descriptor);
  console.log(`V2 descriptor=${checked} exactP2WSHAddress=true`);

  const fundingTxid = cli(["sendtoaddress", deposit.address, "1"], funderWallet);
  mine(1, miner);
  const rawFunding = json<{ hex: string }>(["gettransaction", fundingTxid], funderWallet).hex;
  const fundingTransaction = Transaction.fromHex(rawFunding);
  const fundingVout = fundingTransaction.outs.findIndex((output) => bytesToHex(output.script) === deposit.outputScript);
  if (fundingVout < 0) throw new Error("Funding transaction does not contain the TimeSats V2 deposit output.");
  const funding = verifyFundingTransaction(plan, 0, rawFunding, fundingVout);
  console.log(`V2 FUNDING verified=true vout=${funding.utxo.vout} valueSats=${funding.utxo.valueSats}`);

  const probeDestination = cli(["getnewaddress", "jade-v2-research-probe", "bech32"], funderWallet);
  const probe = json<{ psbt: string }>([
    "walletcreatefundedpsbt",
    JSON.stringify([{ txid: funding.utxo.txid, vout: funding.utxo.vout, sequence: 0xfffffffe }]),
    JSON.stringify([{ [probeDestination]: "0.99999000" }]),
    String(unlockHeight),
    JSON.stringify({ add_inputs: false, fee_rate: 1, replaceable: false, subtractFeeFromOutputs: [0] }),
    "true",
  ], watchWallet);
  const probeDecoded = json<{ inputs?: Array<{ witness_script?: { hex?: string } }> }>(["decodepsbt", probe.psbt]);
  const coreWitnessScript = probeDecoded.inputs?.[0]?.witness_script?.hex;
  if (!coreWitnessScript || coreWitnessScript !== deposit.witnessScript) {
    throw new Error(`Core V2 witness script mismatch: observed=${coreWitnessScript ?? "missing"} expected=${deposit.witnessScript}`);
  }
  console.log(`V2 witnessScript=${coreWitnessScript} coreByteMatch=true`);

  const destination = cli(["getnewaddress", "jade-v2-research-destination", "bech32"], funderWallet);
  const intent = createVaultSpendIntent(funding.utxo, destination, 500);
  const unsigned = buildUnsignedVaultPsbt(intent, funding.utxo).base64;
  const decoded = json<{ tx?: { locktime?: number; vin?: Array<{ sequence?: number }> }; inputs?: Array<{ witness_script?: { hex?: string }; sighash?: string; witness_utxo?: unknown }> }>(["decodepsbt", unsigned]);
  const unsignedPsbt = Psbt.fromBase64(unsigned, { network: bitcoinNetworkFor("regtest") });
  const keyOrigins = unsignedPsbt.data.inputs[0].bip32Derivation;
  if (
    decoded.tx?.locktime !== unlockHeight ||
    decoded.tx.vin?.[0]?.sequence !== 0xfffffffe ||
    decoded.inputs?.[0]?.witness_script?.hex !== deposit.witnessScript ||
    !decoded.inputs?.[0]?.witness_utxo ||
    decoded.inputs?.[0]?.sighash !== "ALL" ||
    keyOrigins?.length !== 1 ||
    keyOrigins[0].path !== "m/0" ||
    bytesToHex(keyOrigins[0].masterFingerprint) !== masterFingerprint ||
    bytesToHex(keyOrigins[0].pubkey) !== deposit.publicKey
  ) {
    throw new Error("TimeSats did not construct the expected Policy V2 BIP174 PSBT.");
  }
  console.log("V2 PSBT coreDecode=true witnessUtxo=true witnessScript=true sighash=ALL keyOrigin=true");

  assertDoesNotSign(unsigned);
  const jadeSignedBase64 = signWithJade(unsigned);
  const signed = Psbt.fromBase64(jadeSignedBase64, { network: bitcoinNetworkFor("regtest") });
  if (signed.data.inputs[0].partialSig?.length !== 1) throw new Error("Jade sign_psbt did not return exactly one V2 partial signature.");

  validateSignedVaultPsbt(intent, funding.utxo, jadeSignedBase64);
  const final = finalizeVaultPsbt(intent, funding.utxo, jadeSignedBase64);
  console.log("V2 jadeSignPsbt=true descriptorRegistration=false partialSignature=true TimeSatsValidation=true");

  const before = mempool(final.rawTransaction);
  if (before.allowed) throw new Error("V2 spend was accepted before unlock height.");
  console.log(`V2 BEFORE_UNLOCK allowed=false reason=${before["reject-reason"] ?? "unknown"}`);
  mine(unlockHeight - Number(cli(["getblockcount"])), miner);
  const after = mempool(final.rawTransaction);
  if (!after.allowed) throw new Error(`V2 spend rejected after unlock height: ${after["reject-reason"] ?? "unknown"}`);
  const spendTxid = cli(["sendrawtransaction", final.rawTransaction]);
  if (spendTxid !== final.txid) throw new Error("Bitcoin Core txid differs from the TimeSats finalized transaction.");
  mine(1, miner);
  const confirmedHeight = Number(cli(["getblockcount"]));
  const confirmation = json<{ confirmations?: number; blockheight?: number }>(["gettransaction", spendTxid], funderWallet);
  if (confirmation.confirmations !== 1 || confirmation.blockheight !== confirmedHeight) {
    throw new Error("V2 spend was not confirmed in the mined Regtest block.");
  }
  if (cli(["gettxout", funding.utxo.txid, String(funding.utxo.vout)]) !== "") throw new Error("V2 original UTXO remains unspent.");
  console.log(`V2 SPEND accepted=true txid=${spendTxid} finalizerTxidMatchesCore=true confirmations=${confirmation.confirmations} confirmedHeight=${confirmedHeight} originalUtxoSpent=true`);
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
      // Already stopped.
    }
  }
  if (ownsDatadir && process.env.TIMESATS_KEEP_REGTEST_DATA !== "1") {
    try {
      rmSync(datadir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch {
      console.warn("Could not remove temporary Regtest datadir.");
    }
  }
}
