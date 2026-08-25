/**
 * Optional, isolated Bitcoin Core integration. It creates a temporary Regtest
 * wallet/key only, derives the vault through TimeSats code, and deletes its
 * datadir at the end unless TIMESATS_KEEP_REGTEST_DATA=1 is set.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transaction } from "bitcoinjs-lib";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { bytesToHex, hexToBytes } from "../src/bitcoin/encoding";
import { deriveVault } from "../src/bitcoin/vault";
import { VAULT_POLICY_VERSION } from "../src/domain/vault-policy";

const bitcoind = process.env.BITCOIND ?? "bitcoind";
const bitcoinCli = process.env.BITCOINCLI ?? "bitcoin-cli";
const datadir = process.env.BITCOIN_REGTEST_DATADIR ?? mkdtempSync(join(tmpdir(), "timesats-regtest-"));
const ownsDatadir = !process.env.BITCOIN_REGTEST_DATADIR;
const wallet = `timesats-cltv-${process.pid}`;
const watchWallet = `${wallet}-watch`;
let vaultOutputScript = "";
let vaultWitnessScript = "";
let disposableSecretKey = new Uint8Array();
let daemonPid: number | undefined;

function cli(args: string[], walletName?: string): string {
  const common = [`-datadir=${datadir}`, "-regtest"];
  if (walletName) common.push(`-rpcwallet=${walletName}`);
  return execFileSync(bitcoinCli, [...common, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function json<T>(args: string[], walletName?: string): T {
  return JSON.parse(cli(args, walletName)) as T;
}

function expectRejected(label: string, rawTransaction: string): string {
  const result = json<Array<{ allowed: boolean; "reject-reason"?: string }>>(["testmempoolaccept", JSON.stringify([rawTransaction])])[0];
  if (result.allowed) throw new Error(`${label} unexpectedly accepted by Bitcoin Core.`);
  const reason = result["reject-reason"] ?? "(no reject reason returned)";
  console.log(`NEGATIVE ${label}: ${reason}`);
  return reason;
}

function mine(blocks: number, address: string): void {
  cli(["generatetoaddress", String(blocks), address]);
}

function waitForRpc(): void {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      cli(["getblockchaininfo"]);
      return;
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
  throw new Error("Timed out waiting for isolated bitcoind Regtest RPC.");
}

function signedSpend(
  txid: string,
  vout: number,
  destination: string,
  locktime: number,
  sequence: number,
): string {
  const raw = cli([
    "createrawtransaction",
    JSON.stringify([{ txid, vout, sequence }]),
    JSON.stringify({ [destination]: 0.999 }),
    String(locktime),
  ]);
  const transaction = Transaction.fromHex(raw);
  const witnessScript = hexToBytes(vaultWitnessScript);
  const signatureHash = transaction.hashForWitnessV0(0, witnessScript, 100_000_000n, Transaction.SIGHASH_ALL);
  const derSignature = secp256k1.sign(signatureHash, disposableSecretKey, { prehash: false, format: "der" });
  transaction.ins[0].witness = [Uint8Array.from([...derSignature, Transaction.SIGHASH_ALL]), witnessScript];
  return transaction.toHex();
}

function corruptSignature(rawTransaction: string): string {
  const transaction = Transaction.fromHex(rawTransaction);
  // Keep the DER envelope intact, but alter an interior signature byte so this
  // exercises OP_CHECKSIG failure rather than only DER-encoding policy.
  transaction.ins[0].witness[0][10] ^= 1;
  return transaction.toHex();
}

function corruptWitnessScript(rawTransaction: string): string {
  const transaction = Transaction.fromHex(rawTransaction);
  transaction.ins[0].witness[1] = Uint8Array.of(0x51); // OP_1; does not match P2WSH hash.
  return transaction.toHex();
}

try {
  if (!existsSync(bitcoind) && bitcoind === "bitcoind") throw new Error("bitcoind was not found. Set BITCOIND to the official binary path.");
  if (!existsSync(bitcoinCli) && bitcoinCli === "bitcoin-cli") throw new Error("bitcoin-cli was not found. Set BITCOINCLI to the official binary path.");

  const daemon = spawn(bitcoind, [
    `-datadir=${datadir}`,
    "-regtest",
    "-server=1",
    "-listen=0",
    "-connect=0",
    "-dnsseed=0",
    "-discover=0",
    "-fallbackfee=0.0001",
    "-printtoconsole=0",
  ], { detached: true, stdio: "ignore" });
  daemonPid = daemon.pid;
  daemon.unref();
  waitForRpc();

  const info = json<{ blocks: number; chain: string; chainwork: string }>(["getblockchaininfo"]);
  if (info.chain !== "regtest") throw new Error(`Unsafe chain selected: ${info.chain}`);
  console.log(`CORE chain=${info.chain} initialHeight=${info.blocks}`);
  cli(["createwallet", wallet]);
  cli(["createwallet", watchWallet, "true"]); // Watch-only holder of the literal P2WSH output.

  const minerAddress = cli(["getnewaddress", "timesats-miner", "bech32"], wallet);
  mine(101, minerAddress);
  disposableSecretKey = secp256k1.utils.randomSecretKey(); // Regtest-test-only; memory-only and never logged.
  const testPublicKey = bytesToHex(secp256k1.getPublicKey(disposableSecretKey, true));

  const unlockHeight = Number(cli(["getblockcount"])) + 10;
  const vault = deriveVault({
    version: VAULT_POLICY_VERSION,
    network: "regtest",
    publicKey: testPublicKey,
    unlockHeight,
  });
  vaultOutputScript = vault.outputScript;
  vaultWitnessScript = vault.witnessScript;
  console.log(`VAULT address=${vault.address} unlockHeight=${unlockHeight} witnessScript=${vault.witnessScript} keyOrigin=ephemeral-regtest-test`);

  // Import the literal TimeSats *P2WSH output script*. Core only permits raw()
  // at descriptor top level. A Miniscript expression is deliberately avoided.
  const descriptor = `raw(${vault.outputScript})`;
  const checkedDescriptor = json<{ descriptor: string }>(["getdescriptorinfo", descriptor]).descriptor;
  const coreAddress = json<string[]>(["deriveaddresses", checkedDescriptor])[0];
  if (coreAddress !== vault.address) throw new Error("Core descriptor address differs from TimeSats-derived P2WSH address.");
  const imported = json<Array<{ success: boolean }>>(["importdescriptors", JSON.stringify([{ desc: checkedDescriptor, timestamp: "now", active: false }])], watchWallet);
  if (!imported[0]?.success) throw new Error(`Core could not import the disposable Regtest descriptor: ${JSON.stringify(imported[0])}`);

  const fundingTxid = cli(["sendtoaddress", vault.address, "1"], wallet);
  mine(1, minerAddress);
  const utxo = json<Array<{ txid: string; vout: number; amount: number }>>(["listunspent", "1", "9999999", JSON.stringify([vault.address])], watchWallet)[0];
  if (!utxo) throw new Error("Funded TimeSats P2WSH UTXO was not found in the disposable Regtest wallet.");
  console.log(`FUNDING txid=${fundingTxid} vout=${utxo.vout} amount=${utxo.amount}`);
  const destination = cli(["getnewaddress", "timesats-destination", "bech32"], wallet);

  const before = signedSpend(utxo.txid, utxo.vout, destination, unlockHeight, 0xfffffffe);
  expectRejected("before-unlockHeight", before);
  expectRejected("final-sequence-ffffffff", signedSpend(utxo.txid, utxo.vout, destination, unlockHeight, 0xffffffff));

  const heightBeforeLowLocktime = Number(cli(["getblockcount"]));
  mine(unlockHeight - heightBeforeLowLocktime - 1, minerAddress); // tip H-1: low nLockTime is final but CLTV remains unsatisfied.
  expectRejected("nLockTime-below-unlockHeight", signedSpend(utxo.txid, utxo.vout, destination, unlockHeight - 1, 0xfffffffe));

  mine(1, minerAddress);
  const correctSpend = signedSpend(utxo.txid, utxo.vout, destination, unlockHeight, 0xfffffffe);
  expectRejected("incorrect-signature", corruptSignature(correctSpend));
  expectRejected("incorrect-witness-script", corruptWitnessScript(correctSpend));
  const accepted = json<Array<{ allowed: boolean; "reject-reason"?: string }>>(["testmempoolaccept", JSON.stringify([correctSpend])])[0];
  if (!accepted.allowed) throw new Error(`Correct post-timelock spend was rejected: ${accepted["reject-reason"] ?? "unknown"}`);
  const spendTxid = cli(["sendrawtransaction", correctSpend]);
  mine(1, minerAddress);
  const originalUtxo = cli(["gettxout", utxo.txid, String(utxo.vout)]);
  if (originalUtxo !== "") throw new Error("Original vault UTXO is still unspent after confirmed spend.");
  console.log(`SPEND accepted=true txid=${spendTxid} confirmedHeight=${cli(["getblockcount"])} originalUtxoSpent=true`);
} finally {
  if (daemonPid) {
    try { process.kill(daemonPid); } catch { /* daemon may not have started */ }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(daemonPid, 0);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      } catch {
        break;
      }
    }
  }
  if (ownsDatadir && process.env.TIMESATS_KEEP_REGTEST_DATA !== "1") {
    try {
      rmSync(datadir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
    } catch {
      console.warn(`Could not remove temporary Regtest datadir: ${datadir}`);
    }
  }
}
