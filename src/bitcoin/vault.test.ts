import { describe, expect, it, vi } from "vitest";
import { VAULT_POLICY_V1, VAULT_POLICY_V2, type VaultPolicy } from "@/domain/vault-policy";
import { bitcoinNetworkFor } from "./networks";
import { createRecoveryBundle, deriveVault, reconstructVault, validatePublicKey } from "./vault";

const generatorPublicKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const alternatePublicKey = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const signetPolicy: VaultPolicy = {
  version: VAULT_POLICY_V1,
  network: "signet",
  publicKey: generatorPublicKey,
  unlockHeight: 840_000,
};

describe("TimeSats vault derivation", () => {
  it("accepts a valid compressed secp256k1 public key", () => {
    expect(validatePublicKey(generatorPublicKey)).toHaveLength(33);
  });

  it("rejects malformed and non-curve public keys", () => {
    expect(() => validatePublicKey("02deadbeef")).toThrow(/33-byte/);
    expect(() => validatePublicKey(`02${"ff".repeat(32)}`)).toThrow(/secp256k1 point/);
  });

  it("accepts a valid block-height unlock value", () => {
    expect(deriveVault(signetPolicy).policy.unlockHeight).toBe(840_000);
  });

  it.each([0, -1, 1.5, 500_000_000])("rejects invalid unlock height %s", (unlockHeight) => {
    expect(() => deriveVault({ ...signetPolicy, unlockHeight })).toThrow();
  });

  it("explicitly rejects mainnet at the code boundary", () => {
    expect(() => bitcoinNetworkFor("mainnet")).toThrow("Mainnet is prohibited");
    expect(() => deriveVault({ ...signetPolicy, network: "mainnet" as never })).toThrow();
  });

  it("has a deterministic policy vector and expected CLTV script", () => {
    const vault = deriveVault(signetPolicy);
    expect(vault.witnessScript).toBe(
      "0340d10cb175210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac",
    );
    expect(deriveVault(signetPolicy)).toEqual(vault);
  });

  it("derives the same P2WSH address from the same policy", () => {
    expect(deriveVault(signetPolicy).address).toBe(deriveVault({ ...signetPolicy }).address);
  });

  it("changes the address when the public key changes", () => {
    expect(deriveVault({ ...signetPolicy, publicKey: alternatePublicKey }).address).not.toBe(deriveVault(signetPolicy).address);
  });

  it("changes script and address when unlock height changes", () => {
    const original = deriveVault(signetPolicy);
    const changed = deriveVault({ ...signetPolicy, unlockHeight: 840_001 });
    expect(changed.witnessScript).not.toBe(original.witnessScript);
    expect(changed.address).not.toBe(original.address);
  });

  it("creates a signet-compatible P2WSH address", () => {
    expect(deriveVault(signetPolicy).address).toMatch(/^tb1q/);
  });

  it("creates a regtest-compatible P2WSH address", () => {
    expect(deriveVault({ ...signetPolicy, network: "regtest" }).address).toMatch(/^bcrt1q/);
  });

  it("creates a recovery bundle without secret fields", () => {
    const bundle = createRecoveryBundle(signetPolicy);
    const serialized = JSON.stringify(bundle).toLowerCase();
    for (const forbidden of ["seed", "mnemonic", "privatekey", "private_key", "wif", "xprv"]) {
      expect(serialized).not.toContain(`\"${forbidden}\"`);
    }
  });

  it("preserves and verifies a policy through JSON serialization", () => {
    const restored = JSON.parse(JSON.stringify(createRecoveryBundle(signetPolicy)));
    expect(reconstructVault(restored)).toEqual(deriveVault(signetPolicy));
  });

  it("rejects non-integer input before script number encoding", () => {
    expect(() => deriveVault({ ...signetPolicy, unlockHeight: 840_000.1 })).toThrow();
  });

  it("does not require network access to derive a vault", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    deriveVault(signetPolicy);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("builds deterministic V2 CHECKLOCKTIMEVERIFY/VERIFY scripts at policy boundaries", () => {
    for (const unlockHeight of [1, 2, 16, 17, 100, 499_999_999]) {
      const v1 = deriveVault({ ...signetPolicy, version: VAULT_POLICY_V1, unlockHeight });
      const v2 = deriveVault({ ...signetPolicy, version: VAULT_POLICY_V2, unlockHeight });
      expect(v2.witnessScript).toContain("b16921");
      expect(v2.witnessScript).not.toBe(v1.witnessScript);
      expect(v2.address).not.toBe(v1.address);
      expect(deriveVault({ ...signetPolicy, version: VAULT_POLICY_V2, unlockHeight })).toEqual(v2);
    }
  });
});
