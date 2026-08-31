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
import {
  classifyXpublessV2Authority,
  readXpublessV2AuthorityRawSnapshot,
  type XpublessV2AuthorityClassification,
} from "./xpubless-v2-authority";
import {
  commitArchiveXpublessV2Plan,
  commitCreateXpublessV2Plan,
  commitHideXpublessV2Deposit,
  commitImportXpublessV2Plan,
  commitRemoveXpublessV2Plan,
  commitRenameXpublessV2Plan,
  commitRestoreArchivedXpublessV2Plan,
  commitRestoreHiddenXpublessV2Deposit,
  type XpublessV2CommittedMutationResult,
  type XpublessV2CreatePlanRequest,
  type XpublessV2HiddenDepositMutationRequest,
  type XpublessV2ImportPlanRequest,
  type XpublessV2PlanMutationRequest,
  type XpublessV2RenamePlanMutationRequest,
} from "./xpubless-v2-committed-mutations";

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
  | { status: "BLOCKED_CONCURRENT_WRITER" }
  | { status: "UNSUPPORTED_EXCLUSIVE_WRITER" }
  | { status: "FAILED_BROWSER_COORDINATION" };

export type XpublessV2BrowserMigrationResult =
  | XpublessV2LegacyMigrationResult
  | XpublessV2BrowserCoordinationResult;

export type XpublessV2BrowserCommittedIssuanceResult =
  | XpublessV2CommittedIssuanceResult
  | XpublessV2BrowserCoordinationResult;

export type XpublessV2BrowserCommittedMutationResult =
  | XpublessV2CommittedMutationResult
  | XpublessV2BrowserCoordinationResult;

export type XpublessV2BrowserAuthorityInspectionResult =
  | XpublessV2AuthorityClassification
  | { status: "FAILED_RECOVERABLE" }
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
  | XpublessV2CommittedIssuanceResult
  | XpublessV2CommittedMutationResult
  | XpublessV2AuthorityInspectionEngineResult;

type XpublessV2AuthorityInspectionEngineResult =
  | XpublessV2AuthorityClassification
  | { status: "FAILED_RECOVERABLE" };

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

type BrowserMutationDependencies = XpublessV2BrowserCommittedIssuanceDependencies;

/**
 * Reads and classifies canonical authority surfaces under the same exclusive
 * domain as every xpubless mutation. It observes only; it never writes or
 * runs migration, and callers do not receive raw legacy values. Its result is
 * not a write capability: every later mutation must acquire and reread again.
 */
export async function browserInspectXpublessV2Authority(
  dependencies: BrowserMutationDependencies,
): Promise<XpublessV2BrowserAuthorityInspectionResult> {
  return runInsideBrowserLock(dependencies.lockManager, () => (
    inspectAuthorityInsideLock(dependencies.storage)
  ));
}

function inspectAuthorityInsideLock(
  storage: XpublessV2BrowserStorageLike,
): XpublessV2AuthorityInspectionEngineResult {
  try {
    return classifyXpublessV2Authority(readXpublessV2AuthorityRawSnapshot(storage));
  } catch {
    // A ready environment can still reject a later storage read. This is not
    // a Web Locks coordination failure and cannot authorize a write path.
    return { status: "FAILED_RECOVERABLE" };
  }
}

export async function browserCommitCreateXpublessV2Plan(
  dependencies: BrowserMutationDependencies,
  request: XpublessV2CreatePlanRequest,
): Promise<XpublessV2BrowserCommittedMutationResult> {
  return runInsideBrowserLock(dependencies.lockManager, (exclusiveWriter) => (
    commitCreateXpublessV2Plan({ storage: dependencies.storage, exclusiveWriter }, request)
  ));
}

export async function browserCommitImportXpublessV2Plan(
  dependencies: BrowserMutationDependencies,
  request: XpublessV2ImportPlanRequest,
): Promise<XpublessV2BrowserCommittedMutationResult> {
  return runInsideBrowserLock(dependencies.lockManager, (exclusiveWriter) => (
    commitImportXpublessV2Plan({ storage: dependencies.storage, exclusiveWriter }, request)
  ));
}

export async function browserCommitArchiveXpublessV2Plan(dependencies: BrowserMutationDependencies, request: XpublessV2PlanMutationRequest): Promise<XpublessV2BrowserCommittedMutationResult> {
  return runInsideBrowserLock(dependencies.lockManager, (exclusiveWriter) => (
    commitArchiveXpublessV2Plan({ storage: dependencies.storage, exclusiveWriter }, request)
  ));
}

export async function browserCommitRestoreArchivedXpublessV2Plan(dependencies: BrowserMutationDependencies, request: XpublessV2PlanMutationRequest): Promise<XpublessV2BrowserCommittedMutationResult> {
  return runInsideBrowserLock(dependencies.lockManager, (exclusiveWriter) => (
    commitRestoreArchivedXpublessV2Plan({ storage: dependencies.storage, exclusiveWriter }, request)
  ));
}

export async function browserCommitHideXpublessV2Deposit(dependencies: BrowserMutationDependencies, request: XpublessV2HiddenDepositMutationRequest): Promise<XpublessV2BrowserCommittedMutationResult> {
  return runInsideBrowserLock(dependencies.lockManager, (exclusiveWriter) => (
    commitHideXpublessV2Deposit({ storage: dependencies.storage, exclusiveWriter }, request)
  ));
}

export async function browserCommitRestoreHiddenXpublessV2Deposit(dependencies: BrowserMutationDependencies, request: XpublessV2HiddenDepositMutationRequest): Promise<XpublessV2BrowserCommittedMutationResult> {
  return runInsideBrowserLock(dependencies.lockManager, (exclusiveWriter) => (
    commitRestoreHiddenXpublessV2Deposit({ storage: dependencies.storage, exclusiveWriter }, request)
  ));
}

export async function browserCommitRemoveXpublessV2Plan(dependencies: BrowserMutationDependencies, request: XpublessV2PlanMutationRequest): Promise<XpublessV2BrowserCommittedMutationResult> {
  return runInsideBrowserLock(dependencies.lockManager, (exclusiveWriter) => (
    commitRemoveXpublessV2Plan({ storage: dependencies.storage, exclusiveWriter }, request)
  ));
}

export async function browserCommitRenameXpublessV2Plan(dependencies: BrowserMutationDependencies, request: XpublessV2RenamePlanMutationRequest): Promise<XpublessV2BrowserCommittedMutationResult> {
  return runInsideBrowserLock(dependencies.lockManager, (exclusiveWriter) => (
    commitRenameXpublessV2Plan({ storage: dependencies.storage, exclusiveWriter }, request)
  ));
}
