import { z } from "zod";

export const VAULT_POLICY_VERSION = 1 as const;
export const LOCKTIME_THRESHOLD = 500_000_000;

export const allowedNetworks = ["signet", "regtest"] as const;
export type AllowedNetwork = (typeof allowedNetworks)[number];

export const VaultPolicySchema = z
  .object({
    version: z.literal(VAULT_POLICY_VERSION),
    network: z.enum(allowedNetworks),
    publicKey: z.string(),
    unlockHeight: z
      .number()
      .int("Unlock block must be an integer.")
      .min(1, "Unlock block must be at least 1.")
      .max(
        LOCKTIME_THRESHOLD - 1,
        "Unlock block must be below 500,000,000 (block-height locktime).",
      ),
  })
  .strict();

export type VaultPolicy = z.infer<typeof VaultPolicySchema>;

/**
 * Mainnet is deliberately absent from the type and schema. This defensive
 * runtime guard is kept at every network boundary so accidental configuration
 * changes fail closed.
 */
export function assertAllowedNetwork(network: string): asserts network is AllowedNetwork {
  if (network === "mainnet") {
    throw new Error("Mainnet is prohibited by TimeSats.");
  }
  if (!allowedNetworks.includes(network as AllowedNetwork)) {
    throw new Error(`Unsupported network: ${network}. Only signet and regtest are allowed.`);
  }
}
