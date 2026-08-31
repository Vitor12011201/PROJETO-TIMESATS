import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  appendIssuedDepositToXpublessV2PlanState,
  createXpublessV2PlanState,
  rehydrateXpublessV2PlanState,
} from "../../src/bitcoin/xpubless-v2-plan-state";
import { createVaultPlan, deriveDeposit } from "../../src/bitcoin/vault-plan";
import { validTestTpub, validTestTpubOrigin } from "../../src/tests/fixtures";
import {
  buildNextXpublessV2LocalState,
  createInitialXpublessV2LocalState,
  XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY,
  XpublessV2LocalStateSchema,
  type XpublessV2LocalState,
} from "../../src/storage/xpubless-v2-local-state";
import type { XpublessV2CommittedIssuanceResult } from "../../src/storage/xpubless-v2-committed-issuance";

const ORIGIN = "http://127.0.0.1:4179";
const STATE_ID = "65d5e9b0-11c2-4d3e-8f40-1234567890ab";
const PLAN_ID = "75d5e9b0-11c2-4d3e-8f40-1234567890ab";
const QUOTA_KEY_PREFIX = "__timesats_p3d4_quota_";
const QUOTA_CHUNK_BYTES = 64 * 1024;
const QUOTA_MAX_ITERATIONS = 256;
const QUOTA_MAX_CHARS = 16 * 1024 * 1024;
const QUOTA_REFINEMENT_STEP_BYTES = 32;
const QUOTA_REFINEMENT_MAX_STEPS = 128;

type HarnessApi = {
  reset(entries: Record<string, string>): void;
  readStorage(key: string): string | null;
  issuance(request: {
    expectedState: unknown;
    localInstanceId: string;
    presentedExtendedPublicKey: string;
  }): Promise<unknown>;
};

interface QuotaFillResult {
  fillerKeys: string[];
  storedChars: number;
  error: { name: string; message: string; isDomException: boolean } | null;
  probeFailed: boolean;
}

async function openHarness(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.goto(ORIGIN);
  await expect.poll(() => page.evaluate(() => Boolean((window as typeof window & { __timesatsP3D3?: unknown }).__timesatsP3D3))).toBe(true);
  return page;
}

function initialState(): XpublessV2LocalState {
  const plan = createVaultPlan({
    label: "P3D4 quota issuance",
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

function expectedNextSerializedLength(expectedState: XpublessV2LocalState): number {
  const currentPlanState = expectedState.plans.find((plan) => plan.localInstanceId === PLAN_ID);
  if (!currentPlanState) throw new Error("Expected P3D4 plan state.");
  const rehydrated = rehydrateXpublessV2PlanState(currentPlanState, validTestTpub);
  const nextDeposit = deriveDeposit(rehydrated, currentPlanState.lastIssuedIndex + 1);
  const nextPlan = appendIssuedDepositToXpublessV2PlanState(currentPlanState, rehydrated, {
    index: nextDeposit.index,
    outputScript: nextDeposit.outputScript,
  });
  return JSON.stringify(buildNextXpublessV2LocalState(expectedState, {
    plans: [nextPlan],
    archivedLocalInstanceIds: expectedState.archivedLocalInstanceIds,
    hiddenDepositIndexes: expectedState.hiddenDepositIndexes,
  })).length;
}

async function reset(page: Page, entries: Record<string, string>): Promise<void> {
  await page.evaluate((nextEntries) => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D4 test harness API was not installed.");
    api.reset(nextEntries);
  }, entries);
}

async function readTarget(page: Page): Promise<XpublessV2LocalState> {
  const raw = await page.evaluate((key) => localStorage.getItem(key), XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY);
  if (!raw) throw new Error("Expected a persisted P3D4 target.");
  return XpublessV2LocalStateSchema.parse(JSON.parse(raw));
}

async function issue(page: Page, expectedState: XpublessV2LocalState): Promise<XpublessV2CommittedIssuanceResult> {
  return page.evaluate((request) => {
    const api = (window as typeof window & { __timesatsP3D3?: HarnessApi }).__timesatsP3D3;
    if (!api) throw new Error("P3D4 test harness API was not installed.");
    return api.issuance(request);
  }, requestFor(expectedState)) as Promise<XpublessV2CommittedIssuanceResult>;
}

async function fillUntilQuota(page: Page, probeBytes: number): Promise<QuotaFillResult> {
  return page.evaluate((settings) => {
    const fillerKeys: string[] = [];
    let storedChars = 0;
    let sequence = 0;
    const observeError = (cause: unknown) => ({
      name: cause instanceof Error ? cause.name : "UnknownError",
      message: cause instanceof Error ? cause.message : String(cause),
      isDomException: cause instanceof DOMException,
    });
    const write = (size: number): { error: ReturnType<typeof observeError> | null } => {
      const key = `${settings.prefix}${sequence.toString().padStart(4, "0")}__`;
      sequence += 1;
      try {
        localStorage.setItem(key, "q".repeat(size));
        fillerKeys.push(key);
        storedChars += size;
        return { error: null };
      } catch (cause) {
        return { error: observeError(cause) };
      }
    };

    let firstError: ReturnType<typeof observeError> | null = null;
    for (let index = 0; index < settings.maxIterations && storedChars + settings.chunkBytes <= settings.maxChars; index += 1) {
      const attempt = write(settings.chunkBytes);
      if (attempt.error) {
        firstError = attempt.error;
        break;
      }
    }

    for (let index = 0; index < settings.maxIterations && storedChars + settings.probeBytes <= settings.maxChars; index += 1) {
      const attempt = write(settings.probeBytes);
      if (attempt.error) {
        firstError ??= attempt.error;
        break;
      }
    }

    const refinementKey = `${settings.prefix}refinement__`;
    let refinementValue = "";
    const refine = (size: number): ReturnType<typeof observeError> | null => {
      const nextValue = refinementValue + "r".repeat(size);
      try {
        localStorage.setItem(refinementKey, nextValue);
        if (refinementValue.length === 0) fillerKeys.push(refinementKey);
        refinementValue = nextValue;
        storedChars += size;
        return null;
      } catch (cause) {
        return observeError(cause);
      }
    };

    let stepFailure: ReturnType<typeof observeError> | null = null;
    for (let index = 0; index < settings.refinementMaxSteps
      && storedChars + settings.refinementStepBytes <= settings.maxChars; index += 1) {
      stepFailure = refine(settings.refinementStepBytes);
      if (stepFailure) break;
    }
    if (!stepFailure) return { fillerKeys, storedChars, error: firstError, probeFailed: false };

    for (let index = 0; index < settings.refinementStepBytes
      && storedChars + 1 <= settings.maxChars; index += 1) {
      const unitFailure = refine(1);
      if (unitFailure) return { fillerKeys, storedChars, error: unitFailure, probeFailed: true };
    }

    return { fillerKeys, storedChars, error: stepFailure, probeFailed: false };
  }, {
    prefix: QUOTA_KEY_PREFIX,
    chunkBytes: QUOTA_CHUNK_BYTES,
    maxIterations: QUOTA_MAX_ITERATIONS,
    maxChars: QUOTA_MAX_CHARS,
    probeBytes,
    refinementStepBytes: QUOTA_REFINEMENT_STEP_BYTES,
    refinementMaxSteps: QUOTA_REFINEMENT_MAX_STEPS,
  });
}

async function removeOnlyFiller(page: Page, fillerKeys: readonly string[]): Promise<void> {
  await page.evaluate((keys) => {
    keys.forEach((key) => localStorage.removeItem(key));
  }, [...fillerKeys]);
}

test.describe("P3D4 real Chromium localStorage quota", () => {
  test("withholds P3C disclosure on real quota failure and succeeds after test-only filler is removed", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const page = await openHarness(context);
      const expected = initialState();
      const currentLength = JSON.stringify(expected).length;
      const nextLength = expectedNextSerializedLength(expected);
      const requiredGrowth = Math.max(1, nextLength - currentLength);
      const probeBytes = Math.max(requiredGrowth * 2 + 256, 1024);

      await reset(page, { [XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY]: JSON.stringify(expected) });
      const fill = await fillUntilQuota(page, probeBytes);
      expect(fill.error).not.toBeNull();
      if (!fill.error) throw new Error("Bounded P3D4 quota fill did not observe a storage failure.");
      expect(fill.storedChars).toBeLessThanOrEqual(QUOTA_MAX_CHARS);
      expect(fill.fillerKeys).not.toHaveLength(0);
      expect(fill.probeFailed).toBe(true);
      console.log(`P3D4 Chromium quota observation: ${fill.error.name}; DOMException=${fill.error.isDomException}; probeBytes=${probeBytes}; storedChars=${fill.storedChars}`);

      const failed = await issue(page, expected);
      expect(failed).toEqual({ status: "FAILED_RECOVERABLE" });
      expect("deposit" in failed).toBe(false);
      const afterFailure = await readTarget(page);
      expect(afterFailure.revision).toBe(0);
      expect(afterFailure.plans[0]?.lastIssuedIndex).toBe(0);

      await removeOnlyFiller(page, fill.fillerKeys);
      expect(await page.evaluate((key) => localStorage.getItem(key), XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY)).not.toBeNull();
      const retry = await issue(page, expected);
      expect(retry.status).toBe("COMMITTED");
      if (retry.status !== "COMMITTED") throw new Error("Expected issuance after quota filler removal.");
      expect(retry.deposit.index).toBe(1);
      const finalState = await readTarget(page);
      expect(finalState.revision).toBe(1);
      expect(finalState.plans[0]?.lastIssuedIndex).toBe(1);
    } finally {
      await context.close();
    }
  });
});
