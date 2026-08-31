import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { XPUBLESS_V2_BROWSER_LOCK_NAME } from "../../src/storage/xpubless-v2-browser";

const ORIGIN = "http://127.0.0.1:4179";
const TEST_STORAGE_KEY = "__timesats_p3d2_test_only_visibility__";

type LockAttempt =
  | { status: "LOCK_UNAVAILABLE" }
  | { status: "LOCK_ACQUIRED"; name: string; mode: string };

type HeldLockState = {
  started: boolean;
  lock: { name: string; mode: string } | null;
  error: string | null;
  release: () => void;
  completion: Promise<void>;
};

type TestWindow = typeof globalThis & {
  __timesatsP3D2HeldLock?: HeldLockState;
  __timesatsP3D2OperationLabel?: string;
};

async function openSameOriginTabs(context: BrowserContext): Promise<{ pageA: Page; pageB: Page }> {
  const pageA = await context.newPage();
  const pageB = await context.newPage();
  await Promise.all([pageA.goto(ORIGIN), pageB.goto(ORIGIN)]);
  return { pageA, pageB };
}

async function holdExclusiveLock(page: Page, lockName: string): Promise<void> {
  await page.evaluate((name) => {
    const browserWindow = globalThis as TestWindow;
    let resolveRelease!: () => void;
    const releaseGate = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const state: HeldLockState = {
      started: false,
      lock: null,
      error: null,
      release: resolveRelease,
      completion: Promise.resolve(),
    };
    state.completion = navigator.locks.request(name, { mode: "exclusive" }, async (lock) => {
      state.lock = lock === null ? null : { name: lock.name, mode: lock.mode };
      state.started = true;
      await releaseGate;
    }).catch((cause: unknown) => {
      state.error = cause instanceof Error ? cause.message : "Unknown lock callback error.";
      state.started = true;
    });
    browserWindow.__timesatsP3D2HeldLock = state;
  }, lockName);

  await expect.poll(async () => page.evaluate(() => {
    const state = (globalThis as TestWindow).__timesatsP3D2HeldLock;
    return { started: state?.started ?? false, lock: state?.lock ?? null, error: state?.error ?? null };
  })).toEqual({
    started: true,
    lock: { name: lockName, mode: "exclusive" },
    error: null,
  });
}

async function releaseHeldLock(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const state = (globalThis as TestWindow).__timesatsP3D2HeldLock;
    if (!state) throw new Error("Expected a test-only held lock.");
    state.release();
    await state.completion;
  });
}

async function requestFailFastExclusiveLock(page: Page, lockName: string): Promise<LockAttempt> {
  return page.evaluate(async (name) => navigator.locks.request(
    name,
    { mode: "exclusive", ifAvailable: true },
    (lock): LockAttempt => {
      if (lock === null) return { status: "LOCK_UNAVAILABLE" };
      return { status: "LOCK_ACQUIRED", name: lock.name, mode: lock.mode };
    },
  ), lockName);
}

async function expectEventuallyAcquired(page: Page, lockName: string): Promise<void> {
  // Bounded Playwright polling observes lifecycle release; production has no polling lock path.
  await expect.poll(
    async () => (await requestFailFastExclusiveLock(page, lockName)).status,
    { timeout: 5_000, intervals: [50, 100, 250] },
  ).toBe("LOCK_ACQUIRED");
}

test.describe("P3D2 Chromium Web Locks coordination", () => {
  test("observes a secure context, real exclusive fail-fast contention, and normal release", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { pageA, pageB } = await openSameOriginTabs(context);
      await expect(pageA.evaluate(() => ({
        secureContext: window.isSecureContext,
        lockRequestType: typeof navigator.locks?.request,
      }))).resolves.toEqual({ secureContext: true, lockRequestType: "function" });

      await holdExclusiveLock(pageA, XPUBLESS_V2_BROWSER_LOCK_NAME);
      expect(await requestFailFastExclusiveLock(pageB, XPUBLESS_V2_BROWSER_LOCK_NAME)).toEqual({ status: "LOCK_UNAVAILABLE" });

      await releaseHeldLock(pageA);
      expect(await requestFailFastExclusiveLock(pageB, XPUBLESS_V2_BROWSER_LOCK_NAME)).toEqual({
        status: "LOCK_ACQUIRED",
        name: XPUBLESS_V2_BROWSER_LOCK_NAME,
        mode: "exclusive",
      });
    } finally {
      await context.close();
    }
  });

  test("observes lock release after the tab that holds it closes", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { pageA, pageB } = await openSameOriginTabs(context);
      await holdExclusiveLock(pageA, XPUBLESS_V2_BROWSER_LOCK_NAME);
      expect(await requestFailFastExclusiveLock(pageB, XPUBLESS_V2_BROWSER_LOCK_NAME)).toEqual({ status: "LOCK_UNAVAILABLE" });

      await pageA.close();
      await expectEventuallyAcquired(pageB, XPUBLESS_V2_BROWSER_LOCK_NAME);
    } finally {
      await context.close();
    }
  });

  test("observes lock release after reload destroys the holding document", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { pageA, pageB } = await openSameOriginTabs(context);
      await holdExclusiveLock(pageA, XPUBLESS_V2_BROWSER_LOCK_NAME);
      expect(await requestFailFastExclusiveLock(pageB, XPUBLESS_V2_BROWSER_LOCK_NAME)).toEqual({ status: "LOCK_UNAVAILABLE" });

      await pageA.reload();
      await expectEventuallyAcquired(pageB, XPUBLESS_V2_BROWSER_LOCK_NAME);
    } finally {
      await context.close();
    }
  });

  test("observes same-origin localStorage visibility between two pages in one context", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { pageA, pageB } = await openSameOriginTabs(context);
      await pageA.evaluate(([key, value]) => localStorage.setItem(key, value), [TEST_STORAGE_KEY, "value-a"]);
      await expect.poll(
        async () => pageB.evaluate((key) => localStorage.getItem(key), TEST_STORAGE_KEY),
      ).toBe("value-a");

      await pageB.evaluate(([key, value]) => localStorage.setItem(key, value), [TEST_STORAGE_KEY, "value-b"]);
      await expect.poll(
        async () => pageA.evaluate((key) => localStorage.getItem(key), TEST_STORAGE_KEY),
      ).toBe("value-b");
    } finally {
      await context.close();
    }
  });

  test("observes two future issuance clients contending only at the real lock layer", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { pageA, pageB } = await openSameOriginTabs(context);
      await holdExclusiveLock(pageA, XPUBLESS_V2_BROWSER_LOCK_NAME);
      expect(await requestFailFastExclusiveLock(pageB, XPUBLESS_V2_BROWSER_LOCK_NAME)).toEqual({ status: "LOCK_UNAVAILABLE" });

      await releaseHeldLock(pageA);
      expect(await requestFailFastExclusiveLock(pageB, XPUBLESS_V2_BROWSER_LOCK_NAME)).toMatchObject({
        status: "LOCK_ACQUIRED",
        name: XPUBLESS_V2_BROWSER_LOCK_NAME,
      });
    } finally {
      await context.close();
    }
  });

  test("uses one real namespace when migration and issuance labels contend", async ({ browser }) => {
    const context = await browser.newContext();
    try {
      const { pageA, pageB } = await openSameOriginTabs(context);
      await pageA.evaluate((label) => { (globalThis as TestWindow).__timesatsP3D2OperationLabel = label; }, "migration");
      await pageB.evaluate((label) => { (globalThis as TestWindow).__timesatsP3D2OperationLabel = label; }, "issuance");

      await holdExclusiveLock(pageA, XPUBLESS_V2_BROWSER_LOCK_NAME);
      expect(await requestFailFastExclusiveLock(pageB, XPUBLESS_V2_BROWSER_LOCK_NAME)).toEqual({ status: "LOCK_UNAVAILABLE" });

      await releaseHeldLock(pageA);
      expect(await requestFailFastExclusiveLock(pageB, XPUBLESS_V2_BROWSER_LOCK_NAME)).toMatchObject({
        status: "LOCK_ACQUIRED",
        name: XPUBLESS_V2_BROWSER_LOCK_NAME,
      });
    } finally {
      await context.close();
    }
  });
});
