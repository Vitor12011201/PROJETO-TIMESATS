import { z } from "zod";
import { assertAllowedNetwork, VAULT_POLICY_V1, VAULT_POLICY_V2 } from "@/domain/vault-policy";
import {
  DEPOSIT_PATH_TEMPLATE,
  LEGACY_VAULT_PLAN_VERSION,
  MAX_NON_HARDENED_INDEX,
  VAULT_PLAN_FORMAT,
  VAULT_PLAN_VERSION,
  InteroperableVaultPlanSchema,
  LegacyVaultPlanSchema,
  VaultPlanMetadataSchema,
  VaultPlanSchema,
  type CreateVaultPlanInput,
  type VaultKeyOrigin,
  type VaultPlan,
} from "@/domain/vault-plan";
import { deriveNonHardenedPublicKeyHex, parseTestExtendedPublicKey } from "./bip32";
import { deriveVault, type DerivedVault } from "./vault";

export interface DerivedDeposit extends DerivedVault {
  index: number;
  derivationPath: string;
  absoluteDerivationPath?: string;
  keyOrigin?: VaultKeyOrigin;
  publicKey: string;
  descriptor: string;
}

const RecoverySchema = z.object({ lastIssuedIndex: z.number().int().min(0).max(MAX_NON_HARDENED_INDEX) }).strict();
export const VaultPlanRecoveryBundleSchema = z.discriminatedUnion("version", [
  z.object({ format: z.literal(VAULT_PLAN_FORMAT), version: z.literal(LEGACY_VAULT_PLAN_VERSION), policy: LegacyVaultPlanSchema.shape.policy, recovery: RecoverySchema, metadata: VaultPlanMetadataSchema }).strict(),
  z.object({ format: z.literal(VAULT_PLAN_FORMAT), version: z.literal(VAULT_PLAN_VERSION), policy: InteroperableVaultPlanSchema.shape.policy, recovery: RecoverySchema, metadata: VaultPlanMetadataSchema }).strict(),
]);
export type VaultPlanRecoveryBundle = z.infer<typeof VaultPlanRecoveryBundleSchema>;

function assertPlanNetworkBeforeSchema(input: unknown): void {
  if (typeof input !== "object" || input === null || !("policy" in input)) return;
  const policy = input.policy;
  if (typeof policy !== "object" || policy === null || !("network" in policy)) return;
  if (typeof policy.network === "string") assertAllowedNetwork(policy.network);
}

function normalizeOrigin(origin: VaultKeyOrigin): VaultKeyOrigin {
  return { masterFingerprint: origin.masterFingerprint.toLowerCase(), sourcePath: origin.sourcePath.replace(/(\d+)[hH]/g, "$1'") };
}

function sourcePathChildNumbers(sourcePath: string): number[] {
  if (sourcePath === "m") return [];
  return sourcePath.slice(2).split("/").map((component) => {
    const hardened = component.endsWith("'");
    const index = Number(component.slice(0, hardened ? -1 : undefined));
    if (!Number.isSafeInteger(index) || index < 0 || index > MAX_NON_HARDENED_INDEX) {
      throw new Error("Public key origin path contains an invalid BIP32 child number.");
    }
    return hardened ? index + 0x80000000 : index;
  });
}

function fingerprintHex(fingerprint: number): string {
  return fingerprint.toString(16).padStart(8, "0");
}

function assertV2OriginMatchesExtendedPublicKey(extendedPublicKey: string, origin: VaultKeyOrigin): void {
  const key = parseTestExtendedPublicKey(extendedPublicKey);
  const childNumbers = sourcePathChildNumbers(origin.sourcePath);
  if (key.depth !== childNumbers.length) {
    throw new Error("Public key origin path depth does not match the supplied tpub.");
  }
  if (key.depth > 0 && key.index !== childNumbers[childNumbers.length - 1]) {
    throw new Error("Public key origin path child number does not match the supplied tpub.");
  }
  // A descendant tpub cannot prove its parent or master fingerprint without ancestor public keys.
  if (key.depth === 0 && origin.masterFingerprint !== fingerprintHex(key.fingerprint)) {
    throw new Error("Public key origin master fingerprint does not match the supplied root tpub.");
  }
}

function normalizePlan(plan: VaultPlan): VaultPlan {
  assertAllowedNetwork(plan.policy.network);
  const extendedPublicKey = parseTestExtendedPublicKey(plan.policy.keySource.extendedPublicKey).publicExtendedKey;
  if (plan.policy.policyVersion === VAULT_POLICY_V2) {
    const keyOrigin = normalizeOrigin(plan.policy.keySource.keyOrigin);
    assertV2OriginMatchesExtendedPublicKey(extendedPublicKey, keyOrigin);
    const keySource = { ...plan.policy.keySource, extendedPublicKey, keyOrigin };
    return { ...plan, metadata: { label: plan.metadata.label.trim() }, policy: { ...plan.policy, keySource } } as VaultPlan;
  }
  const keySource = { ...plan.policy.keySource, extendedPublicKey };
  return { ...plan, metadata: { label: plan.metadata.label.trim() }, policy: { ...plan.policy, keySource } } as VaultPlan;
}

export function parseVaultPlan(input: unknown): VaultPlan {
  assertPlanNetworkBeforeSchema(input);
  return normalizePlan(VaultPlanSchema.parse(input));
}

export function createVaultPlan(input: CreateVaultPlanInput): VaultPlan {
  assertAllowedNetwork(input.network);
  if (input.policyVersion === VAULT_POLICY_V2) {
    if (!input.keyOrigin) throw new Error("Policy V2 requires public master fingerprint and source origin path.");
    return parseVaultPlan({
      format: VAULT_PLAN_FORMAT,
      version: VAULT_PLAN_VERSION,
      metadata: { label: input.label },
      policy: { policyVersion: VAULT_POLICY_V2, network: input.network, unlockHeight: input.unlockHeight, keySource: { type: "bip32-testnet-xpub-with-origin", extendedPublicKey: input.extendedPublicKey, keyOrigin: input.keyOrigin }, derivation: { pathTemplate: DEPOSIT_PATH_TEMPLATE, hardened: false } },
      lastIssuedIndex: 0,
    });
  }
  return parseVaultPlan({
    format: VAULT_PLAN_FORMAT,
    version: LEGACY_VAULT_PLAN_VERSION,
    metadata: { label: input.label },
    policy: { policyVersion: VAULT_POLICY_V1, network: input.network, unlockHeight: input.unlockHeight, keySource: { type: "bip32-testnet-xpub", extendedPublicKey: input.extendedPublicKey }, derivation: { pathTemplate: DEPOSIT_PATH_TEMPLATE, hardened: false } },
    lastIssuedIndex: 0,
  });
}

function absolutePath(origin: VaultKeyOrigin, index: number): string {
  return origin.sourcePath === "m" ? `m/${index}` : `${origin.sourcePath}/${index}`;
}

export function deriveDeposit(planInput: VaultPlan, index: number): DerivedDeposit {
  const plan = parseVaultPlan(planInput);
  if (!Number.isInteger(index) || index < 0 || index > MAX_NON_HARDENED_INDEX) throw new Error("Deposit index must be a non-hardened BIP32 integer.");
  const publicKey = deriveNonHardenedPublicKeyHex(plan.policy.keySource.extendedPublicKey, index);
  const vault = deriveVault({ version: plan.policy.policyVersion, network: plan.policy.network, publicKey, unlockHeight: plan.policy.unlockHeight });
  const origin = plan.policy.policyVersion === VAULT_POLICY_V2 ? plan.policy.keySource.keyOrigin : undefined;
  return { ...vault, index, derivationPath: `m/${index}`, absoluteDerivationPath: origin ? absolutePath(origin, index) : undefined, keyOrigin: origin, publicKey, descriptor: `raw(${vault.outputScript})` };
}

export function deriveIssuedDeposits(planInput: VaultPlan): DerivedDeposit[] {
  const plan = parseVaultPlan(planInput);
  return Array.from({ length: plan.lastIssuedIndex + 1 }, (_, index) => deriveDeposit(plan, index));
}

export function issueNextDeposit(planInput: VaultPlan): { plan: VaultPlan; deposit: DerivedDeposit } {
  const plan = parseVaultPlan(planInput);
  if (plan.lastIssuedIndex >= MAX_NON_HARDENED_INDEX) throw new Error("No more non-hardened deposit indexes are available for this plan.");
  const nextPlan = { ...plan, lastIssuedIndex: plan.lastIssuedIndex + 1 } as VaultPlan;
  return { plan: nextPlan, deposit: deriveDeposit(nextPlan, nextPlan.lastIssuedIndex) };
}

export function createVaultPlanRecoveryBundle(planInput: VaultPlan): VaultPlanRecoveryBundle {
  const plan = parseVaultPlan(planInput);
  return { format: VAULT_PLAN_FORMAT, version: plan.version, policy: plan.policy, recovery: { lastIssuedIndex: plan.lastIssuedIndex }, metadata: plan.metadata } as VaultPlanRecoveryBundle;
}

export function reconstructVaultPlan(bundleInput: unknown): VaultPlan {
  assertPlanNetworkBeforeSchema(bundleInput);
  const bundle = VaultPlanRecoveryBundleSchema.parse(bundleInput);
  return parseVaultPlan({ format: bundle.format, version: bundle.version, policy: bundle.policy, metadata: bundle.metadata, lastIssuedIndex: bundle.recovery.lastIssuedIndex });
}

/** Stable public-only identity; labels intentionally do not affect it. */
export function vaultPlanIdentity(planInput: VaultPlan): string {
  const plan = parseVaultPlan(planInput);
  const origin = plan.policy.policyVersion === VAULT_POLICY_V2 ? `:${plan.policy.keySource.keyOrigin.masterFingerprint}:${plan.policy.keySource.keyOrigin.sourcePath}` : "";
  return [plan.policy.policyVersion, plan.policy.network, plan.policy.unlockHeight, plan.policy.keySource.extendedPublicKey, plan.policy.derivation.pathTemplate].join(":") + origin;
}
