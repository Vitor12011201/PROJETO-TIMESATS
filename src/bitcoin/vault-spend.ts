import { secp256k1 } from "@noble/curves/secp256k1.js";
import { address, Psbt, Transaction } from "bitcoinjs-lib";
import { witnessStackToScriptWitness } from "bitcoinjs-lib/src/psbt/psbtutils";
import type { PsbtInput } from "bip174";
import {
  CLTV_SEQUENCE,
  PSBT_SIGHASH_ALL,
  VaultSpendIntentSchema,
  VaultUtxoSchema,
  type VaultSpendIntent,
  type VaultUtxo,
} from "@/domain/vault-spend";
import { assertAllowedNetwork } from "@/domain/vault-policy";
import type { VaultPlan } from "@/domain/vault-plan";
import { bytesToHex, hexToBytes } from "./encoding";
import { bitcoinNetworkFor } from "./networks";
import { deriveDeposit, vaultPlanIdentity, type DerivedDeposit } from "./vault-plan";

export interface VerifiedFunding {
  utxo: VaultUtxo;
  deposit: DerivedDeposit;
}

export interface UnsignedVaultPsbt {
  intent: VaultSpendIntent;
  base64: string;
}

export interface FinalizedVaultSpend {
  rawTransaction: string;
  txid: string;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function safeSats(value: bigint): number {
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Funding output value is not a positive, safe-integer satoshi amount.");
  }
  return Number(value);
}

function transactionInputTxid(hash: Uint8Array): string {
  return bytesToHex(Uint8Array.from(hash).reverse());
}

function parsePsbt(base64: string, network: VaultSpendIntent["network"]): Psbt {
  if (typeof base64 !== "string" || base64.trim() === "") {
    throw new Error("PSBT must be a non-empty Base64 string.");
  }
  try {
    return Psbt.fromBase64(base64.trim(), { network: bitcoinNetworkFor(network) });
  } catch {
    throw new Error("Signed PSBT is malformed or unsupported.");
  }
}

/**
 * Offline proof only: this establishes that the supplied raw transaction had
 * the expected output. It cannot prove that the outpoint remains unspent.
 */
export function verifyFundingTransaction(
  plan: VaultPlan,
  depositIndex: number,
  rawFundingTransaction: string,
  vout: number,
): VerifiedFunding {
  assertAllowedNetwork(plan.policy.network);
  if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) {
    throw new Error("Funding vout must be a valid unsigned transaction output index.");
  }
  let transaction: Transaction;
  try {
    transaction = Transaction.fromHex(rawFundingTransaction.trim());
  } catch {
    throw new Error("Funding transaction must be valid raw transaction hexadecimal.");
  }
  const output = transaction.outs[vout];
  if (!output) throw new Error("Funding transaction does not contain the selected vout.");

  const deposit = deriveDeposit(plan, depositIndex);
  const expectedOutputScript = hexToBytes(deposit.outputScript);
  if (!sameBytes(output.script, expectedOutputScript)) {
    throw new Error("Funding output script does not belong to the selected VaultPlan deposit.");
  }

  const utxo = VaultUtxoSchema.parse({
    network: plan.policy.network,
    planIdentity: vaultPlanIdentity(plan),
    depositIndex,
    txid: transaction.getId(),
    vout,
    valueSats: safeSats(output.value),
    outputScript: deposit.outputScript,
    witnessScript: deposit.witnessScript,
    publicKey: deposit.publicKey,
    unlockHeight: deposit.policy.unlockHeight,
  });
  return { utxo, deposit };
}

export function createVaultSpendIntent(
  utxoInput: VaultUtxo,
  destinationAddress: string,
  feeSats: number,
): VaultSpendIntent {
  const utxo = VaultUtxoSchema.parse(utxoInput);
  assertAllowedNetwork(utxo.network);
  if (!Number.isSafeInteger(feeSats) || feeSats <= 0) {
    throw new Error("Fee must be a positive integer number of sats.");
  }
  if (feeSats >= utxo.valueSats) {
    throw new Error("Fee must be less than the verified input value.");
  }
  const destination = destinationAddress.trim();
  try {
    address.toOutputScript(destination, bitcoinNetworkFor(utxo.network));
  } catch {
    throw new Error("Destination address is invalid or belongs to a different test network.");
  }
  return VaultSpendIntentSchema.parse({
    version: 1,
    network: utxo.network,
    planIdentity: utxo.planIdentity,
    depositIndex: utxo.depositIndex,
    fundingTxid: utxo.txid,
    fundingVout: utxo.vout,
    inputValueSats: utxo.valueSats,
    destinationAddress: destination,
    destinationValueSats: utxo.valueSats - feeSats,
    feeSats,
    unlockHeight: utxo.unlockHeight,
    sequence: CLTV_SEQUENCE,
    sighashType: PSBT_SIGHASH_ALL,
  });
}

function assertIntentMatchesUtxo(intent: VaultSpendIntent, utxo: VaultUtxo): void {
  if (
    intent.network !== utxo.network ||
    intent.planIdentity !== utxo.planIdentity ||
    intent.depositIndex !== utxo.depositIndex ||
    intent.fundingTxid !== utxo.txid ||
    intent.fundingVout !== utxo.vout ||
    intent.inputValueSats !== utxo.valueSats ||
    intent.unlockHeight !== utxo.unlockHeight
  ) {
    throw new Error("Spend intent does not match the verified Vault UTXO.");
  }
}

/** Builds a BIP174 PSBT v0. No private key or BIP32 origin metadata is needed. */
export function buildUnsignedVaultPsbt(intentInput: VaultSpendIntent, utxoInput: VaultUtxo): UnsignedVaultPsbt {
  const intent = VaultSpendIntentSchema.parse(intentInput);
  const utxo = VaultUtxoSchema.parse(utxoInput);
  assertAllowedNetwork(intent.network);
  assertIntentMatchesUtxo(intent, utxo);
  if (intent.destinationValueSats !== intent.inputValueSats - intent.feeSats || intent.destinationValueSats <= 0) {
    throw new Error("Spend intent output amount is inconsistent with its integer fee.");
  }
  const destinationScript = address.toOutputScript(intent.destinationAddress, bitcoinNetworkFor(intent.network));
  const psbt = new Psbt({ network: bitcoinNetworkFor(intent.network) });
  // Transaction version 2 is unrelated to PSBT v0; it is deterministic here.
  psbt.setVersion(2);
  psbt.setLocktime(intent.unlockHeight);
  psbt.addInput({
    hash: intent.fundingTxid,
    index: intent.fundingVout,
    sequence: intent.sequence,
    witnessUtxo: { script: hexToBytes(utxo.outputScript), value: BigInt(utxo.valueSats) },
    witnessScript: hexToBytes(utxo.witnessScript),
    sighashType: intent.sighashType,
  });
  psbt.addOutput({ script: destinationScript, value: BigInt(intent.destinationValueSats) });
  return { intent, base64: psbt.toBase64() };
}

function assertPsbtIntentInvariants(psbt: Psbt, intent: VaultSpendIntent, utxo: VaultUtxo): void {
  if (psbt.version !== 2 || psbt.locktime !== intent.unlockHeight || psbt.inputCount !== 1 || psbt.txOutputs.length !== 1) {
    throw new Error("Signed PSBT transaction structure differs from the original spend intent.");
  }
  const input = psbt.txInputs[0];
  const inputData = psbt.data.inputs[0];
  const output = psbt.txOutputs[0];
  const expectedDestination = address.toOutputScript(intent.destinationAddress, bitcoinNetworkFor(intent.network));
  if (
    transactionInputTxid(input.hash) !== intent.fundingTxid ||
    input.index !== intent.fundingVout ||
    input.sequence !== intent.sequence ||
    output.value !== BigInt(intent.destinationValueSats) ||
    !sameBytes(output.script, expectedDestination)
  ) {
    throw new Error("Signed PSBT changes the outpoint, sequence, or destination transaction fields.");
  }
  if (!inputData.witnessUtxo || !inputData.witnessScript || inputData.sighashType !== intent.sighashType) {
    throw new Error("Signed PSBT is missing required P2WSH witness data or SIGHASH_ALL.");
  }
  if (
    inputData.witnessUtxo.value !== BigInt(utxo.valueSats) ||
    !sameBytes(inputData.witnessUtxo.script, hexToBytes(utxo.outputScript)) ||
    !sameBytes(inputData.witnessScript, hexToBytes(utxo.witnessScript))
  ) {
    throw new Error("Signed PSBT changes the verified vault witness data.");
  }
  if (inputData.finalScriptSig || inputData.finalScriptWitness) {
    throw new Error("Signed PSBT must return a partial signature; TimeSats performs finalization after verification.");
  }
}

/** Verifies transaction invariants and the expected P2WSH ECDSA partial signature. */
export function validateSignedVaultPsbt(intentInput: VaultSpendIntent, utxoInput: VaultUtxo, signedBase64: string): Psbt {
  const intent = VaultSpendIntentSchema.parse(intentInput);
  const utxo = VaultUtxoSchema.parse(utxoInput);
  assertAllowedNetwork(intent.network);
  assertIntentMatchesUtxo(intent, utxo);
  const psbt = parsePsbt(signedBase64, intent.network);
  assertPsbtIntentInvariants(psbt, intent, utxo);
  const signatures = psbt.data.inputs[0].partialSig;
  const expectedPublicKey = hexToBytes(utxo.publicKey);
  if (!signatures || signatures.length !== 1 || !sameBytes(signatures[0].pubkey, expectedPublicKey)) {
    throw new Error("Signed PSBT does not contain exactly one signature for the expected vault public key.");
  }
  const signatureWithHashType = signatures[0].signature;
  if (signatureWithHashType.length < 2 || signatureWithHashType.at(-1) !== intent.sighashType) {
    throw new Error("Signed PSBT signature does not use the required SIGHASH_ALL type.");
  }
  const signature = signatureWithHashType.slice(0, -1);
  const unsignedTransaction = Transaction.fromBuffer(psbt.data.globalMap.unsignedTx.toBuffer());
  const signatureHash = unsignedTransaction.hashForWitnessV0(
    0,
    hexToBytes(utxo.witnessScript),
    BigInt(utxo.valueSats),
    intent.sighashType,
  );
  try {
    if (!secp256k1.verify(signature, signatureHash, expectedPublicKey, { prehash: false, format: "der" })) {
      throw new Error("invalid");
    }
  } catch {
    throw new Error("Signed PSBT signature is invalid for the expected vault public key.");
  }
  return psbt;
}

export function finalizeVaultPsbt(intent: VaultSpendIntent, utxo: VaultUtxo, signedBase64: string): FinalizedVaultSpend {
  const psbt = validateSignedVaultPsbt(intent, utxo, signedBase64);
  psbt.finalizeInput(0, (_index: number, input: PsbtInput) => {
    const signature = input.partialSig?.[0]?.signature;
    const witnessScript = input.witnessScript;
    if (!signature || !witnessScript) throw new Error("Expected validated P2WSH signature and witness script.");
    return {
      finalScriptSig: undefined,
      finalScriptWitness: witnessStackToScriptWitness([signature, witnessScript]),
    };
  });
  const transaction = psbt.extractTransaction(false);
  return { rawTransaction: transaction.toHex(), txid: transaction.getId() };
}
