export {
  createVaultPlan,
  parseVaultPlan,
  deriveDeposit,
  deriveIssuedDeposits,
  issueNextDeposit,
  createVaultPlanRecoveryBundle,
  reconstructVaultPlan,
  vaultPlanIdentity,
} from "./vault-plan";

export {
  verifyFundingTransaction,
  createVaultSpendIntent,
  buildUnsignedVaultPsbt,
  validateSignedVaultPsbt,
  finalizeVaultPsbt,
} from "./vault-spend";

export { allowedNetworks } from "@/domain/vault-policy";

export type {
  CreateVaultPlanInput,
  VaultKeyOrigin,
  VaultPlan,
} from "@/domain/vault-plan";

export type { AllowedNetwork } from "@/domain/vault-policy";
export type { VaultSpendIntent, VaultUtxo } from "@/domain/vault-spend";
export type { DerivedDeposit, VaultPlanRecoveryBundle } from "./vault-plan";
export type { FinalizedVaultSpend, UnsignedVaultPsbt, VerifiedFunding } from "./vault-spend";
