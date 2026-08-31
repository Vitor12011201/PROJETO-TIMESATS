# P3D Browser Validation Design

**P3D BROWSER VALIDATION DESIGN**

**NOT USER-FACING**

**NOT ACTIVATED**

P1, P2, P3A, P3B, and P3C are frozen pure or injected-boundary work. P3B
and P3C prove migration, committed issuance, resume behavior, and
persist/read-back decisions against synchronous injected storage and writer
boundaries. They do not prove browser coordination, real `localStorage`,
multi-tab visibility, quota behavior, page lifecycle, reload, or browser
crash behavior.

This document defines the design and evidence required before any browser
adapter or user-facing activation. It does not authorize runtime wiring,
browser storage access, Web Locks implementation, recovery changes, wallet
adapters, or a mainnet change.

## Existing Boundaries

P3B and P3C deliberately use synchronous interfaces:

```ts
interface XpublessV2MigrationExclusiveWriter {
  runExclusive<T>(operation: () => T):
    | { acquired: true; value: T }
    | { acquired: false };
}

interface XpublessV2MigrationStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
```

P3C has the same synchronous writer shape and a narrower `getItem`/`setItem`
storage interface. Their synchronous execution is intentional: P3B/P3C own the
storage state machine, strict parsing, re-read rules, P2 rehydration, P2
append, and P3A envelope transitions. Neither engine treats a revision as a
lock or compare-and-swap primitive.

Web Locks is asynchronous. It must not be forced into these interfaces by
blocking the main thread, busy waiting, `Atomics.wait`, polling, or a hidden
Promise-to-sync bridge. Such a bridge would be an incorrect browser
architecture and a new, untested concurrency mechanism.

## Proposed Browser Orchestration

The preferred architecture is **asynchronous browser orchestration outside
P3B/P3C**. A future browser wrapper owns the Promise boundary and invokes an
existing synchronous engine only while the real browser lock is held.

Conceptually:

```ts
async function runUnderBrowserXpublessWriter(
  runEngine: (writer: AlreadyHeldWriter) => Result,
): Promise<Result> {
  if (!navigator.locks) return { status: "UNSUPPORTED_EXCLUSIVE_WRITER" };

  return navigator.locks.request(
    "timesats:xpubless-local-state:v1",
    { mode: "exclusive", ifAvailable: true },
    (lock) => {
      if (lock === null) return { status: "BLOCKED_CONCURRENT_WRITER" };

      const alreadyHeldWriter = {
        runExclusive<T>(operation: () => T) {
          return { acquired: true as const, value: operation() };
        },
      };

      return runEngine(alreadyHeldWriter);
    },
  );
}
```

This is an architectural sketch, not a frozen TypeScript implementation. P3D1
must verify installed DOM typings and Web Locks behavior before coding. The
actual wrapper passes the already-held writer and a minimal browser adapter to
P3B or P3C only inside the Web Locks callback.

The already-held writer is not a second lock. It is a synchronous capability
used to satisfy the existing engine boundary after the one real lock has been
obtained. There must be no localStorage lock flag, timestamp lease, revision
lock, polling loop, or second mutex.

P3B/P3C can therefore remain unchanged. The browser wrapper returns a Promise
because Web Locks is asynchronous; the business transition remains the
already-tested synchronous transition inside the callback.

### Lock Domain

The proposed stable lock name is:

```text
timesats:xpubless-local-state:v1
```

It protects the complete xpubless local envelope domain, not one operation.
Migration, committed issuance, and all future envelope mutations (rename,
archive, hidden preferences, plan removal, and local-plan mutations) must use
this same exclusive name. Separate migration and issuance locks would allow
conflicting writes to `timesats.xpubless-local-state.v1`.

The lock name is not secret, a Bitcoin identity, a `stateId`, a
`localInstanceId`, a HIC, or a deduplication key.

### Fail-Fast Policy

The initial browser design chooses fail-fast acquisition through Web Locks
semantics equivalent to `ifAvailable: true`:

```text
lock available -> run one local transaction
lock unavailable -> return blocked-concurrent-writer immediately
```

This preserves P3B/P3C's `BLOCKED_CONCURRENT_WRITER` behavior, avoids an
unbounded UI wait, and makes multi-tab tests deterministic. A future UI may
offer an explicit retry; it must not create a second transaction from an old
snapshot while waiting.

If the approved exclusive-writer primitive is unavailable, browser xpubless
writes fail closed with a browser-level status such as
`UNSUPPORTED_EXCLUSIVE_WRITER`. There is no fallback based on `localStorage`,
revision, `storage` events, timers, or polling. P3E will decide whether that
means read-only presentation, unavailable xpubless operations, or continued
legacy runtime for a browser that is not supported.

## Real Browser Storage Adapter

A future production adapter is intentionally minimal:

```ts
interface BrowserXpublessStorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
```

Inside the browser wrapper it delegates directly to real `localStorage`. It
must not serialize application objects, parse schemas, normalize input, retry
writes, implement locks, make migration decisions, or perform cleanup. Those
remain P3A/P3B/P3C responsibilities.

### Read Boundary

No localStorage read that authorizes a mutation may occur before the Web Lock.
The prohibited sequence is:

```text
read localStorage -> await lock -> write decision computed from old read
```

The required sequence is:

```text
acquire browser lock -> invoke P3B/P3C -> engine re-reads all relevant keys
```

The wrapper may test browser capability before lock acquisition. It must not
pre-read the target, journal, legacy keys, revision, or preferences and use
that data to authorize a write.

`expectedState` may be obtained by UI before the lock, but it is only P3C's
optimistic precondition. P3C still reads persistent state after lock and accepts
only exact expected state, exact deterministic expected-next state, or stale.

### Public Reconnect Timing

P3C receives a presented extended public key that is session-only. A future
wallet, Core, Jade, QR, or manual reconnect can take seconds or require user
interaction. That work must finish before lock acquisition. The lock covers
only the short local transaction:

```text
obtain public source outside lock
  -> acquire exclusive lock
  -> re-read, rehydrate, derive, append, persist, read back
  -> release lock
```

If local state changes while public reconnect is in progress, P3C returns
`BLOCKED_STALE_STATE`. Holding the lock during human or hardware interaction is
not permitted.

## Same-Origin Coordination

Web Locks and `localStorage` behavior must be exercised by two pages in the
same browser storage partition and same dedicated test origin. Two independent
browser contexts are not a multi-tab test: they generally do not share the
same localStorage partition and cannot prove the required same-user behavior.

The browser-real test topology is:

```text
one disposable BrowserContext / temporary profile
  one dedicated local test origin
    Page A (tab A)
    Page B (tab B)
```

The test initializes only that context's localStorage and destroys the complete
context afterwards. It must never use a developer profile, a production origin,
an existing TimeSats profile, or cleanup-by-deleting keys from a personal
profile.

`storage` events may later notify a UI that another tab changed state. They are
notification only: they are neither a lock nor authority. Correctness remains
exclusive writer plus re-read after acquisition plus P3B/P3C validation.

## Required Browser-Real Evidence

The following scenarios are browser evidence requirements, not behavior claims
until they have been run on the named browser/version/environment.

### Lock and Lifecycle

1. **Basic lock.** Page A holds the real lock. Page B uses fail-fast acquisition
   and receives unavailable/blocking status, with zero xpubless storage mutation.
   After A releases, a new B attempt acquires the lock.
2. **Close release.** Page A holds the lock, then the page is closed. Page B
   must eventually acquire it. The proof must not use `beforeunload`, a manual
   unlock call, or a localStorage flag.
3. **Reload release.** A reload/navigation destroys a lock-holding page context;
   B eventually acquires. This is distinct from closing a page and needs its
   own test.
4. **Visibility.** A writes the target through real localStorage. B acquires the
   lock and its engine re-read observes that persisted value.
5. **Different operation.** A changes state under the lock. B holds an old
   expected state for a different operation. After B acquires the lock, it must
   re-read and fail stale or require an explicit upper-layer retry, never write
   the snapshot calculated before A.

### Issuance and Migration Contention

The two-tab issuance test is mandatory:

```text
state revision N, deposit #3, same expectedState and public source in A and B

A acquires lock and commits #4
B while A holds lock -> BLOCKED_CONCURRENT_WRITER, zero mutation
A releases
B repeats the same request -> exact P3C expected-next replay -> #4, zero set
```

B must never produce #5 from that same request. The replay still requires the
correct presented public source, because P3C must reconstruct the deterministic
expected-next state rather than disclose an address from storage alone.

Migration and issuance must also contend on the same lock in both directions:

```text
A holds/runs migration -> B committed issuance is blocked
A holds/runs issuance -> B migration is blocked
```

No migration and issuance mutation may run concurrently in different lock
domains.

### Reload Persistence

After a complete browser-real migration, reload and inspect again. Required
state is a valid target, absent journal, and all four legacy keys absent, giving
`COMPLETE_XPUBLESS` only for the known managed localStorage surfaces.

After committed issuance of #4, reload must preserve revision `N + 1` and
`lastIssuedIndex = 4`; it must not regress to #3. Repeating the old request
with the correct source may recognize the exact P3C replay, not issue #5.

### Artificial Failure Around Real Storage

P3B/P3C's fake tests already model exceptions. Browser-real tests need a
**test-only** wrapper around a real adapter, not production test hooks. The
wrapper can call real `localStorage.setItem(key, value)` and then throw, or
throw on the next `getItem`. This proves actual persisted browser state plus an
uncertain application result.

The critical P3C case is:

```text
real setItem(next) succeeds -> test wrapper throws before read-back
first call: no COMMITTED result and no address disclosure
retry same request: re-read real state, exact expected-next, return same #N+1
retry: zero second write and never #N+2
```

This is not a browser process crash simulation. It is an application-failure
test after a real browser storage write.

### Quota

Quota is browser and environment dependent. P3D must not encode a universal
size such as five megabytes. A bounded, isolated test should fill only the
disposable test origin until a browser-observed quota error occurs, then attempt
the TimeSats transaction. It must verify no `COMMITTED` result/address on the
failing attempt, re-read state, and exercise retry/recovery according to the
observed browser result.

A passing quota test means only that quota failure behavior was observed for
that browser, version, and test environment. It is not a storage-capacity claim
for all browsers.

### Corruption and Residue

Browser-real tests must also establish that a corrupt target fails closed and
that a journal or any one of the four legacy keys blocks normal P3C issuance.
Migration validation must inspect the same known legacy surface inventory in
real localStorage. Correctness does not depend on a storage event arriving.

## Crash Claim Boundary

The evidence categories remain distinct:

```text
tab close != reload != page crash != browser process kill != OS crash != power loss
```

P3D can make only an application/browser-level claim for scenarios the harness
actually runs: write/read-back behavior, reload, tab lifecycle, same-origin
visibility, and Web Locks coordination. Real `setItem` followed by `getItem`
and reload does not prove fsync, physical power-loss durability, OS-crash
durability, multi-key atomicity, or hardware persistence.

Browser process kill and OS/power-loss tests need separately specified
infrastructure and may not be faithfully simulated by a normal page test. A
tab close must never be described as a power-loss proof.

## Privacy and Scope Checks

Browser tests use only public deterministic fixtures. They must never use a
seed, mnemonic, private key, WIF, xprv, tprv, Core wallet, Jade, or mainnet.

After browser-real issuance, the serialized target must be checked against real
fixture values and must not contain the presented tpub, child public key,
witness script, descriptor, or address. The persisted commitment remains index
plus output script.

After browser-real migration, assert all of the following:

```text
timesats.xpubless-local-state.v1 present and valid
timesats.vault-plans.v3 absent
timesats.vault-plans.v2 absent
timesats.archived-plan-identities.v1 absent
timesats.hidden-deposit-indexes.v1 absent
timesats.xpubless-migration-journal.v1 absent
```

The serialized target must not contain the fixture tpub or legacy identity.
This is an inventory of TimeSats-managed localStorage keys only. It cannot
prove removal from DevTools history, browser extensions, OS swap, crash dumps,
manual exports, recovery files, or unrelated browser state.

P3D changes neither recovery nor the allowed Signet/Regtest network policy. It
does not implement public-source adapters, PSBT/spending, funding inference, or
UI activation.

## Infrastructure Inventory and Harness Decision

The repository currently has Vitest configured with `jsdom`. It has no
Playwright, Puppeteer, WebDriver, Vitest Browser Mode provider, browser E2E
configuration, or existing multi-page browser harness. `jsdom` localStorage in
unit tests is not browser-real evidence for Web Locks, quota, lifecycle, or
multi-tab storage behavior.

The recommended smallest new tooling decision for browser-real P3D validation
is `@playwright/test` as a dev dependency. It provides a local test server
integration, disposable browser contexts, multiple same-context pages, reload
and page-close control, and Chromium/Firefox/WebKit execution from one test
harness. This is **DEPENDENCY DECISION PENDING**. Browser binaries and CI
caching/download requirements are a separate operational cost; no package or
browser binary is added by this design.

Alternatives require an independently approved harness decision:

- Vitest Browser Mode plus an appropriate browser provider is not installed and
  needs separate multi-page/lock-control evaluation.
- Puppeteer or WebDriver would introduce a distinct test stack and need the same
  origin-isolation and multi-tab guarantees.

P3D must use a test-only isolated route/build/harness that imports the future
browser wrapper through supported module boundaries. It must not wire normal
application storage authority and must not inspect or execute unstable Next
chunks as a testing workaround. Production adapter/orchestration code and
test-only pause/fault controls remain separate.

## Browser Matrix

No generic browser support claim is authorized today. The exact runner and
actual browser versions must be recorded with test evidence.

| Engine | Initial role | Current evidence | Claim permitted now |
| --- | --- | --- | --- |
| Chromium | Candidate first proof after tooling approval. | Not tested. | None. |
| Firefox | Required before claiming Firefox support. | Not tested. | None. |
| WebKit | Required before claiming WebKit support. | Not tested. | None. |

For each executed engine, evidence must separately record Web Locks support,
basic lock/refusal, same-origin visibility, two-tab issuance, migration versus
issuance contention, reload, artificial after-write failure, quota observation,
and any lifecycle result. An unsupported engine must not fall back to an unsafe
writer scheme.

## Browser Validation Matrix

| Scenario | Browser primitive exercised | Persistent state expected | Second-tab behavior | Disclosure allowed? | Claim level | Release gate? |
| --- | --- | --- | --- | --- | --- | --- |
| Basic lock | Web Locks exclusive acquisition | Unchanged while held | B fail-fast blocks; succeeds after release | No for B while blocked | Coordination only after observed | Yes |
| Lock refusal | `ifAvailable` no lock | No xpubless mutation | No queued writer assumption | No | Browser-specific | Yes |
| Tab close | Lock lifetime on page close | No speculative cleanup | B eventually acquires | Only after B verified transaction | Lifecycle observed | Yes |
| Reload | Lock lifetime plus reload | Persisted state re-read after reload | B proceeds only after release | Only after P3C commit | Lifecycle observed | Yes |
| Same request in two tabs | Web Locks plus same-origin localStorage | Exactly one revision N+1 / #N+1 | B replay returns same #N+1 after A | A after verification; B only replay after source validation | End-to-end issuance | Yes |
| Migration vs issuance | Shared lock name | No concurrent envelope mutation | Other operation blocks | No while blocked | Cross-operation coordination | Yes |
| Real visibility | localStorage same-origin visibility | B sees A's persisted target after lock/re-read | B bases decision on re-read | Only if P3C verifies | Browser storage behavior | Yes |
| After-write artificial failure | localStorage real write plus test wrapper throw | Next may persist; retry determines exact state | Replay must not write again | No first call; yes only replay commit | Application failure after real write | Yes |
| Quota | Browser quota exception | No unverified disclosure; re-read required | No special bypass | No on failure | Browser/version/environment specific | Yes |
| Target corruption | Real localStorage read/parse | Corrupt target retained for diagnosis | No corrective concurrent write | No | Fail-closed behavior | Yes |
| Legacy residue/journal | Real localStorage inventory | Target not used for normal issuance | No issuance under coexistence | No | Authority gate | Yes |
| Unsupported Web Locks | Feature detection | No unsafe write path | No fallback coordination | No | Unsupported browser policy | Yes |

## Non-Negotiable Invariants

1. One lock domain protects every xpubless local mutation.
2. No storage-authorizing read occurs before the real lock.
3. The real browser lock sits outside the synchronous engines.
4. P3B and P3C remain the source of business semantics.
5. Revision is not a lock, mutex, or compare-and-swap primitive.
6. A storage event is not a lock or authority.
7. No localStorage flag, timestamp lease, or polling fallback is allowed.
8. No wallet, hardware, Core, QR, or user interaction occurs while the lock is held.
9. Every mutation re-reads state after lock acquisition.
10. No address is disclosed before P3C returns `COMMITTED`.
11. A same-request replay may return the same committed deposit.
12. A same-request replay never creates `#N+2`.
13. Journal or legacy residue blocks normal issuance.
14. Every browser test profile/origin is isolated and disposable.
15. Browser tests use no private material.
16. Mainnet remains prohibited.
17. No power-loss or fsync claim is made from normal browser tests.
18. Browser-specific claims exist only after evidence in that engine.
19. P3D does not activate UI or runtime authority.
20. P3E remains an explicit, separate activation gate.

## Conservative P3D Sequence

1. **P3D1 - Browser adapter and orchestration contract.** Implement unused
   asynchronous Web Locks orchestration and minimal browser storage adapter,
   keeping P3B/P3C unchanged. It requires no browser E2E tooling: unit/mock
   tests only, no real Web Locks, no real multi-tab/localStorage lifecycle
   claim, and no app wiring.
2. **P3D2 - Browser harness and lock proof.** Add an approved real-browser
   harness only after an explicit tooling/dependency decision; use isolated
   origin, same-context two-tab tests, basic fail-fast lock, close, reload, and
   visibility proof.
3. **P3D3 - Real storage transaction proof.** Exercise P3B migration and P3C
   issuance/replay through the adapter, including reload and real-after-write
   artificial failures.
4. **P3D4 - Lifecycle, quota, and engine matrix.** Observe bounded quota
   failure, corruption/residue refusal, lifecycle behavior, and each selected
   browser engine. Record exact versions and limitations.
5. **P3D5 - Evidence review.** Publish a browser evidence report and decide
   whether P3E activation design may begin. No automatic activation follows.

## Go / No-Go

**GO for P3D1 design and isolated implementation planning.** The async-to-sync
boundary is specified: Web Locks owns the asynchronous outer transaction and
the already-held synchronous writer capability calls unchanged P3B/P3C only
inside that lock.

**NO-GO for real-browser P3D execution until a browser tooling/dependency
decision is approved.** The repository currently has no runner capable of
proving real same-origin multi-tab Web Locks or localStorage behavior.

**NO-GO for mainnet and generic browser support claims.** P3D does not alter
the Signet/Regtest-only policy, and no engine is supported until its own real
browser evidence has been recorded.

**NO-GO for P3E, user-facing migration, normal xpubless runtime authority, or
release.** Passing P3D1 alone is insufficient. Activation remains blocked until
the approved browser harness demonstrates the relevant engine matrix, one-lock
domain, re-read boundary, lifecycle/reload behavior, same-request no-`#N+2`
issuance, migration/issuance contention, real storage failure behavior, quota
observations, known-surface privacy inventory, and a separate product/security
activation decision.
