import { z } from "zod";
import { parseVaultPlan, vaultPlanIdentity, type VaultPlan } from "@/bitcoin";
import { MAX_NON_HARDENED_INDEX, VaultPlanSchema } from "@/domain/vault-plan";

export const VAULT_PLAN_STORAGE_KEY = "timesats.vault-plans.v3";
export const ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY = "timesats.archived-plan-identities.v1";
export const HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY = "timesats.hidden-deposit-indexes.v1";
const LEGACY_VAULT_PLAN_STORAGE_KEY = "timesats.vault-plans.v2";

const StoredVaultPlansSchema = z
  .object({
    format: z.literal("timesats-local-vault-plans"),
    version: z.union([z.literal(2), z.literal(3)]),
    plans: z.array(VaultPlanSchema),
  })
  .strict();

export interface LoadedVaultPlans {
  plans: VaultPlan[];
  error: string | null;
}

const ArchivedPlanIdentitiesSchema = z.array(z.string().min(1));
const DepositIndexSchema = z.number().int().min(0).max(MAX_NON_HARDENED_INDEX);

export type HiddenDepositIndexes = Record<string, number[]>;

function normalizeHiddenDepositIndexes(value: unknown): HiddenDepositIndexes {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Hidden deposit preferences must be an object.");
  return Object.fromEntries(
    Object.entries(value).map(([identity, indexes]) => [
      z.string().min(1).parse(identity),
      [...new Set(z.array(DepositIndexSchema).parse(indexes))].sort((left, right) => left - right),
    ]).filter(([, indexes]) => indexes.length > 0),
  );
}

export function loadVaultPlans(storage: Pick<Storage, "getItem">): LoadedVaultPlans {
  const raw = storage.getItem(VAULT_PLAN_STORAGE_KEY) ?? storage.getItem(LEGACY_VAULT_PLAN_STORAGE_KEY);
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
    JSON.stringify({ format: "timesats-local-vault-plans", version: 3, plans: validated }),
  );
}

/** Archive state is a local UI preference, deliberately separate from the public VaultPlan. */
export function loadArchivedPlanIdentities(storage: Pick<Storage, "getItem">): string[] {
  const raw = storage.getItem(ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY);
  if (raw === null) return [];
  try {
    return [...new Set(ArchivedPlanIdentitiesSchema.parse(JSON.parse(raw)))];
  } catch {
    return [];
  }
}

export function saveArchivedPlanIdentities(storage: Pick<Storage, "setItem">, identities: string[]): void {
  storage.setItem(ARCHIVED_PLAN_IDENTITIES_STORAGE_KEY, JSON.stringify([...new Set(ArchivedPlanIdentitiesSchema.parse(identities))]));
}

export function archivePlanIdentity(identities: string[], identity: string): string[] {
  return [...new Set([...ArchivedPlanIdentitiesSchema.parse(identities), z.string().min(1).parse(identity)])];
}

export function restorePlanIdentity(identities: string[], identity: string): string[] {
  ArchivedPlanIdentitiesSchema.parse(identities);
  z.string().min(1).parse(identity);
  return identities.filter((candidate) => candidate !== identity);
}

/** Hidden deposits are a local visual preference, deliberately separate from a plan and its recovery. */
export function loadHiddenDepositIndexes(storage: Pick<Storage, "getItem">): HiddenDepositIndexes {
  const raw = storage.getItem(HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY);
  if (raw === null) return {};
  try {
    return normalizeHiddenDepositIndexes(JSON.parse(raw));
  } catch {
    return {};
  }
}

export function saveHiddenDepositIndexes(storage: Pick<Storage, "setItem">, hiddenDepositIndexes: HiddenDepositIndexes): void {
  storage.setItem(HIDDEN_DEPOSIT_INDEXES_STORAGE_KEY, JSON.stringify(normalizeHiddenDepositIndexes(hiddenDepositIndexes)));
}

export function hideDepositIndex(hiddenDepositIndexes: HiddenDepositIndexes, identity: string, index: number): HiddenDepositIndexes {
  const normalized = normalizeHiddenDepositIndexes(hiddenDepositIndexes);
  const planIdentity = z.string().min(1).parse(identity);
  const depositIndex = DepositIndexSchema.parse(index);
  return {
    ...normalized,
    [planIdentity]: [...new Set([...(normalized[planIdentity] ?? []), depositIndex])].sort((left, right) => left - right),
  };
}

export function restoreHiddenDepositIndex(hiddenDepositIndexes: HiddenDepositIndexes, identity: string, index: number): HiddenDepositIndexes {
  const normalized = normalizeHiddenDepositIndexes(hiddenDepositIndexes);
  const planIdentity = z.string().min(1).parse(identity);
  const depositIndex = DepositIndexSchema.parse(index);
  const remaining = (normalized[planIdentity] ?? []).filter((candidate) => candidate !== depositIndex);
  if (remaining.length === 0) {
    const rest = { ...normalized };
    delete rest[planIdentity];
    return rest;
  }
  return { ...normalized, [planIdentity]: remaining };
}

export function removeHiddenDepositIndexesForPlan(hiddenDepositIndexes: HiddenDepositIndexes, identity: string): HiddenDepositIndexes {
  const normalized = normalizeHiddenDepositIndexes(hiddenDepositIndexes);
  const planIdentity = z.string().min(1).parse(identity);
  const rest = { ...normalized };
  delete rest[planIdentity];
  return rest;
}

/** Replaces only the same public policy; metadata follows the incoming valid plan and issuance never regresses. */
export function upsertVaultPlan(plans: VaultPlan[], plan: VaultPlan): VaultPlan[] {
  const incoming = parseVaultPlan(plan);
  const identity = vaultPlanIdentity(incoming);
  const existingIndex = plans.findIndex((candidate) => vaultPlanIdentity(candidate) === identity);
  if (existingIndex < 0) return [...plans, incoming];
  const existing = parseVaultPlan(plans[existingIndex]);
  const reconciled = parseVaultPlan({ ...incoming, lastIssuedIndex: Math.max(existing.lastIssuedIndex, incoming.lastIssuedIndex) });
  return plans.map((candidate, index) => (index === existingIndex ? reconciled : candidate));
}
