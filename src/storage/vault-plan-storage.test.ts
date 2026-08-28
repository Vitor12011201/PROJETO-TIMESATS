import { describe, expect, it } from "vitest";
import { createVaultPlan, deriveDeposit, issueNextDeposit } from "@/bitcoin/vault-plan";
import { validTestTpub } from "@/tests/fixtures";
import { loadVaultPlans, saveVaultPlans, upsertVaultPlan, VAULT_PLAN_STORAGE_KEY } from "./vault-plan-storage";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

function plan() {
  return createVaultPlan({ label: "Minha Casa", network: "regtest", unlockHeight: 500, extendedPublicKey: validTestTpub });
}

describe("public-only local VaultPlan storage", () => {
  it("round-trips only validated public plan data", () => {
    const storage = memoryStorage();
    saveVaultPlans(storage, [plan()]);
    const loaded = loadVaultPlans(storage);
    expect(loaded.error).toBeNull();
    expect(loaded.plans).toEqual([plan()]);
    expect(storage.getItem(VAULT_PLAN_STORAGE_KEY)?.toLowerCase()).not.toContain("private");
  });

  it("fails safely for corrupt local data", () => {
    const storage = memoryStorage();
    storage.setItem(VAULT_PLAN_STORAGE_KEY, "{invalid json");
    expect(loadVaultPlans(storage)).toEqual(expect.objectContaining({ plans: [], error: expect.stringMatching(/invalid|corrupted/i) }));
  });

  it("loads an unchanged V1 plan from the v0.3 storage key without silently converting it", () => {
    const storage = memoryStorage();
    const legacy = { ...plan(), lastIssuedIndex: 1, metadata: { label: "Plano V1 legado" } };
    storage.setItem("timesats.vault-plans.v2", JSON.stringify({ format: "timesats-local-vault-plans", version: 2, plans: [legacy] }));
    const loaded = loadVaultPlans(storage);
    expect(storage.getItem(VAULT_PLAN_STORAGE_KEY)).toBeNull();
    expect(loaded).toEqual({ plans: [legacy], error: null });
    expect(deriveDeposit(loaded.plans[0], 1)).toEqual(deriveDeposit(legacy, 1));
    expect(issueNextDeposit(loaded.plans[0]).deposit).toEqual(issueNextDeposit(legacy).deposit);
  });

  it("updates the same public policy without making metadata part of the identity", () => {
    const original = plan();
    const renamed = { ...original, metadata: { label: "Aposentadoria" } };
    expect(upsertVaultPlan([original], renamed)).toEqual([renamed]);
  });

  it("keeps issuance monotonic while preserving incoming metadata for the same identity", () => {
    const existing = { ...plan(), lastIssuedIndex: 5, metadata: { label: "Estado local" } };
    const olderRecovery = { ...plan(), lastIssuedIndex: 1, metadata: { label: "Recovery importado" } };
    const newerRecovery = { ...plan(), lastIssuedIndex: 7, metadata: { label: "Recovery mais novo" } };

    expect(upsertVaultPlan([existing], olderRecovery)).toEqual([{ ...olderRecovery, lastIssuedIndex: 5 }]);
    expect(upsertVaultPlan([{ ...plan(), lastIssuedIndex: 1 }], newerRecovery)).toEqual([newerRecovery]);
  });

  it("does not merge plans whose canonical identities differ", () => {
    const regtest = plan();
    const signet = createVaultPlan({ label: "Signet", network: "signet", unlockHeight: regtest.policy.unlockHeight, extendedPublicKey: regtest.policy.keySource.extendedPublicKey });

    expect(upsertVaultPlan([regtest], signet)).toEqual([regtest, signet]);
  });
});
