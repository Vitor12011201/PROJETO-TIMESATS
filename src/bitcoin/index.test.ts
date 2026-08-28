import { describe, expect, it } from "vitest";
import { Transaction } from "bitcoinjs-lib";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import * as core from ".";

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

describe("TimeSats core public API", () => {
  it("builds an unsigned PSBT through the public plan, funding, and spending flow", () => {
    const plan = core.createVaultPlan({
      label: "Core public API",
      network: "regtest",
      unlockHeight: 250,
      extendedPublicKey: validTestTpub,
      policyVersion: 2,
      keyOrigin: validTestTpubOrigin,
    });
    const deposit = core.deriveDeposit(plan, 0);
    const funding = new Transaction();
    funding.addInput(new Uint8Array(32).fill(0x33), 0);
    funding.addOutput(hexToUint8Array(deposit.outputScript), 500_000n);

    const verified = core.verifyFundingTransaction(plan, 0, funding.toHex(), 0);
    const intent = core.createVaultSpendIntent(verified.utxo, "bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m", 500);
    const unsigned = core.buildUnsignedVaultPsbt(intent, verified.utxo);

    expect(verified.deposit).toEqual(deposit);
    expect(unsigned.intent).toEqual(intent);
    expect(unsigned.base64).toMatch(/^cHNidP8/);
  });

  it("exposes only the intended runtime core operations", () => {
    expect(Object.keys(core).sort()).toEqual([
      "allowedNetworks",
      "buildUnsignedVaultPsbt",
      "createVaultPlan",
      "createVaultPlanRecoveryBundle",
      "createVaultSpendIntent",
      "deriveDeposit",
      "deriveIssuedDeposits",
      "finalizeVaultPsbt",
      "issueNextDeposit",
      "parseVaultPlan",
      "reconstructVaultPlan",
      "validateSignedVaultPsbt",
      "vaultPlanIdentity",
      "verifyFundingTransaction",
    ]);
  });
});
