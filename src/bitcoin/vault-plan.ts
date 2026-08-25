import { z } from "zod";
import { assertAllowedNetwork, VAULT_POLICY_VERSION } from "@/domain/vault-policy";
import {
  DEPOSIT_PATH_TEMPLATE,
  MAX_NON_HARDENED_INDEX,
  VAULT_PLAN_FORMAT,
  VAULT_PLAN_VERSION,
  VaultPlanSchema,
  type CreateVaultPlanInput,
  type VaultPlan,
} from "@/domain/vault-plan";
import { deriveNonHardenedPublicKeyHex, parseTestExtendedPublicKey } from "./bip32";
import { deriveVault, type DerivedVault } from "./vault";

export interface DerivedDeposit extends DerivedVault {
  index: number;
  derivationPath: string;
  publicKey: string;
  descriptor: string;
}

export const VaultPlanRecoveryBundleSchema = z
  .object({
    format: z.literal(VAULT_PLAN_FORMAT),
    version: z.literal(VAULT_PLAN_VERSION),
    policy: VaultPlanSchema.shape.policy,
    recovery: z
      .object({
        lastIssuedIndex: VaultPlanSchema.shape.lastIssuedIndex,
      })
      .strict(),
    metadata: VaultPlanSchema.shape.metadata,
  })
  .strict();

export type VaultPlanRecoveryBundle = z.infer<typeof VaultPlanRecoveryBundleSchema>;

function assertPlanNetworkBeforeSchema(input: unknown): void {
  if (typeof input !== "object" || input === null || !("policy" in input)) return;
  const policy = input.policy;
  if (typeof policy !== "object" || policy === null || !("network" in policy)) return;
  if (typeof policy.network === "string") assertAllowedNetwork(policy.network);
}

function normalizePlan(plan: VaultPlan): VaultPlan {
  assertAllowedNetwork(plan.policy.network);
  const key = parseTestExtendedPublicKey(plan.policy.keySource.extendedPublicKey);
  const extendedPublicKey = key.publicExtendedKey;
  return {
    ...plan,
    metadata: { label: plan.metadata.label.trim() },
    policy: {
      ...plan.policy,
      keySource: { ...plan.policy.keySource, extendedPublicKey },
    },
  };
}

export function parseVaultPlan(input: unknown): VaultPlan {
  assertPlanNetworkBeforeSchema(input);
  return normalizePlan(VaultPlanSchema.parse(input));
}

export function createVaultPlan(input: CreateVaultPlanInput): VaultPlan {
  assertAllowedNetwork(input.network);
  return parseVaultPlan({
    format: VAULT_PLAN_FORMAT,
    version: VAULT_PLAN_VERSION,
    metadata: { label: input.label },
    policy: {
      policyVersion: VAULT_POLICY_VERSION,
      network: input.network,
      unlockHeight: input.unlockHeight,
      keySource: {
        type: "bip32-testnet-xpub",
        extendedPublicKey: input.extendedPublicKey,
      },
      derivation: { pathTemplate: DEPOSIT_PATH_TEMPLATE, hardened: false },
    },
    lastIssuedIndex: 0,
  });
}

export function deriveDeposit(planInput: VaultPlan, index: number): DerivedDeposit {
  const plan = parseVaultPlan(planInput);
  if (!Number.isInteger(index) || index < 0 || index > MAX_NON_HARDENED_INDEX) {
    throw new Error("Deposit index must be a non-hardened BIP32 integer.");
  }
  const publicKey = deriveNonHardenedPublicKeyHex(plan.policy.keySource.extendedPublicKey, index);
  const vault = deriveVault({
    version: plan.policy.policyVersion,
    network: plan.policy.network,
    publicKey,
    unlockHeight: plan.policy.unlockHeight,
  });
  return {
    ...vault,
    index,
    derivationPath: `m/${index}`,
    publicKey,
    // BIP 385 raw() is an exact, reconstructable descriptor for this output.
    descriptor: `raw(${vault.outputScript})`,
  };
}

export function deriveIssuedDeposits(planInput: VaultPlan): DerivedDeposit[] {
  const plan = parseVaultPlan(planInput);
  return Array.from({ length: plan.lastIssuedIndex + 1 }, (_, index) => deriveDeposit(plan, index));
}

export function issueNextDeposit(planInput: VaultPlan): { plan: VaultPlan; deposit: DerivedDeposit } {
  const plan = parseVaultPlan(planInput);
  if (plan.lastIssuedIndex >= MAX_NON_HARDENED_INDEX) {
    throw new Error("No more non-hardened deposit indexes are available for this plan.");
  }
  const index = plan.lastIssuedIndex + 1;
  const nextPlan = { ...plan, lastIssuedIndex: index };
  return { plan: nextPlan, deposit: deriveDeposit(nextPlan, index) };
}

export function createVaultPlanRecoveryBundle(planInput: VaultPlan): VaultPlanRecoveryBundle {
  const plan = parseVaultPlan(planInput);
  return {
    format: VAULT_PLAN_FORMAT,
    version: VAULT_PLAN_VERSION,
    policy: plan.policy,
    recovery: { lastIssuedIndex: plan.lastIssuedIndex },
    metadata: plan.metadata,
  };
}

export function reconstructVaultPlan(bundleInput: unknown): VaultPlan {
  assertPlanNetworkBeforeSchema(bundleInput);
  const bundle = VaultPlanRecoveryBundleSchema.parse(bundleInput);
  return parseVaultPlan({
    format: bundle.format,
    version: bundle.version,
    policy: bundle.policy,
    metadata: bundle.metadata,
    lastIssuedIndex: bundle.recovery.lastIssuedIndex,
  });
}

/** Stable public-only identity; labels intentionally do not affect it. */
export function vaultPlanIdentity(planInput: VaultPlan): string {
  const plan = parseVaultPlan(planInput);
  return [
    plan.policy.network,
    plan.policy.unlockHeight,
    plan.policy.keySource.extendedPublicKey,
    plan.policy.derivation.pathTemplate,
  ].join(":");
}
