import { secp256k1 } from "@noble/curves/secp256k1.js";
import { opcodes, payments, script } from "bitcoinjs-lib";
import { VAULT_POLICY_V1, VaultPolicySchema, type VaultPolicy } from "@/domain/vault-policy";
import { bytesToHex, hexToBytes } from "./encoding";
import { bitcoinNetworkFor } from "./networks";

export interface DerivedVault {
  policy: VaultPolicy;
  witnessScript: string;
  address: string;
  outputScript: string;
}

export interface RecoveryBundle extends VaultPolicy {
  address: string;
  witnessScript: string;
  outputScript: string;
  outputType: "p2wsh-v0";
}

/** Validates a compressed secp256k1 point through noble-curves, not regex alone. */
export function validatePublicKey(publicKey: string): Uint8Array {
  if (!/^(02|03)[0-9a-fA-F]{64}$/.test(publicKey)) {
    throw new Error("Public key must be a 33-byte compressed secp256k1 public key in hexadecimal.");
  }
  const key = hexToBytes(publicKey);
  try {
    secp256k1.Point.fromHex(publicKey);
  } catch {
    throw new Error("Public key is not a valid secp256k1 point.");
  }
  return key;
}

export function buildWitnessScript(policyVersion: VaultPolicy["version"], unlockHeight: number, publicKey: Uint8Array): Uint8Array {
  // bitcoinjs-lib encodes the Script number; no hand-written integer encoding.
  return script.compile([
    script.number.encode(unlockHeight),
    opcodes.OP_CHECKLOCKTIMEVERIFY,
    policyVersion === VAULT_POLICY_V1 ? opcodes.OP_DROP : opcodes.OP_VERIFY,
    publicKey,
    opcodes.OP_CHECKSIG,
  ]);
}

export function deriveVault(input: VaultPolicy): DerivedVault {
  const policy = VaultPolicySchema.parse(input);
  const publicKey = validatePublicKey(policy.publicKey);
  const witnessScript = buildWitnessScript(policy.version, policy.unlockHeight, publicKey);
  const payment = payments.p2wsh({ redeem: { output: witnessScript }, network: bitcoinNetworkFor(policy.network) });

  if (!payment.address || !payment.output) {
    throw new Error("Could not derive the P2WSH vault address.");
  }

  return {
    policy: { ...policy, publicKey: policy.publicKey.toLowerCase() },
    witnessScript: bytesToHex(witnessScript),
    address: payment.address,
    outputScript: bytesToHex(payment.output),
  };
}

export function createRecoveryBundle(input: VaultPolicy): RecoveryBundle {
  const vault = deriveVault(input);
  return {
    ...vault.policy,
    address: vault.address,
    witnessScript: vault.witnessScript,
    outputScript: vault.outputScript,
    outputType: "p2wsh-v0",
  };
}

export function reconstructVault(bundle: RecoveryBundle): DerivedVault {
  const vault = deriveVault({
    version: bundle.version,
    network: bundle.network,
    publicKey: bundle.publicKey,
    unlockHeight: bundle.unlockHeight,
  });
  if (vault.address !== bundle.address || vault.witnessScript !== bundle.witnessScript || vault.outputScript !== bundle.outputScript) {
    throw new Error("Recovery bundle derived data does not match its policy.");
  }
  return vault;
}
