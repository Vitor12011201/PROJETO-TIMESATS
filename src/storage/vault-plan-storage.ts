import { z } from "zod";
import { VaultPlanSchema, type VaultPlan } from "@/domain/vault-plan";
import { parseVaultPlan, vaultPlanIdentity } from "@/bitcoin/vault-plan";

export const VAULT_PLAN_STORAGE_KEY = "timesats.vault-plans.v2";

const StoredVaultPlansSchema = z
  .object({
    format: z.literal("timesats-local-vault-plans"),
    version: z.literal(2),
    plans: z.array(VaultPlanSchema),
  })
  .strict();

export interface LoadedVaultPlans {
  plans: VaultPlan[];
  error: string | null;
}

export function loadVaultPlans(storage: Pick<Storage, "getItem">): LoadedVaultPlans {
  const raw = storage.getItem(VAULT_PLAN_STORAGE_KEY);
  if (raw === null) return { plans: [], error: null };
  try {
    const stored = StoredVaultPlansSchema.parse(JSON.parse(raw));
    return { plans: stored.plans.map(parseVaultPlan), error: null };
  } catch {
    return {
      plans: [],
      error: "Stored plan data is invalid or corrupted. It was not used; import a verified recovery bundle instead.",
    };
  }
}

export function saveVaultPlans(storage: Pick<Storage, "setItem">, plans: VaultPlan[]): void {
  const validated = plans.map(parseVaultPlan);
  storage.setItem(
    VAULT_PLAN_STORAGE_KEY,
    JSON.stringify({ format: "timesats-local-vault-plans", version: 2, plans: validated }),
  );
}

/** Replaces only the same public policy; user-facing metadata may change safely. */
export function upsertVaultPlan(plans: VaultPlan[], plan: VaultPlan): VaultPlan[] {
  const identity = vaultPlanIdentity(plan);
  const existingIndex = plans.findIndex((candidate) => vaultPlanIdentity(candidate) === identity);
  if (existingIndex < 0) return [...plans, parseVaultPlan(plan)];
  return plans.map((candidate, index) => (index === existingIndex ? parseVaultPlan(plan) : candidate));
}
