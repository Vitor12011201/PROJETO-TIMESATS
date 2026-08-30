import { z } from "zod";
import {
  DEPOSIT_PATH_TEMPLATE,
  MAX_NON_HARDENED_INDEX,
  VaultPlanMetadataSchema,
} from "./vault-plan";
import {
  LOCKTIME_THRESHOLD,
  VAULT_POLICY_V2,
  allowedNetworks,
} from "./vault-policy";

/**
 * Isolated durable-state contract for a future xpubless Policy V2 plan.
 * It is not a VaultPlan, recovery bundle, storage envelope, or Bitcoin identity.
 */
export const XPUBLESS_V2_PLAN_STATE_FORMAT = "timesats-xpubless-v2-plan-state" as const;
export const XPUBLESS_V2_PLAN_STATE_VERSION = 1 as const;

export const HISTORICAL_IDENTITY_COMMITMENT_SCHEME = "timesats-historical-identity" as const;
export const HISTORICAL_IDENTITY_COMMITMENT_VERSION = 1 as const;
export const HISTORICAL_IDENTITY_COMMITMENT_ALGORITHM = "sha256" as const;
export const XPUBLESS_V2_KEY_SOURCE_TYPE = "bip32-testnet-xpub-with-origin" as const;

const CanonicalFingerprintSchema = z.string().regex(/^[0-9a-f]{8}$/, "Master fingerprint must be exactly eight lowercase hexadecimal characters.");
const CanonicalSourcePathSchema = z.string()
  .regex(/^m(?:\/(?:0|[1-9]\d*)(?:')?)*$/, "Source path must be an absolute BIP32 path with canonical apostrophe hardening markers.")
  .superRefine((path, context) => {
    if (path === "m") return;
    path.slice(2).split("/").forEach((component, position) => {
      const numberText = component.endsWith("'") ? component.slice(0, -1) : component;
      const index = Number(numberText);
      if (!Number.isSafeInteger(index) || index > MAX_NON_HARDENED_INDEX) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Source path child number exceeds the BIP32 non-hardened range.",
          path: [position],
        });
      }
    });
  });
const UnlockHeightSchema = z.number().int("Unlock block must be an integer.").min(1, "Unlock block must be at least 1.").max(LOCKTIME_THRESHOLD - 1, "Unlock block must be below the block-height locktime threshold.");
const IssuedIndexSchema = z.number().int("Issued output index must be an integer.").min(0, "Issued output index must be non-negative.").max(MAX_NON_HARDENED_INDEX, "Issued output index exceeds the BIP32 non-hardened range.");
const CanonicalLocalInstanceIdSchema = z.string()
  .uuid("Local instance ID must be a UUID.")
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "Local instance ID must use lowercase canonical UUID text.");

export const XpublessV2KeyOriginSchema = z.object({
  masterFingerprint: CanonicalFingerprintSchema,
  sourcePath: CanonicalSourcePathSchema,
}).strict();

export const XpublessV2DerivationSchema = z.object({
  pathTemplate: z.literal(DEPOSIT_PATH_TEMPLATE),
  hardened: z.literal(false),
}).strict();

export const HistoricalIdentityCommitmentV1Schema = z.object({
  scheme: z.literal(HISTORICAL_IDENTITY_COMMITMENT_SCHEME),
  version: z.literal(HISTORICAL_IDENTITY_COMMITMENT_VERSION),
  algorithm: z.literal(HISTORICAL_IDENTITY_COMMITMENT_ALGORITHM),
  digest: z.string().regex(/^[0-9a-f]{64}$/, "Historical identity commitment digest must be lowercase SHA256 hexadecimal."),
}).strict();

export const XpublessV2IssuedOutputSchema = z.object({
  index: IssuedIndexSchema,
  outputScript: z.string().regex(/^0020[0-9a-f]{64}$/, "Issued output must be a lowercase P2WSH v0 outputScript."),
}).strict();

/**
 * Public material used only to serialize HIC v1. It contains a tpub and is
 * deliberately not part of XpublessV2PlanState durable data.
 *
 * This domain schema validates a canonical testnet extended-public-key shape,
 * not BIP32 checksum or derivation semantics. P2 must provide material already
 * validated and normalized by the existing VaultPlan/BIP32 boundary.
 */
export const HistoricalIdentityMaterialV1Schema = z.object({
  policyVersion: z.literal(VAULT_POLICY_V2),
  network: z.enum(allowedNetworks),
  unlockHeight: UnlockHeightSchema,
  keySource: z.object({
    type: z.literal(XPUBLESS_V2_KEY_SOURCE_TYPE),
    extendedPublicKey: z.string().regex(/^tpub[1-9A-HJ-NP-Za-km-z]{107}$/, "Historical identity material requires a canonical testnet extended public key."),
  }).strict(),
  keyOrigin: XpublessV2KeyOriginSchema,
  derivation: XpublessV2DerivationSchema,
}).strict();

/**
 * HIC v1 is binding plus conditional integrity only. It is not authentication,
 * a trust anchor, tamper-proof state, a secret, or a post-quantum claim.
 */
export function serializeHistoricalIdentityPreimageV1(materialInput: HistoricalIdentityMaterialV1): string {
  const material = HistoricalIdentityMaterialV1Schema.parse(materialInput);
  return JSON.stringify([
    HISTORICAL_IDENTITY_COMMITMENT_SCHEME,
    HISTORICAL_IDENTITY_COMMITMENT_VERSION,
    material.policyVersion,
    material.network,
    material.unlockHeight,
    material.keySource.type,
    material.keySource.extendedPublicKey,
    material.keyOrigin.masterFingerprint,
    material.keyOrigin.sourcePath,
    material.derivation.pathTemplate,
    material.derivation.hardened,
  ]);
}

/**
 * One durable xpubless Policy V2 plan state. It intentionally excludes tpub,
 * canonical vaultPlanIdentity, child public keys, witness scripts, descriptors,
 * funding data, and all private material.
 */
export const XpublessV2PlanStateSchema = z.object({
  format: z.literal(XPUBLESS_V2_PLAN_STATE_FORMAT),
  version: z.literal(XPUBLESS_V2_PLAN_STATE_VERSION),
  localInstanceId: CanonicalLocalInstanceIdSchema,
  policyVersion: z.literal(VAULT_POLICY_V2),
  network: z.enum(allowedNetworks),
  unlockHeight: UnlockHeightSchema,
  derivation: XpublessV2DerivationSchema,
  keyOrigin: XpublessV2KeyOriginSchema,
  metadata: VaultPlanMetadataSchema,
  historicalIdentityCommitment: HistoricalIdentityCommitmentV1Schema,
  lastIssuedIndex: IssuedIndexSchema,
  issuedOutputs: z.array(XpublessV2IssuedOutputSchema).min(1, "At least Deposit #0 must be present."),
}).strict().superRefine((state, context) => {
  if (state.issuedOutputs.length !== state.lastIssuedIndex + 1) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["issuedOutputs"],
      message: "Issued outputs must cover exactly #0 through lastIssuedIndex.",
    });
  }
  state.issuedOutputs.forEach((output, position) => {
    if (output.index !== position) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["issuedOutputs", position, "index"],
        message: "Issued output indexes must be contiguous and ordered from #0.",
      });
    }
  });
});

export type HistoricalIdentityMaterialV1 = z.infer<typeof HistoricalIdentityMaterialV1Schema>;
export type HistoricalIdentityCommitmentV1 = z.infer<typeof HistoricalIdentityCommitmentV1Schema>;
export type XpublessV2PlanState = z.infer<typeof XpublessV2PlanStateSchema>;
