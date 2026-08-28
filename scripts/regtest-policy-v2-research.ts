/**
 * Isolated Regtest research for the prospective, versioned V2 policy.
 *
 * This is deliberately not a product runtime path. It asks Bitcoin Core to
 * compile the candidate descriptor, obtains its witness script from a
 * watch-only descriptor wallet, and then tests whether a separate Core wallet
 * can sign that exact script using only legitimate public key-origin metadata.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opcodes, payments, Psbt, script, Transaction } from "bitcoinjs-lib";
import { bytesToHex, hexToBytes } from "../src/bitcoin/encoding";
import { bitcoinNetworkFor } from "../src/bitcoin/networks";
import { buildUnsignedVaultPsbt, createVaultSpendIntent, finalizeVaultPsbt, validateSignedVaultPsbt } from "../src/bitcoin/vault-spend";
import { regtestHarnessPorts, resolveHarnessExecutable } from "./regtest-harness";

const bitcoind = resolveHarnessExecutable(process.env.BITCOIND ?? "bitcoind", "bitcoind");
const bitcoinCli = resolveHarnessExecutable(process.env.BITCOINCLI ?? "bitcoin-cli", "bitcoin-cli");
const { rpcPort, p2pPort } = regtestHarnessPorts(process.env.BITCOIN_REGTEST_RPC_PORT, process.env.BITCOIN_REGTEST_P2P_PORT, process.pid, 56_000);
const datadir = process.env.BITCOIN_REGTEST_DATADIR ?? mkdtempSync(join(tmpdir(), "timesats-regtest-policy-v2-"));
const ownsDatadir = !process.env.BITCOIN_REGTEST_DATADIR;
const suffix = String(process.pid);
const funderWallet = `timesats-v2-funder-${suffix}`;
const signerWallet = `timesats-v2-signer-${suffix}`;
const watchWallet = `timesats-v2-watch-${suffix}`;
const wrongWallet = `timesats-v2-wrong-${suffix}`;
let daemonPid: number | undefined;

interface AddressInfo {
  hdkeypath?: string;
  hdmasterfingerprint?: string;
  pubkey?: string;
}

interface ProcessedPsbt {
  complete: boolean;
  psbt: string;
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
  throw new Error("Timed out waiting for isolated Regtest RPC.");
}

function mine(blocks: number, address: string): void {
  cli(["generatetoaddress", String(blocks), address]);
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

function assertCoreOrigin(info: AddressInfo): Required<Pick<AddressInfo, "hdkeypath" | "hdmasterfingerprint" | "pubkey">> {
  if (!info.pubkey || !info.hdkeypath || !info.hdmasterfingerprint) {
    throw new Error("Bitcoin Core did not return complete public key-origin metadata.");
  }
  if (!/^m\/(?:\d+(?:['h])?)(?:\/\d+(?:['h])?)*$/i.test(info.hdkeypath)) {
    throw new Error("Bitcoin Core returned an invalid absolute BIP32 path.");
  }
  if (!/^[0-9a-f]{8}$/i.test(info.hdmasterfingerprint)) {
    throw new Error("Bitcoin Core returned an invalid master fingerprint.");
  }
  return { pubkey: info.pubkey.toLowerCase(), hdkeypath: info.hdkeypath.replace(/(\d+)[hH]/g, "$1'"), hdmasterfingerprint: info.hdmasterfingerprint.toLowerCase() };
}

function buildCandidateScript(unlockHeight: number, publicKey: Uint8Array): Uint8Array {
  return script.compile([
    script.number.encode(unlockHeight),
    opcodes.OP_CHECKLOCKTIMEVERIFY,
    opcodes.OP_VERIFY,
    publicKey,
    opcodes.OP_CHECKSIG,
  ]);
}

try {
  const daemon = spawn(bitcoind, [
    `-datadir=${datadir}`, "-regtest", "-server=1", `-port=${p2pPort}`, `-rpcport=${rpcPort}`, "-listen=0", "-connect=0", "-dnsseed=0", "-discover=0", "-fallbackfee=0.0001", "-printtoconsole=0",
  ], { detached: true, stdio: "ignore" });
  daemonPid = daemon.pid;
  daemon.unref();
  waitForRpc();

  const chain = json<{ blocks: number; chain: string }>(["getblockchaininfo"]);
  if (chain.chain !== "regtest") throw new Error(`Unsafe chain selected: ${chain.chain}`);
  console.log(`CORE chain=regtest initialHeight=${chain.blocks} rpcPort=${rpcPort} p2pPort=${p2pPort} version=${json<{ subversion: string }>(["getnetworkinfo"]).subversion}`);

  cli(["createwallet", funderWallet]);
  cli(["createwallet", signerWallet]);
  cli(["createwallet", watchWallet, "true"]);
  cli(["createwallet", wrongWallet]);
  const miner = cli(["getnewaddress", "v2-research-miner", "bech32"], funderWallet);
  mine(101, miner);

  const signerAddress = cli(["getnewaddress", "v2-research-signer", "bech32"], signerWallet);
  const origin = assertCoreOrigin(json<AddressInfo>(["getaddressinfo", signerAddress], signerWallet));
  const unlockHeight = Number(cli(["getblockcount"])) + 6;
  const descriptor = `wsh(and_v(v:after(${unlockHeight}),pk(${origin.pubkey})))`;
  const checked = checkedDescriptor(descriptor);
  const candidateAddress = json<string[]>(["deriveaddresses", checked])[0];
  importWatchDescriptor(descriptor);
  console.log(`V2 descriptor=${checked}`);

  const fundingTxid = cli(["sendtoaddress", candidateAddress, "1"], funderWallet);
  mine(1, miner);
  const rawFunding = json<{ hex: string }>(["gettransaction", fundingTxid], funderWallet).hex;
  const fundingTransaction = Transaction.fromHex(rawFunding);
  const expectedPayment = payments.p2wsh({ redeem: { output: buildCandidateScript(unlockHeight, hexToBytes(origin.pubkey)) }, network: bitcoinNetworkFor("regtest") });
  if (!expectedPayment.address || !expectedPayment.output || expectedPayment.address !== candidateAddress) {
    throw new Error("Locally compiled candidate does not match Bitcoin Core V2 P2WSH address.");
  }
  const fundingVout = fundingTransaction.outs.findIndex((output) => bytesToHex(output.script) === bytesToHex(expectedPayment.output!));
  if (fundingVout < 0) throw new Error("V2 funding output was not found.");

  const probeDestination = cli(["getnewaddress", "v2-research-probe", "bech32"], funderWallet);
  const probe = json<{ psbt: string }>([
    "walletcreatefundedpsbt",
    JSON.stringify([{ txid: fundingTxid, vout: fundingVout, sequence: 0xfffffffe }]),
    JSON.stringify([{ [probeDestination]: "0.99999000" }]),
    String(unlockHeight),
    JSON.stringify({ add_inputs: false, fee_rate: 1, replaceable: false, subtractFeeFromOutputs: [0] }),
    "true",
  ], watchWallet);
  const probeDecoded = json<{ inputs?: Array<{ witness_script?: { hex?: string } }> }>(["decodepsbt", probe.psbt]);
  const coreWitnessScript = probeDecoded.inputs?.[0]?.witness_script?.hex;
  const locallyCompiled = bytesToHex(buildCandidateScript(unlockHeight, hexToBytes(origin.pubkey)));
  if (!coreWitnessScript || coreWitnessScript !== locallyCompiled) {
    throw new Error(`Core V2 witness script mismatch: observed=${coreWitnessScript ?? "missing"} expected=${locallyCompiled}`);
  }
  console.log(`V2 witnessScript=${coreWitnessScript} coreByteMatch=true`);

  const fundingOutput = fundingTransaction.outs[fundingVout];
  const destination = cli(["getnewaddress", "v2-research-destination", "bech32"], funderWallet);
  const valueSats = Number(fundingOutput.value);
  const feeSats = 500;
  const utxo = {
    network: "regtest" as const,
    planIdentity: "research-policy-v2",
    depositIndex: 0,
    txid: fundingTxid,
    vout: fundingVout,
    valueSats,
    outputScript: bytesToHex(fundingOutput.script),
    witnessScript: coreWitnessScript,
    publicKey: origin.pubkey,
    keyOrigin: { masterFingerprint: origin.hdmasterfingerprint, path: origin.hdkeypath },
    unlockHeight,
  };
  const intent = createVaultSpendIntent(utxo, destination, feeSats);
  const unsigned = buildUnsignedVaultPsbt(intent, utxo).base64;
  const decoded = json<{ tx?: { locktime?: number; vin?: Array<{ sequence?: number }> }; inputs?: Array<{ witness_script?: { hex?: string }; sighash?: string; bip32_derivs?: unknown }> }>(["decodepsbt", unsigned]);
  if (decoded.tx?.locktime !== unlockHeight || decoded.tx.vin?.[0]?.sequence !== 0xfffffffe || decoded.inputs?.[0]?.witness_script?.hex !== coreWitnessScript || decoded.inputs?.[0]?.sighash !== "ALL") {
    throw new Error("Bitcoin Core did not decode V2 PSBT policy fields as expected.");
  }
  console.log("V2 PSBT coreDecode=true witnessUtxo=true witnessScript=true sighash=ALL keyOrigin=true");

  const wrong = json<ProcessedPsbt>(["walletprocesspsbt", unsigned, "true", "ALL", "true", "false"], wrongWallet);
  if (Psbt.fromBase64(wrong.psbt, { network: bitcoinNetworkFor("regtest") }).data.inputs[0].partialSig?.length) {
    throw new Error("Wrong Core wallet signed V2 PSBT.");
  }
  console.log("V2 NEGATIVE wrong-key-wallet=no-signature");

  const processed = json<ProcessedPsbt>(["walletprocesspsbt", unsigned, "true", "ALL", "true", "false"], signerWallet);
  if (processed.complete) throw new Error("Core finalized despite finalize=false.");
  const signed = Psbt.fromBase64(processed.psbt, { network: bitcoinNetworkFor("regtest") });
  if (signed.data.inputs[0].partialSig?.length !== 1) throw new Error("Bitcoin Core walletprocesspsbt returned no V2 partial signature.");
  console.log(`V2 signerKeyOrigins=${JSON.stringify(signed.data.inputs[0].bip32Derivation?.map((entry) => ({ path: entry.path, fingerprint: bytesToHex(entry.masterFingerprint), pubkey: bytesToHex(entry.pubkey) })) ?? [])}`);

  validateSignedVaultPsbt(intent, utxo, processed.psbt);
  const final = finalizeVaultPsbt(intent, utxo, processed.psbt);
  console.log("V2 walletprocesspsbt=true partialSignature=true TimeSatsValidation=true finalizedByCore=false");

  const before = mempool(final.rawTransaction);
  if (before.allowed) throw new Error("V2 spend was accepted before unlock height.");
  console.log(`V2 BEFORE_UNLOCK allowed=false reason=${before["reject-reason"] ?? "unknown"}`);
  const currentHeight = Number(cli(["getblockcount"]));
  mine(unlockHeight - currentHeight, miner);
  const after = mempool(final.rawTransaction);
  if (!after.allowed) throw new Error(`V2 spend rejected after unlock height: ${after["reject-reason"] ?? "unknown"}`);
  const spendTxid = cli(["sendrawtransaction", final.rawTransaction]);
  mine(1, miner);
  if (cli(["gettxout", fundingTxid, String(fundingVout)]) !== "") throw new Error("V2 original UTXO remains unspent.");
  console.log(`V2 SPEND accepted=true txid=${spendTxid} confirmedHeight=${cli(["getblockcount"])} originalUtxoSpent=true`);
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
