# Xpubless V2 Browser Evidence And Activation Gates

**P3D5 AUDIT. NOT USER-FACING. NOT ACTIVATED.**

This document records only evidence available through P3D4 at commit
`3ef57b8`. It is an activation recommendation, not a runtime design change.
No result here authorizes mainnet, changes recovery, connects a wallet, or
activates xpubless in the TimeSats app.

## Evidence Classes

| Class | Meaning |
| --- | --- |
| `PURE_PROVEN` | Deterministic domain/storage transition covered without I/O. |
| `UNIT_MOCK_PROVEN` | Injected storage/writer behavior covered by unit tests. |
| `REAL_BROWSER_PROVEN` | Observed in the named browser/version/test environment. |
| `REAL_BROWSER_PARTIAL` | A useful browser subset was observed; listed gaps remain. |
| `ARCHITECTURALLY_DESIGNED` | Specified boundary or policy, not runtime evidence. |
| `ENVIRONMENT_UNAVAILABLE` | The requested environment did not launch; no product inference. |
| `NOT_PROVEN` | No evidence supports the property. |
| `OUT_OF_SCOPE` | Deliberately not a P1-P3D4 responsibility. |

Evidence is browser/version/environment specific. A passing isolated harness is
not evidence that the production TimeSats app is activated safely.

## Historical Chain

| Phase | Delivered evidence | Class |
| --- | --- | --- |
| P1 | Xpubless V2 plan-state schema and HIC contract. | `PURE_PROVEN` |
| P2 | Pure conversion, source rehydration, and issued-output append. | `PURE_PROVEN` |
| P3A | Local envelope, revisions, preferences, and migration-journal contracts. | `PURE_PROVEN` |
| P3B | Resumable legacy migration over injected storage/writer. | `UNIT_MOCK_PROVEN` |
| P3C | Persist/read-back before deposit disclosure over injected storage/writer. | `UNIT_MOCK_PROVEN` |
| P3D0 | Browser coordination and validation design. | `ARCHITECTURALLY_DESIGNED` |
| P3D1 | Async browser orchestration around unchanged synchronous engines. | `UNIT_MOCK_PROVEN` |
| P3D2 | Chromium Web Locks, same-origin tabs, close/reload lifecycle primitive. | `REAL_BROWSER_PROVEN` |
| P3D3 | Chromium P3B/P3C transactions through P3D1 and real localStorage. | `REAL_BROWSER_PROVEN` |
| P3D4 | Chromium quota and Chromium/Firefox capability matrix. | Browser-specific; detailed below. |

## Core State And Transaction Evidence

### P1: Durable Plan State

`XpublessV2PlanState` intentionally excludes durable `tpub`,
`vaultPlanIdentity`, child public keys, witness scripts, descriptors, funding
data, and private material. It retains a local instance UUID, network, unlock
height, non-hardened derivation rule, public origin, metadata, HIC,
`lastIssuedIndex`, and contiguous issued output-script commitments.

HIC is a binding and conditional-integrity aid. It is not authentication, a
trust anchor, tamper-proof cryptographic identity, or a post-quantum property.

### P2: Rehydration And Append

Given a presented session-only public source, P2 rehydrates only after it
matches the candidate HIC and every issued output commitment. A wrong source,
altered HIC, or altered output commitment fails. The next output append is
deterministic and validates exactly the next index and script.

There is intentionally no candidate-only next-address API. Rehydration derives
and verifies `#0..#N`, so conversion and issuance currently remain `O(N)` in
issued deposits.

### P3A: Envelope Contracts

The envelope carries a stable `stateId`, monotonic revision, unique local plan
IDs, local archive/hidden preferences, and a strict migration journal. It
requires canonical cleanup order and preserves historical plan fields across
revisions. Revision is diagnostics/stale-state material, not a mutex or CAS.

### P3B: Migration Engine

P3B strictly inventories all four legacy keys, reconciles only the approved
V2/V3 mirror (V3 metadata and maximum issued index), preserves V2-only plans,
and blocks V1, duplicate semantics, orphan preferences, and hidden indexes
beyond issuance. It uses `PREPARED`, `TARGET_VERIFIED`, `CLEANUP_PENDING`, and
`COMPLETE`, verifies write/read-back, removes legacy keys in order, and resumes
after partial cleanup without speculative rollback.

Migration neither knows nor infers funding, balances, UTXO state, or whether
deletion is financially safe.

### P3C: Committed Issuance

The central invariant is:

```text
NO VERIFIED PERSISTENCE -> NO ADDRESS DISCLOSURE
```

P3C compares the complete persisted envelope with either the supplied valid
`expectedState` or one deterministic expected-next envelope. It revalidates the
public source even for replay. An uncertain write can therefore retry as the
same committed `#N+1`, with zero second write and never `#N+2`. Different
envelope content is stale, not a reconciliation opportunity.

### P3D1: Isolated Browser Boundary

P3D1 is `UNIT_MOCK_PROVEN`, not browser proof by itself. It preserves P3B/P3C
as synchronous engines inside an async outer lock callback, uses one lock name
(`timesats:xpubless-local-state:v1`), fails fast, keeps the already-held writer
private, and distinguishes engine/storage exceptions from lock-manager failure.
It fails closed with `UNSUPPORTED_EXCLUSIVE_WRITER` when no approved writer is
provided.

## Browser Evidence

### Chromium

Environment: Playwright `1.62.1`, Playwright-managed Chromium build `1234`,
`browser.version() = 151.0.7922.34`, disposable BrowserContext, two Pages, and
test-only origin `http://127.0.0.1:4179`.

P3D2 observed a secure context, real `navigator.locks`, a real exclusive Lock,
`ifAvailable` fail-fast, normal release, release after tab close, release after
reload, and same-origin localStorage visibility. P3D3 exercised real P3D1 plus
P3B/P3C against real localStorage: complete migration and reload, resume after
a real remove followed by an application throw, issuance and reload replay,
two-tab same-request replay without `#N+2`, an after-real-target-set throw with
no disclosure and same-`#N+1` retry, and journal-residue blocking.

P3D4 observed real quota exhaustion during P3C. `localStorage.setItem` raised
`QuotaExceededError` as a `DOMException`; P3C returned `FAILED_RECOVERABLE`
without address/deposit disclosure, the prior valid target remained revision 0
with index 0, removing only test filler keys preserved it, and the same request
then committed index 1 at revision 1. The observed `5,238,105` stored
characters is diagnostic for these runs only, not a quota guarantee or product
threshold.

Classification: `REAL_BROWSER_PROVEN` and `PROVEN_FOR_TESTED_SCOPE` for this
Playwright-managed Chromium environment.

### Firefox

Environment: Playwright-managed Firefox build `1538`,
`browser.version() = 153.0`, same isolated origin/topology.

P3D4 observed a secure context, Web Locks availability, same-origin
localStorage visibility, exclusive acquisition, `ifAvailable` fail-fast,
normal release, P3D1-to-P3C `#0 -> #1` committed issuance smoke, no fixture
`tpub` in the target, and explicit P3D1 fail-closed behavior without a supplied
lock manager and with zero target write.

Not proven in Firefox: P3B migration/reload/resume, two-tab same-request P3C
replay, after-real-set recovery, quota behavior, tab-close release, reload
release, and complete P3D2/P3D3 parity.

Classification: `REAL_BROWSER_PARTIAL`, not general Firefox support.

### WebKit, Safari, And iOS

Playwright-managed WebKit build `2336` / `26.5` was downloaded but did not
launch on this host because `libicu74`, `libxml2`, and `libflite1` are missing.
No system packages were installed. Classification is
`ENVIRONMENT_UNAVAILABLE`, not unsupported, incompatible, or Web-Locks absent.
No TimeSats behavior was observed in WebKit.

There is no evidence for Safari on macOS, Safari on iOS, WKWebView, iPhone, or
iPad behavior. Even future Playwright WebKit evidence would not automatically
prove all Safari/iOS product environments.

### Evidence Matrix

| Property | Pure/unit | Chromium | Firefox | WebKit | Required for P3E? | Required for public claim? | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Xpubless schema | Proven | N/A | N/A | N/A | Yes | Yes | P1 strict contracts. |
| Rehydration | Proven | Exercised by P3C | Smoke exercised | Unavailable | Yes | Yes | P2 is O(N). |
| Migration | Unit/mock | Proven | Not proven | Unavailable | Yes | Per enabled browser | P3D3 Chromium only. |
| Migration resume | Unit/mock | Proven | Not proven | Unavailable | Yes | Per enabled browser | Real remove then throw in Chromium. |
| Issuance/read-back | Unit/mock | Proven | Smoke | Unavailable | Yes | Per enabled browser | P3C through P3D1. |
| Persist-before-disclosure | Unit/mock | Proven | Smoke only | Unavailable | Yes | Yes | Chromium includes after-set recovery. |
| Idempotent replay | Unit/mock | Proven | Not proven | Unavailable | Yes | Per enabled browser | Chromium never `#N+2`. |
| Two-tab contention | Unit/mock | Proven | Partial lock smoke | Unavailable | Yes | Per enabled browser | Firefox did not run P3D3 replay. |
| Close/reload release | Designed/unit | Proven | Not proven | Unavailable | Yes | Per enabled browser | Chromium P3D2 only. |
| Quota recovery | Unit/mock | Proven | Not proven | Unavailable | Yes | Per enabled browser | No universal quota size. |
| LocalStorage visibility | Designed/unit | Proven | Proven | Unavailable | Yes | Per enabled browser | Same context/origin. |
| Exclusive writer | Unit/mock | Proven | Proven | Unavailable | Yes | Yes | No fallback writer. |
| Privacy fixture checks | Proven/unit | Proven | `tpub` smoke | Unavailable | Yes | Scoped claim only | Known TimeSats surfaces. |

### Browser Policy

| Environment | Evidence level | Writes recommendation | Reads recommendation | Claim | Missing evidence |
| --- | --- | --- | --- | --- | --- |
| Tested Chromium | `REAL_BROWSER_PROVEN` | Candidate only after P3E gates. | Candidate only after P3E loader work. | Tested Playwright Chromium environment. | Actual-app E2E and activation gates. |
| Tested Firefox | `REAL_BROWSER_PARTIAL` | Do not enable until parity if Firefox is a launch target. | P3E decision pending. | Tested Playwright Firefox partial matrix. | Full P3D2/P3D3 and quota parity. |
| WebKit | `ENVIRONMENT_UNAVAILABLE` | No recommendation from evidence. | P3E decision pending. | None. | Launch/runtime evidence. |
| Browser without approved writer | Designed plus P3D1/browser negative path | Fail closed. | Read-only inspection is a P3E decision. | No write support claim. | Product read-only safety/UX. |

No current evidence authorizes marketing or support claims for Google Chrome,
Microsoft Edge, Brave, Opera, Safari, iOS Safari, or all Firefox versions.
Engine similarity is not evidence.

## Product Storage And Writer Audit

The current production app is legacy-authoritative. In
`src/components/timesats-app.tsx`, `window.localStorage` is read on startup at
lines 84-87 and written directly through these legacy surfaces:

| Surface | Current writer/use | Activation consequence |
| --- | --- | --- |
| Plans | `persist`/`upsertAndPersist` at lines 95-115; create, import, and `issueNextDeposit` at lines 118-161. | Writes V3 VaultPlans containing the public source. |
| Archive | `persistArchived` at lines 100-103; archive/restore at 176-189. | Writes `timesats.archived-plan-identities.v1`. |
| Hidden | `persistHiddenDeposits` at lines 105-107; hide/restore at 191-200. | Writes `timesats.hidden-deposit-indexes.v1`. |
| Remove plan | Lines 202-209 write plans, archive, and hidden independently. | Three non-locked legacy writes. |
| Storage helpers | `src/storage/vault-plan-storage.ts` writes `timesats.vault-plans.v3`, `timesats.archived-plan-identities.v1`, and `timesats.hidden-deposit-indexes.v1`. | `saveVaultPlans` does not remove an existing V2 key. |

This inventory found no other production direct `window.localStorage` call in
`src` outside this app surface, but P3E must repeat the inventory as part of
its change review. Today these writers do not share the xpubless Web Lock and
would bypass the P3B/P3C authority model if both runtimes were active. This is
a **limited-activation blocker** until P3E gates/removes/replaces every
conflicting legacy writer for an xpubless-enabled profile. It is not a reason
to modify legacy behavior in P3D5.

## Non-Negotiable Runtime Policy

- Xpubless writes require the one approved exclusive writer domain,
  `timesats:xpubless-local-state:v1`. Issuance, rename, archive, hidden,
  removal, and every future envelope mutation must use it; revision alone is
  not a lock or CAS.
- No localStorage flag, timestamp lease, revision-as-lock, storage event, or
  BroadcastChannel mutex is an acceptable fallback.
- Storage failures fail closed. They never disclose an address, auto-delete
  plans, or create hidden cleanup to make quota space.
- A future UX may offer safe retry after a storage error; it must not invent an
  exact browser quota or destructive remediation.
- Read-only inspection without a writer is conceptually distinct from
  migration, issuance, rename, archive, hidden, removal, and every other
  mutation. It is not implemented or proven safe as an activation path, so
  P3E must decide its authority and UX explicitly.

## Recovery, Reconnect, And Security Boundaries

Official recovery is unchanged. The existing public recovery bundle contains
the public source and records the highest issued index; it is not a key backup
and must be updated after issuance. Xpubless browser state is convenience and
runtime state, not the only recovery anchor.

P3B does not create or alter a recovery bundle. Before automatic destructive
legacy cleanup, P3E must decide whether to require/offer an existing recovery
export and must test upgrade scenarios. Existing recovery behavior is useful,
but there is no evidence that every migrating user holds a current export; do
not assume that local legacy storage alone is a sufficient backup policy.

P3C still requires a session-only `presentedExtendedPublicKey`. Browser work
does not implement wallet/Core/Jade/QR reconnect. P3E needs a defined public
source acquisition boundary, but P4 wallet interoperability remains separate.
P4 should stay capability-based around `PUBLIC_KEY_SOURCE`, `PSBT_SIGNER`, and
generic transports; Jade, Trezor, Electrum, and other names are adapters and
evidence targets, not branches in P3E core wiring.

Xpubless reduces persistence of known public-source material in managed
TimeSats storage. It does not prove that no trace exists in browser extensions,
DevTools history, exports, OS memory/swap, screenshots, logs outside known
code, or manual copies. It also does not make current V2 outputs quantum-safe,
post-quantum, or future-proof: on-chain witness concealment and quantum
spend-security are distinct.

Mainnet remains `NO_GO`. Physical Jade remains unproven; QEMU evidence is not
physical-device support and remains a separate v0.5 release consideration.

## Activation Gates

| Gate | Status | Blocks P3E engineering? | Blocks limited activation? | Blocks broad launch? | Next action |
| --- | --- | --- | --- | --- | --- |
| Chromium P3D2-P3D4 evidence | Proven in test env | No | No by itself | Yes | Actual-app E2E. |
| Firefox parity | Partial | No | Only if Firefox writes enabled | Yes for Firefox claim | Run full intended parity. |
| WebKit evidence | Environment unavailable | No | Only if WebKit is enabled/claimed | Yes for WebKit claim | Use compatible host; decide launch requirement. |
| Quota | Chromium proven | No | No by itself | Yes per browser claim | Real-app quota UX/E2E. |
| Capability gate | Designed, not app-proven | No | **Yes** | **Yes** | Bind approved writer detection to the actual app. |
| Legacy writer inventory | Conflicting writers found | No | **Yes** | **Yes** | Gate all legacy/xpubless writers under one authority. |
| Actual-app browser tests | Not proven | No | **Yes** | **Yes** | Test production app upgrade, tabs, reload, quota. |
| Public reconnect | No product adapter | No | **Yes** for issuance | **Yes** | Define P3E/P4 boundary. |
| Recovery/export decision | Not proven for migration UX | No | **Yes** | **Yes** | Specify pre-cleanup UX and upgrade evidence. |
| Mainnet | Prohibited | No | N/A | **Yes** | Separate milestone/security review. |
| Physical Jade | Not proven | No | Not a P3D runtime blocker | Potential v0.5 release gate | Physical-device phase. |
| Wallet interoperability | Out of scope | No | Issuance source path decision | Yes for wallet claims | P4 contracts/research. |

Migration UX must explicitly handle `BLOCKED_UNSUPPORTED_V1`,
`BLOCKED_DUPLICATE_SEMANTICS`, `BLOCKED_ORPHAN_LEGACY_PREFERENCES`,
`BLOCKED_HIDDEN_INDEX_OUTSIDE_ISSUANCE`, `BLOCKED_AMBIGUOUS_COEXISTENCE`,
`BLOCKED_CONCURRENT_WRITER`, and `FAILED_RECOVERABLE`. It may not silently
cleanup. `NO_LEGACY_STATE` means all target/journal/known legacy surfaces are
absent; `COMPLETE_XPUBLESS` means a valid target is the only known authority.
Neither says no Bitcoin, empty wallet, or safe-to-delete.

## Recommendation

| Decision | Recommendation | Reason |
| --- | --- | --- |
| P3E design | `GO` | Browser/storage boundaries and evidence gaps are explicit. |
| P3E isolated implementation | `GO` | It can wire capability-gated runtime without altering crypto. |
| Limited activation | `CONDITIONAL_GO` | Only after writer inventory resolution, capability gate, reconnect/recovery decisions, and actual-app E2E. |
| Firefox activation | `NO_GO` | Require full intended P3D2/P3D3/quota parity before enabling writes. |
| WebKit/Safari activation | `NO_GO` | No WebKit runtime evidence. |
| Broad browser claim | `NO_GO` | Evidence is not product-browser coverage. |
| Mainnet | `NO_GO` | Unchanged policy/security gate. |
| P4 architecture research | `GO` in parallel | Public-source/PSBT contracts are orthogonal to P3E storage wiring. |

Firefox parity need not block P3E engineering if P3E is capability-gated and
does not enable or claim Firefox writes. It should block Firefox activation if
Firefox writes are intended. WebKit evidence likewise need not block P3E
engineering or a limited supported-environment plan that fails closed on
WebKit; it becomes a release gate if Safari/iOS support is required.

P3D evidence alone is not public activation. P3E must remain wiring and UX
only: no change to scripts, HIC, VaultPlan identity, PSBT, recovery format,
network policy, or mainnet policy without separate review.

## Proposed P3E Sequence

1. **P3E1:** repeat production writer inventory; freeze one runtime authority
   and capability-gating transition design. It does not activate migration.
2. **P3E2:** add unused actual-app environment binding and capability gate with
   no crypto change.
3. **P3E3:** add the xpubless loader and development-gated migration UX with
   all blocker/recovery states.
4. **P3E4:** add development-gated committed issuance and preference mutations
   with an explicit public-source reconnect boundary and
   stale/concurrent/quota handling.
5. **P3E5:** real-app Chromium E2E for legacy upgrade, reload, partial resume,
   tab close, concurrent tab, quota, and no-bypass writers.
6. **P3E6:** reassess activation, browser policy, recovery/export decision, and
   enabled environments.

P4A architecture/contracts may proceed in parallel with this work. Direct
wallet UI integration should wait for the P3E runtime authority boundary so a
wallet-specific path cannot bypass committed issuance or the shared writer.

## Security Property Summary

```text
USER OWNS KEYS.
TIMESATS NEVER NEEDS PRIVATE KEYS.
PUBLIC SOURCE IS SESSION-ONLY IN THE XPUBLESS PATH.
DURABLE STATE COMMITS TO ISSUED OUTPUTS.
WRITES REQUIRE ONE EXCLUSIVE LOCK DOMAIN.
MIGRATION IS RESUMABLE.
ADDRESS DISCLOSURE REQUIRES VERIFIED COMMIT.
REPLAY NEVER ADVANCES THE SAME REQUEST TO N+2.
STORAGE FAILURE FAILS CLOSED.
NO FUNDING INFERENCE.
NO MAINNET.
```

## Claims Allowed Today

Allowed technical wording:

- "P1-P3C provide xpubless V2 state, resumable migration, and committed
  issuance primitives with injected-boundary tests."
- "In the tested Playwright-managed Chromium environment, real localStorage
  quota exhaustion withheld P3C disclosure and allowed retry after test filler
  removal."
- "In the tested Playwright-managed Chromium and Firefox environments, Web
  Locks coordination, same-origin localStorage, and P3D1-to-P3C issuance smoke
  were observed."

Prohibited wording includes "all browsers supported", "Chrome supported",
"Safari/iOS supported", "Firefox fully supported", "Firefox universally
supported", "all wallets supported", "physical Jade proven", "quota is N
MB", "atomic storage", "power-loss safe", "fsync", "OS-crash safe",
"quantum safe", "post-quantum", "mainnet ready", or "production
activated".

## Verified Counts And Scope

The verified unit baseline is 372 tests, including 6 golden vectors. Browser
evidence totals 15 executable passing tests: 6 P3D2 Chromium lock tests, 6
P3D3 Chromium transaction tests, 1 Chromium quota test, 1 Chromium matrix
test, and 1 Firefox matrix test. WebKit did not pass because it did not launch.

P3D5 changes only this document. It neither resolves the listed gates nor
implements P3E/P4.
