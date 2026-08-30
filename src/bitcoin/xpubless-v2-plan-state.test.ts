import { createHash } from "node:crypto";
import { HDKey } from "@scure/bip32";
import { describe, expect, it, vi } from "vitest";
import { MAX_NON_HARDENED_INDEX, type VaultPlan } from "@/domain/vault-plan";
import { serializeHistoricalIdentityPreimageV1 } from "@/domain/xpubless-v2-plan-state";
import { testnetBip32Versions } from "./bip32";
import {
  createVaultPlan,
  deriveDeposit,
  deriveIssuedDeposits,
  issueNextDeposit,
  vaultPlanIdentity,
} from "./vault-plan";
import {
  appendIssuedDepositToXpublessV2PlanState,
  createXpublessV2PlanState,
  rehydrateXpublessV2PlanState,
  type XpublessV2IssuedDepositCommitment,
} from "./xpubless-v2-plan-state";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";

const LOCAL_INSTANCE_ID = "30f5d018-bd99-4f4e-9c5d-2a7445f5c1f6";
const ALTERNATE_LOCAL_INSTANCE_ID = "1f5d2ac6-cb73-4c2b-9626-a55778b69a1f";
const EXPECTED_HIC_DIGEST = "4c97d12818326f873a3e3628f754e542ef55679cdd2789f0205e5650cdcf168a";
const EXPECTED_HIC_PREIMAGE = "[\"timesats-historical-identity\",1,2,\"regtest\",250,\"bip32-testnet-xpub-with-origin\",\"tpubDDjsCRDQ9YzyaAq9rspCfq8RZFrWoBpYnLxK6sS2hS2yukqSczgcYiur8Scx4Hd5AZatxTuzMtJQJhchufv1FRFanLqUP7JHwusSSpfcEp2\",\"6f53d49c\",\"m/44'/1'/0'\",\"m/<index>\",false]";

function v2Plan(lastIssuedIndex = 3, label = "P2 V2 fixture"): VaultPlan {
  let plan = createVaultPlan({
    label,
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  while (plan.lastIssuedIndex < lastIssuedIndex) {
    plan = issueNextDeposit(plan).plan;
  }
  return plan;
}

function v1Plan(): VaultPlan {
  return createVaultPlan({
    label: "P2 V1 fixture",
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: validTestTpub,
  });
}

/** Builds a valid same-depth but commitment-incompatible public tpub. */
function unrelatedPublicTpub(): string {
  const original = HDKey.fromExtendedKey(validTestTpub, testnetBip32Versions);
  const child = original.deriveChild(1);
  if (child.publicKey === null || child.chainCode === null) throw new Error("Expected public BIP32 child material.");
  return new HDKey({
    versions: testnetBip32Versions,
    publicKey: child.publicKey,
    chainCode: child.chainCode,
    depth: original.depth,
    index: original.index,
    parentFingerprint: original.parentFingerprint,
  }).publicExtendedKey;
}

function assertStateDoesNotPersistDerivedPublicMaterial(state: unknown, plan: VaultPlan): void {
  const serialized = JSON.stringify(state);
  expect(serialized).not.toContain(plan.policy.keySource.extendedPublicKey);
  expect(serialized).not.toContain(vaultPlanIdentity(plan));
  for (const deposit of deriveIssuedDeposits(plan)) {
    expect(serialized).not.toContain(deposit.publicKey);
    expect(serialized).not.toContain(deposit.witnessScript);
    expect(serialized).not.toContain(deposit.descriptor);
    expect(serialized).not.toContain(deposit.address);
  }
}

describe("xpubless V2 pure conversion and rehydration", () => {
  it("computes the P1 HIC v1 fixture digest at runtime with browser-safe bitcoinjs SHA256", () => {
    const state = createXpublessV2PlanState(v2Plan(0), LOCAL_INSTANCE_ID);
    expect(state.historicalIdentityCommitment.digest).toBe(EXPECTED_HIC_DIGEST);
    expect(createHash("sha256").update(EXPECTED_HIC_PREIMAGE, "utf8").digest("hex")).toBe(EXPECTED_HIC_DIGEST);
    expect(serializeHistoricalIdentityPreimageV1({
      policyVersion: 2,
      network: "regtest",
      unlockHeight: 250,
      keySource: { type: "bip32-testnet-xpub-with-origin", extendedPublicKey: validTestTpub },
      keyOrigin: validTestTpubOrigin,
      derivation: { pathTemplate: "m/<index>", hardened: false },
    })).toBe(EXPECTED_HIC_PREIMAGE);
  });

  it("converts a normalized V2 plan deterministically without persisting its tpub or derived public material", () => {
    const plan = v2Plan();
    const before = structuredClone(plan);
    const first = createXpublessV2PlanState(plan, LOCAL_INSTANCE_ID);
    const second = createXpublessV2PlanState(plan, LOCAL_INSTANCE_ID);

    expect(first).toEqual(second);
    expect(plan).toEqual(before);
    expect(first.issuedOutputs).toEqual(deriveIssuedDeposits(plan).map(({ index, outputScript }) => ({ index, outputScript })));
    assertStateDoesNotPersistDerivedPublicMaterial(first, plan);
  });

  it("changes only localInstanceId when the same V2 plan is converted with another caller-provided UUID", () => {
    const plan = v2Plan();
    const first = createXpublessV2PlanState(plan, LOCAL_INSTANCE_ID);
    const second = createXpublessV2PlanState(plan, ALTERNATE_LOCAL_INSTANCE_ID);

    expect(second).toEqual({ ...first, localInstanceId: ALTERNATE_LOCAL_INSTANCE_ID });
    expect(second.historicalIdentityCommitment).toEqual(first.historicalIdentityCommitment);
  });

  it("keeps HIC stable across mutable label, local instance, and issued-output changes", () => {
    const first = createXpublessV2PlanState(v2Plan(0, "First label"), LOCAL_INSTANCE_ID);
    const later = createXpublessV2PlanState(v2Plan(3, "Later label"), ALTERNATE_LOCAL_INSTANCE_ID);

    expect(later.historicalIdentityCommitment).toEqual(first.historicalIdentityCommitment);
  });

  it("rejects V1 conversion and invalid caller-provided localInstanceId", () => {
    expect(() => createXpublessV2PlanState(v1Plan(), LOCAL_INSTANCE_ID)).toThrow(/Policy V2/i);
    expect(() => createXpublessV2PlanState(v2Plan(), LOCAL_INSTANCE_ID.toUpperCase())).toThrow(/lowercase canonical UUID/i);
  });

  it("rehydrates the correct source in memory with the same identity and issued deposits", () => {
    const original = v2Plan();
    const state = createXpublessV2PlanState(original, LOCAL_INSTANCE_ID);
    const stateBefore = structuredClone(state);
    const rehydrated = rehydrateXpublessV2PlanState(state, validTestTpub);

    expect(rehydrated.lastIssuedIndex).toBe(state.lastIssuedIndex);
    expect(rehydrated.metadata.label).toBe(state.metadata.label);
    expect(vaultPlanIdentity(rehydrated)).toBe(vaultPlanIdentity(original));
    expect(deriveIssuedDeposits(rehydrated)).toEqual(deriveIssuedDeposits(original));
    expect(state).toEqual(stateBefore);
  });

  it("rejects a valid same-depth but wrong public tpub without echoing key material", () => {
    const state = createXpublessV2PlanState(v2Plan(), LOCAL_INSTANCE_ID);
    expect(() => rehydrateXpublessV2PlanState(state, unrelatedPublicTpub())).toThrow("Presented public key does not match this xpubless plan state.");
  });

  it("rejects tampered output commitments even while the original HIC remains intact", () => {
    const state = createXpublessV2PlanState(v2Plan(), LOCAL_INSTANCE_ID);
    const tampered = {
      ...state,
      issuedOutputs: [{ ...state.issuedOutputs[0], outputScript: "0020" + "00".repeat(32) }, ...state.issuedOutputs.slice(1)],
    };
    expect(() => rehydrateXpublessV2PlanState(tampered, validTestTpub)).toThrow("Presented public key does not match this xpubless plan state.");
  });

  it("rejects a structurally valid but altered HIC digest with correct output commitments", () => {
    const state = createXpublessV2PlanState(v2Plan(), LOCAL_INSTANCE_ID);
    const tampered = {
      ...state,
      historicalIdentityCommitment: { ...state.historicalIdentityCommitment, digest: "00".repeat(32) },
    };
    expect(() => rehydrateXpublessV2PlanState(tampered, validTestTpub)).toThrow("Presented public key does not match this xpubless plan state.");
  });

  it.each([
    ["master fingerprint", { masterFingerprint: "00000000", sourcePath: validTestTpubOrigin.sourcePath }],
    ["historical source-path ancestor", { masterFingerprint: validTestTpubOrigin.masterFingerprint, sourcePath: "m/84'/1'/0'" }],
  ])("rejects altered historical %s even when the descendant tpub reproduces outputs", (_name, keyOrigin) => {
    const state = createXpublessV2PlanState(v2Plan(), LOCAL_INSTANCE_ID);
    const tampered = { ...state, keyOrigin };
    expect(() => rehydrateXpublessV2PlanState(tampered, validTestTpub)).toThrow("Presented public key does not match this xpubless plan state.");
  });

  it.each([
    "tprv8ZgxMBicQKsPe",
    "xprv9s21ZrQH143K3",
    `L${"1".repeat(50)}`,
    "xpub661MyMwAqRbcFt",
    "not-an-extended-key",
  ])("rejects presented private-like, mainnet, or malformed material", (presentedExtendedPublicKey) => {
    const state = createXpublessV2PlanState(v2Plan(), LOCAL_INSTANCE_ID);
    expect(() => rehydrateXpublessV2PlanState(state, presentedExtendedPublicKey)).toThrow();
  });

  it("appends only the correctly derived Deposit #4 without reintroducing public session material", () => {
    const currentPlan = v2Plan();
    const planBefore = structuredClone(currentPlan);
    const state = createXpublessV2PlanState(currentPlan, LOCAL_INSTANCE_ID);
    const stateBefore = structuredClone(state);
    const nextDeposit = issueNextDeposit(currentPlan).deposit;
    const nextCommitment: XpublessV2IssuedDepositCommitment = {
      index: nextDeposit.index,
      outputScript: nextDeposit.outputScript,
    };
    const commitmentBefore = structuredClone(nextCommitment);
    const updated = appendIssuedDepositToXpublessV2PlanState(state, currentPlan, nextCommitment);

    expect(updated).toEqual({
      ...state,
      lastIssuedIndex: 4,
      issuedOutputs: [...state.issuedOutputs, nextCommitment],
    });
    expect(state).toEqual(stateBefore);
    expect(currentPlan).toEqual(planBefore);
    expect(nextCommitment).toEqual(commitmentBefore);
    assertStateDoesNotPersistDerivedPublicMaterial(updated, { ...currentPlan, lastIssuedIndex: 4 } as VaultPlan);
  });

  it("rejects skipped, repeated, wrong-plan, wrong-output, and stale-plan append attempts", () => {
    const currentPlan = v2Plan();
    const state = createXpublessV2PlanState(currentPlan, LOCAL_INSTANCE_ID);
    const expected = deriveDeposit(currentPlan, 4);
    const expectedCommitment = { index: expected.index, outputScript: expected.outputScript };
    const anotherPlan = createVaultPlan({
      label: "Other plan",
      network: "regtest",
      unlockHeight: 251,
      extendedPublicKey: validTestTpub,
      policyVersion: 2,
      keyOrigin: validTestTpubOrigin,
    });

    expect(() => appendIssuedDepositToXpublessV2PlanState(state, currentPlan, deriveDeposit(currentPlan, 5))).toThrow(/Issued deposit/i);
    expect(() => appendIssuedDepositToXpublessV2PlanState(state, currentPlan, deriveDeposit(currentPlan, 3))).toThrow(/Issued deposit/i);
    expect(() => appendIssuedDepositToXpublessV2PlanState(state, currentPlan, deriveDeposit(currentPlan, 2))).toThrow(/Issued deposit/i);
    expect(() => appendIssuedDepositToXpublessV2PlanState(state, currentPlan, { ...expectedCommitment, outputScript: "0020" + "11".repeat(32) })).toThrow(/Issued deposit/i);
    expect(() => appendIssuedDepositToXpublessV2PlanState(state, currentPlan, deriveDeposit(anotherPlan, 4))).toThrow(/Issued deposit/i);
    expect(() => appendIssuedDepositToXpublessV2PlanState(state, { ...currentPlan, lastIssuedIndex: 2 } as VaultPlan, expectedCommitment)).toThrow(/does not match/i);
    expect(() => appendIssuedDepositToXpublessV2PlanState(state, { ...currentPlan, lastIssuedIndex: 4 } as VaultPlan, expectedCommitment)).toThrow(/does not match/i);
    expect(() => appendIssuedDepositToXpublessV2PlanState(state, v1Plan(), expectedCommitment)).toThrow(/Policy V2/i);
  });

  it("does not use I/O globals for conversion, rehydration, or append", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const plan = v2Plan();
    const state = createXpublessV2PlanState(plan, LOCAL_INSTANCE_ID);
    const rehydrated = rehydrateXpublessV2PlanState(state, validTestTpub);
    const next = deriveDeposit(rehydrated, 4);
    appendIssuedDepositToXpublessV2PlanState(state, rehydrated, { index: next.index, outputScript: next.outputScript });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("does not expose a direct candidate-only derivation path for Deposit #N+1", () => {
    const state = createXpublessV2PlanState(v2Plan(4), LOCAL_INSTANCE_ID);
    expect(state.lastIssuedIndex).toBe(4);
    expect(state.issuedOutputs).toHaveLength(5);
    expect("extendedPublicKey" in state).toBe(false);
    expect(MAX_NON_HARDENED_INDEX).toBe(0x7fffffff);
  });
});
