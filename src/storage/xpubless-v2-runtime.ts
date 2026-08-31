import type { XpublessV2AuthorityClassification } from "./xpubless-v2-authority";
import {
  browserInspectXpublessV2Authority,
  browserRunXpublessV2LegacyMigration,
  type XpublessV2BrowserAuthorityInspectionResult,
  type XpublessV2BrowserMigrationResult,
} from "./xpubless-v2-browser";
import {
  resolveXpublessV2BrowserEnvironment,
  type XpublessV2BrowserEnvironmentResult,
} from "./xpubless-v2-browser-environment";
import type { XpublessV2LocalState } from "./xpubless-v2-local-state";
import type {
  XpublessV2LegacyMigrationStatus,
  XpublessV2MigrationUuidSource,
} from "./xpubless-v2-migration";

/**
 * This experimental gate is deliberately impossible in a production build.
 * The public environment value only opts into a development runtime; it never
 * selects the authority, which is always derived from canonical storage.
 */
export interface XpublessV2DevelopmentGateEnvironment {
  NODE_ENV?: string;
  NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV?: string;
}

function currentDevelopmentGateEnvironment(): XpublessV2DevelopmentGateEnvironment {
  return {
    NODE_ENV: process.env.NODE_ENV,
    NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV: process.env.NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV,
  };
}

export function isXpublessV2DevelopmentGateEnabled(
  environment: XpublessV2DevelopmentGateEnvironment = currentDevelopmentGateEnvironment(),
): boolean {
  return environment.NODE_ENV === "development"
    && environment.NEXT_PUBLIC_TIMESATS_XPUBLESS_V2_DEV === "1";
}

type ReadyBrowserEnvironment = Extract<XpublessV2BrowserEnvironmentResult, { status: "READY" }>;
type BrowserRuntimeDependencies = Pick<ReadyBrowserEnvironment, "storage" | "lockManager">;

export type XpublessV2RuntimeUnavailableReason = Exclude<XpublessV2BrowserEnvironmentResult["status"], "READY">
  | "UNAVAILABLE_UUID_SOURCE";
export type XpublessV2RuntimeMigrationReason = Exclude<
  XpublessV2LegacyMigrationStatus,
  "COMPLETE_XPUBLESS" | "NO_LEGACY_STATE"
> | "LEGACY_AUTHORITY" | "MIGRATION_IN_PROGRESS_OR_RESUMABLE";
export type XpublessV2RuntimeAuthorityBlocker =
  | "AMBIGUOUS_BLOCKED"
  | "BLOCKED_CORRUPT_TARGET"
  | "BLOCKED_CORRUPT_JOURNAL";

/**
 * Product-oriented startup result. This is observation only: XPUBLESS_READY
 * contains no lock token, so every later mutation must lock and reread again.
 */
export type XpublessV2RuntimeStartupResult =
  | { status: "DISABLED" }
  | { status: "EMPTY_READY" }
  | { status: "XPUBLESS_READY"; state: XpublessV2LocalState }
  | { status: "MIGRATION_BLOCKED"; reason: XpublessV2RuntimeMigrationReason }
  | { status: "AUTHORITY_BLOCKED"; reason: XpublessV2RuntimeAuthorityBlocker }
  | { status: "RUNTIME_UNAVAILABLE"; reason: XpublessV2RuntimeUnavailableReason }
  | { status: "BLOCKED_CONCURRENT_WRITER" }
  | { status: "FAILED_BROWSER_COORDINATION" }
  | { status: "FAILED_RECOVERABLE" };

/** Dependencies stay injectable so runtime state-machine tests need no browser globals. */
export interface XpublessV2RuntimeDependencies {
  developmentGateEnabled: boolean;
  resolveEnvironment(): XpublessV2BrowserEnvironmentResult;
  inspect(dependencies: BrowserRuntimeDependencies): Promise<XpublessV2BrowserAuthorityInspectionResult>;
  migrate(dependencies: BrowserRuntimeDependencies & { uuidSource: XpublessV2MigrationUuidSource }): Promise<XpublessV2BrowserMigrationResult>;
  createUuidSource(): XpublessV2MigrationUuidSource | null;
}

/**
 * Browser UUIDs are opaque local identifiers, not authentication, dedupe
 * proofs, Bitcoin identities, or key material. No UUID is generated until
 * P3B actually needs one while migration runs under its writer boundary.
 */
export function createBrowserXpublessV2MigrationUuidSource(): XpublessV2MigrationUuidSource | null {
  if (typeof crypto === "undefined" || typeof crypto.randomUUID !== "function") return null;
  return {
    nextMigrationId(): string {
      return crypto.randomUUID();
    },
    nextStateId(): string {
      return crypto.randomUUID();
    },
    nextLocalInstanceId(): string {
      return crypto.randomUUID();
    },
  };
}

function defaultDependencies(): XpublessV2RuntimeDependencies {
  return {
    developmentGateEnabled: isXpublessV2DevelopmentGateEnabled(),
    resolveEnvironment: resolveXpublessV2BrowserEnvironment,
    inspect: browserInspectXpublessV2Authority,
    migrate: browserRunXpublessV2LegacyMigration,
    createUuidSource: createBrowserXpublessV2MigrationUuidSource,
  };
}

function mapNonMigrationInspection(
  inspection: XpublessV2BrowserAuthorityInspectionResult,
): XpublessV2RuntimeStartupResult {
  switch (inspection.status) {
    case "EMPTY_LOCAL_STATE":
      return { status: "EMPTY_READY" };
    case "XPUBLESS_AUTHORITY":
      return { status: "XPUBLESS_READY", state: inspection.state };
    case "LEGACY_AUTHORITY":
      return { status: "MIGRATION_BLOCKED", reason: "LEGACY_AUTHORITY" };
    case "MIGRATION_IN_PROGRESS_OR_RESUMABLE":
      return { status: "MIGRATION_BLOCKED", reason: "MIGRATION_IN_PROGRESS_OR_RESUMABLE" };
    case "AMBIGUOUS_BLOCKED":
    case "BLOCKED_CORRUPT_TARGET":
    case "BLOCKED_CORRUPT_JOURNAL":
      return { status: "AUTHORITY_BLOCKED", reason: inspection.status };
    case "BLOCKED_CONCURRENT_WRITER":
    case "FAILED_BROWSER_COORDINATION":
    case "FAILED_RECOVERABLE":
      return inspection;
    default:
      return { status: "FAILED_RECOVERABLE" };
  }
}

function requiresMigration(
  inspection: XpublessV2BrowserAuthorityInspectionResult,
): inspection is Extract<XpublessV2AuthorityClassification, {
  status: "LEGACY_AUTHORITY" | "MIGRATION_IN_PROGRESS_OR_RESUMABLE";
}> {
  return inspection.status === "LEGACY_AUTHORITY"
    || inspection.status === "MIGRATION_IN_PROGRESS_OR_RESUMABLE";
}

async function reinspectAfterMigration(
  dependencies: XpublessV2RuntimeDependencies,
  environment: BrowserRuntimeDependencies,
): Promise<XpublessV2RuntimeStartupResult> {
  return mapNonMigrationInspection(await dependencies.inspect(environment));
}

/**
 * Executes at most one P3B attempt per startup call: inspect, optionally
 * migrate/resume, then inspect again. It never falls back to legacy loading
 * once the development gate selected this experimental runtime.
 */
export async function startXpublessV2DevelopmentRuntime(
  dependencies: XpublessV2RuntimeDependencies = defaultDependencies(),
): Promise<XpublessV2RuntimeStartupResult> {
  if (!dependencies.developmentGateEnabled) return { status: "DISABLED" };

  const environment = dependencies.resolveEnvironment();
  if (environment.status !== "READY") {
    return { status: "RUNTIME_UNAVAILABLE", reason: environment.status };
  }

  const inspection = await dependencies.inspect(environment);
  if (!requiresMigration(inspection)) return mapNonMigrationInspection(inspection);

  const uuidSource = dependencies.createUuidSource();
  if (!uuidSource) return { status: "RUNTIME_UNAVAILABLE", reason: "UNAVAILABLE_UUID_SOURCE" };

  const migration = await dependencies.migrate({ ...environment, uuidSource });
  if (migration.status !== "COMPLETE_XPUBLESS" && migration.status !== "NO_LEGACY_STATE") {
    if (migration.status === "BLOCKED_CONCURRENT_WRITER") return { status: "MIGRATION_BLOCKED", reason: migration.status };
    if (migration.status === "FAILED_BROWSER_COORDINATION") return { status: "FAILED_BROWSER_COORDINATION" };
    if (migration.status === "UNSUPPORTED_EXCLUSIVE_WRITER") {
      return { status: "RUNTIME_UNAVAILABLE", reason: migration.status };
    }
    return { status: "MIGRATION_BLOCKED", reason: migration.status };
  }

  // Migration status alone is never authority evidence; canonical surfaces win.
  return reinspectAfterMigration(dependencies, environment);
}
