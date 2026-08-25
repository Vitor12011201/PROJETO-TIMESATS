import { describe, expect, it } from "vitest";
import { createVaultPlan } from "@/bitcoin/vault-plan";
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

  it("updates the same public policy without making metadata part of the identity", () => {
    const original = plan();
    const renamed = { ...original, metadata: { label: "Aposentadoria" } };
    expect(upsertVaultPlan([original], renamed)).toEqual([renamed]);
  });
});
