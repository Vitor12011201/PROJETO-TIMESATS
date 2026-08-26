/** Optional v0.3 proof: TimeSats only sees a tpub and PSBT; signing is IPC to a test-only process. */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { Transaction } from "bitcoinjs-lib";
import { createVaultPlan, deriveDeposit } from "../src/bitcoin/vault-plan";
import { buildUnsignedVaultPsbt, createVaultSpendIntent, finalizeVaultPsbt, validateSignedVaultPsbt, verifyFundingTransaction } from "../src/bitcoin/vault-spend";
import { bytesToHex } from "../src/bitcoin/encoding";

const bitcoind = process.env.BITCOIND ?? "bitcoind";
const bitcoinCli = process.env.BITCOINCLI ?? "bitcoin-cli";
const datadir = process.env.BITCOIN_REGTEST_DATADIR ?? mkdtempSync(join(tmpdir(), "timesats-regtest-psbt-"));
const ownsDatadir = !process.env.BITCOIN_REGTEST_DATADIR;
const wallet = `timesats-psbt-${process.pid}`;
let daemonPid: number | undefined;
let signer: ChildProcessWithoutNullStreams | undefined;

function cli(args: string[], walletName?: string): string {
  const common = [`-datadir=${datadir}`, "-regtest"];
  if (walletName) common.push(`-rpcwallet=${walletName}`);
  return execFileSync(bitcoinCli, [...common, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function json<T>(args: string[], walletName?: string): T { return JSON.parse(cli(args, walletName)) as T; }
function sleep(milliseconds: number): void { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds); }
function mine(blocks: number, address: string): void { cli(["generatetoaddress", String(blocks), address]); }
function waitForRpc(): void { for (let attempt = 0; attempt < 80; attempt += 1) { try { cli(["getblockchaininfo"]); return; } catch { sleep(250); } } throw new Error("Timed out waiting for Regtest RPC."); }
function mempool(rawTransaction: string): { allowed: boolean; "reject-reason"?: string } { return json<Array<{ allowed: boolean; "reject-reason"?: string }>>(["testmempoolaccept", JSON.stringify([rawTransaction])])[0]; }

interface SignerResponse { id: number; tpub?: string; psbt?: string; error?: string }
function startSigner(): (request: object) => Promise<SignerResponse> {
  const runner = resolve("node_modules/vite-node/vite-node.mjs");
  const signerScript = resolve("scripts/regtest-psbt-signer.ts");
  signer = spawn(process.execPath, [runner, "--config", "vitest.config.mjs", signerScript], { stdio: ["pipe", "pipe", "pipe"] });
  const responses = new Map<number, (value: SignerResponse) => void>();
  createInterface({ input: signer.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const response = JSON.parse(line) as SignerResponse;
    const resolveResponse = responses.get(response.id);
    if (resolveResponse) { responses.delete(response.id); resolveResponse(response); }
  });
  let nextId = 0;
  return (request: object) => new Promise((resolveResponse, reject) => {
    if (!signer?.stdin.writable) { reject(new Error("Test signer is unavailable.")); return; }
    const id = nextId++;
    responses.set(id, resolveResponse);
    signer.stdin.write(`${JSON.stringify({ id, ...request })}\n`);
  });
}

try {
  if (!existsSync(bitcoind) && bitcoind === "bitcoind") throw new Error("bitcoind was not found. Set BITCOIND to the official binary path.");
  if (!existsSync(bitcoinCli) && bitcoinCli === "bitcoin-cli") throw new Error("bitcoin-cli was not found. Set BITCOINCLI to the official binary path.");
  const daemon = spawn(bitcoind, [`-datadir=${datadir}`, "-regtest", "-server=1", "-listen=0", "-connect=0", "-dnsseed=0", "-discover=0", "-fallbackfee=0.0001", "-printtoconsole=0"], { detached: true, stdio: "ignore" });
  daemonPid = daemon.pid; daemon.unref(); waitForRpc();
  const chain = json<{ chain: string; blocks: number }>(["getblockchaininfo"]);
  if (chain.chain !== "regtest") throw new Error(`Unsafe chain selected: ${chain.chain}`);
  console.log(`CORE chain=regtest initialHeight=${chain.blocks}`);

  const requestSigner = startSigner();
  const initialized = await requestSigner({ type: "init" });
  if (!initialized.tpub || initialized.error) throw new Error(initialized.error ?? "Signer did not return a public tpub.");
  cli(["createwallet", wallet]);
  const miner = cli(["getnewaddress", "timesats-miner", "bech32"], wallet);
  mine(101, miner);
  const unlockHeight = Number(cli(["getblockcount"])) + 6;
  const plan = createVaultPlan({ label: "Regtest external signer proof", network: "regtest", unlockHeight, extendedPublicKey: initialized.tpub });
  const deposit = deriveDeposit(plan, 0);
  const fundingTxid = cli(["sendtoaddress", deposit.address, "1"], wallet);
  mine(1, miner);
  // The harness wallet owns the funding transaction. `gettransaction` avoids
  // requiring txindex while still yields the exact raw transaction supplied to
  // the product's offline verifier.
  const rawFunding = json<{ hex: string }>(["gettransaction", fundingTxid], wallet).hex;
  const fundingVout = Transaction.fromHex(rawFunding).outs.findIndex((output) => bytesToHex(output.script) === deposit.outputScript);
  if (fundingVout < 0) throw new Error("Funding transaction does not contain the expected Deposit #0 output.");
  const funding = verifyFundingTransaction(plan, 0, rawFunding, fundingVout);
  console.log(`FUNDING txid=${funding.utxo.txid} vout=${funding.utxo.vout} valueSats=${funding.utxo.valueSats} belongsToDeposit0=true`);
  const destination = cli(["getnewaddress", "timesats-destination", "bech32"], wallet);
  const intent = createVaultSpendIntent(funding.utxo, destination, 500);
  const unsigned = buildUnsignedVaultPsbt(intent, funding.utxo);
  console.log(`PSBT unsigned=true inputs=1 outputs=1 locktime=${intent.unlockHeight} sequence=0xfffffffe`);
  const signed = await requestSigner({ type: "sign", psbt: unsigned.base64, index: 0 });
  if (!signed.psbt || signed.error) throw new Error(signed.error ?? "Signer did not return a signed PSBT.");
  validateSignedVaultPsbt(intent, funding.utxo, signed.psbt);
  const final = finalizeVaultPsbt(intent, funding.utxo, signed.psbt);
  const before = mempool(final.rawTransaction);
  if (before.allowed) throw new Error("Spend was accepted before unlock height.");
  console.log(`BEFORE_UNLOCK allowed=false reason=${before["reject-reason"] ?? "unknown"}`);
  const currentHeight = Number(cli(["getblockcount"]));
  mine(unlockHeight - currentHeight, miner);
  const after = mempool(final.rawTransaction);
  if (!after.allowed) throw new Error(`Spend rejected after unlock: ${after["reject-reason"] ?? "unknown"}`);
  const spendTxid = cli(["sendrawtransaction", final.rawTransaction]);
  mine(1, miner);
  if (cli(["gettxout", funding.utxo.txid, String(funding.utxo.vout)]) !== "") throw new Error("Original vault UTXO remains unspent.");
  console.log(`SPEND accepted=true txid=${spendTxid} confirmedHeight=${cli(["getblockcount"])} originalUtxoSpent=true`);
  await requestSigner({ type: "close" });
} finally {
  signer?.kill();
  if (daemonPid) { try { process.kill(daemonPid); } catch { /* daemon may not have started */ } }
  if (ownsDatadir && process.env.TIMESATS_KEEP_REGTEST_DATA !== "1") { try { rmSync(datadir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }); } catch { console.warn("Could not remove temporary Regtest datadir."); } }
}
