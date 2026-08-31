import type {
  XpublessV2BrowserLockManagerLike,
  XpublessV2BrowserLockRequestOptions,
  XpublessV2BrowserStorageLike,
} from "./xpubless-v2-browser";

/**
 * Testable call-time host boundary. Production obtains this from browser
 * globals lazily; no module evaluation reads window, navigator, or storage.
 */
export interface XpublessV2BrowserEnvironmentHost {
  getStorage(): XpublessV2BrowserStorageLike;
  getLockManager(): XpublessV2BrowserLockManagerLike | null | undefined;
}

export type XpublessV2BrowserEnvironmentResult =
  | {
    status: "READY";
    storage: XpublessV2BrowserStorageLike;
    lockManager: XpublessV2BrowserLockManagerLike;
  }
  | { status: "NOT_BROWSER_ENVIRONMENT" }
  | { status: "UNSUPPORTED_EXCLUSIVE_WRITER" }
  | { status: "UNAVAILABLE_BROWSER_STORAGE" };

function resolveDefaultBrowserHost(): XpublessV2BrowserEnvironmentHost | null {
  if (typeof window === "undefined" || typeof navigator === "undefined") return null;
  return {
    getStorage(): XpublessV2BrowserStorageLike {
      return window.localStorage;
    },
    getLockManager(): XpublessV2BrowserLockManagerLike | null | undefined {
      return (navigator as { locks?: XpublessV2BrowserLockManagerLike }).locks;
    },
  };
}

function adaptStorage(storage: XpublessV2BrowserStorageLike): XpublessV2BrowserStorageLike {
  return {
    getItem(key: string): string | null {
      return storage.getItem(key);
    },
    setItem(key: string, value: string): void {
      storage.setItem(key, value);
    },
    removeItem(key: string): void {
      storage.removeItem(key);
    },
  };
}

function adaptLockManager(lockManager: XpublessV2BrowserLockManagerLike): XpublessV2BrowserLockManagerLike {
  return {
    request<T>(
      name: string,
      options: XpublessV2BrowserLockRequestOptions,
      callback: (lock: object | null) => T | PromiseLike<T>,
    ): Promise<T> {
      return lockManager.request(name, options, callback);
    },
  };
}

/**
 * Resolves capabilities only. It deliberately performs no TimeSats key reads,
 * UUID generation, authority classification, or storage mutation.
 */
export function resolveXpublessV2BrowserEnvironment(
  injectedHost?: XpublessV2BrowserEnvironmentHost | null,
): XpublessV2BrowserEnvironmentResult {
  const host = injectedHost === undefined ? resolveDefaultBrowserHost() : injectedHost;
  if (!host) return { status: "NOT_BROWSER_ENVIRONMENT" };

  let storage: XpublessV2BrowserStorageLike;
  try {
    storage = host.getStorage();
  } catch {
    return { status: "UNAVAILABLE_BROWSER_STORAGE" };
  }
  if (!storage) return { status: "UNAVAILABLE_BROWSER_STORAGE" };

  let lockManager: XpublessV2BrowserLockManagerLike | null | undefined;
  try {
    lockManager = host.getLockManager();
  } catch {
    return { status: "UNSUPPORTED_EXCLUSIVE_WRITER" };
  }
  if (!lockManager) return { status: "UNSUPPORTED_EXCLUSIVE_WRITER" };

  return {
    status: "READY",
    storage: adaptStorage(storage),
    lockManager: adaptLockManager(lockManager),
  };
}
