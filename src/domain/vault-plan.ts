import { z } from "zod";
import { LOCKTIME_THRESHOLD, VAULT_POLICY_V1, VAULT_POLICY_V2, allowedNetworks, type AllowedNetwork } from "./vault-policy";

export const LEGACY_VAULT_PLAN_VERSION = 2 as const;
export const VAULT_PLAN_VERSION = 3 as const;
export const VAULT_PLAN_FORMAT = "timesats-vault-plan" as const;
export const DEPOSIT_PATH_TEMPLATE = "m/<index>" as const;
export const MAX_NON_HARDENED_INDEX = 0x7fffffff;

const UnlockHeightSchema = z.number().int("Unlock block must be an integer.").min(1, "Unlock block must be at least 1.").max(LOCKTIME_THRESHOLD - 1, "Unlock block must be below 500,000,000 (block-height locktime).");
const DerivationSchema = z.object({ pathTemplate: z.literal(DEPOSIT_PATH_TEMPLATE), hardened: z.literal(false) }).strict();
const LastIssuedIndexSchema = z.number().int("Last issued index must be an integer.").min(0, "A plan must issue Deposit #0 when it is created.").max(MAX_NON_HARDENED_INDEX, "Deposit index exceeds the BIP32 non-hardened range.");

export const PublicKeySourceSchema = z.object({ type: z.literal("bip32-testnet-xpub"), extendedPublicKey: z.string().min(1, "An extended public key is required.") }).strict();
export const KeyOriginSchema = z.object({
  masterFingerprint: z.string().regex(/^[0-9a-fA-F]{8}$/, "Master fingerprint must be 4-byte hexadecimal."),
  sourcePath: z.string().regex(/^m(?:\/(?:0|[1-9]\d*)(?:['hH])?)*$/, "Source origin path must be an absolute BIP32 path."),
}).strict();
export const InteroperablePublicKeySourceSchema = z.object({
  type: z.literal("bip32-testnet-xpub-with-origin"),
  extendedPublicKey: z.string().min(1, "An extended public key is required."),
  keyOrigin: KeyOriginSchema,
}).strict();

const LegacyVaultPlanPolicySchema = z.object({ policyVersion: z.literal(VAULT_POLICY_V1), network: z.enum(allowedNetworks), unlockHeight: UnlockHeightSchema, keySource: PublicKeySourceSchema, derivation: DerivationSchema }).strict();
const InteroperableVaultPlanPolicySchema = z.object({ policyVersion: z.literal(VAULT_POLICY_V2), network: z.enum(allowedNetworks), unlockHeight: UnlockHeightSchema, keySource: InteroperablePublicKeySourceSchema, derivation: DerivationSchema }).strict();
export const VaultPlanPolicySchema = z.discriminatedUnion("policyVersion", [LegacyVaultPlanPolicySchema, InteroperableVaultPlanPolicySchema]);

export const VaultPlanMetadataSchema = z.object({ label: z.string().trim().min(1, "Plan name is required.").max(80, "Plan name must be 80 characters or fewer.") }).strict();
export const LegacyVaultPlanSchema = z.object({ format: z.literal(VAULT_PLAN_FORMAT), version: z.literal(LEGACY_VAULT_PLAN_VERSION), policy: LegacyVaultPlanPolicySchema, metadata: VaultPlanMetadataSchema, lastIssuedIndex: LastIssuedIndexSchema }).strict();
export const InteroperableVaultPlanSchema = z.object({ format: z.literal(VAULT_PLAN_FORMAT), version: z.literal(VAULT_PLAN_VERSION), policy: InteroperableVaultPlanPolicySchema, metadata: VaultPlanMetadataSchema, lastIssuedIndex: LastIssuedIndexSchema }).strict();
export const VaultPlanSchema = z.discriminatedUnion("version", [LegacyVaultPlanSchema, InteroperableVaultPlanSchema]);

export type PublicKeySource = z.infer<typeof PublicKeySourceSchema>;
export type InteroperablePublicKeySource = z.infer<typeof InteroperablePublicKeySourceSchema>;
export type VaultKeyOrigin = z.infer<typeof KeyOriginSchema>;
export type VaultPlanPolicy = z.infer<typeof VaultPlanPolicySchema>;
export type VaultPlanMetadata = z.infer<typeof VaultPlanMetadataSchema>;
export type VaultPlan = z.infer<typeof VaultPlanSchema>;

export interface CreateVaultPlanInput {
  label: string;
  network: AllowedNetwork;
  unlockHeight: number;
  extendedPublicKey: string;
  policyVersion?: 1 | 2;
  keyOrigin?: VaultKeyOrigin;
}
