import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createVaultPlan, deriveIssuedDeposits, issueNextDeposit } from "@/bitcoin/vault-plan";
import { MAX_NON_HARDENED_INDEX } from "./vault-plan";
import {
  HISTORICAL_IDENTITY_COMMITMENT_ALGORITHM,
  HISTORICAL_IDENTITY_COMMITMENT_SCHEME,
  HISTORICAL_IDENTITY_COMMITMENT_VERSION,
  HistoricalIdentityMaterialV1Schema,
  XPUBLESS_V2_PLAN_STATE_FORMAT,
  XPUBLESS_V2_PLAN_STATE_VERSION,
  XpublessV2IssuedOutputSchema,
  XpublessV2PlanStateSchema,
  serializeHistoricalIdentityPreimageV1,
  type HistoricalIdentityMaterialV1,
} from "./xpubless-v2-plan-state";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";

const LOCAL_INSTANCE_ID = "30f5d018-bd99-4f4e-9c5d-2a7445f5c1f6";
const EXPECTED_PREIMAGE_STRING = "[\"timesats-historical-identity\",1,2,\"regtest\",250,\"bip32-testnet-xpub-with-origin\",\"tpubDDjsCRDQ9YzyaAq9rspCfq8RZFrWoBpYnLxK6sS2hS2yukqSczgcYiur8Scx4Hd5AZatxTuzMtJQJhchufv1FRFanLqUP7JHwusSSpfcEp2\",\"6f53d49c\",\"m/44'/1'/0'\",\"m/<index>\",false]";
const EXPECTED_SHA256_HEX = "4c97d12818326f873a3e3628f754e542ef55679cdd2789f0205e5650cdcf168a";

const fixtureMaterial: HistoricalIdentityMaterialV1 = {
  policyVersion: 2,
  network: "regtest",
  unlockHeight: 250,
  keySource: {
    type: "bip32-testnet-xpub-with-origin",
    extendedPublicKey: validTestTpub,
  },
  keyOrigin: validTestTpubOrigin,
  derivation: { pathTemplate: "m/<index>", hardened: false },
};

function hicDigestForTest(material: HistoricalIdentityMaterialV1): string {
  return createHash("sha256").update(serializeHistoricalIdentityPreimageV1(material), "utf8").digest("hex");
}

function fixtureOutputs(lastIssuedIndex: number): Array<{ index: number; outputScript: string }> {
  let plan = createVaultPlan({
    label: "Xpubless fixture",
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  while (plan.lastIssuedIndex < lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  return deriveIssuedDeposits(plan).map(({ index, outputScript }) => ({ index, outputScript }));
}

function validState(lastIssuedIndex = 0) {
  return {
    format: XPUBLESS_V2_PLAN_STATE_FORMAT,
    version: XPUBLESS_V2_PLAN_STATE_VERSION,
    localInstanceId: LOCAL_INSTANCE_ID,
    policyVersion: 2,
    network: "regtest" as const,
    unlockHeight: 250,
    derivation: { pathTemplate: "m/<index>" as const, hardened: false as const },
    keyOrigin: validTestTpubOrigin,
    metadata: { label: "  Xpubless fixture  " },
    historicalIdentityCommitment: {
      scheme: HISTORICAL_IDENTITY_COMMITMENT_SCHEME,
      version: HISTORICAL_IDENTITY_COMMITMENT_VERSION,
      algorithm: HISTORICAL_IDENTITY_COMMITMENT_ALGORITHM,
      digest: EXPECTED_SHA256_HEX,
    },
    lastIssuedIndex,
    issuedOutputs: fixtureOutputs(lastIssuedIndex),
  };
}

describe("XpublessV2PlanState", () => {
  it("accepts the minimum durable state with Deposit #0 and its exact P2WSH outputScript", () => {
    const state = XpublessV2PlanStateSchema.parse(validState());
    expect(state.issuedOutputs).toEqual(fixtureOutputs(0));
    expect(state.issuedOutputs[0].outputScript).toMatch(/^0020[0-9a-f]{64}$/);
  });

  it("accepts a contiguous #0 through #3 state and JSON round-trips it", () => {
    const state = XpublessV2PlanStateSchema.parse(validState(3));
    expect(state.issuedOutputs.map(({ index }) => index)).toEqual([0, 1, 2, 3]);
    expect(XpublessV2PlanStateSchema.parse(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it("uses the existing label trim semantics without including label in HIC material", () => {
    expect(XpublessV2PlanStateSchema.parse(validState()).metadata.label).toBe("Xpubless fixture");
    expect(() => HistoricalIdentityMaterialV1Schema.parse({ ...fixtureMaterial, label: "renamed" })).toThrow();
  });

  it("accepts signet and canonical lowercase V2 origin metadata", () => {
    const state = XpublessV2PlanStateSchema.parse({ ...validState(), network: "signet" });
    expect(state.network).toBe("signet");
    expect(state.keyOrigin).toEqual(validTestTpubOrigin);
    expect(state.localInstanceId).toBe(LOCAL_INSTANCE_ID);
  });

  it("accepts the scalar maximum non-hardened issued-output index without allocating a giant state array", () => {
    expect(XpublessV2IssuedOutputSchema.parse({ index: MAX_NON_HARDENED_INDEX, outputScript: fixtureOutputs(0)[0].outputScript }).index).toBe(MAX_NON_HARDENED_INDEX);
  });

  it("freezes the HIC v1 ordered JSON tuple", () => {
    expect(serializeHistoricalIdentityPreimageV1(fixtureMaterial)).toBe(EXPECTED_PREIMAGE_STRING);
  });

  it("matches the frozen SHA256 HIC v1 test vector without Node crypto in the production module", () => {
    expect(createHash("sha256").update(EXPECTED_PREIMAGE_STRING, "utf8").digest("hex")).toBe(EXPECTED_SHA256_HEX);
  });

  it("keeps HIC v1 stable across label, local UUID, issuance, and output-list changes outside its material", () => {
    const first = XpublessV2PlanStateSchema.parse(validState());
    const later = XpublessV2PlanStateSchema.parse({
      ...validState(3),
      localInstanceId: "1f5d2ac6-cb73-4c2b-9626-a55778b69a1f",
      metadata: { label: "Renamed" },
    });
    expect(first.lastIssuedIndex).toBe(0);
    expect(later.lastIssuedIndex).toBe(3);
    expect(later.historicalIdentityCommitment).toEqual(first.historicalIdentityCommitment);
    expect(serializeHistoricalIdentityPreimageV1(fixtureMaterial)).toBe(EXPECTED_PREIMAGE_STRING);
  });

  it.each([
    ["network", { ...fixtureMaterial, network: "signet" }],
    ["unlockHeight", { ...fixtureMaterial, unlockHeight: 251 }],
    ["extendedPublicKey", { ...fixtureMaterial, keySource: { ...fixtureMaterial.keySource, extendedPublicKey: validTestTpub.slice(0, -1) + "3" } }],
    ["masterFingerprint", { ...fixtureMaterial, keyOrigin: { ...fixtureMaterial.keyOrigin, masterFingerprint: "00000000" } }],
    ["sourcePath", { ...fixtureMaterial, keyOrigin: { ...fixtureMaterial.keyOrigin, sourcePath: "m/84'/1'/0'" } }],
  ])("changes the HIC v1 preimage when historical %s changes", (_field, material) => {
    const changedMaterial = material as HistoricalIdentityMaterialV1;
    expect(serializeHistoricalIdentityPreimageV1(changedMaterial)).not.toBe(EXPECTED_PREIMAGE_STRING);
    expect(hicDigestForTest(changedMaterial)).not.toBe(EXPECTED_SHA256_HEX);
  });

  it.each([
    ["uppercase fingerprint", { ...fixtureMaterial, keyOrigin: { ...fixtureMaterial.keyOrigin, masterFingerprint: "6F53D49C" } }],
    ["h source-path alias", { ...fixtureMaterial, keyOrigin: { ...fixtureMaterial.keyOrigin, sourcePath: "m/44h/1'/0'" } }],
    ["private extended key", { ...fixtureMaterial, keySource: { ...fixtureMaterial.keySource, extendedPublicKey: "tprv8ZgxMBicQKsPe" } }],
  ])("requires canonical public HIC material and rejects %s", (_name, material) => {
    expect(() => serializeHistoricalIdentityPreimageV1(material as HistoricalIdentityMaterialV1)).toThrow();
  });

  it.each([
    ["mainnet", { network: "mainnet" }],
    ["policy V1", { policyVersion: 1 }],
    ["wrong state version", { version: 2 }],
    ["wrong state format", { format: "timesats-vault-plan" }],
    ["invalid UUID", { localInstanceId: "not-a-uuid" }],
    ["uppercase UUID", { localInstanceId: LOCAL_INSTANCE_ID.toUpperCase() }],
    ["uppercase fingerprint", { keyOrigin: { ...validTestTpubOrigin, masterFingerprint: "6F53D49C" } }],
    ["h source path alias", { keyOrigin: { ...validTestTpubOrigin, sourcePath: "m/44h/1'/0'" } }],
    ["H source path alias", { keyOrigin: { ...validTestTpubOrigin, sourcePath: "m/44H/1'/0'" } }],
    ["source path leading-zero alias", { keyOrigin: { ...validTestTpubOrigin, sourcePath: "m/044'/1'/0'" } }],
    ["relative source path", { keyOrigin: { ...validTestTpubOrigin, sourcePath: "44'/1'/0'" } }],
    ["negative source path child", { keyOrigin: { ...validTestTpubOrigin, sourcePath: "m/-1" } }],
    ["malformed source path", { keyOrigin: { ...validTestTpubOrigin, sourcePath: "m/not-a-path" } }],
    ["source path child above range", { keyOrigin: { ...validTestTpubOrigin, sourcePath: "m/2147483648" } }],
    ["hardened deposit derivation", { derivation: { pathTemplate: "m/<index>", hardened: true } }],
    ["different deposit derivation", { derivation: { pathTemplate: "m/0", hardened: false } }],
    ["unlock height below range", { unlockHeight: 0 }],
    ["unlock height above range", { unlockHeight: 500_000_000 }],
    ["uppercase output script", { issuedOutputs: [{ ...fixtureOutputs(0)[0], outputScript: fixtureOutputs(0)[0].outputScript.toUpperCase() }] }],
    ["non-P2WSH output script", { issuedOutputs: [{ ...fixtureOutputs(0)[0], outputScript: "0014" + "00".repeat(20) }] }],
    ["negative output index", { issuedOutputs: [{ ...fixtureOutputs(0)[0], index: -1 }] }],
    ["out-of-range output index", { issuedOutputs: [{ ...fixtureOutputs(0)[0], index: MAX_NON_HARDENED_INDEX + 1 }] }],
    ["missing Deposit #0", { lastIssuedIndex: 1, issuedOutputs: [{ ...fixtureOutputs(0)[0], index: 1 }] }],
    ["missing middle index", { lastIssuedIndex: 2, issuedOutputs: [fixtureOutputs(0)[0], { ...fixtureOutputs(0)[0], index: 2 }] }],
    ["out-of-order outputs", { lastIssuedIndex: 1, issuedOutputs: [...fixtureOutputs(1)].reverse() }],
    ["duplicate output index", { lastIssuedIndex: 1, issuedOutputs: [fixtureOutputs(0)[0], { ...fixtureOutputs(0)[0], index: 0 }] }],
    ["lastIssuedIndex mismatch", { lastIssuedIndex: 1 }],
    ["uppercase HIC digest", { historicalIdentityCommitment: { ...validState().historicalIdentityCommitment, digest: EXPECTED_SHA256_HEX.toUpperCase() } }],
    ["short HIC digest", { historicalIdentityCommitment: { ...validState().historicalIdentityCommitment, digest: "00" } }],
    ["unknown HIC scheme", { historicalIdentityCommitment: { ...validState().historicalIdentityCommitment, scheme: "other-scheme" } }],
    ["unknown HIC algorithm", { historicalIdentityCommitment: { ...validState().historicalIdentityCommitment, algorithm: "sha512" } }],
    ["unknown HIC version", { historicalIdentityCommitment: { ...validState().historicalIdentityCommitment, version: 2 } }],
  ])("rejects %s", (_name, override) => {
    expect(() => XpublessV2PlanStateSchema.parse({ ...validState(), ...override })).toThrow();
  });

  it.each([
    "extendedPublicKey",
    "tpub",
    "xpub",
    "vaultPlanIdentity",
    "publicKey",
    "witnessScript",
    "descriptor",
    "privateKey",
    "seed",
    "mnemonic",
    "wif",
    "xprv",
    "tprv",
  ])("rejects unexpected durable-state field %s", (field) => {
    expect(() => XpublessV2PlanStateSchema.parse({ ...validState(), [field]: "injected" })).toThrow();
  });

  it("rejects extras at each nested durable-state object level", () => {
    const cases = [
      { ...validState(), derivation: { ...validState().derivation, extra: true } },
      { ...validState(), keyOrigin: { ...validState().keyOrigin, extra: true } },
      { ...validState(), metadata: { ...validState().metadata, extra: true } },
      { ...validState(), historicalIdentityCommitment: { ...validState().historicalIdentityCommitment, extra: true } },
      { ...validState(), issuedOutputs: [{ ...validState().issuedOutputs[0], extra: true }] },
    ];
    cases.forEach((candidate) => expect(() => XpublessV2PlanStateSchema.parse(candidate)).toThrow());
  });

  it("rejects unknown fields in HIC material without scanning unrelated strings", () => {
    expect(() => HistoricalIdentityMaterialV1Schema.parse({ ...fixtureMaterial, extendedPublicKey: "injected" })).toThrow();
    expect(() => HistoricalIdentityMaterialV1Schema.parse({ ...fixtureMaterial, keySource: { ...fixtureMaterial.keySource, privateKey: "injected" } })).toThrow();
    expect(XpublessV2PlanStateSchema.parse({ ...validState(), metadata: { label: "tpub is not a prohibited-field heuristic" } }).metadata.label).toContain("tpub");
  });
});
