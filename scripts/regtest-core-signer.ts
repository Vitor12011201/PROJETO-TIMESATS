/**
 * Optional v0.4 proof: an isolated Bitcoin Core descriptor wallet retains the
 * private key and signs a TimeSats PSBT through walletprocesspsbt.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Psbt, Transaction } from "bitcoinjs-lib";
import { parseTestExtendedPublicKey } from "../src/bitcoin/bip32";
import { bytesToHex, hexToBytes } from "../src/bitcoin/encoding";
import { bitcoinNetworkFor } from "../src/bitcoin/networks";
import { buildUnsignedVaultPsbt, createVaultSpendIntent, finalizeVaultPsbt, validateSignedVaultPsbt, verifyFundingTransaction } from "../src/bitcoin/vault-spend";
import { createVaultPlan, deriveDeposit } from "../src/bitcoin/vault-plan";

const bitcoind = process.env.BITCOIND ?? "bitcoind";
const bitcoinCli = process.env.BITCOINCLI ?? "bitcoin-cli";
const datadir = process.env.BITCOIN_REGTEST_DATADIR ?? mkdtempSync(join(tmpdir(), "timesats-regtest-core-signer-"));
const ownsDatadir = !process.env.BITCOIN_REGTEST_DATADIR;
const suffix = String(process.pid);
const funderWallet = `timesats-core-funder-${suffix}`;
const signerWallet = `timesats-core-signer-${suffix}`;
const watchOnlyWallet = `timesats-core-watch-${suffix}`;
const wrongSignerWallet = `timesats-core-wrong-${suffix}`;
let daemonPid: number | undefined;

interface AddressInfo {
  desc?: string;
  hdkeypath?: string;
  hdmasterfingerprint?: string;
  pubkey?: string;
}

interface ProcessedPsbt {
  complete: boolean;
  psbt: string;
}

function cli(args: string[], walletName?: string): string {
  const common = [`-datadir=${datadir}`, "-regtest"];
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

function publicSourceFromCoreWallet(wallet: string, info: AddressInfo): { accountTpub: string; externalChainTpub: string; publicKey: string } {
  if (!info.pubkey) throw new Error("Bitcoin Core did not return the signer public key.");
  const descriptors = json<{ descriptors: Array<{ active: boolean; desc: string; internal?: boolean }> }>(["listdescriptors", "false"], wallet).descriptors;
  const externalWpkh = descriptors.find(({ active, desc, internal }) => active && !internal && desc.startsWith("wpkh("));
  const match = externalWpkh?.desc.match(/\](tpub[1-9A-HJ-NP-Za-km-z]+)\/0\/\*(?:\)|#)/);
  if (!match) throw new Error("Bitcoin Core signer wallet did not expose the expected public tpub /0/* key expression.");
  const accountTpub = match[1];
  const externalChainTpub = parseTestExtendedPublicKey(accountTpub).deriveChild(0).publicExtendedKey;
  return { accountTpub, externalChainTpub, publicKey: info.pubkey.toLowerCase() };
}

function descriptorForTimeSatsPolicy(unlockHeight: number, publicKey: string): string {
  // Core descriptor representation only. The literal TimeSats script remains
  // the source of truth and is checked again through the returned PSBT.
  return `wsh(and_v(v:after(${unlockHeight}),pk(${publicKey})))`;
}

function parseAbsoluteBip32Path(path: string): number[] {
  if (!path.startsWith("m/")) throw new Error("Bitcoin Core did not return an absolute BIP32 path.");
  return path.slice(2).split("/").map((component) => {
    const hardened = /['h]$/i.test(component);
    const value = Number(component.replace(/['h]$/i, ""));
    if (!Number.isInteger(value) || value < 0 || value > 0x7fffffff) throw new Error("Bitcoin Core returned an invalid BIP32 path component.");
    return hardened ? value + 0x80000000 : value;
  });
}

function addCoreKeyOrigin(unsignedBase64: string, publicKey: string, info: AddressInfo): string {
  if (!info.hdmasterfingerprint || !info.hdkeypath) throw new Error("Bitcoin Core did not return key-origin metadata for signer key.");
  parseAbsoluteBip32Path(info.hdkeypath);
  const psbt = Psbt.fromBase64(unsignedBase64, { network: bitcoinNetworkFor("regtest") });
  psbt.updateInput(0, {
    bip32Derivation: [{
      masterFingerprint: hexToBytes(info.hdmasterfingerprint),
      path: info.hdkeypath,
      pubkey: hexToBytes(publicKey),
    }],
  });
  return psbt.toBase64();
}

function importDescriptor(wallet: string, descriptor: string): string {
  const checked = json<{ descriptor: string }>(["getdescriptorinfo", descriptor]).descriptor;
  const result = json<Array<{ success: boolean; error?: { message?: string } }>>(
    ["importdescriptors", JSON.stringify([{ desc: checked, timestamp: "now" }])],
    wallet,
  )[0];
  if (!result?.success) throw new Error(`Bitcoin Core could not import TimeSats descriptor: ${result?.error?.message ?? "unknown error"}`);
  return checked;
}

function assertDoesNotSign(wallet: string, unsignedBase64: string, label: string): void {
  const result = json<ProcessedPsbt>(["walletprocesspsbt", unsignedBase64, "true", "ALL", "true", "false"], wallet);
  const parsed = Psbt.fromBase64(result.psbt, { network: bitcoinNetworkFor("regtest") });
  if (result.complete || parsed.data.inputs[0].partialSig?.length) {
    throw new Error(`${label} unexpectedly signed the TimeSats PSBT.`);
  }
  console.log(`NEGATIVE ${label}=no-signature`);
}

try {
  if (!existsSync(bitcoind) && bitcoind === "bitcoind") throw new Error("bitcoind was not found. Set BITCOIND to an official Bitcoin Core binary path.");
  if (!existsSync(bitcoinCli) && bitcoinCli === "bitcoin-cli") throw new Error("bitcoin-cli was not found. Set BITCOINCLI to an official Bitcoin Core binary path.");

  const daemon = spawn(bitcoind, [
    `-datadir=${datadir}`, "-regtest", "-server=1", "-listen=0", "-connect=0", "-dnsseed=0", "-discover=0", "-fallbackfee=0.0001", "-printtoconsole=0",
  ], { detached: true, stdio: "ignore" });
  daemonPid = daemon.pid;
  daemon.unref();
  waitForRpc();

  const chain = json<{ blocks: number; chain: string }>(["getblockchaininfo"]);
  if (chain.chain !== "regtest") throw new Error(`Unsafe chain selected: ${chain.chain}`);
  console.log(`CORE chain=regtest initialHeight=${chain.blocks}`);
  console.log(`CORE version=${json<{ subversion: string }>(["getnetworkinfo"]).subversion}`);

  cli(["createwallet", funderWallet]);
  cli(["createwallet", signerWallet]);
  cli(["createwallet", watchOnlyWallet, "true"]);
  cli(["createwallet", wrongSignerWallet]);
  const miner = cli(["getnewaddress", "timesats-core-miner", "bech32"], funderWallet);
  mine(101, miner);

  const signerKeyAddress = cli(["getnewaddress", "timesats-core-signer-key", "bech32"], signerWallet);
  const signerAddressInfo = json<AddressInfo>(["getaddressinfo", signerKeyAddress], signerWallet);
  const signerKey = publicSourceFromCoreWallet(signerWallet, signerAddressInfo);
  const unlockHeight = Number(cli(["getblockcount"])) + 6;
  const plan = createVaultPlan({
    label: "Regtest Bitcoin Core signer proof",
    network: "regtest",
    unlockHeight,
    extendedPublicKey: signerKey.externalChainTpub,
  });
  const deposit = deriveDeposit(plan, 0);
  if (deposit.publicKey !== signerKey.publicKey) throw new Error("TimeSats Deposit #0 public key does not match Bitcoin Core wallet key.");

  const miniscriptDescriptor = descriptorForTimeSatsPolicy(unlockHeight, deposit.publicKey);
  const checkedMiniscript = json<{ descriptor: string }>(["getdescriptorinfo", miniscriptDescriptor]).descriptor;
  const miniscriptAddress = json<string[]>(["deriveaddresses", checkedMiniscript])[0];
  const rawOutputDescriptor = importDescriptor(watchOnlyWallet, `raw(${deposit.outputScript})`);
  const rawOutputAddress = json<string[]>(["deriveaddresses", rawOutputDescriptor])[0];
  if (rawOutputAddress !== deposit.address) throw new Error("Bitcoin Core raw() descriptor does not derive the exact TimeSats P2WSH address.");
  console.log(`DESCRIPTOR exactP2WSHAddress=true keyOriginAvailable=${Boolean(signerKey.accountTpub && json<AddressInfo>(["getaddressinfo", signerKeyAddress], signerWallet).hdmasterfingerprint)}`);
  console.log(`MINISCRIPT byteEquivalent=${miniscriptAddress === deposit.address}`);

  const wrongKeyAddress = cli(["getnewaddress", "timesats-core-wrong-key", "bech32"], wrongSignerWallet);
  const wrongInfo = json<AddressInfo>(["getaddressinfo", wrongKeyAddress], wrongSignerWallet);
  if (!wrongInfo.pubkey) throw new Error("Bitcoin Core did not return wrong-wallet public key.");
  if (wrongInfo.pubkey.toLowerCase() === deposit.publicKey) throw new Error("Wrong signer wallet unexpectedly generated the TimeSats public key.");

  const fundingTxid = cli(["sendtoaddress", deposit.address, "1"], funderWallet);
  mine(1, miner);
  const rawFunding = json<{ hex: string }>(["gettransaction", fundingTxid], funderWallet).hex;
  const fundingVout = Transaction.fromHex(rawFunding).outs.findIndex((output) => bytesToHex(output.script) === deposit.outputScript);
  if (fundingVout < 0) throw new Error("Funding transaction does not contain the TimeSats deposit output.");
  const funding = verifyFundingTransaction(plan, 0, rawFunding, fundingVout);
  console.log(`FUNDING verified=true vout=${funding.utxo.vout} valueSats=${funding.utxo.valueSats}`);

  const destination = cli(["getnewaddress", "timesats-core-destination", "bech32"], funderWallet);
  const intent = createVaultSpendIntent(funding.utxo, destination, 500);
  const unsigned = buildUnsignedVaultPsbt(intent, funding.utxo);
  const decodedUnsigned = json<{ inputs?: Array<{ sighash?: string; witness_script?: string; witness_utxo?: unknown }>; tx?: { locktime?: number; vin?: Array<{ sequence?: number }> } }>(["decodepsbt", unsigned.base64]);
  if (
    decodedUnsigned.tx?.locktime !== unlockHeight ||
    decodedUnsigned.tx.vin?.[0]?.sequence !== intent.sequence ||
    decodedUnsigned.inputs?.[0]?.sighash !== "ALL" ||
    !decodedUnsigned.inputs[0].witness_script ||
    !decodedUnsigned.inputs[0].witness_utxo
  ) {
    throw new Error("Bitcoin Core decodepsbt did not recognize TimeSats witness data and transaction policy fields.");
  }
  console.log("PSBT coreDecode=true inputs=1 outputs=1 witnessUtxo=true witnessScript=true sighash=ALL");

  assertDoesNotSign(watchOnlyWallet, unsigned.base64, "watch-only-wallet");
  assertDoesNotSign(wrongSignerWallet, unsigned.base64, "wrong-key-wallet");
  assertDoesNotSign(signerWallet, unsigned.base64, "signer-without-key-origin");

  const unsignedWithKeyOrigin = addCoreKeyOrigin(unsigned.base64, deposit.publicKey, signerAddressInfo);
  const processed = json<ProcessedPsbt>(["walletprocesspsbt", unsignedWithKeyOrigin, "true", "ALL", "true", "false"], signerWallet);
  if (processed.complete) throw new Error("Bitcoin Core finalized the PSBT despite finalize=false.");
  const signed = Psbt.fromBase64(processed.psbt, { network: bitcoinNetworkFor("regtest") });
  const input = signed.data.inputs[0];
  if (!input.partialSig?.length) throw new Error("Bitcoin Core walletprocesspsbt returned no partial signature.");
  const metadataAdded = Boolean(input.bip32Derivation?.length);
  validateSignedVaultPsbt(intent, funding.utxo, processed.psbt);
  const final = finalizeVaultPsbt(intent, funding.utxo, processed.psbt);
  console.log(`SIGNER walletprocesspsbt=true partialSignature=true finalizedByCore=false bip32MetadataAdded=${metadataAdded}`);

  const before = mempool(final.rawTransaction);
  if (before.allowed) throw new Error("TimeSats spend was accepted before unlock height.");
  console.log(`BEFORE_UNLOCK allowed=false reason=${before["reject-reason"] ?? "unknown"}`);
  const currentHeight = Number(cli(["getblockcount"]));
  mine(unlockHeight - currentHeight, miner);
  const after = mempool(final.rawTransaction);
  if (!after.allowed) throw new Error(`TimeSats spend was rejected after unlock height: ${after["reject-reason"] ?? "unknown"}`);
  const spendTxid = cli(["sendrawtransaction", final.rawTransaction]);
  mine(1, miner);
  if (cli(["gettxout", funding.utxo.txid, String(funding.utxo.vout)]) !== "") throw new Error("Original TimeSats UTXO remains unspent.");
  console.log(`SPEND accepted=true txid=${spendTxid} confirmedHeight=${cli(["getblockcount"])} originalUtxoSpent=true`);
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
      // The daemon has already stopped.
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
