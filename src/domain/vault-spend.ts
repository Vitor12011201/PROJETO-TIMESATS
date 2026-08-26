import { z } from "zod";
import { LOCKTIME_THRESHOLD, allowedNetworks } from "./vault-policy";

export const CLTV_SEQUENCE = 0xfffffffe;
export const PSBT_SIGHASH_ALL = 0x01;

const SatoshiSchema = z
  .number()
  .int("Satoshi values must be integers.")
  .safe("Satoshi values must remain JavaScript safe integers.")
  .positive("Satoshi values must be positive.");

export const VaultUtxoSchema = z
  .object({
    network: z.enum(allowedNetworks),
    planIdentity: z.string().min(1),
    depositIndex: z.number().int().min(0).max(0x7fffffff),
    txid: z.string().regex(/^[0-9a-f]{64}$/i, "Funding transaction id must be hexadecimal."),
    vout: z.number().int().min(0).max(0xffffffff),
    valueSats: SatoshiSchema,
    outputScript: z.string().regex(/^[0-9a-f]*$/i),
    witnessScript: z.string().regex(/^[0-9a-f]*$/i),
    publicKey: z.string().regex(/^(02|03)[0-9a-f]{64}$/i),
    unlockHeight: z.number().int().min(1).max(LOCKTIME_THRESHOLD - 1),
  })
  .strict();

export type VaultUtxo = z.infer<typeof VaultUtxoSchema>;

export const VaultSpendIntentSchema = z
  .object({
    version: z.literal(1),
    network: z.enum(allowedNetworks),
    planIdentity: z.string().min(1),
    depositIndex: z.number().int().min(0).max(0x7fffffff),
    fundingTxid: z.string().regex(/^[0-9a-f]{64}$/i),
    fundingVout: z.number().int().min(0).max(0xffffffff),
    inputValueSats: SatoshiSchema,
    destinationAddress: z.string().trim().min(1),
    destinationValueSats: SatoshiSchema,
    feeSats: SatoshiSchema,
    unlockHeight: z.number().int().min(1).max(LOCKTIME_THRESHOLD - 1),
    sequence: z.literal(CLTV_SEQUENCE),
    sighashType: z.literal(PSBT_SIGHASH_ALL),
  })
  .strict();

export type VaultSpendIntent = z.infer<typeof VaultSpendIntentSchema>;
