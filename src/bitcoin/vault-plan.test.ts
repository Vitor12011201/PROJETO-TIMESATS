import { describe, expect, it, vi } from "vitest";
import { LEGACY_VAULT_PLAN_VERSION, MAX_NON_HARDENED_INDEX, type VaultPlan } from "@/domain/vault-plan";
import {
  createVaultPlan,
  createVaultPlanRecoveryBundle,
  deriveDeposit,
  deriveIssuedDeposits,
  issueNextDeposit,
  reconstructVaultPlan,
} from "./vault-plan";
import { deriveNonHardenedPublicKey, parseTestExtendedPublicKey } from "./bip32";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";

function planInput() {
  return {
    label: "Minha Casa",
    network: "signet" as const,
    unlockHeight: 840_000,
    extendedPublicKey: validTestTpub,
  };
}

function interoperablePlanInput() {
  return {
    ...planInput(),
    policyVersion: 2 as const,
    keyOrigin: validTestTpubOrigin,
  };
}

describe("VaultPlan public-only deterministic derivation", () => {
  it("creates a valid plan and immediately issues Deposit #0", () => {
    const plan = createVaultPlan(planInput());
    expect(plan.version).toBe(LEGACY_VAULT_PLAN_VERSION);
    expect(plan.lastIssuedIndex).toBe(0);
    expect(deriveIssuedDeposits(plan)).toHaveLength(1);
  });

  it.each([
    { ...planInput(), label: "" },
    { ...planInput(), unlockHeight: 500_000_000 },
    { ...planInput(), network: "mainnet" as never },
  ])("rejects invalid plan input", (input) => {
    expect(() => createVaultPlan(input)).toThrow();
  });

  it("rejects labels longer than the existing 80-character schema limit", () => {
    expect(() => createVaultPlan({ ...planInput(), label: "a".repeat(81) })).toThrow(/80 characters/i);
  });

  it("rejects mainnet at the plan boundary", () => {
    expect(() => createVaultPlan({ ...planInput(), network: "mainnet" as never })).toThrow(/Mainnet|Invalid enum/);
  });

  it("does not let metadata alter the Bitcoin policy", () => {
    const original = createVaultPlan(planInput());
    const renamed = createVaultPlan({ ...planInput(), label: "Aposentadoria" });
    expect(deriveDeposit(renamed, 0)).toMatchObject({
      publicKey: deriveDeposit(original, 0).publicKey,
      witnessScript: deriveDeposit(original, 0).witnessScript,
      outputScript: deriveDeposit(original, 0).outputScript,
      address: deriveDeposit(original, 0).address,
    });
  });

  it("accepts a valid test-network extended public key", () => {
    expect(deriveDeposit(createVaultPlan(planInput()), 0).publicKey).toMatch(/^(02|03)[0-9a-f]{64}$/);
  });

  it.each([
    "tprv8ZgxMBicQKsPe",
    "xprv9s21ZrQH143K3",
    "cV1Y4a6S3rB9oZ7qYZgSrHq1uQW9AemPX9cWBVW9s8AzK2BysYJq",
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
  ])("rejects a private-key-like input", (extendedPublicKey) => {
    expect(() => createVaultPlan({ ...planInput(), extendedPublicKey })).toThrow(/must not receive/);
  });

  it("rejects malformed and mainnet extended public keys", () => {
    expect(() => createVaultPlan({ ...planInput(), extendedPublicKey: "not-an-extended-key" })).toThrow(/Extended public key/);
    expect(() => createVaultPlan({ ...planInput(), extendedPublicKey: "xpub661MyMwAqRbcFt" })).toThrow(/Extended public key/);
  });

  it("rejects hardened derivation indexes", () => {
    expect(() => deriveNonHardenedPublicKey(validTestTpub, 0x80000000)).toThrow(/non-hardened/);
  });

  it("rejects negative, out-of-range, and hardened public deposit indexes", () => {
    const plan = createVaultPlan(planInput());
    for (const index of [-1, MAX_NON_HARDENED_INDEX + 1, 0x80000000]) {
      expect(() => deriveDeposit(plan, index)).toThrow(/non-hardened/i);
    }
  });

  it("derives Deposit #0 and #1 deterministically and differently", () => {
    const plan = createVaultPlan(planInput());
    const zero = deriveDeposit(plan, 0);
    const one = deriveDeposit(plan, 1);
    expect(deriveDeposit(plan, 0)).toEqual(zero);
    expect(deriveDeposit(plan, 1)).toEqual(one);
    expect(zero.derivationPath).toBe("m/0");
    expect(one.derivationPath).toBe("m/1");
    expect(one.publicKey).not.toBe(zero.publicKey);
    expect(one.witnessScript).not.toBe(zero.witnessScript);
    expect(one.outputScript).not.toBe(zero.outputScript);
    expect(one.address).not.toBe(zero.address);
    expect(one.policy.unlockHeight).toBe(zero.policy.unlockHeight);
  });

  it("issues the next address immutably", () => {
    const first = createVaultPlan(planInput());
    const { plan: second, deposit } = issueNextDeposit(first);
    expect(first.lastIssuedIndex).toBe(0);
    expect(second.lastIssuedIndex).toBe(1);
    expect(deposit.index).toBe(1);
  });

  it("changes deposits when unlock height or public source changes", () => {
    const plan = createVaultPlan(planInput());
    const differentHeight = createVaultPlan({ ...planInput(), unlockHeight: 840_001 });
    expect(deriveDeposit(differentHeight, 0).address).not.toBe(deriveDeposit(plan, 0).address);
    const alteredSource = parseTestExtendedPublicKey(validTestTpub).deriveChild(2).publicExtendedKey;
    const differentSource = createVaultPlan({ ...planInput(), extendedPublicKey: alteredSource });
    expect(deriveDeposit(differentSource, 0).address).not.toBe(deriveDeposit(plan, 0).address);
  });

  it("exports/imports a public recovery bundle and reconstructs issued deposits", () => {
    const { plan } = issueNextDeposit(createVaultPlan(planInput()));
    const bundle = createVaultPlanRecoveryBundle(plan);
    const restored = reconstructVaultPlan(JSON.parse(JSON.stringify(bundle)));
    expect(deriveIssuedDeposits(restored)).toEqual(deriveIssuedDeposits(plan));
    const serialized = JSON.stringify(bundle).toLowerCase();
    for (const forbidden of ["seed", "mnemonic", "private", "wif", "xprv", "tprv"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("issues Deposit #6 after reconstructing recovery state at index 5", () => {
    const issued = { ...createVaultPlan(planInput()), lastIssuedIndex: 5 } as VaultPlan;
    const restored = reconstructVaultPlan(createVaultPlanRecoveryBundle(issued));
    const next = issueNextDeposit(restored);

    expect(next.plan.lastIssuedIndex).toBe(6);
    expect(next.deposit.index).toBe(6);
    expect(next.deposit).toEqual(deriveDeposit(restored, 6));
    expect(deriveIssuedDeposits(next.plan).map((deposit) => deposit.index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(next.deposit.address).not.toBe(deriveDeposit(restored, 5).address);
  });

  it("rejects invalid, altered, and inconsistent recovery bundles", () => {
    const bundle = createVaultPlanRecoveryBundle(createVaultPlan(planInput()));
    expect(() => reconstructVaultPlan({ ...bundle, version: 3 })).toThrow();
    expect(() => reconstructVaultPlan({ ...bundle, policy: { ...bundle.policy, network: "mainnet" } })).toThrow();
    expect(() => reconstructVaultPlan({ ...bundle, policy: { ...bundle.policy, keySource: { ...bundle.policy.keySource, privateKey: "never-accepted" } } })).toThrow();
    expect(() => reconstructVaultPlan({ ...bundle, recovery: { lastIssuedIndex: -1 } })).toThrow();
    expect(() => reconstructVaultPlan({ ...bundle, policy: { ...bundle.policy, derivation: { pathTemplate: "m/0'", hardened: true } } })).toThrow();
  });

  it("does not use network access for plan or deposit derivation", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    deriveDeposit(createVaultPlan(planInput()), 0);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("retains a strict public-only VaultPlan shape", () => {
    const plan: VaultPlan = createVaultPlan(planInput());
    expect(plan.policy.keySource.type).toBe("bip32-testnet-xpub");
  });

  it("versions V2 plans, commits public key origin, and never reinterprets V1", () => {
    const v1 = createVaultPlan(planInput());
    const v2 = createVaultPlan(interoperablePlanInput());
    expect(v1.version).toBe(2);
    expect(v1.policy.policyVersion).toBe(1);
    expect(v2.version).toBe(3);
    expect(v2.policy.policyVersion).toBe(2);
    expect(v2.policy.keySource.type).toBe("bip32-testnet-xpub-with-origin");
    expect(deriveDeposit(v2, 0).absoluteDerivationPath).toBe("m/44'/1'/0'/0");
    expect(deriveDeposit(v2, 0).address).not.toBe(deriveDeposit(v1, 0).address);
  });

  it("normalizes hardened source-path markers and appends the child index once", () => {
    const plan = createVaultPlan({ ...interoperablePlanInput(), keyOrigin: { masterFingerprint: "6F53D49C", sourcePath: "m/44h/1H/0h" } });
    expect(plan.policy.keySource.type).toBe("bip32-testnet-xpub-with-origin");
    if (plan.policy.keySource.type !== "bip32-testnet-xpub-with-origin") throw new Error("Expected V2 key source.");
    expect(plan.policy.keySource.keyOrigin).toEqual(validTestTpubOrigin);
    expect(deriveDeposit(plan, 7).absoluteDerivationPath).toBe("m/44'/1'/0'/7");
  });

  it("round-trips V2 recovery while retaining the V1 recovery format", () => {
    const legacy = createVaultPlanRecoveryBundle(createVaultPlan(planInput()));
    const interoperable = createVaultPlanRecoveryBundle(createVaultPlan(interoperablePlanInput()));
    expect(legacy.version).toBe(2);
    expect(interoperable.version).toBe(3);
    expect(reconstructVaultPlan(legacy)).toEqual(createVaultPlan(planInput()));
    expect(reconstructVaultPlan(interoperable)).toEqual(createVaultPlan(interoperablePlanInput()));
  });

  it.each([
    { ...interoperablePlanInput(), keyOrigin: { masterFingerprint: "not-hex", sourcePath: "m/44'/1'/0'" } },
    { ...interoperablePlanInput(), keyOrigin: { masterFingerprint: "6f53d49c", sourcePath: "m/not-a-path" } },
  ])("rejects malformed V2 key-origin metadata", (input) => {
    expect(() => createVaultPlan(input)).toThrow();
  });

  it("requires V2 origin depth and child number to match the supplied tpub", () => {
    expect(() => createVaultPlan({ ...interoperablePlanInput(), keyOrigin: { ...validTestTpubOrigin, sourcePath: "m" } })).toThrow(/depth/i);
    expect(() => createVaultPlan({ ...interoperablePlanInput(), keyOrigin: { ...validTestTpubOrigin, sourcePath: "m/44'/1'/1'" } })).toThrow(/child number/i);
    expect(() => createVaultPlan({ ...interoperablePlanInput(), keyOrigin: { ...validTestTpubOrigin, sourcePath: "m/44'/1'/0" } })).toThrow(/child number/i);
  });

  it("accepts the maximum non-hardened source child and rejects the next value", () => {
    const maximumChildTpub = parseTestExtendedPublicKey(validTestTpub).deriveChild(MAX_NON_HARDENED_INDEX).publicExtendedKey;
    const maximumOrigin = { ...validTestTpubOrigin, sourcePath: "m/44'/1'/0'/2147483647" };
    const plan = createVaultPlan({ ...interoperablePlanInput(), extendedPublicKey: maximumChildTpub, keyOrigin: maximumOrigin });
    expect(plan.policy.keySource.type).toBe("bip32-testnet-xpub-with-origin");
    expect(() => createVaultPlan({ ...interoperablePlanInput(), extendedPublicKey: maximumChildTpub, keyOrigin: { ...maximumOrigin, sourcePath: "m/44h/1H/0h/2147483648" } })).toThrow(/invalid BIP32 child number/i);
  });

  it("checks a root tpub against its public master fingerprint", () => {
    const rootTpub = "tpubD6NzVbkrYhZ4Yeqkh5GKpfjjeB9cqLnnXzBvPB8g3qsRuUFvXe754t4g6rNhyw8vK7isRuwR9Vz3NeCd4LhS1rk8eHtBJERoSaLacdVSFnv";
    const input = { ...planInput(), extendedPublicKey: rootTpub, policyVersion: 2 as const, keyOrigin: { masterFingerprint: "35885c45", sourcePath: "m" } };
    expect(createVaultPlan(input).policy.policyVersion).toBe(2);
    expect(() => createVaultPlan({ ...input, keyOrigin: { ...input.keyOrigin, masterFingerprint: "00000000" } })).toThrow(/master fingerprint/i);
  });
});
