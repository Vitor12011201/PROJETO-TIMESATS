import { describe, expect, it } from "vitest";
import { Transaction } from "bitcoinjs-lib";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import * as core from ".";
import type {
  ChainObserver,
  ExternalSigner,
  TransactionBroadcaster,
} from ".";

function hexToUint8Array(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function fundingContext() {
  const plan = core.createVaultPlan({
    label: "External boundary test",
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
  const verified = core.verifyFundingTransaction(plan, deposit.index, funding.toHex(), 0);
  const intent = core.createVaultSpendIntent(verified.utxo, "bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m", 500);
  return { plan, deposit, funding, verified, intent };
}

describe("external adapter contracts", () => {
  it("treats an external signer response as untrusted until core validation", async () => {
    const { intent, verified } = fundingContext();
    const unsigned = core.buildUnsignedVaultPsbt(intent, verified.utxo);
    const signer: ExternalSigner = {
      async signPsbt(request) {
        expect(request).toEqual({ network: "regtest", unsignedPsbtBase64: unsigned.base64 });
        return { signedPsbtBase64: request.unsignedPsbtBase64 };
      },
    };

    const response = await signer.signPsbt({ network: "regtest", unsignedPsbtBase64: unsigned.base64 });

    expect(() => core.validateSignedVaultPsbt(intent, verified.utxo, response.signedPsbtBase64)).toThrow(/exactly one signature/i);
  });

  it("feeds observer candidates back into deterministic funding verification", async () => {
    const { plan, deposit, funding } = fundingContext();
    const observer: ChainObserver = {
      async findFundingCandidates(request) {
        expect(request).toEqual({
          network: "regtest",
          deposits: [{ depositIndex: deposit.index, outputScript: deposit.outputScript }],
        });
        return [{ depositIndex: deposit.index, rawFundingTransaction: funding.toHex(), vout: 0 }];
      },
    };

    const [candidate] = await observer.findFundingCandidates({
      network: plan.policy.network,
      deposits: [{ depositIndex: deposit.index, outputScript: deposit.outputScript }],
    });
    const verified = core.verifyFundingTransaction(
      plan,
      candidate.depositIndex,
      candidate.rawFundingTransaction,
      candidate.vout,
    );

    expect(verified.deposit).toEqual(deposit);
  });

  it("passes a raw transaction unchanged to the broadcaster boundary", async () => {
    const rawTransaction = "02000000000000000000";
    const broadcaster: TransactionBroadcaster = {
      async broadcast(request) {
        expect(request.network).toBe("regtest");
        expect(request.rawTransaction).toBe(rawTransaction);
        return { txid: "a".repeat(64) };
      },
    };

    const receipt = await broadcaster.broadcast({ network: "regtest", rawTransaction });

    expect(receipt.txid).toBe("a".repeat(64));
  });
});
