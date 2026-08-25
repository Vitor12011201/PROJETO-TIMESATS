import { z } from "zod";
import {
  LOCKTIME_THRESHOLD,
  VAULT_POLICY_VERSION,
  allowedNetworks,
  type AllowedNetwork,
} from "./vault-policy";

export const VAULT_PLAN_VERSION = 2 as const;
export const VAULT_PLAN_FORMAT = "timesats-vault-plan" as const;
export const DEPOSIT_PATH_TEMPLATE = "m/<index>" as const;
export const MAX_NON_HARDENED_INDEX = 0x7fffffff;

export const PublicKeySourceSchema = z
  .object({
    type: z.literal("bip32-testnet-xpub"),
    extendedPublicKey: z.string().min(1, "An extended public key is required."),
  })
  .strict();

export const VaultPlanPolicySchema = z
  .object({
    policyVersion: z.literal(VAULT_POLICY_VERSION),
    network: z.enum(allowedNetworks),
    unlockHeight: z
      .number()
      .int("Unlock block must be an integer.")
      .min(1, "Unlock block must be at least 1.")
      .max(
        LOCKTIME_THRESHOLD - 1,
        "Unlock block must be below 500,000,000 (block-height locktime).",
      ),
    keySource: PublicKeySourceSchema,
    derivation: z
      .object({
        pathTemplate: z.literal(DEPOSIT_PATH_TEMPLATE),
        hardened: z.literal(false),
      })
      .strict(),
  })
  .strict();

export const VaultPlanMetadataSchema = z
  .object({
    label: z
      .string()
      .trim()
      .min(1, "Plan name is required.")
      .max(80, "Plan name must be 80 characters or fewer."),
  })
  .strict();

export const VaultPlanSchema = z
  .object({
    format: z.literal(VAULT_PLAN_FORMAT),
    version: z.literal(VAULT_PLAN_VERSION),
    policy: VaultPlanPolicySchema,
    metadata: VaultPlanMetadataSchema,
    lastIssuedIndex: z
      .number()
      .int("Last issued index must be an integer.")
      .min(0, "A plan must issue Deposit #0 when it is created.")
      .max(MAX_NON_HARDENED_INDEX, "Deposit index exceeds the BIP32 non-hardened range."),
  })
  .strict();

export type PublicKeySource = z.infer<typeof PublicKeySourceSchema>;
export type VaultPlanPolicy = z.infer<typeof VaultPlanPolicySchema>;
export type VaultPlanMetadata = z.infer<typeof VaultPlanMetadataSchema>;
export type VaultPlan = z.infer<typeof VaultPlanSchema>;

export interface CreateVaultPlanInput {
  label: string;
  network: AllowedNetwork;
  unlockHeight: number;
  extendedPublicKey: string;
}
