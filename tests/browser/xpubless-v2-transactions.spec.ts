import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createXpublessV2PlanState } from "../../src/bitcoin/xpubless-v2-plan-state";
import { createVaultPlan, deriveDeposit, issueNextDeposit, vaultPlanIdentity } from "../../src/bitcoin/vault-plan";
import { validTestTpub, validTestTpubOrigin } from "../../src/tests/fixtures";
import {
  XPUBLESS_V2_LEGACY_STORAGE_KEYS,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY,
  XpublessV2LocalStateSchema,
  createInitialXpublessV2LocalState,
  type XpublessV2LocalState,
} from "../../src/storage/xpubless-v2-local-state";
import type { XpublessV2CommittedIssuanceResult } from "../../src/storage/xpubless-v2-committed-issuance";

const ORIGIN = "http://127.0.0.1:4179";
const STATE_ID = "75d5e9b0-11c2-4d3e-8f40-1234567890ab";
const PLAN_ID = "85d5e9b0-11c2-4d3e-8f40-1234567890ab";
const MIGRATION_ID = "95d5e9b0-11c2-4d3e-8f40-1234567890ab";
const MIGRATION_STATE_ID = "a5d5e9b0-11c2-4d3e-8f40-1234567890ab";
const MIGRATION_PLAN_ID = "b5d5e9b0-11c2-4d3e-8f40-1234567890ab";

type StorageFault = "NORMAL" | "THROW_AFTER_TARGET_SET" | "THROW_AFTER_FIRST_LEGACY_REMOVE";

type HarnessApi = {
  reset(entries: Record<string, string>): void;
  readStorage(key: string): string | null;
  configureFault(fault: StorageFault): void;
  targetSetCount(): number;
  pauseNextLock(): void;
  lockPauseStarted(): boolean;
  releasePausedLock(): void;
  migration(ids: { migrationId: string; stateId: string; localInstanceIds: string[] }): Promise<unknown>;
  issuance(request: {
    expectedState: unknown;
    localInstanceId: string;
    presentedExtendedPublicKey: string;
  }): Promise<unknown>;
};

async function openHarness(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(ORIGIN);
  await waitForHarness(page);
  return page;
}

async function waitForHarness(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __timesatsP3D3?: unknown }).__timesatsP3D3))).toBe(true);
}

function v2Plan(label: string, lastIssuedIndex = 0) {
  let plan = createVaultPlan({
    label,
    network: "regtest",
    unlockHeight: 250,
    extendedPublicKey: validTestTpub,
    policyVersion: 2,
    keyOrigin: validTestTpubOrigin,
  });
  while (plan.lastIssuedIndex < lastIssuedIndex) plan = issueNextDeposit(plan).plan;
  return plan;
}

function legacyV3Snapshot(plan: ReturnType<typeof v2Plan>): Record<string, string> {
  return {
    [XPUBLESS_V2_LEGACY_STORAGE_KEYS[0]]: JSON.stringify({
      format: "timesats-local-vault-plans",
      version: 3,
      plans: [plan],
    }),
  };
}

function initialState(lastIssuedIndex: number): XpublessV2LocalState {
  return createInitialXpublessV2LocalState({
    stateId: STATE_ID,
    plans: [createXpublessV2PlanState(v2Plan("P3D3 issuance", lastIssuedIndex), PLAN_ID)],
    archivedLocalInstanceIds: [],
    hiddenDepositIndexes: {},
  });
}

function storedTarget(state: XpublessV2LocalState): Record<string, string> {
  return { [XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY]: JSON.stringify(state) };
}

function issuanceRequest(expectedState: XpublessV2LocalState) {
  return {
    expectedState,
    localInstanceId: PLAN_ID,
    presentedExtendedPublicKey: validTestTpub,
  };
}

function migrationIds() {
  return {
    migrationId: MIGRATION_ID,
    stateId: MIGRATION_STATE_ID,
    localInstanceIds: [MIGRATION_PLAN_ID],
  };
}

async function reset(page: Page, entries: Record<string, string>): Promise<void> {
  await page.evaluate((nextEntries) => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D3 test harness API was not installed.");
    api.reset(nextEntries);
  }, entries);
}

async function readStorage(page: Page, key: string): Promise<string | null> {
  return page.evaluate((storageKey) => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D3 test harness API was not installed.");
    return api.readStorage(storageKey);
  }, key);
}

async function runMigration(page: Page): Promise<{ status: string }> {
  return page.evaluate((ids) => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D3 test harness API was not installed.");
    return api.migration(ids);
  }, migrationIds()) as Promise<{ status: string }>;
}

async function runIssuance(page: Page, expectedState: XpublessV2LocalState): Promise<XpublessV2CommittedIssuanceResult> {
  return page.evaluate((request) => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D3 test harness API was not installed.");
    return api.issuance(request);
  }, issuanceRequest(expectedState)) as Promise<XpublessV2CommittedIssuanceResult>;
}

async function configureFault(page: Page, fault: StorageFault): Promise<void> {
  await page.evaluate((nextFault) => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D3 test harness API was not installed.");
    api.configureFault(nextFault);
  }, fault);
}

async function pauseNextLock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D3 test harness API was not installed.");
    api.pauseNextLock();
  });
}

async function lockPauseStarted(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D3 test harness API was not installed.");
    return api.lockPauseStarted();
  });
}

async function releasePausedLock(page: Page): Promise<void> {
  await page.evaluate(() => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D3 test harness API was not installed.");
    api.releasePausedLock();
  });
}

async function targetSetCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D3 test harness API was not installed.");
    return api.targetSetCount();
  });
}

function parsedTarget(raw: string | null): XpublessV2LocalState {
  if (!raw) throw new Error("Expected a persisted xpubless target.");
  return XpublessV2LocalStateSchema.parse(JSON.parse(raw));
}

test.describe("P3D3 real Chromium xpubless transactions", () => {
  test("runs P3B migration through P3D1 against real localStorage and survives reload", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await openHarness(context);
      const legacyPlan = v2Plan("P3D3 migration", 1);
      await reset(page, legacyV3Snapshot(legacyPlan));

      expect(await runMigration(page)).toEqual({ status: "COMPLETE_XPUBLESS" });
      const rawTarget = await readStorage(page, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY);
      const target = parsedTarget(rawTarget);
      expect(target.stateId).toBe(MIGRATION_STATE_ID);
      expect(target.plans[0]?.localInstanceId).toBe(MIGRATION_PLAN_ID);
      expect(target.plans[0]?.lastIssuedIndex).toBe(1);
      expect(await readStorage(page, XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY)).toBeNull();
      for (const key of XPUBLESS_V2_LEGACY_STORAGE_KEYS) expect(await readStorage(page, key)).toBeNull();

      const deposit = deriveDeposit(legacyPlan, 1);
      expect(rawTarget).not.toContain(validTestTpub);
      expect(rawTarget).not.toContain(vaultPlanIdentity(legacyPlan));
      expect(rawTarget).not.toContain(deposit.publicKey);
      expect(rawTarget).not.toContain(deposit.witnessScript);
      expect(rawTarget).not.toContain(deposit.descriptor);

      await page.reload();
      await waitForHarness(page);
      expect(await runMigration(page)).toEqual({ status: "COMPLETE_XPUBLESS" });
      expect(parsedTarget(await readStorage(page, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY))).toEqual(target);
      expect(await readStorage(page, XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY)).toBeNull();
      for (const key of XPUBLESS_V2_LEGACY_STORAGE_KEYS) expect(await readStorage(page, key)).toBeNull();
    } finally {
      await context.close();
    }
  });

  test("resumes P3B after a test-only exception following a real legacy removeItem", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await openHarness(context);
      await reset(page, legacyV3Snapshot(v2Plan("P3D3 migration resume")));
      await configureFault(page, "THROW_AFTER_FIRST_LEGACY_REMOVE");

      expect(await runMigration(page)).toEqual({ status: "FAILED_RECOVERABLE" });
      expect(await readStorage(page, XPUBLESS_V2_LEGACY_STORAGE_KEYS[0])).toBeNull();
      expect(await readStorage(page, XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY)).not.toBeNull();
      expect(await readStorage(page, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)).not.toBeNull();

      await page.reload();
      await waitForHarness(page);
      expect(await runMigration(page)).toEqual({ status: "COMPLETE_XPUBLESS" });
      expect(await readStorage(page, XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY)).toBeNull();
      for (const key of XPUBLESS_V2_LEGACY_STORAGE_KEYS) expect(await readStorage(page, key)).toBeNull();
    } finally {
      await context.close();
    }
  });

  test("runs P3C committed issuance through P3D1, persists across reload, and replays #1", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await openHarness(context);
      const expected = initialState(0);
      await reset(page, storedTarget(expected));

      const first = await runIssuance(page, expected);
      expect(first.status).toBe("COMMITTED");
      if (first.status !== "COMMITTED") throw new Error("Expected committed issuance.");
      const canonicalDeposit = deriveDeposit(v2Plan("P3D3 issuance", 0), 1);
      expect(first).toEqual({
        status: "COMMITTED",
        stateId: STATE_ID,
        revision: 1,
        deposit: { localInstanceId: PLAN_ID, index: 1, address: canonicalDeposit.address, outputScript: canonicalDeposit.outputScript },
      });
      const rawTarget = await readStorage(page, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY);
      const persisted = parsedTarget(rawTarget);
      expect(persisted.revision).toBe(1);
      expect(persisted.plans[0]?.lastIssuedIndex).toBe(1);
      expect(rawTarget).not.toContain(validTestTpub);
      expect(rawTarget).not.toContain(first.deposit.address);
      expect(rawTarget).not.toContain(canonicalDeposit.publicKey);
      expect(rawTarget).not.toContain(canonicalDeposit.witnessScript);
      expect(rawTarget).not.toContain(canonicalDeposit.descriptor);

      await page.reload();
      await waitForHarness(page);
      expect(parsedTarget(await readStorage(page, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY))).toEqual(persisted);
      expect(await targetSetCount(page)).toBe(0);
      expect(await runIssuance(page, expected)).toEqual(first);
      expect(await targetSetCount(page)).toBe(0);
    } finally {
      await context.close();
    }
  });

  test("uses real Web Locks for two-tab P3C blocking and same-request #4 replay without #5", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const pageA = await openHarness(context);
      const pageB = await openHarness(context);
      const expected = initialState(3);
      await reset(pageA, storedTarget(expected));
      await pauseNextLock(pageA);
      const commitA = runIssuance(pageA, expected);
      await expect.poll(() => lockPauseStarted(pageB)).toBe(true);

      expect(await runIssuance(pageB, expected)).toEqual({ status: "BLOCKED_CONCURRENT_WRITER" });
      await releasePausedLock(pageB);
      const resultA = await commitA;
      expect(resultA.status).toBe("COMMITTED");
      if (resultA.status !== "COMMITTED") throw new Error("Expected tab A to commit #4.");
      expect(resultA.deposit.index).toBe(4);

      const committedRaw = await readStorage(pageA, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY);
      await expect.poll(() => readStorage(pageB, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)).toBe(committedRaw);
      expect(await targetSetCount(pageB)).toBe(0);
      const resultB = await runIssuance(pageB, expected);
      expect(resultB).toEqual(resultA);
      expect(await targetSetCount(pageB)).toBe(0);
      const persisted = parsedTarget(await readStorage(pageB, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY));
      expect(persisted.revision).toBe(1);
      expect(persisted.plans[0]?.lastIssuedIndex).toBe(4);
    } finally {
      await context.close();
    }
  });

  test("withholds disclosure after a real target setItem failure and replays the persisted #1 without a second write", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await openHarness(context);
      const expected = initialState(0);
      await reset(page, storedTarget(expected));
      await configureFault(page, "THROW_AFTER_TARGET_SET");

      const failed = await runIssuance(page, expected);
      expect(failed).toEqual({ status: "FAILED_RECOVERABLE" });
      expect("deposit" in failed).toBe(false);
      const persistedAfterFailure = parsedTarget(await readStorage(page, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY));
      expect(persistedAfterFailure.revision).toBe(1);
      expect(persistedAfterFailure.plans[0]?.lastIssuedIndex).toBe(1);
      expect(await targetSetCount(page)).toBe(1);

      const retry = await runIssuance(page, expected);
      expect(retry.status).toBe("COMMITTED");
      if (retry.status !== "COMMITTED") throw new Error("Expected replay after persisted target.");
      expect(retry.deposit.index).toBe(1);
      expect(await targetSetCount(page)).toBe(1);
      expect(parsedTarget(await readStorage(page, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY))).toEqual(persistedAfterFailure);
    } finally {
      await context.close();
    }
  });

  test("blocks P3C real issuance when a journal residue is present without writing the target", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await openHarness(context);
      const expected = initialState(0);
      await reset(page, {
        ...storedTarget(expected),
        [XPUBLESS_V2_MIGRATION_JOURNAL_STORAGE_KEY]: "test-only journal residue",
      });

      expect(await runIssuance(page, expected)).toEqual({ status: "BLOCKED_STORAGE_NOT_READY" });
      expect(await targetSetCount(page)).toBe(0);
      expect(parsedTarget(await readStorage(page, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY))).toEqual(expected);
    } finally {
      await context.close();
    }
  });
});
