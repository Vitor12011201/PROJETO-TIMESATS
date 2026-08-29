import { describe, expect, it } from "vitest";
import { createVaultPlan, deriveDeposit, issueNextDeposit, vaultPlanIdentity } from "@/bitcoin/vault-plan";
import { validTestTpub } from "@/tests/fixtures";
import {
  ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY,
  HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY,
  archivePlanIdentity,
  hideDepositIndex,
  loadArchivedPlanIdentities,
  loadHiddenDepositIndexes,
  loadVaultPlans,
  removeHiddenDepositIndexesForPlan,
  restoreHiddenDepositIndex,
  restorePlanIdentity,
  saveArchivedPlanIdentities,
  saveHiddenDepositIndexes,
  saveVaultPlans,
  upsertVaultPlan,
  VAULT_PLAN_STORAGE_KEY,
} from "./vault-plan-storage";

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

  it("round-trips an archived public identity without changing the VaultPlan", () => {
    const storage = memoryStorage();
    const original = { ...plan(), lastIssuedIndex: 5 };
    const identity = vaultPlanIdentity(original);

    saveVaultPlans(storage, [original]);
    saveArchivedPlanIdentities(storage, archivePlanIdentity([], identity));

    expect(loadVaultPlans(storage).plans).toEqual([original]);
    expect(loadArchivedPlanIdentities(storage)).toEqual([identity]);
    expect(vaultPlanIdentity(loadVaultPlans(storage).plans[0])).toBe(identity);
  });

  it("restores an archived identity without changing public plan data", () => {
    const original = { ...plan(), lastIssuedIndex: 5 };
    const identity = vaultPlanIdentity(original);

    expect(restorePlanIdentity([identity], identity)).toEqual([]);
    expect(original.lastIssuedIndex).toBe(5);
    expect(vaultPlanIdentity(original)).toBe(identity);
  });

  it("treats corrupted archive preferences as empty without touching stored plans", () => {
    const storage = memoryStorage();
    saveVaultPlans(storage, [plan()]);
    storage.setItem(ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY, "{invalid json");

    expect(loadArchivedPlanIdentities(storage)).toEqual([]);
    expect(loadVaultPlans(storage).plans).toEqual([plan()]);
  });

  it("round-trips hidden deposit indexes per public plan identity without changing the plan", () => {
    const storage = memoryStorage();
    const first = { ...plan(), lastIssuedIndex: 5 };
    const second = createVaultPlan({ label: "Outro plano", network: "signet", unlockHeight: 500, extendedPublicKey: validTestTpub });
    const firstIdentity = vaultPlanIdentity(first);
    const secondIdentity = vaultPlanIdentity(second);
    const hidden = hideDepositIndex(hideDepositIndex(hideDepositIndex({}, firstIdentity, 4), firstIdentity, 2), firstIdentity, 2);
    const withSecond = hideDepositIndex(hidden, secondIdentity, 1);

    saveVaultPlans(storage, [first, second]);
    saveHiddenDepositIndexes(storage, withSecond);

    expect(loadHiddenDepositIndexes(storage)).toEqual({ [firstIdentity]: [2, 4], [secondIdentity]: [1] });
    expect(loadVaultPlans(storage).plans).toEqual([first, second]);
    expect(vaultPlanIdentity(loadVaultPlans(storage).plans[0])).toBe(firstIdentity);
  });

  it("restores one hidden index and removes preferences only for the removed plan", () => {
    const firstIdentity = vaultPlanIdentity(plan());
    const secondIdentity = vaultPlanIdentity(createVaultPlan({ label: "Outro plano", network: "signet", unlockHeight: 500, extendedPublicKey: validTestTpub }));
    const hidden = { [firstIdentity]: [2, 4], [secondIdentity]: [1] };

    expect(restoreHiddenDepositIndex(hidden, firstIdentity, 2)).toEqual({ [firstIdentity]: [4], [secondIdentity]: [1] });
    expect(removeHiddenDepositIndexesForPlan(hidden, firstIdentity)).toEqual({ [secondIdentity]: [1] });
  });

  it("fails closed for corrupt or invalid hidden deposit preferences without touching plans", () => {
    const storage = memoryStorage();
    saveVaultPlans(storage, [plan()]);
    storage.setItem(HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY, JSON.stringify({ invalid: [-1, 0x80000000] }));

    expect(loadHiddenDepositIndexes(storage)).toEqual({});
    expect(loadVaultPlans(storage).plans).toEqual([plan()]);
  });
});
