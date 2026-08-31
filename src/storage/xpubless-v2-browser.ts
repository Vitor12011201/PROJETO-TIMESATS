import {
  commitNextXpublessV2Deposit,
  type XpublessV2CommittedIssuanceRequest,
  type XpublessV2CommittedIssuanceResult,
} from "./xpubless-v2-committed-issuance";
import {
  runXpublessV2LegacyMigration,
  type XpublessV2LegacyMigrationResult,
  type XpublessV2MigrationUuidSource,
} from "./xpubless-v2-migration";

/** One exclusive browser coordination domain for every xpubless envelope mutation. */
export const XPUBLESS_V2_BROWSER_LOCK_NAME = "timesats:xpubless-local-state:v1" as const;

export interface XpublessV2BrowserLockRequestOptions {
  mode: "exclusive";
  ifAvailable: true;
}

/**
 * Structural subset of the asynchronous Web Locks API. It is injected so P3D1
 * unit tests do not claim real-browser behavior.
 */
export interface XpublessV2BrowserLockManagerLike {
  request<T>(
    name: string,
    options: XpublessV2BrowserLockRequestOptions,
    callback: (lock: object | null) => T | PromiseLike<T>,
  ): Promise<T>;
}

/** Raw browser-compatible persistence boundary; it owns no storage semantics. */
export interface XpublessV2BrowserStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface XpublessV2BrowserMigrationDependencies {
  lockManager?: XpublessV2BrowserLockManagerLike | null;
  storage: XpublessV2BrowserStorageLike;
  uuidSource: XpublessV2MigrationUuidSource;
}

export interface XpublessV2BrowserCommittedIssuanceDependencies {
  lockManager?: XpublessV2BrowserLockManagerLike | null;
  storage: XpublessV2BrowserStorageLike;
}

export type XpublessV2BrowserCoordinationResult =
  | { status: "UNSUPPORTED_EXCLUSIVE_WRITER" }
  | { status: "FAILED_BROWSER_COORDINATION" };

export type XpublessV2BrowserMigrationResult =
  | XpublessV2LegacyMigrationResult
  | XpublessV2BrowserCoordinationResult;

export type XpublessV2BrowserCommittedIssuanceResult =
  | XpublessV2CommittedIssuanceResult
  | XpublessV2BrowserCoordinationResult;

type AlreadyHeldWriter = {
  runExclusive<T>(operation: () => T): { acquired: true; value: T };
};

/**
 * This closure capability is not a second lock. The outer Web Locks callback
 * already owns real exclusion; P3B/P3C only require this synchronous proof.
 */
function createAlreadyHeldWriter(): AlreadyHeldWriter {
  return {
    runExclusive<T>(operation: () => T): { acquired: true; value: T } {
      return { acquired: true, value: operation() };
    },
  };
}

type LockableEngineResult =
  | XpublessV2LegacyMigrationResult
  | XpublessV2CommittedIssuanceResult;

type BrowserLockCallbackResult<T> =
  | { kind: "LOCK_UNAVAILABLE" }
  | { kind: "ENGINE_RESULT"; value: T }
  | { kind: "ENGINE_ERROR"; cause: unknown };

/**
 * The only real lock request happens here. The synchronous writer capability
 * is created lexically inside its callback and never returned to callers.
 * Callback exceptions are enveloped so a lock-manager rejection remains
 * distinguishable from an engine/storage exception that occurred while locked.
 */
async function runInsideBrowserLock<T extends LockableEngineResult>(
  lockManager: XpublessV2BrowserLockManagerLike | null | undefined,
  operation: (writer: AlreadyHeldWriter) => T,
): Promise<T | XpublessV2BrowserCoordinationResult> {
  if (!lockManager) return { status: "UNSUPPORTED_EXCLUSIVE_WRITER" };

  let callbackResult: BrowserLockCallbackResult<T>;
  try {
    callbackResult = await lockManager.request<BrowserLockCallbackResult<T>>(
      XPUBLESS_V2_BROWSER_LOCK_NAME,
      { mode: "exclusive", ifAvailable: true },
      (lock) => {
        if (lock === null) return { kind: "LOCK_UNAVAILABLE" };
        try {
          return { kind: "ENGINE_RESULT", value: operation(createAlreadyHeldWriter()) };
        } catch (cause) {
          return { kind: "ENGINE_ERROR", cause };
        }
      },
    );
  } catch {
    return { status: "FAILED_BROWSER_COORDINATION" };
  }

  if (callbackResult.kind === "LOCK_UNAVAILABLE") return { status: "BLOCKED_CONCURRENT_WRITER" } as T;
  if (callbackResult.kind === "ENGINE_ERROR") throw callbackResult.cause;
  return callbackResult.value;
}

/**
 * UNIT/MOCK boundary only. A future browser layer injects an actual Web Locks
 * adapter and storage object; this function neither reads browser globals nor
 * changes the P3B migration state machine.
 */
export async function browserRunXpublessV2LegacyMigration(
  dependencies: XpublessV2BrowserMigrationDependencies,
): Promise<XpublessV2BrowserMigrationResult> {
  return runInsideBrowserLock(dependencies.lockManager, (exclusiveWriter) => (
    runXpublessV2LegacyMigration({
      storage: dependencies.storage,
      exclusiveWriter,
      uuidSource: dependencies.uuidSource,
    })
  ));
}

/**
 * UNIT/MOCK boundary only. Public reconnect is complete before this call; P3C
 * receives the request unchanged and remains solely responsible for issuance.
 */
export async function browserCommitNextXpublessV2Deposit(
  dependencies: XpublessV2BrowserCommittedIssuanceDependencies,
  request: XpublessV2CommittedIssuanceRequest,
): Promise<XpublessV2BrowserCommittedIssuanceResult> {
  return runInsideBrowserLock(dependencies.lockManager, (exclusiveWriter) => (
    commitNextXpublessV2Deposit({
      storage: dependencies.storage,
      exclusiveWriter,
    }, request)
  ));
}
