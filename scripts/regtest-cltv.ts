/**
 * Optional Bitcoin Core integration. It is Regtest-only and creates a random
 * BIP32 root exclusively in this process. Product code receives only its tpub.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HDKey } from "@scure/bip32";
import { randomBytes } from "@noble/hashes/utils.js";
import { Transaction } from "bitcoinjs-lib";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { testnetBip32Versions } from "../src/bitcoin/bip32";
import { bytesToHex, hexToBytes } from "../src/bitcoin/encoding";
import { createVaultPlan, deriveDeposit, type DerivedDeposit } from "../src/bitcoin/vault-plan";

const bitcoind = process.env.BITCOIND ?? "bitcoind";
const bitcoinCli = process.env.BITCOINCLI ?? "bitcoin-cli";
const datadir = process.env.BITCOIN_REGTEST_DATADIR ?? mkdtempSync(join(tmpdir(), "timesats-regtest-"));
const ownsDatadir = !process.env.BITCOIN_REGTEST_DATADIR;
const wallet = `timesats-plan-${process.pid}`;
const watchWallet = `${wallet}-watch`;
const fundingAmountBtc = "1";
const spendAmountBtc = "0.999";
const fundingAmountSats = 100_000_000n;
let daemonPid: number | undefined;

interface RegtestUtxo { txid: string; vout: number }
interface TestDeposit { deposit: DerivedDeposit; privateKey: Uint8Array; utxo?: RegtestUtxo }

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

function signedSpend(testDeposit: TestDeposit, destination: string, locktime: number, sequence: number): string {
  if (!testDeposit.utxo) throw new Error("Missing funded Regtest UTXO.");
  const raw = cli([
    "createrawtransaction",
    JSON.stringify([{ txid: testDeposit.utxo.txid, vout: testDeposit.utxo.vout, sequence }]),
    JSON.stringify({ [destination]: spendAmountBtc }),
    String(locktime),
  ]);
  const transaction = Transaction.fromHex(raw);
  const witnessScript = hexToBytes(testDeposit.deposit.witnessScript);
  const signatureHash = transaction.hashForWitnessV0(0, witnessScript, fundingAmountSats, Transaction.SIGHASH_ALL);
  const derSignature = secp256k1.sign(signatureHash, testDeposit.privateKey, { prehash: false, format: "der" });
  transaction.ins[0].witness = [Uint8Array.from([...derSignature, Transaction.SIGHASH_ALL]), witnessScript];
  return transaction.toHex();
}

function corruptSignature(rawTransaction: string): string {
  const transaction = Transaction.fromHex(rawTransaction);
  transaction.ins[0].witness[0][10] ^= 1;
  return transaction.toHex();
}

function corruptWitnessScript(rawTransaction: string): string {
  const transaction = Transaction.fromHex(rawTransaction);
  transaction.ins[0].witness[1] = Uint8Array.of(0x51);
  return transaction.toHex();
}

try {
  if (!existsSync(bitcoind) && bitcoind === "bitcoind") throw new Error("bitcoind was not found. Set BITCOIND to the official binary path.");
  if (!existsSync(bitcoinCli) && bitcoinCli === "bitcoin-cli") throw new Error("bitcoin-cli was not found. Set BITCOINCLI to the official binary path.");

  const daemon = spawn(bitcoind, [
    `-datadir=${datadir}`, "-regtest", "-server=1", "-listen=0", "-connect=0", "-dnsseed=0", "-discover=0", "-fallbackfee=0.0001", "-printtoconsole=0",
  ], { detached: true, stdio: "ignore" });
  daemonPid = daemon.pid;
  daemon.unref();
  waitForRpc();

  const info = json<{ blocks: number; chain: string }>(["getblockchaininfo"]);
  if (info.chain !== "regtest") throw new Error(`Unsafe chain selected: ${info.chain}`);
  console.log(`CORE chain=${info.chain} initialHeight=${info.blocks}`);
  cli(["createwallet", wallet]);
  cli(["createwallet", watchWallet, "true"]);
  const minerAddress = cli(["getnewaddress", "timesats-miner", "bech32"], wallet);
  mine(101, minerAddress);

  // Random harness-only root. Its public half is the sole input given to TimeSats code.
  const harnessRoot = HDKey.fromMasterSeed(randomBytes(32), testnetBip32Versions);
  const unlockHeight = Number(cli(["getblockcount"])) + 10;
  const plan = createVaultPlan({
    label: "Regtest multi-deposit proof",
    network: "regtest",
    unlockHeight,
    extendedPublicKey: harnessRoot.publicExtendedKey,
  });
  const testDeposits: TestDeposit[] = [0, 1].map((index) => {
    const child = harnessRoot.deriveChild(index);
    if (child.privateKey === null || child.publicKey === null) throw new Error("Harness BIP32 child unexpectedly lacks key material.");
    const deposit = deriveDeposit(plan, index);
    if (deposit.publicKey !== bytesToHex(child.publicKey)) throw new Error(`Product public derivation differs at Deposit #${index}.`);
    return { deposit, privateKey: child.privateKey };
  });
  if (testDeposits[0].deposit.address === testDeposits[1].deposit.address) throw new Error("Plan deposit addresses must differ.");
  console.log(`PLAN unlockHeight=${unlockHeight} Deposit#0=${testDeposits[0].deposit.address} Deposit#1=${testDeposits[1].deposit.address} addressesDifferent=true`);

  for (const testDeposit of testDeposits) {
    const descriptor = `raw(${testDeposit.deposit.outputScript})`;
    const checkedDescriptor = json<{ descriptor: string }>(["getdescriptorinfo", descriptor]).descriptor;
    const coreAddress = json<string[]>(["deriveaddresses", checkedDescriptor])[0];
    if (coreAddress !== testDeposit.deposit.address) throw new Error(`Core descriptor address differs at Deposit #${testDeposit.deposit.index}.`);
    const imported = json<Array<{ success: boolean }>>(["importdescriptors", JSON.stringify([{ desc: checkedDescriptor, timestamp: "now", active: false }])], watchWallet);
    if (!imported[0]?.success) throw new Error(`Core could not import Deposit #${testDeposit.deposit.index}.`);
  }

  testDeposits.forEach(({ deposit }) => cli(["sendtoaddress", deposit.address, fundingAmountBtc], wallet));
  mine(1, minerAddress);
  for (const testDeposit of testDeposits) {
    const utxo = json<RegtestUtxo[]>(["listunspent", "1", "9999999", JSON.stringify([testDeposit.deposit.address])], watchWallet)[0];
    if (!utxo) throw new Error(`Funded UTXO missing for Deposit #${testDeposit.deposit.index}.`);
    testDeposit.utxo = utxo;
    console.log(`FUNDING Deposit#${testDeposit.deposit.index} txid=${utxo.txid} vout=${utxo.vout} amountBtc=${fundingAmountBtc}`);
  }
  const destination = cli(["getnewaddress", "timesats-destination", "bech32"], wallet);

  for (const testDeposit of testDeposits) {
    expectRejected(`before-unlockHeight-Deposit#${testDeposit.deposit.index}`, signedSpend(testDeposit, destination, unlockHeight, 0xfffffffe));
  }
  expectRejected("final-sequence-ffffffff-Deposit#0", signedSpend(testDeposits[0], destination, unlockHeight, 0xffffffff));

  const heightBeforeLowLocktime = Number(cli(["getblockcount"]));
  mine(unlockHeight - heightBeforeLowLocktime - 1, minerAddress);
  expectRejected("nLockTime-below-unlockHeight-Deposit#0", signedSpend(testDeposits[0], destination, unlockHeight - 1, 0xfffffffe));

  mine(1, minerAddress);
  const spends = testDeposits.map((testDeposit) => signedSpend(testDeposit, destination, unlockHeight, 0xfffffffe));
  expectRejected("incorrect-signature-Deposit#0", corruptSignature(spends[0]));
  expectRejected("incorrect-witness-script-Deposit#0", corruptWitnessScript(spends[0]));
  const spendTxids = spends.map((rawTransaction, index) => {
    const accepted = json<Array<{ allowed: boolean; "reject-reason"?: string }>>(["testmempoolaccept", JSON.stringify([rawTransaction])])[0];
    if (!accepted.allowed) throw new Error(`Correct Deposit #${index} spend was rejected: ${accepted["reject-reason"] ?? "unknown"}`);
    return cli(["sendrawtransaction", rawTransaction]);
  });
  mine(1, minerAddress);
  for (const [index, testDeposit] of testDeposits.entries()) {
    if (!testDeposit.utxo) throw new Error("Missing UTXO after spend.");
    const originalUtxo = cli(["gettxout", testDeposit.utxo.txid, String(testDeposit.utxo.vout)]);
    if (originalUtxo !== "") throw new Error(`Original Deposit #${index} UTXO remains unspent.`);
    console.log(`SPEND Deposit#${index} accepted=true txid=${spendTxids[index]} confirmedHeight=${cli(["getblockcount"])} originalUtxoSpent=true`);
  }
} finally {
  if (daemonPid) {
    try { process.kill(daemonPid); } catch { /* daemon may not have started */ }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try { process.kill(daemonPid, 0); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250); } catch { break; }
    }
  }
  if (ownsDatadir && process.env.TIMESATS_KEEP_REGTEST_DATA !== "1") {
    try { rmSync(datadir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch { console.warn(`Could not remove temporary Regtest datadir: ${datadir}`); }
  }
}
