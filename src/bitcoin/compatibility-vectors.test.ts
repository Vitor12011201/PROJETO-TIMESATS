import { describe, expect, it } from "vitest";
import { payments, Psbt, Transaction } from "bitcoinjs-lib";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import { bytesToHex, hexToBytes } from "./encoding";
import { bitcoinNetworkFor } from "./networks";
import {
  createVaultPlan,
  createVaultPlanRecoveryBundle,
  deriveDeposit,
  issueNextDeposit,
  reconstructVaultPlan,
  vaultPlanIdentity,
} from "./vault-plan";
import {
  buildUnsignedVaultPsbt,
  createVaultSpendIntent,
  verifyFundingTransaction,
} from "./vault-spend";
import { deriveVault } from "./vault";
import { parseTestExtendedPublicKey } from "./bip32";

const goldenTpub = "tpubDDjsCRDQ9YzyaAq9rspCfq8RZFrWoBpYnLxK6sS2hS2yukqSczgcYiur8Scx4Hd5AZatxTuzMtJQJhchufv1FRFanLqUP7JHwusSSpfcEp2";
const goldenTpubOrigin = { masterFingerprint: "6f53d49c", sourcePath: "m/44'/1'/0'" } as const;
const generatorPublicKey = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const destinationPublicKey = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5";
const destinationOutputScript = "001406afd46bcdfd22ef94ac122aa11f241244a37ecc";

const v1 = {
  plan: {
    format: "timesats-vault-plan",
    version: 2,
    policy: {
      policyVersion: 1,
      network: "signet",
      unlockHeight: 840_000,
      keySource: { type: "bip32-testnet-xpub", extendedPublicKey: goldenTpub },
      derivation: { pathTemplate: "m/<index>", hardened: false },
    },
    metadata: { label: "Golden V1" },
    lastIssuedIndex: 2,
  },
  identity: `1:signet:840000:${goldenTpub}:m/<index>`,
  deposit: {
    policy: {
      version: 1,
      network: "signet",
      publicKey: "034f0ad066d19de8d83354aa0270a3a12a6490559f151f524aba094e84bfce3969",
      unlockHeight: 840_000,
    },
    witnessScript: "0340d10cb17521034f0ad066d19de8d83354aa0270a3a12a6490559f151f524aba094e84bfce3969ac",
    address: "tb1q8dn6hutj5r78esarghcwqx8ekx4qf2asz4axq29ee8zfcx6dkqsqrrzxnn",
    outputScript: "00203b67abf172a0fc7cc3a345f0e018f9b1aa04abb0157a6028b9c9c49c1b4db020",
    index: 2,
    derivationPath: "m/2",
    publicKey: "034f0ad066d19de8d83354aa0270a3a12a6490559f151f524aba094e84bfce3969",
    descriptor: "raw(00203b67abf172a0fc7cc3a345f0e018f9b1aa04abb0157a6028b9c9c49c1b4db020)",
  },
  recovery: {
    format: "timesats-vault-plan",
    version: 2,
    policy: {
      policyVersion: 1,
      network: "signet",
      unlockHeight: 840_000,
      keySource: { type: "bip32-testnet-xpub", extendedPublicKey: goldenTpub },
      derivation: { pathTemplate: "m/<index>", hardened: false },
    },
    recovery: { lastIssuedIndex: 2 },
    metadata: { label: "Golden V1" },
  },
  destination: "tb1qq6hag67dl53wl99vzg42z8eyzfz2xlkvvlryfj",
  rawFundingTransaction: "010000000111111111111111111111111111111111111111111111111111111111111111110200000000ffffffff0120a10700000000002200203b67abf172a0fc7cc3a345f0e018f9b1aa04abb0157a6028b9c9c49c1b4db02000000000",
  utxo: {
    network: "signet",
    planIdentity: `1:signet:840000:${goldenTpub}:m/<index>`,
    depositIndex: 2,
    txid: "7116b43cdf3f969fe168deba422d857fbc428687d9743288c7a9e9ead1b52665",
    vout: 0,
    valueSats: 500_000,
    outputScript: "00203b67abf172a0fc7cc3a345f0e018f9b1aa04abb0157a6028b9c9c49c1b4db020",
    witnessScript: "0340d10cb17521034f0ad066d19de8d83354aa0270a3a12a6490559f151f524aba094e84bfce3969ac",
    publicKey: "034f0ad066d19de8d83354aa0270a3a12a6490559f151f524aba094e84bfce3969",
    unlockHeight: 840_000,
  },
  intent: {
    version: 1,
    network: "signet",
    planIdentity: `1:signet:840000:${goldenTpub}:m/<index>`,
    depositIndex: 2,
    fundingTxid: "7116b43cdf3f969fe168deba422d857fbc428687d9743288c7a9e9ead1b52665",
    fundingVout: 0,
    inputValueSats: 500_000,
    destinationAddress: "tb1qq6hag67dl53wl99vzg42z8eyzfz2xlkvvlryfj",
    destinationValueSats: 499_500,
    feeSats: 500,
    unlockHeight: 840_000,
    sequence: 0xfffffffe,
    sighashType: Transaction.SIGHASH_ALL,
  },
  psbt: "cHNidP8BAFICAAAAAWUmtdHq6anHiDJ02YeGQrx/hS1Cut5o4Z+WP988tBZxAAAAAAD+////ASyfBwAAAAAAFgAUBq/Ua839Iu+UrBIqoR8kEkSjfsxA0QwAAAEBKyChBwAAAAAAIgAgO2er8XKg/HzDo0Xw4Bj5saoEq7AVemAoucnEnBtNsCABAwQBAAAAAQUpA0DRDLF1IQNPCtBm0Z3o2DNUqgJwo6EqZJBVnxUfUkq6CU6Ev845aawAAA==",
} as const;

const v2 = {
  plan: {
    format: "timesats-vault-plan",
    version: 3,
    policy: {
      policyVersion: 2,
      network: "regtest",
      unlockHeight: 250,
      keySource: {
        type: "bip32-testnet-xpub-with-origin",
        extendedPublicKey: goldenTpub,
        keyOrigin: goldenTpubOrigin,
      },
      derivation: { pathTemplate: "m/<index>", hardened: false },
    },
    metadata: { label: "Golden V2" },
    lastIssuedIndex: 0,
  },
  identity: `2:regtest:250:${goldenTpub}:m/<index>:6f53d49c:m/44'/1'/0'`,
  deposit: {
    policy: {
      version: 2,
      network: "regtest",
      publicKey: "03121045f0f7781d0b14f919f2476c8a94c5b21c17a7c325116b72ac7e99d5b9c0",
      unlockHeight: 250,
    },
    witnessScript: "02fa00b1692103121045f0f7781d0b14f919f2476c8a94c5b21c17a7c325116b72ac7e99d5b9c0ac",
    address: "bcrt1qv5hlaf40hxwq8zr9fzwsg2u2r4dtjwpqccr2a7a9pc5j93jpt8vq8krr5h",
    outputScript: "0020652ffea6afb99c038865489d042b8a1d5ab93820c606aefba50e2922c64159d8",
    index: 0,
    derivationPath: "m/0",
    absoluteDerivationPath: "m/44'/1'/0'/0",
    keyOrigin: goldenTpubOrigin,
    publicKey: "03121045f0f7781d0b14f919f2476c8a94c5b21c17a7c325116b72ac7e99d5b9c0",
    descriptor: "raw(0020652ffea6afb99c038865489d042b8a1d5ab93820c606aefba50e2922c64159d8)",
  },
  recovery: {
    format: "timesats-vault-plan",
    version: 3,
    policy: {
      policyVersion: 2,
      network: "regtest",
      unlockHeight: 250,
      keySource: {
        type: "bip32-testnet-xpub-with-origin",
        extendedPublicKey: goldenTpub,
        keyOrigin: goldenTpubOrigin,
      },
      derivation: { pathTemplate: "m/<index>", hardened: false },
    },
    recovery: { lastIssuedIndex: 0 },
    metadata: { label: "Golden V2" },
  },
  destination: "bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m",
  rawFundingTransaction: "010000000122222222222222222222222222222222222222222222222222222222222222220400000000ffffffff01b0710b0000000000220020652ffea6afb99c038865489d042b8a1d5ab93820c606aefba50e2922c64159d800000000",
  utxo: {
    network: "regtest",
    planIdentity: `2:regtest:250:${goldenTpub}:m/<index>:6f53d49c:m/44'/1'/0'`,
    depositIndex: 0,
    txid: "a979a7c7c229d2d6ff07afe6b37ff462395fb435e2ee872cd1da21181487b36d",
    vout: 0,
    valueSats: 750_000,
    outputScript: "0020652ffea6afb99c038865489d042b8a1d5ab93820c606aefba50e2922c64159d8",
    witnessScript: "02fa00b1692103121045f0f7781d0b14f919f2476c8a94c5b21c17a7c325116b72ac7e99d5b9c0ac",
    publicKey: "03121045f0f7781d0b14f919f2476c8a94c5b21c17a7c325116b72ac7e99d5b9c0",
    keyOrigin: { masterFingerprint: "6f53d49c", path: "m/44'/1'/0'/0" },
    unlockHeight: 250,
  },
  intent: {
    version: 1,
    network: "regtest",
    planIdentity: `2:regtest:250:${goldenTpub}:m/<index>:6f53d49c:m/44'/1'/0'`,
    depositIndex: 0,
    fundingTxid: "a979a7c7c229d2d6ff07afe6b37ff462395fb435e2ee872cd1da21181487b36d",
    fundingVout: 0,
    inputValueSats: 750_000,
    destinationAddress: "bcrt1qq6hag67dl53wl99vzg42z8eyzfz2xlkvwk6f7m",
    destinationValueSats: 749_300,
    feeSats: 700,
    unlockHeight: 250,
    sequence: 0xfffffffe,
    sighashType: Transaction.SIGHASH_ALL,
  },
  psbt: "cHNidP8BAFICAAAAAW2zhxQYIdrRLIfu4jW0Xzli9H+z5q8H/9bSKcLHp3mpAAAAAAD+////AfRuCwAAAAAAFgAUBq/Ua839Iu+UrBIqoR8kEkSjfsz6AAAAAAEBK7BxCwAAAAAAIgAgZS/+pq+5nAOIZUidBCuKHVq5OCDGBq77pQ4pIsZBWdgBAwQBAAAAAQUoAvoAsWkhAxIQRfD3eB0LFPkZ8kdsipTFshwXp8MlEWtyrH6Z1bnArCIGAxIQRfD3eB0LFPkZ8kdsipTFshwXp8MlEWtyrH6Z1bnAFG9T1JwsAACAAQAAgAAAAIAAAAAAAAA=",
} as const;

function syntheticFundingTransaction(outputScript: string, valueSats: number, previousHashByte: number, previousVout: number): string {
  const transaction = new Transaction();
  transaction.addInput(new Uint8Array(32).fill(previousHashByte), previousVout);
  transaction.addOutput(hexToBytes(outputScript), BigInt(valueSats));
  return transaction.toHex();
}

function buildV1Context() {
  const initialPlan = createVaultPlan({
    label: "Golden V1",
    network: "signet",
    unlockHeight: 840_000,
    extendedPublicKey: validTestTpub,
  });
  const firstIssued = issueNextDeposit(initialPlan);
  const secondIssued = issueNextDeposit(firstIssued.plan);
  const plan = secondIssued.plan;
  const deposit = deriveDeposit(plan, 2);
  const rawFundingTransaction = syntheticFundingTransaction(deposit.outputScript, 500_000, 0x11, 2);
  const verified = verifyFundingTransaction(plan, 2, rawFundingTransaction, 0);
  const intent = createVaultSpendIntent(verified.utxo, v1.destination, 500);
  return {
    plan,
    issuedDeposit: secondIssued.deposit,
    deposit,
    rawFundingTransaction,
    verified,
    intent,
    unsigned: buildUnsignedVaultPsbt(intent, verified.utxo),
  };
}

function buildV2Context() {
  const plan = createVaultPlan({
    label: "Golden V2",
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  const deposit = deriveDeposit(plan, 0);
  const rawFundingTransaction = syntheticFundingTransaction(deposit.outputScript, 750_000, 0x22, 4);
  const verified = verifyFundingTransaction(plan, 0, rawFundingTransaction, 0);
  const intent = createVaultSpendIntent(verified.utxo, v2.destination, 700);
  return { plan, deposit, rawFundingTransaction, verified, intent, unsigned: buildUnsignedVaultPsbt(intent, verified.utxo) };
}

function assertPsbtSemantics(unsignedBase64: string, expected: typeof v1 | typeof v2) {
  const psbt = Psbt.fromBase64(unsignedBase64, { network: bitcoinNetworkFor(expected.intent.network) });
  const input = psbt.txInputs[0];
  const inputData = psbt.data.inputs[0];
  const output = psbt.txOutputs[0];

  // BIP174 v0 is represented by the unsigned transaction global map.
  expect(psbt.data.globalMap.unsignedTx).toBeDefined();
  expect(psbt.version).toBe(2);
  expect(psbt.locktime).toBe(expected.intent.unlockHeight);
  expect(psbt.inputCount).toBe(1);
  expect(psbt.txOutputs).toHaveLength(1);
  expect(bytesToHex(Uint8Array.from(input.hash).reverse())).toBe(expected.intent.fundingTxid);
  expect(input.index).toBe(expected.intent.fundingVout);
  expect(input.sequence).toBe(0xfffffffe);
  expect(bytesToHex(output.script)).toBe(destinationOutputScript);
  expect(output.value).toBe(BigInt(expected.intent.destinationValueSats));
  expect(inputData.witnessUtxo).toEqual({
    script: hexToBytes(expected.utxo.outputScript),
    value: BigInt(expected.utxo.valueSats),
  });
  expect(inputData.witnessScript).toEqual(hexToBytes(expected.utxo.witnessScript));
  expect(inputData.sighashType).toBe(Transaction.SIGHASH_ALL);
  expect(inputData.partialSig).toBeUndefined();
}

describe("Bitcoin compatibility golden vectors", () => {
  it("keeps the historical V1 primitive byte-for-byte compatible", () => {
    const vault = deriveVault({
      version: 1,
      network: "signet",
      publicKey: generatorPublicKey,
      unlockHeight: 840_000,
    });

    expect(vault.witnessScript).toBe("0340d10cb175210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac");
    expect(vault.outputScript).toBe("00206471ddfa6f844aa934c28778290d0defb54e514875a6d35fecd5aefa482cdadd");
    expect(vault.address).toBe("tb1qv3cam7n0s392jdxzsauzjrgda765u52gwkndxhlv6kh05jpvmtwste5y68");
  });

  it("keeps V1 public derivation, recovery, funding, intent, and PSBT vectors", () => {
    const { plan, issuedDeposit, deposit, rawFundingTransaction, verified, intent, unsigned } = buildV1Context();

    expect(validTestTpub).toBe(goldenTpub);
    expect(plan).toEqual(v1.plan);
    expect(vaultPlanIdentity(plan)).toBe(v1.identity);
    expect(issuedDeposit).toEqual(deposit);
    expect(deposit).toEqual(v1.deposit);
    expect(createVaultPlanRecoveryBundle(plan)).toEqual(v1.recovery);
    expect(reconstructVaultPlan(JSON.parse(JSON.stringify(v1.recovery)))).toEqual(plan);
    // This only proves that the output existed in this supplied raw transaction, not that it remains unspent.
    expect(rawFundingTransaction).toBe(v1.rawFundingTransaction);
    expect(verified.utxo).toEqual(v1.utxo);
    expect(intent).toEqual(v1.intent);
    expect(unsigned.base64).toBe(v1.psbt);
    expect(buildUnsignedVaultPsbt(intent, verified.utxo).base64).toBe(v1.psbt);
    expect(Psbt.fromBase64(v1.psbt, { network: bitcoinNetworkFor("signet") }).toBase64()).toBe(v1.psbt);
    assertPsbtSemantics(unsigned.base64, v1);
    expect(Psbt.fromBase64(unsigned.base64).data.inputs[0].bip32Derivation).toBeUndefined();
  });

  it("keeps V2 public-source derivation, origin, recovery, funding, intent, and PSBT vectors", () => {
    const { plan, deposit, rawFundingTransaction, verified, intent, unsigned } = buildV2Context();

    expect(plan).toEqual(v2.plan);
    expect(vaultPlanIdentity(plan)).toBe(v2.identity);
    expect(deposit).toEqual(v2.deposit);
    expect(createVaultPlanRecoveryBundle(plan)).toEqual(v2.recovery);
    expect(reconstructVaultPlan(JSON.parse(JSON.stringify(v2.recovery)))).toEqual(plan);
    // This only proves that the output existed in this supplied raw transaction, not that it remains unspent.
    expect(rawFundingTransaction).toBe(v2.rawFundingTransaction);
    expect(verified.utxo).toEqual(v2.utxo);
    expect(intent).toEqual(v2.intent);
    expect(unsigned.base64).toBe(v2.psbt);
    expect(buildUnsignedVaultPsbt(intent, verified.utxo).base64).toBe(v2.psbt);
    expect(Psbt.fromBase64(v2.psbt, { network: bitcoinNetworkFor("regtest") }).toBase64()).toBe(v2.psbt);
    assertPsbtSemantics(unsigned.base64, v2);
    expect(Psbt.fromBase64(unsigned.base64).data.inputs[0].bip32Derivation).toEqual([{
      masterFingerprint: hexToBytes("6f53d49c"),
      path: "m/44'/1'/0'/0",
      pubkey: hexToBytes(v2.deposit.publicKey),
    }]);
  });

  it("keeps identity tied to Bitcoin-critical V2 policy fields, not metadata or issuance state", () => {
    const first = buildV2Context().plan;
    const renamed = createVaultPlan({
      label: "Different label",
      network: "regtest",
      unlockHeight: 250,
      extendedPublicKey: goldenTpub,
      policyVersion: 2,
      keyOrigin: validTestTpubOrigin,
    });
    const issued = issueNextDeposit(first).plan;
    const changedUnlockHeight = createVaultPlan({
      label: "Golden V2",
      network: "regtest",
      unlockHeight: 251,
      extendedPublicKey: goldenTpub,
      policyVersion: 2,
      keyOrigin: validTestTpubOrigin,
    });

    expect(vaultPlanIdentity(first)).toBe(v2.identity);
    expect(vaultPlanIdentity(renamed)).toBe(v2.identity);
    expect(vaultPlanIdentity(issued)).toBe(v2.identity);
    expect(vaultPlanIdentity(changedUnlockHeight)).not.toBe(v2.identity);
  });

  it("uses the documented public V2 origin and verifies the encoded tpub node metadata", () => {
    const key = parseTestExtendedPublicKey(validTestTpub);

    expect(validTestTpub).toBe(goldenTpub);
    expect(validTestTpubOrigin).toEqual(goldenTpubOrigin);
    expect({
      depth: key.depth,
      parentFingerprint: key.parentFingerprint.toString(16).padStart(8, "0"),
      childNumber: key.index,
    }).toEqual({
      depth: 3,
      parentFingerprint: "e9528086",
      childNumber: 0x80000000,
    });
  });

  it("uses the fixed public destination programs for both test networks", () => {
    expect(bytesToHex(payments.p2wpkh({ pubkey: hexToBytes(destinationPublicKey), network: bitcoinNetworkFor("signet") }).output!)).toBe(destinationOutputScript);
    expect(bytesToHex(payments.p2wpkh({ pubkey: hexToBytes(destinationPublicKey), network: bitcoinNetworkFor("regtest") }).output!)).toBe(destinationOutputScript);
  });
});
