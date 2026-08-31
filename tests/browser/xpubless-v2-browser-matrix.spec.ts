import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createXpublessV2PlanState } from "../../src/bitcoin/xpubless-v2-plan-state";
import { createVaultPlan } from "../../src/bitcoin/vault-plan";
import { validTestTpub, validTestTpubOrigin } from "../../src/tests/fixtures";
import {
  createInitialXpublessV2LocalState,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XpublessV2LocalStateSchema,
  type XpublessV2LocalState,
} from "../../src/storage/xpubless-v2-local-state";
import { XPUBLESS_V2_BROWSER_LOCK_NAME } from "../../src/storage/xpubless-v2-browser";

const ORIGIN = "http://127.0.0.1:4179";
const STATE_ID = "45d5e9b0-11c2-4d3e-8f40-1234567890ab";
const PLAN_ID = "55d5e9b0-11c2-4d3e-8f40-1234567890ab";
const TEST_STORAGE_KEY = "__timesats_p3d4_matrix_visibility__";

type HarnessApi = {
  reset(entries: Record<string, string>): void;
  targetSetCount(): number;
  issuance(request: {
    expectedState: unknown;
    localInstanceId: string;
    presentedExtendedPublicKey: string;
  }): Promise<unknown>;
  issuanceWithoutExclusiveWriter(request: {
    expectedState: unknown;
    localInstanceId: string;
    presentedExtendedPublicKey: string;
  }): Promise<unknown>;
};

type LockAttempt =
  | { status: "LOCK_UNAVAILABLE" }
  | { status: "LOCK_ACQUIRED"; name: string; mode: string };

type TestWindow = typeof globalThis & {
  __timesatsP3D4HeldLock?: { started: boolean; release: () => void; completion: Promise<void> };
};

async function openHarness(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(ORIGIN);
  await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __timesatsP3D3?: unknown }).__timesatsP3D3))).toBe(true);
  return page;
}

function initialState(): XpublessV2LocalState {
  const plan = createVaultPlan({
    label: "P3D4 browser matrix",
    network: "regtest",
    unlockHeight: 250,
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

function requestFor(expectedState: XpublessV2LocalState) {
  return {
    expectedState,
    localInstanceId: PLAN_ID,
    presentedExtendedPublicKey: validTestTpub,
  };
}

async function reset(page: Page, entries: Record<string, string>): Promise<void> {
  await page.evaluate((nextEntries) => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D4 test harness API was not installed.");
    api.reset(nextEntries);
  }, entries);
}

async function issue(page: Page, expectedState: XpublessV2LocalState, withoutLockManager = false): Promise<{ status: string }> {
  return page.evaluate(({ request, noLockManager }) => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D4 test harness API was not installed.");
    return noLockManager ? api.issuanceWithoutExclusiveWriter(request) : api.issuance(request);
  }, { request: requestFor(expectedState), noLockManager: withoutLockManager }) as Promise<{ status: string }>;
}

async function holdLock(page: Page): Promise<void> {
  await page.evaluate((name) => {
    const testWindow = globalThis as TestWindow;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const state = { started: false, release, completion: Promise.resolve() };
    state.completion = navigator.locks.request(name, { mode: "exclusive" }, async () => {
      state.started = true;
      await gate;
    });
    testWindow.__timesatsP3D4HeldLock = state;
  }, XPUBLESS_V2_BROWSER_LOCK_NAME);
  await expect.poll(() => page.evaluate(() => (globalThis as TestWindow).__timesatsP3D4HeldLock?.started ?? false)).toBe(true);
}

async function releaseLock(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const state = (globalThis as TestWindow).__timesatsP3D4HeldLock;
    if (!state) throw new Error("Expected P3D4 test-only held lock.");
    state.release();
    await state.completion;
  });
}

async function failFastAttempt(page: Page): Promise<LockAttempt> {
  return page.evaluate(async (name) => navigator.locks.request(
    name,
    { mode: "exclusive", ifAvailable: true },
    (lock): LockAttempt => lock === null
      ? { status: "LOCK_UNAVAILABLE" }
      : { status: "LOCK_ACQUIRED", name: lock.name, mode: lock.mode },
  ), XPUBLESS_V2_BROWSER_LOCK_NAME);
}

test.describe("P3D4 real browser capability matrix", () => {
  test("classifies the tested engine and either executes P3C or fails closed without Web Locks", async ({ browser }, testInfo) => {
    const context = await browser.newContext();
    try {
      const pageA = await openHarness(context);
      const pageB = await openHarness(context);
      const capability = await pageA.evaluate(() => {
        const key = "__timesats_p3d4_matrix_localstorage_probe__";
        try {
          localStorage.setItem(key, "available");
          const visible = localStorage.getItem(key) === "available";
          localStorage.removeItem(key);
          return {
            secureContext: window.isSecureContext,
            lockRequestType: typeof navigator.locks?.request,
            localStorageAvailable: visible,
          };
        } catch {
          return {
            secureContext: window.isSecureContext,
            lockRequestType: typeof navigator.locks?.request,
            localStorageAvailable: false,
          };
        }
      });
      expect(capability.secureContext).toBe(true);
      expect(capability.localStorageAvailable).toBe(true);

      await pageA.evaluate(([key, value]) => localStorage.setItem(key, value), [TEST_STORAGE_KEY, "page-a"]);
      await expect.poll(() => pageB.evaluate((key) => localStorage.getItem(key), TEST_STORAGE_KEY)).toBe("page-a");
      await pageB.evaluate(([key, value]) => localStorage.setItem(key, value), [TEST_STORAGE_KEY, "page-b"]);
      await expect.poll(() => pageA.evaluate((key) => localStorage.getItem(key), TEST_STORAGE_KEY)).toBe("page-b");

      const expected = initialState();
      await reset(pageA, { [XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY]: JSON.stringify(expected) });

      const unavailableWriter = await issue(pageA, expected, true);
      expect(unavailableWriter).toEqual({ status: "UNSUPPORTED_EXCLUSIVE_WRITER" });
      expect(await pageA.evaluate((key) => localStorage.getItem(key), XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)).toBe(JSON.stringify(expected));
      const targetSets = await pageA.evaluate(() => {
        const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
        if (!api) throw new Error("P3D4 test harness API was not installed.");
        return api.targetSetCount();
      });
      expect(targetSets).toBe(0);

      if (capability.lockRequestType !== "function") {
        console.log(`P3D4 matrix ${testInfo.project.name} ${await browser.version()}: EXCLUSIVE_WRITER_UNAVAILABLE`);
        return;
      }

      await holdLock(pageA);
      expect(await failFastAttempt(pageB)).toEqual({ status: "LOCK_UNAVAILABLE" });
      await releaseLock(pageA);
      expect(await failFastAttempt(pageB)).toEqual({
        status: "LOCK_ACQUIRED",
        name: XPUBLESS_V2_BROWSER_LOCK_NAME,
        mode: "exclusive",
      });

      const issued = await issue(pageA, expected);
      expect(issued.status).toBe("COMMITTED");
      const rawTarget = await pageA.evaluate((key) => localStorage.getItem(key), XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY);
      if (!rawTarget) throw new Error("Expected P3D4 browser-matrix target.");
      const target = XpublessV2LocalStateSchema.parse(JSON.parse(rawTarget));
      expect(target.revision).toBe(1);
      expect(target.plans[0]?.lastIssuedIndex).toBe(1);
      expect(rawTarget).not.toContain(validTestTpub);
      console.log(`P3D4 matrix ${testInfo.project.name} ${await browser.version()}: PROVEN_FOR_TESTED_SCOPE`);
    } finally {
      await context.close();
    }
  });
});
