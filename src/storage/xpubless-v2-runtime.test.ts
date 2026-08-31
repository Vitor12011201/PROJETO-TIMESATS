import { describe, expect, it, vi } from "vitest";
import { createXpublessV2PlanState } from "@/bitcoin/xpubless-v2-plan-state";
import { createVaultPlan } from "@/bitcoin/vault-plan";
import { validTestTpub, validTestTpubOrigin } from "@/tests/fixtures";
import {
  createInitialXpublessV2LocalState,
  type XpublessV2LocalState,
} from "./xpubless-v2-local-state";
import type {
  XpublessV2BrowserAuthorityInspectionResult,
  XpublessV2BrowserLockManagerLike,
  XpublessV2BrowserLockRequestOptions,
  XpublessV2BrowserMigrationResult,
  XpublessV2BrowserStorageLike,
} from "./xpubless-v2-browser";
import type { XpublessV2BrowserEnvironmentResult } from "./xpubless-v2-browser-environment";
import type { XpublessV2MigrationUuidSource } from "./xpubless-v2-migration";
import {
  isXpublessV2DevelopmentGateEnabled,
  startXpublessV2DevelopmentRuntime,
  type XpublessV2RuntimeDependencies,
} from "./xpubless-v2-runtime";

const STATE_ID = "11111111-1111-4111-8111-111111111111";
const PLAN_ID = "22222222-2222-4222-8222-222222222222";

const storage: XpublessV2BrowserStorageLike = {
  getItem(): string | null { return null; },
  setItem(): void {},
  removeItem(): void {},
};

const lockManager: XpublessV2BrowserLockManagerLike = {
  async request<T>(
    _name: string,
    _options: XpublessV2BrowserLockRequestOptions,
    callback: (lock: object | null) => T | PromiseLike<T>,
  ): Promise<T> {
    return callback({});
  },
};

const readyEnvironment: XpublessV2BrowserEnvironmentResult = {
  status: "READY",
  storage,
  lockManager,
};

const uuidSource: XpublessV2MigrationUuidSource = {
  nextMigrationId: () => "33333333-3333-4333-8333-333333333333",
  nextStateId: () => STATE_ID,
  nextLocalInstanceId: () => PLAN_ID,
};

function xpublessState(): XpublessV2LocalState {
  const plan = createVaultPlan({
    label: "Runtime state",
    network: "regtest",
    unlockHeight: 700,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  return createInitialXpublessV2LocalState({
    stateId: STATE_ID,
    plans: [createXpublessV2PlanState(plan, PLAN_ID)],
    archivedLocalInstanceIds: [],
    hiddenDepositIndexes: {},
  });
}

function legacyAuthority(): XpublessV2BrowserAuthorityInspectionResult {
  return { status: "LEGACY_AUTHORITY", presentLegacyKeys: ["timesats.vault-plans.v3"] };
}

function inspectMock(
  ...results: XpublessV2BrowserAuthorityInspectionResult[]
): XpublessV2RuntimeDependencies["inspect"] {
  let position = 0;
  return vi.fn(async (): Promise<XpublessV2BrowserAuthorityInspectionResult> => {
    const result = results[Math.min(position, results.length - 1)];
    position += 1;
    if (!result) throw new Error("Inspection mock requires a result.");
    return result;
  });
}

function migrateMock(result: XpublessV2BrowserMigrationResult): XpublessV2RuntimeDependencies["migrate"] {
  return vi.fn(async (): Promise<XpublessV2BrowserMigrationResult> => result);
}

function environmentMock(result: XpublessV2BrowserEnvironmentResult): XpublessV2RuntimeDependencies["resolveEnvironment"] {
  return vi.fn((): XpublessV2BrowserEnvironmentResult => result);
}

function runtimeDependencies(
  overrides: Partial<XpublessV2RuntimeDependencies> = {},
): XpublessV2RuntimeDependencies {
  return {
    developmentGateEnabled: true,
    resolveEnvironment: environmentMock(readyEnvironment),
    inspect: inspectMock({ status: "EMPTY_LOCAL_STATE" }),
    migrate: migrateMock({ status: "COMPLETE_XPUBLESS" }),
    createUuidSource: vi.fn(() => uuidSource),
    ...overrides,
  };
}

describe("P3E4 development-gated xpubless startup runtime", () => {
  it("is enabled only by the explicit development-only environment combination", () => {
    expect(isXpublessV2DevelopmentGateEnabled({ NODE_ENV: "development", NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV: "1" })).toBe(true);
    expect(isXpublessV2DevelopmentGateEnabled({ NODE_ENV: "production", NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV: "1" })).toBe(false);
    expect(isXpublessV2DevelopmentGateEnabled({ NODE_ENV: "development" })).toBe(false);
  });

  it("bypasses the runtime with zero dependencies when the development gate is off", async () => {
    const dependencies = runtimeDependencies({ developmentGateEnabled: false });
    await expect(startXpublessV2DevelopmentRuntime(dependencies)).resolves.toEqual({ status: "DISABLED" });
    expect(dependencies.resolveEnvironment).not.toHaveBeenCalled();
    expect(dependencies.inspect).not.toHaveBeenCalled();
    expect(dependencies.createUuidSource).not.toHaveBeenCalled();
    expect(dependencies.migrate).not.toHaveBeenCalled();
  });

  it.each([
    "NOT_BROWSER_ENVIRONMENT",
    "UNSUPPORTED_EXCLUSIVE_WRITER",
    "UNAVAILABLE_BROWSER_STORAGE",
  ] as const)("fails closed when the real browser environment is %s", async (status) => {
    const dependencies = runtimeDependencies({
      resolveEnvironment: environmentMock({ status }),
    });
    await expect(startXpublessV2DevelopmentRuntime(dependencies)).resolves.toEqual({
      status: "RUNTIME_UNAVAILABLE",
      reason: status,
    });
    expect(dependencies.inspect).not.toHaveBeenCalled();
    expect(dependencies.migrate).not.toHaveBeenCalled();
  });

  const noMigrationCases: Array<[string, XpublessV2BrowserAuthorityInspectionResult, Record<string, unknown>]> = [
    ["empty", { status: "EMPTY_LOCAL_STATE" }, { status: "EMPTY_READY" }],
    ["xpubless", { status: "XPUBLESS_AUTHORITY", state: xpublessState() }, { status: "XPUBLESS_READY" }],
    ["ambiguous", { status: "AMBIGUOUS_BLOCKED", presentLegacyKeys: ["timesats.vault-plans.v3"] }, { status: "AUTHORITY_BLOCKED", reason: "AMBIGUOUS_BLOCKED" }],
    ["corrupt target", { status: "BLOCKED_CORRUPT_TARGET" }, { status: "AUTHORITY_BLOCKED", reason: "BLOCKED_CORRUPT_TARGET" }],
    ["corrupt journal", { status: "BLOCKED_CORRUPT_JOURNAL" }, { status: "AUTHORITY_BLOCKED", reason: "BLOCKED_CORRUPT_JOURNAL" }],
    ["inspection busy", { status: "BLOCKED_CONCURRENT_WRITER" }, { status: "BLOCKED_CONCURRENT_WRITER" }],
    ["inspection coordination failure", { status: "FAILED_BROWSER_COORDINATION" }, { status: "FAILED_BROWSER_COORDINATION" }],
    ["inspection storage failure", { status: "FAILED_RECOVERABLE" }, { status: "FAILED_RECOVERABLE" }],
  ];

  it.each(noMigrationCases)("maps %s without UUID creation or migration", async (_name, inspection, expected) => {
    const dependencies = runtimeDependencies({ inspect: inspectMock(inspection) });
    const result = await startXpublessV2DevelopmentRuntime(dependencies);
    expect(result).toMatchObject(expected);
    expect(dependencies.createUuidSource).not.toHaveBeenCalled();
    expect(dependencies.migrate).not.toHaveBeenCalled();
  });

  const migrationStartingCases: Array<[string, XpublessV2BrowserAuthorityInspectionResult]> = [
    ["legacy", legacyAuthority()],
    ["journal", { status: "MIGRATION_IN_PROGRESS_OR_RESUMABLE", phase: "CLEANUP_PENDING" }],
  ];

  it.each(migrationStartingCases)("runs P3B once for %s then trusts only xpubless reinspection", async (_name, firstInspection) => {
    const state = xpublessState();
    const dependencies = runtimeDependencies({
      inspect: inspectMock(firstInspection, { status: "XPUBLESS_AUTHORITY", state }),
    });
    await expect(startXpublessV2DevelopmentRuntime(dependencies)).resolves.toEqual({ status: "XPUBLESS_READY", state });
    expect(dependencies.createUuidSource).toHaveBeenCalledTimes(1);
    expect(dependencies.migrate).toHaveBeenCalledTimes(1);
    expect(dependencies.inspect).toHaveBeenCalledTimes(2);
  });

  const migrationBlockerCases: Array<[string, XpublessV2BrowserMigrationResult]> = [
    ["V1", "BLOCKED_UNSUPPORTED_V1"],
    ["duplicate", "BLOCKED_DUPLICATE_SEMANTICS"],
    ["orphan preferences", "BLOCKED_ORPHAN_LEGACY_PREFERENCES"],
    ["hidden outside issuance", "BLOCKED_HIDDEN_INDEX_OUTSIDE_ISSUANCE"],
    ["ambiguous coexistence", "BLOCKED_AMBIGUOUS_COEXISTENCE"],
    ["migration concurrent writer", "BLOCKED_CONCURRENT_WRITER"],
    ["migration storage failure", "FAILED_RECOVERABLE"],
  ].map(([name, status]) => [name, { status }] as [string, XpublessV2BrowserMigrationResult]);

  it.each(migrationBlockerCases)("preserves the P3B %s blocker reason", async (_name, migration) => {
    const dependencies = runtimeDependencies({
      inspect: inspectMock(legacyAuthority()),
      migrate: migrateMock(migration),
    });
    await expect(startXpublessV2DevelopmentRuntime(dependencies)).resolves.toEqual({ status: "MIGRATION_BLOCKED", reason: migration.status });
    expect(dependencies.inspect).toHaveBeenCalledTimes(1);
    expect(dependencies.migrate).toHaveBeenCalledTimes(1);
  });

  it("keeps browser coordination failures distinct from P3B blockers", async () => {
    const dependencies = runtimeDependencies({
      inspect: inspectMock(legacyAuthority()),
      migrate: migrateMock({ status: "FAILED_BROWSER_COORDINATION" }),
    });
    await expect(startXpublessV2DevelopmentRuntime(dependencies)).resolves.toEqual({ status: "FAILED_BROWSER_COORDINATION" });
  });

  it.each([
    ["xpubless", { status: "XPUBLESS_AUTHORITY", state: xpublessState() }, { status: "XPUBLESS_READY" }],
    ["empty", { status: "EMPTY_LOCAL_STATE" }, { status: "EMPTY_READY" }],
  ] as const)("reinspects after NO_LEGACY_STATE because another tab may leave %s authority", async (_name, secondInspection, expected) => {
    const dependencies = runtimeDependencies({
      inspect: inspectMock(legacyAuthority(), secondInspection),
      migrate: migrateMock({ status: "NO_LEGACY_STATE" }),
    });
    await expect(startXpublessV2DevelopmentRuntime(dependencies)).resolves.toMatchObject(expected);
    expect(dependencies.inspect).toHaveBeenCalledTimes(2);
  });

  const postMigrationCases: Array<[string, XpublessV2BrowserAuthorityInspectionResult, Record<string, unknown>]> = [
    ["ambiguous", { status: "AMBIGUOUS_BLOCKED", presentLegacyKeys: ["timesats.vault-plans.v3"] }, { status: "AUTHORITY_BLOCKED", reason: "AMBIGUOUS_BLOCKED" }],
    ["corrupt", { status: "BLOCKED_CORRUPT_TARGET" }, { status: "AUTHORITY_BLOCKED", reason: "BLOCKED_CORRUPT_TARGET" }],
    ["still migrating", { status: "MIGRATION_IN_PROGRESS_OR_RESUMABLE", phase: "TARGET_VERIFIED" }, { status: "MIGRATION_BLOCKED", reason: "MIGRATION_IN_PROGRESS_OR_RESUMABLE" }],
  ];

  it.each(postMigrationCases)("never reports ready when COMPLETE reinspection is %s", async (_name, secondInspection, expected) => {
    const dependencies = runtimeDependencies({
      inspect: inspectMock(legacyAuthority(), secondInspection),
    });
    await expect(startXpublessV2DevelopmentRuntime(dependencies)).resolves.toEqual(expected);
    expect(dependencies.migrate).toHaveBeenCalledTimes(1);
    expect(dependencies.inspect).toHaveBeenCalledTimes(2);
  });

  it("fails closed when an eligible migration lacks crypto.randomUUID without invoking P3B", async () => {
    const dependencies = runtimeDependencies({
      inspect: inspectMock(legacyAuthority()),
      createUuidSource: vi.fn(() => null),
    });
    await expect(startXpublessV2DevelopmentRuntime(dependencies)).resolves.toEqual({
      status: "RUNTIME_UNAVAILABLE",
      reason: "UNAVAILABLE_UUID_SOURCE",
    });
    expect(dependencies.migrate).not.toHaveBeenCalled();
  });
});
