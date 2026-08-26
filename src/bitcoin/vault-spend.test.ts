import { describe, expect, it } from "vitest";
import { randomBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { address, networks, payments, Psbt, Transaction } from "bitcoinjs-lib";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { testnetBip32Versions } from "./bip32";
import { bitcoinNetworkFor } from "./networks";
import {
  buildUnsignedVaultPsbt,
  createVaultSpendIntent,
  finalizeVaultPsbt,
  validateSignedVaultPsbt,
  verifyFundingTransaction,
} from "./vault-spend";
import { createVaultPlan, deriveDeposit } from "./vault-plan";
import { hexToBytes } from "./encoding";

function testContext() {
  const root = HDKey.fromMasterSeed(randomBytes(32), testnetBip32Versions);
  const child = root.deriveChild(0);
  if (!child.publicKey || !child.privateKey) throw new Error("Test signer key unavailable.");
  const plan = createVaultPlan({
    label: "PSBT test plan",
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: root.publicExtendedKey,
  });
  const deposit = deriveDeposit(plan, 0);
  const funding = new Transaction();
  funding.addInput(new Uint8Array(32), 0);
  funding.addOutput(hexToBytes(deposit.outputScript), 500_000n);
  const verified = verifyFundingTransaction(plan, 0, funding.toHex(), 0);
  const destinationKey = HDKey.fromMasterSeed(randomBytes(32), testnetBip32Versions).deriveChild(1).publicKey;
  if (!destinationKey) throw new Error("Destination key unavailable.");
  const destination = payments.p2wpkh({ pubkey: destinationKey, network: bitcoinNetworkFor("regtest") }).address;
  if (!destination) throw new Error("Destination address unavailable.");
  const intent = createVaultSpendIntent(verified.utxo, destination, 500);
  const unsigned = buildUnsignedVaultPsbt(intent, verified.utxo);
  const mainnetDestination = payments.p2wpkh({ pubkey: destinationKey, network: networks.bitcoin }).address;
  if (!mainnetDestination) throw new Error("Mainnet destination address unavailable.");
  return { child, plan, deposit, funding, verified, destination, mainnetDestination, intent, unsigned };
}

function sign(unsignedBase64: string, privateKey: Uint8Array, publicKey: Uint8Array): string {
  const psbt = Psbt.fromBase64(unsignedBase64, { network: bitcoinNetworkFor("regtest") });
  return signPsbt(psbt, privateKey, publicKey);
}

function signPsbt(psbt: Psbt, privateKey: Uint8Array, publicKey: Uint8Array): string {
  psbt.signInput(0, {
    publicKey,
    sign(hash) {
      return secp256k1.sign(hash, privateKey, { prehash: false, format: "compact" });
    },
  });
  return psbt.toBase64();
}

/** Deliberately bypasses the library's "pubkey must be in script" guard for a negative test. */
function attachWrongKeySignature(psbt: Psbt, privateKey: Uint8Array, publicKey: Uint8Array): string {
  const input = psbt.data.inputs[0];
  if (!input.witnessUtxo || !input.witnessScript || input.sighashType === undefined) throw new Error("Test PSBT lacks witness data.");
  const transaction = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const hash = transaction.hashForWitnessV0(0, input.witnessScript, input.witnessUtxo.value, input.sighashType);
  const signature = secp256k1.sign(hash, privateKey, { prehash: false, format: "der" });
  psbt.updateInput(0, { partialSig: [{ pubkey: publicKey, signature: Uint8Array.from([...signature, input.sighashType]) }] });
  return psbt.toBase64();
}

describe("offline Vault UTXO and BIP174 PSBT preparation", () => {
  it("proves raw funding output belongs to the selected deterministic deposit", () => {
    const { verified, deposit, funding } = testContext();
    expect(verified.utxo.txid).toBe(Transaction.fromHex(funding.toHex()).getId());
    expect(verified.utxo.valueSats).toBe(500_000);
    expect(verified.utxo.outputScript).toBe(deposit.outputScript);
    expect(verified.utxo.witnessScript).toBe(deposit.witnessScript);
  });

  it("rejects malformed funding, missing vout, wrong deposit and wrong script", () => {
    const { plan, funding } = testContext();
    expect(() => verifyFundingTransaction(plan, 0, "not-hex", 0)).toThrow(/valid raw/i);
    expect(() => verifyFundingTransaction(plan, 0, funding.toHex(), 1)).toThrow(/does not contain/i);
    expect(() => verifyFundingTransaction(plan, 1, funding.toHex(), 0)).toThrow(/does not belong/i);
  });

  it("uses integer fee, policy locktime, and the non-final non-RBF sequence", () => {
    const { verified, intent, destination, mainnetDestination } = testContext();
    expect(intent.destinationValueSats).toBe(499_500);
    expect(intent.unlockHeight).toBe(250);
    expect(intent.sequence).toBe(0xfffffffe);
    expect(() => createVaultSpendIntent(verified.utxo, destination, 0)).toThrow(/positive integer/i);
    expect(() => createVaultSpendIntent(verified.utxo, destination, -1)).toThrow(/positive integer/i);
    expect(() => createVaultSpendIntent(verified.utxo, destination, 500_000)).toThrow(/less than/i);
    expect(() => createVaultSpendIntent(verified.utxo, "bc1qnotatestaddress", 500)).toThrow(/invalid|different/i);
    expect(() => createVaultSpendIntent(verified.utxo, mainnetDestination, 500)).toThrow(/invalid|different/i);
  });

  it("builds deterministic one-input one-output PSBT v0 carrying witness data", () => {
    const { unsigned, intent, verified } = testContext();
    const repeat = buildUnsignedVaultPsbt(intent, verified.utxo);
    const psbt = Psbt.fromBase64(unsigned.base64, { network: bitcoinNetworkFor("regtest") });
    expect(unsigned.base64).toBe(repeat.base64);
    expect(psbt.inputCount).toBe(1);
    expect(psbt.txOutputs).toHaveLength(1);
    expect(psbt.locktime).toBe(intent.unlockHeight);
    expect(psbt.txInputs[0].sequence).toBe(0xfffffffe);
    expect(psbt.data.inputs[0].witnessUtxo?.value).toBe(500_000n);
    expect(psbt.data.inputs[0].witnessScript).toEqual(hexToBytes(verified.utxo.witnessScript));
    expect(psbt.data.inputs[0].sighashType).toBe(Transaction.SIGHASH_ALL);
    expect(psbt.data.inputs[0].bip32Derivation).toBeUndefined();
    expect(Psbt.fromBase64(unsigned.base64).toBase64()).toBe(unsigned.base64);
  });

  it("adds V2 BIP32 metadata only when a public key origin is part of the plan", () => {
    const root = HDKey.fromMasterSeed(randomBytes(32), testnetBip32Versions);
    const plan = createVaultPlan({ label: "V2", network: "regtest", unlockHeight: 250, extendedPublicKey: root.publicExtendedKey, policyVersion: 2, keyOrigin: { masterFingerprint: "deadbeef", sourcePath: "m" } });
    const deposit = deriveDeposit(plan, 0);
    const funding = new Transaction();
    funding.addInput(new Uint8Array(32), 0);
    funding.addOutput(hexToBytes(deposit.outputScript), 500_000n);
    const verified = verifyFundingTransaction(plan, 0, funding.toHex(), 0);
    const destinationKey = HDKey.fromMasterSeed(randomBytes(32), testnetBip32Versions).deriveChild(1).publicKey!;
    const destination = payments.p2wpkh({ pubkey: destinationKey, network: bitcoinNetworkFor("regtest") }).address!;
    const psbt = Psbt.fromBase64(buildUnsignedVaultPsbt(createVaultSpendIntent(verified.utxo, destination, 500), verified.utxo).base64);
    expect(psbt.data.inputs[0].bip32Derivation).toEqual([{ masterFingerprint: hexToBytes("deadbeef"), path: "m/0", pubkey: hexToBytes(deposit.publicKey) }]);
  });

  it("rejects hostile V2 fingerprint, path, child-index, and public-key origin substitutions", () => {
    const root = HDKey.fromMasterSeed(randomBytes(32), testnetBip32Versions);
    const child = root.deriveChild(0);
    if (!child.privateKey || !child.publicKey) throw new Error("V2 test signer unavailable.");
    const plan = createVaultPlan({ label: "V2", network: "regtest", unlockHeight: 250, extendedPublicKey: root.publicExtendedKey, policyVersion: 2, keyOrigin: { masterFingerprint: "deadbeef", sourcePath: "m" } });
    const deposit = deriveDeposit(plan, 0);
    const funding = new Transaction(); funding.addInput(new Uint8Array(32), 0); funding.addOutput(hexToBytes(deposit.outputScript), 500_000n);
    const verified = verifyFundingTransaction(plan, 0, funding.toHex(), 0);
    const destinationKey = HDKey.fromMasterSeed(randomBytes(32), testnetBip32Versions).deriveChild(1).publicKey!;
    const destination = payments.p2wpkh({ pubkey: destinationKey, network: bitcoinNetworkFor("regtest") }).address!;
    const intent = createVaultSpendIntent(verified.utxo, destination, 500);
    const unsigned = buildUnsignedVaultPsbt(intent, verified.utxo).base64;
    const variants = [
      { masterFingerprint: hexToBytes("feedface"), path: "m/0", pubkey: hexToBytes(deposit.publicKey) },
      { masterFingerprint: hexToBytes("deadbeef"), path: "m/1", pubkey: hexToBytes(deposit.publicKey) },
      { masterFingerprint: hexToBytes("deadbeef"), path: "m/0", pubkey: HDKey.fromMasterSeed(randomBytes(32), testnetBip32Versions).deriveChild(0).publicKey! },
    ];
    for (const bip32Derivation of variants) {
      const psbt = Psbt.fromBase64(unsigned, { network: bitcoinNetworkFor("regtest") });
      psbt.data.inputs[0].bip32Derivation = [bip32Derivation];
      const signed = signPsbt(psbt, child.privateKey, child.publicKey);
      expect(() => validateSignedVaultPsbt(intent, verified.utxo, signed)).toThrow(/key-origin metadata/i);
    }
  });

  it("validates, finalizes, and extracts a signed PSBT without production key material", () => {
    const { child, unsigned, intent, verified } = testContext();
    const signed = sign(unsigned.base64, child.privateKey!, child.publicKey!);
    expect(validateSignedVaultPsbt(intent, verified.utxo, signed)).toBeInstanceOf(Psbt);
    const final = finalizeVaultPsbt(intent, verified.utxo, signed);
    const transaction = Transaction.fromHex(final.rawTransaction);
    expect(transaction.getId()).toBe(final.txid);
    expect(transaction.locktime).toBe(intent.unlockHeight);
    expect(transaction.ins[0].sequence).toBe(intent.sequence);
    expect(transaction.ins[0].witness).toHaveLength(2);
    expect(transaction.ins[0].witness[1]).toEqual(hexToBytes(verified.utxo.witnessScript));
  });

  it("rejects an absent or wrong-key signature", () => {
    const { child, unsigned, intent, verified } = testContext();
    expect(() => validateSignedVaultPsbt(intent, verified.utxo, unsigned.base64)).toThrow(/exactly one signature/i);
    expect(() => validateSignedVaultPsbt(intent, verified.utxo, "not-a-valid-psbt")).toThrow(/malformed/i);
    const wrong = HDKey.fromMasterSeed(randomBytes(32), testnetBip32Versions).deriveChild(0);
    if (!wrong.privateKey || !wrong.publicKey) throw new Error("Wrong signer missing key.");
    const signedWrong = attachWrongKeySignature(Psbt.fromBase64(unsigned.base64), wrong.privateKey, wrong.publicKey);
    expect(() => validateSignedVaultPsbt(intent, verified.utxo, signedWrong)).toThrow(/expected vault public key/i);
    expect(child.privateKey).toBeDefined();
  });

  it("rejects a V1 PSBT that attempts to present V2 key-origin metadata", () => {
    const { child, unsigned, intent, verified } = testContext();
    const psbt = Psbt.fromBase64(unsigned.base64, { network: bitcoinNetworkFor("regtest") });
    psbt.updateInput(0, { bip32Derivation: [{ masterFingerprint: hexToBytes("deadbeef"), path: "m/0", pubkey: child.publicKey! }] });
    const signed = signPsbt(psbt, child.privateKey!, child.publicKey!);
    expect(() => validateSignedVaultPsbt(intent, verified.utxo, signed)).toThrow(/Policy V1 vault/i);
  });

  it("rejects altered destination, fee/output, extra input/output, locktime, sequence, and witness script", () => {
    const { child, unsigned, intent, verified } = testContext();
    const variants: Array<() => string> = [
      () => {
        const changedIntent = { ...intent, destinationAddress: address.fromOutputScript(hexToBytes(verified.utxo.outputScript), bitcoinNetworkFor("regtest"))! };
        const altered = buildUnsignedVaultPsbt(changedIntent, verified.utxo);
        return sign(altered.base64, child.privateKey!, child.publicKey!);
      },
      () => {
        const changedIntent = { ...intent, feeSats: 1_000, destinationValueSats: intent.inputValueSats - 1_000 };
        const altered = buildUnsignedVaultPsbt(changedIntent, verified.utxo);
        return sign(altered.base64, child.privateKey!, child.publicKey!);
      },
      () => {
        const psbt = Psbt.fromBase64(unsigned.base64, { network: bitcoinNetworkFor("regtest") });
        psbt.addOutput({ script: hexToBytes(verified.utxo.outputScript), value: 1n });
        return signPsbt(psbt, child.privateKey!, child.publicKey!);
      },
      () => {
        const psbt = Psbt.fromBase64(unsigned.base64, { network: bitcoinNetworkFor("regtest") });
        psbt.addInput({ hash: "11".repeat(32), index: 0, witnessUtxo: { script: hexToBytes(verified.utxo.outputScript), value: 1n }, witnessScript: hexToBytes(verified.utxo.witnessScript) });
        return signPsbt(psbt, child.privateKey!, child.publicKey!);
      },
      () => {
        const psbt = new Psbt({ network: bitcoinNetworkFor("regtest") });
        psbt.setVersion(2); psbt.setLocktime(intent.unlockHeight);
        psbt.addInput({ hash: "22".repeat(32), index: intent.fundingVout, sequence: intent.sequence, witnessUtxo: { script: hexToBytes(verified.utxo.outputScript), value: BigInt(verified.utxo.valueSats) }, witnessScript: hexToBytes(verified.utxo.witnessScript), sighashType: Transaction.SIGHASH_ALL });
        psbt.addOutput({ address: intent.destinationAddress, value: BigInt(intent.destinationValueSats) });
        return signPsbt(psbt, child.privateKey!, child.publicKey!);
      },
      () => {
        const psbt = Psbt.fromBase64(unsigned.base64, { network: bitcoinNetworkFor("regtest") }); psbt.setLocktime(intent.unlockHeight - 1); return signPsbt(psbt, child.privateKey!, child.publicKey!);
      },
      () => {
        const psbt = Psbt.fromBase64(unsigned.base64, { network: bitcoinNetworkFor("regtest") }); psbt.setInputSequence(0, 0xffffffff); return signPsbt(psbt, child.privateKey!, child.publicKey!);
      },
      () => {
        const psbt = Psbt.fromBase64(unsigned.base64, { network: bitcoinNetworkFor("regtest") }); psbt.data.inputs[0].witnessScript = Uint8Array.of(0x51); return psbt.toBase64();
      },
    ];
    for (const altered of variants) {
      expect(() => validateSignedVaultPsbt(intent, verified.utxo, altered())).toThrow(/differs|changes|missing/i);
    }
  });
});
