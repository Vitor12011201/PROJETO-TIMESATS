import { describe, expect, it } from "vitest";
import type {
  XpublessV2BrowserLockManagerLike,
  XpublessV2BrowserLockRequestOptions,
  XpublessV2BrowserStorageLike,
} from "./xpubless-v2-browser";
import {
  resolveXpublessV2BrowserEnvironment,
  type XpublessV2BrowserEnvironmentHost,
} from "./xpubless-v2-browser-environment";

class ReceiverStorage implements XpublessV2BrowserStorageLike {
  readonly values = new Map<string, string>();
  readonly calls: string[] = [];

  getItem(key: string): string | null {
    if (!(this instanceof ReceiverStorage)) throw new Error("Storage receiver was lost.");
    this.calls.push(`get:${key}`);
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (!(this instanceof ReceiverStorage)) throw new Error("Storage receiver was lost.");
    this.calls.push(`set:${key}`);
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (!(this instanceof ReceiverStorage)) throw new Error("Storage receiver was lost.");
    this.calls.push(`remove:${key}`);
    this.values.delete(key);
  }
}

class ReceiverLockManager implements XpublessV2BrowserLockManagerLike {
  readonly requests: Array<{ name: string; options: XpublessV2BrowserLockRequestOptions }> = [];

  async request<T>(
    name: string,
    options: XpublessV2BrowserLockRequestOptions,
    callback: (lock: object | null) => T | PromiseLike<T>,
  ): Promise<T> {
    if (!(this instanceof ReceiverLockManager)) throw new Error("Lock-manager receiver was lost.");
    this.requests.push({ name, options });
    return callback({});
  }
}

function host(storage: ReceiverStorage, lockManager: XpublessV2BrowserLockManagerLike | null): XpublessV2BrowserEnvironmentHost {
  return {
    getStorage: () => storage,
    getLockManager: () => lockManager,
  };
}

describe("P3E3B production browser environment binding (UNIT/STRUCTURAL ONLY)", () => {
  it("returns not-browser without attempting browser capability access", () => {
    expect(resolveXpublessV2BrowserEnvironment(null)).toEqual({ status: "NOT_BROWSER_ENVIRONMENT" });
  });

  it("returns unavailable storage when the browser storage getter throws", () => {
    const result = resolveXpublessV2BrowserEnvironment({
      getStorage: () => {
        throw new Error("Storage access denied.");
      },
      getLockManager: () => new ReceiverLockManager(),
    });
    expect(result).toEqual({ status: "UNAVAILABLE_BROWSER_STORAGE" });
  });

  it("fails closed when browser storage exists but Web Locks are absent", () => {
    const storage = new ReceiverStorage();
    expect(resolveXpublessV2BrowserEnvironment(host(storage, null))).toEqual({ status: "UNSUPPORTED_EXCLUSIVE_WRITER" });
    expect(storage.calls).toEqual([]);
  });

  it("returns receiver-safe adapters without reading TimeSats keys during resolution", async () => {
    const storage = new ReceiverStorage();
    const lockManager = new ReceiverLockManager();
    const result = resolveXpublessV2BrowserEnvironment(host(storage, lockManager));
    expect(result.status).toBe("READY");
    if (result.status !== "READY") throw new Error("Expected browser environment adapters.");

    expect(storage.calls).toEqual([]);
    expect(lockManager.requests).toEqual([]);
    result.storage.setItem("test-key", "test-value");
    expect(result.storage.getItem("test-key")).toBe("test-value");
    result.storage.removeItem("test-key");
    expect(result.storage.getItem("test-key")).toBeNull();
    expect(await result.lockManager.request("test-lock", { mode: "exclusive", ifAvailable: true }, () => "held")).toBe("held");
    expect(storage.calls).toEqual(["set:test-key", "get:test-key", "remove:test-key", "get:test-key"]);
    expect(lockManager.requests).toEqual([{
      name: "test-lock",
      options: { mode: "exclusive", ifAvailable: true },
    }]);
  });
});
