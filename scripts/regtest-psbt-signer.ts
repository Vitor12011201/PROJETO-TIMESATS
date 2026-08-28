/**
 * Test-only external signer. It is a separate process and retains a randomly
 * generated Regtest BIP32 root only in this process memory. It must never be
 * imported by src/ or shipped by the browser bundle.
 */
import { createInterface } from "node:readline";
import { HDKey } from "@scure/bip32";
import { randomBytes } from "@noble/hashes/utils.js";
import { Psbt, Transaction } from "bitcoinjs-lib";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { testnetBip32Versions } from "../src/bitcoin/bip32";
import { bitcoinNetworkFor } from "../src/bitcoin/networks";

type Request = { id: number; type: "init" } | { id: number; type: "sign"; psbt: string; index: number } | { id: number; type: "close" };
let root: HDKey | undefined;

function reply(value: object): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    const request = JSON.parse(line) as Request;
    if (request.type === "init") {
      root = HDKey.fromMasterSeed(randomBytes(32), testnetBip32Versions);
      reply({ id: request.id, tpub: root.publicExtendedKey });
      continue;
    }
    if (request.type === "close") {
      reply({ id: request.id });
      break;
    }
    if (!root || !Number.isInteger(request.index) || request.index < 0 || request.index > 0x7fffffff) {
      throw new Error("Signer is not initialized or received an invalid child index.");
    }
    const child = root.deriveChild(request.index);
    if (!child.privateKey || !child.publicKey) throw new Error("Test signer child key unavailable.");
    const psbt = Psbt.fromBase64(request.psbt, { network: bitcoinNetworkFor("regtest") });
    psbt.signInput(0, {
      publicKey: child.publicKey,
      sign(hash) { return secp256k1.sign(hash, child.privateKey!, { prehash: false, format: "compact" }); },
    }, [Transaction.SIGHASH_ALL]);
    reply({ id: request.id, psbt: psbt.toBase64() });
  } catch (cause) {
    reply({ id: -1, error: cause instanceof Error ? cause.message : "Test signer failed." });
  }
}
