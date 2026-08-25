import { HDKey } from "@scure/bip32";
import { bytesToHex } from "./encoding";
import { MAX_NON_HARDENED_INDEX } from "@/domain/vault-plan";

/** BIP32 testnet versions; BitcoinJS uses these exact values for both Signet and Regtest. */
export const testnetBip32Versions = {
  public: 0x043587cf,
  private: 0x04358394,
} as const;

const privateExtendedPrefix = /^(?:xprv|tprv|yprv|zprv|uprv|vprv)/i;
const wifLike = /^[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}$/;
const mnemonicLike = /^(?:[a-z]+\s+){11,23}[a-z]+$/i;

/**
 * Rejects formats TimeSats must never accept. This is intentionally an input
 * guard, not a wallet parser: actual extended-key decoding stays in scure-bip32.
 */
export function assertPublicOnlyInput(value: string): void {
  const trimmed = value.trim();
  if (privateExtendedPrefix.test(trimmed)) {
    throw new Error("TimeSats does not need and must not receive an extended private key.");
  }
  if (wifLike.test(trimmed)) {
    throw new Error("TimeSats does not need and must not receive a private key or WIF.");
  }
  if (mnemonicLike.test(trimmed)) {
    throw new Error("TimeSats does not need and must not receive a seed phrase or mnemonic.");
  }
}

/** Parses only a public BIP32 test-network extended key (tpub). */
export function parseTestExtendedPublicKey(extendedPublicKey: string): HDKey {
  assertPublicOnlyInput(extendedPublicKey);
  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(extendedPublicKey.trim(), testnetBip32Versions);
  } catch {
    throw new Error("Extended public key must be a valid test-network BIP32 public key (tpub). Mainnet xpub is not allowed.");
  }
  if (key.privateKey !== null || key.publicKey === null) {
    throw new Error("TimeSats does not need and must not receive an extended private key.");
  }
  return key;
}

export function deriveNonHardenedPublicKey(extendedPublicKey: string, index: number): Uint8Array {
  if (!Number.isInteger(index) || index < 0 || index > MAX_NON_HARDENED_INDEX) {
    throw new Error("Deposit index must be a non-hardened BIP32 integer.");
  }
  const child = parseTestExtendedPublicKey(extendedPublicKey).deriveChild(index);
  if (child.privateKey !== null || child.publicKey === null) {
    throw new Error("Expected a public-only BIP32 child key.");
  }
  return child.publicKey;
}

export function deriveNonHardenedPublicKeyHex(extendedPublicKey: string, index: number): string {
  return bytesToHex(deriveNonHardenedPublicKey(extendedPublicKey, index));
}
