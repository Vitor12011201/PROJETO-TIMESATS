"use client";

import { useEffect } from "react";
import {
  browserCommitNextXpublessV2Deposit,
  browserRunXpublessV2LegacyMigration,
  type XpublessV2BrowserLockManagerLike,
  type XpublessV2BrowserLockRequestOptions,
  type XpublessV2BrowserStorageLike,
} from "../../../../src/storage/xpubless-v2-browser";
import { XPUBLESS_V2_LEGACY_STORAGE_KEYS, XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY } from "../../../../src/storage/xpubless-v2-local-state";
import type { XpublessV2CommittedIssuanceRequest } from "../../../../src/storage/xpubless-v2-committed-issuance";

type StorageFault = "NORMAL" | "THROW_AFTER_TARGET_SET" | "THROW_AFTER_FIRST_LEGACY_REMOVE";

interface MigrationIds {
  migrationId: string;
  stateId: string;
  localInstanceIds: string[];
}

interface PauseGate {
  armed: boolean;
}

interface P3D3HarnessApi {
  reset(entries: Record<string, string>): void;
  readStorage(key: string): string | null;
  configureFault(fault: StorageFault): void;
  targetSetCount(): number;
  pauseNextLock(): void;
  lockPauseStarted(): boolean;
  releasePausedLock(): void;
  migration(ids: MigrationIds): Promise<unknown>;
  issuance(request: XpublessV2CommittedIssuanceRequest): Promise<unknown>;
}

declare global {
  interface Window {
    __timesatsP3D3?: P3D3HarnessApi;
  }
}

let storageFault: StorageFault = "NORMAL";
let targetWriteCount = 0;
let pauseGate: PauseGate | null = null;
const TEST_ONLY_LOCK_GATE_KEY = "__timesats_p3d3_test_only_lock_gate__";

function createRealStorage(): XpublessV2BrowserStorageLike {
  return {
    getItem(key) {
      return localStorage.getItem(key);
    },
    setItem(key, value) {
      localStorage.setItem(key, value);
      if (key === XPUBLESS_V2_LOCAL_STATE_STORAGE_KEY) {
        targetWriteCount += 1;
        if (storageFault === "THROW_AFTER_TARGET_SET") {
          storageFault = "NORMAL";
          throw new Error("P3D3 test-only failure after real target setItem.");
        }
      }
    },
    removeItem(key) {
      localStorage.removeItem(key);
      if (storageFault === "THROW_AFTER_FIRST_LEGACY_REMOVE" && XPUBLESS_V2_LEGACY_STORAGE_KEYS.includes(key as typeof XPUBLESS_V2_LEGACY_STORAGE_KEYS[number])) {
        storageFault = "NORMAL";
        throw new Error("P3D3 test-only failure after real legacy removeItem.");
      }
    },
  };
}

function createRealLockManager(): XpublessV2BrowserLockManagerLike {
  return {
    request<T>(
      name: string,
      options: XpublessV2BrowserLockRequestOptions,
      callback: (lock: object | null) => T | PromiseLike<T>,
    ): Promise<T> {
      return navigator.locks.request(name, options, async (lock) => {
        const gate = lock === null ? null : pauseGate;
        if (gate) {
          pauseGate = null;
          localStorage.setItem(TEST_ONLY_LOCK_GATE_KEY, "started");
          // Test-only gate control; P3B/P3C never use this key or this polling path.
          await new Promise<void>((resolve) => {
            const interval = window.setInterval(() => {
              if (localStorage.getItem(TEST_ONLY_LOCK_GATE_KEY) === "release") {
                window.clearInterval(interval);
                localStorage.removeItem(TEST_ONLY_LOCK_GATE_KEY);
                resolve();
              }
            }, 10);
          });
        }
        return callback(lock);
      }) as Promise<T>;
    },
  };
}

function createMigrationUuidSource(ids: MigrationIds) {
  let localIndex = 0;
  return {
    nextMigrationId: () => ids.migrationId,
    nextStateId: () => ids.stateId,
    nextLocalInstanceId: () => {
      const value = ids.localInstanceIds[localIndex];
      localIndex += 1;
      if (!value) throw new Error("P3D3 deterministic local UUID source exhausted.");
      return value;
    },
  };
}

const api: P3D3HarnessApi = {
  reset(entries) {
    localStorage.clear();
    Object.entries(entries).forEach(([key, value]) => localStorage.setItem(key, value));
    storageFault = "NORMAL";
    targetWriteCount = 0;
    pauseGate = null;
    localStorage.removeItem(TEST_ONLY_LOCK_GATE_KEY);
  },
  readStorage(key) {
    return localStorage.getItem(key);
  },
  configureFault(fault) {
    storageFault = fault;
  },
  targetSetCount() {
    return targetWriteCount;
  },
  pauseNextLock() {
    pauseGate = { armed: true };
  },
  lockPauseStarted() {
    return localStorage.getItem(TEST_ONLY_LOCK_GATE_KEY) === "started";
  },
  releasePausedLock() {
    if (localStorage.getItem(TEST_ONLY_LOCK_GATE_KEY) !== "started") {
      throw new Error("Expected a P3D3 test-only paused lock.");
    }
    localStorage.setItem(TEST_ONLY_LOCK_GATE_KEY, "release");
  },
  migration(ids) {
    return browserRunXpublessV2LegacyMigration({
      lockManager: createRealLockManager(),
      storage: createRealStorage(),
      uuidSource: createMigrationUuidSource(ids),
    });
  },
  issuance(request) {
    return browserCommitNextXpublessV2Deposit({
      lockManager: createRealLockManager(),
      storage: createRealStorage(),
    }, request);
  },
};

export default function P3D3HarnessPage() {
  useEffect(() => {
    window.__timesatsP3D3 = api;
    return () => {
      delete window.__timesatsP3D3;
    };
  }, []);

  return <main>P3D3 test-only Next harness</main>;
}
