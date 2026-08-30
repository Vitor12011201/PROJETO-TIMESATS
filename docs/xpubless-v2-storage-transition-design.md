# Design P3 - Xpubless V2 Storage Transition

## Status

**P3 STORAGE DESIGN. NOT YET USER-FACING. NOT YET ACTIVATED.**

P1 (`XpublessV2PlanState` and HIC v1) and P2 (pure conversion,
rehydration, and append) are production-quality pure primitives. This document
does not activate xpubless persistence. Legacy storage remains runtime
authority. This is not a recovery-format, wallet-adapter, UI, Policy V1/V2, or
mainnet decision.

```text
FAIL CLOSED
PRESERVE RECOVERABILITY
NO SILENT SEMANTIC MIGRATION
```

P3 may later implement isolated primitives, but cannot wire them into the app
until its activation gates are separately met.

## Real Legacy Storage Inventory

`src/storage/vault-plan-storage.ts` currently defines four independent
localStorage entries:

| Key | Current content | V2 exposure |
| --- | --- | --- |
| `timesats.vault-plans.v3` | `{ format: "timesats-local-vault-plans", version: 3, plans: VaultPlan[] }` | Complete V2 `VaultPlan` contains tpub. |
| `timesats.vault-plans.v2` | Same legacy envelope with `version: 2`; fallback only when v3 is absent | Can retain complete V1/V2 plans and tpub. |
| `timesats.archived-plan-identities.v1` | Array of `vaultPlanIdentity` strings | V2 identity includes tpub and origin literally. |
| `timesats.hidden-deposit-indexes.v1` | Map from `vaultPlanIdentity` to index arrays | Map keys can include V2 tpub and origin literally. |

`loadVaultPlans()` reads v3 with `getItem(v3) ?? getItem(v2)`. A present but
corrupt v3 blocks the current v2 fallback; it does not mean v2 is absent.
`saveVaultPlans()` writes v3 and never removes v2. There is no production
`removeItem` call for these keys. Removing a plan rewrites the current three
entries but neither deletes them nor removes ignored v2.

Archive and hidden loaders deliberately return empty preferences on malformed
data. That is acceptable for current UI loading, but cannot be proof for a
destructive cleanup: malformed raw preferences may still be a known surface
with historical identity text. P3 preflight reads raw entries strictly instead
of using forgiving loader output as an exposure inventory.

Current hidden-index behavior must be preserved or blocked, never silently
changed: indexes are BIP32-range integers, duplicates are removed and sorted,
an identity need not resolve to a loaded plan, and an index may exceed the
current `lastIssuedIndex`. Hidden state is UI-only and never changes issuance.

`src/components/timesats-app.tsx` currently loads and saves plans, archive,
and hidden entries independently. It calls `issueNextDeposit` then saves plans
without multi-tab locking or read-back. Import upserts a complete legacy plan;
archive/hidden are keyed by canonical identity. P3 does not modify this.

## Proposed Xpubless Envelope

P3 uses one monolithic local state entry, not separate candidate and preference
entries. Its proposed shape is:

```ts
{
  format: "timesats-xpubless-local-state",
  version: 1,
  stateId: "lowercase canonical UUID",
  revision: 0,
  plans: XpublessV2PlanState[],
  archivedLocalInstanceIds: string[],
  hiddenDepositIndexes: { "<localInstanceId>": number[] }
}
```

The new storage key is:

```text
timesats.xpubless-local-state.v1
```

The three version levels remain distinct:

```text
VaultPlan:                 timesats-vault-plan / version 2 or 3
XpublessV2PlanState:       timesats-xpubless-v2-plan-state / version 1
Xpubless local envelope:   timesats-xpubless-local-state / version 1
```

The envelope and every nested preference object are future strict schemas. They
must not contain legacy `VaultPlan`, tpub/xpub, `vaultPlanIdentity`, child
public keys, witness scripts, descriptors, recovery bundles, funding data, or
private material. Preferences live in the envelope, not in P1's plan-state
schema. The journal is also a future strict schema.

`stateId` is an opaque UUID for one durable-envelope instance. It is created
once with the initial in-memory target at revision 0, remains stable across
revision 0, 1, 2, 3, and later writes, and lets journal/resume logic identify
that the revisions belong to one logical envelope without using tpub. It is not a
Bitcoin identity, `localInstanceId`, `migrationId`, HIC, dedupe key, revision,
or authentication mechanism. A migration can finish while the `stateId`
continues in the normal envelope for years. `localInstanceId` continues to
identify each plan instance.

Semantic validation additionally requires unique plan UUIDs; valid P1 plan
states; archive UUIDs that resolve to one plan; hidden-map UUIDs that resolve
to one plan; hidden indexes that are unique, sorted, BIP32-range integers, and
at most that plan's `lastIssuedIndex`; and a non-negative safe-integer revision.
An orphan preference or an index for a never-issued deposit is a semantic error
in the new envelope and fails closed.

Before legacy cleanup, P3 compares the read-back envelope to the exact target
calculated from preflight: same reconciled plan count and metadata, same
`lastIssuedIndex`, byte-identical output commitments, unique UUID assignments,
archive/hidden mappings, `stateId`, and expected revision. Schema parsing alone
is not enough. This is application-level write/read-back validation, not a
claim about power-loss durability.

### Scale boundary

P2 conversion and rehydration derive and verify every known output from `#0`
through `#lastIssuedIndex`; target construction and semantic validation retain
that O(N) property. The explicit output list is an intentional recoverability
and discovery trade-off, not a solved arbitrary-scale storage problem. P3 adds
no new maximum, compaction, Merkle construction, or alternate schema in this
design. Any future scale decision needs separate evidence.

### Revision

Revision starts at 0 and increments exactly once for each read-back-validated
envelope transition. It supports diagnostics, expected-state assertions,
stale-write detection in tests, and journal binding. It is not a mutex,
compare-and-swap primitive, or multi-tab defense. Two tabs can both read 5 and
write 6, so every writer still needs exclusive access and a re-read after lock.

## Exclusive Writer and Write Protocol

Every envelope mutation requires a future `ExclusiveWriter` abstraction. The
production candidate is a browser-level exclusive lock such as Web Locks,
scoped to TimeSats storage. P3 must not substitute revision, a localStorage
flag, or a timestamp for an exclusive lock.

The browser primitive, support matrix, abort behavior, and real multi-tab proof
are not established. Consequently P3A/P3B can use injected fake writers, but
user-facing activation remains blocked until a real exclusive writer and
browser-real tests are proven.

Every future writer follows this protocol:

```text
1. acquire exclusive writer
2. re-read storage after lock acquisition
3. strictly parse and inventory current state
4. confirm stateId/revision and preconditions
5. calculate next state in memory
6. write envelope
7. immediately read back
8. JSON parse, schema parse, semantic equality validation
9. release lock
```

Never read, wait for a lock, and write a state calculated before the lock. A
failed lock or stale expected revision is `BLOCKED_CONCURRENT_WRITER`: no
cleanup and no address disclosure.

## Local IDs and Preferences

After migration, preferences use only `localInstanceId`:

```text
legacy vaultPlanIdentity
  -> exactly one reconciled V2 plan
  -> that plan's localInstanceId
  -> envelope archive/hidden preference
```

They must not use canonical identity, HIC, or `outputScript #0`; X2A refuted
the latter as a local-reference aliasing construction.

P3, not P2, generates each `localInstanceId` with an appropriate cryptographic
UUID API. It does so before pure P2 conversion. Once a target envelope passes
read-back, resume must reuse its UUIDs; restart may not create replacement IDs.

## Legacy Preflight and Reconciliation

Preflight strictly reads all four legacy keys, not only the current loader's
chosen key, before any target or cleanup write.

### V2/v3 reconciliation

X2B proved exactly one same-policy rule:

```text
same vaultPlanIdentity in v2 and v3
  -> v3 metadata has current-loader precedence
  -> lastIssuedIndex = max(v2, v3)
  -> one V2 source plan for P2 conversion
```

It is permitted only when that identity occurs at most once in each entry and
both copies parse normally. It never reduces `lastIssuedIndex`. Plans present
in only one key remain distinct plans in the migrated union; a v2-only plan
cannot disappear merely because v3 exists.

This is limited to the two physical legacy keys and one parse-valid V2 copy per
key. X2B grouped the v3/v2 union by canonical identity and retained every
one-sided identity; for a two-key mirror it selected the v3 label by the same
precedence as the current loader and selected the maximum issued index. A label
difference is therefore covered only in that exact v2/v3 mirror rule. It does
not authorize merging arbitrary duplicate rows, imports, local instances,
preference conflicts, origins, or storage insertion order.

Repeated identity inside v2 or v3, malformed source data, or any merge beyond
this proved mirror rule is `BLOCKED_DUPLICATE_SEMANTICS` or
`FAILED_RECOVERABLE`. No cleanup is allowed. HIC is not a dedupe policy or
authentication.

Archive and hidden state are separate global legacy entries, not a second
per-key plan copy to merge. They are remapped only when their canonical
identity resolves to exactly one plan after the limited rule above and their
values pass the preflight constraints below. Any competing preference source,
unresolvable identity, malformed raw value, or semantic conflict outside that
real legacy shape blocks rather than choosing or merging a preference.

### V1

Any relevant V1 in either legacy plan key produces
`BLOCKED_UNSUPPORTED_V1`. Mixed V1/V2 snapshots receive zero partial cleanup.
V1 is not converted, assigned an origin, placed in the V2 envelope, or
deleted. Legacy remains intact and authority.

### Orphan and malformed preferences

P3 intentionally tightens the convenient X2B research behavior that discarded
unknown preferences. If a present archive identity or hidden-map key does not
resolve to exactly one reconciled V2 plan, migration returns
`BLOCKED_ORPHAN_LEGACY_PREFERENCES`. A malformed raw archive/hidden entry
returns `FAILED_RECOVERABLE`. In both cases no cleanup occurs and legacy stays
authority. This avoids deleting a string that can contain tpub or changing
archive/hidden behavior silently.

For a valid mapping, archive is deduplicated by `localInstanceId`; hidden
indexes are deduplicated and sorted only when each is at most the candidate's
`lastIssuedIndex`. A legacy hidden index above that limit is not silently
discarded: it returns `BLOCKED_HIDDEN_INDEX_OUTSIDE_ISSUANCE`, retains legacy,
and permits no cleanup. Hidden state never affects issuance.

## Migration Journal

P3 uses a separate journal key:

```text
timesats.xpubless-migration-journal.v1
```

The journal is crash-recovery coordination metadata, not a trust anchor,
backup, plan state, or recovery artifact. It contains no tpub, VaultPlan,
canonical identity, private data, or preference identity.

```ts
{
  format: "timesats-xpubless-migration-journal",
  version: 1,
  migrationId: "lowercase canonical UUID",
  targetStateId: "lowercase canonical UUID",
  targetRevision: 0,
  phase: "PREPARED" | "TARGET_VERIFIED" | "CLEANUP_PENDING" | "COMPLETE",
  remainingLegacyKeys: string[]
}
```

`migrationId`, target `stateId`, and target revision bind journal records to
one parsed target for resume. `migrationId` identifies this migration execution
only; it is not stored in the normal envelope after migration. This is
coordination only, not authentication of a substituted target, and it does not
create a new hash format.

`remainingLegacyKeys` is a subset of the four fixed legacy keys. The journal is
written before target creation and updated only after target read-back. A
terminal COMPLETE journal may be removed after final inventory; if a crash
precedes removal, startup removes it only after confirming target validity and
absence of every legacy key.

## Migration State Machine

All transitions run under the exclusive writer. No transition assumes multi-key
atomicity.

| Phase | Persistent state and crash behavior | Startup/resume | Cleanup? |
| --- | --- | --- | --- |
| `LEGACY_ONLY` | No target or journal. | Legacy is authority. | No. |
| `PREFLIGHT_VALIDATED` / `PREPARED` | Strict inventory passed; journal written; legacy untouched. | Re-read/revalidate legacy; retry construction with same migration ID. | No. |
| `TARGET_CONSTRUCTED` | Target exists only in memory. | Crash leaves `PREPARED` plus legacy. | No. |
| `TARGET_WRITTEN` | `setItem` returned but read-back is not trusted yet. | Re-read target; parse failure retains legacy. | No. |
| `TARGET_READBACK_VERIFIED` / `TARGET_VERIFIED` | Target semantically equals expected target; all legacy remains. | Legacy remains operational authority; target is only a controlled migration target. | No. |
| `CLEANUP_PENDING` | Journal lists legacy keys still present; individual deletes may have occurred. | Re-read target and resume only listed removals. | Yes, only listed keys. |
| `FINAL_EXPOSURE_INVENTORY` | All deletes attempted. | Verify target, journal binding, known-key absence, and forbidden-field inventory. | Only terminal journal action. |
| `COMPLETE_XPUBLESS` | Terminal journal written then removable. | Target is sole durable authority. | Already complete. |

No normal plan creation, import, archive, hidden update, or issuance is allowed
while the journal is `PREPARED`, `TARGET_VERIFIED`, or `CLEANUP_PENDING`. This
prevents lost updates and preference mismatch while representations coexist.
The journal must enter `CLEANUP_PENDING` before the first legacy deletion. From
that first deletion onward, target read-back validity is critically necessary
for recoverability; legacy is no longer a sole operational authority even if a
subset of its keys remains.

## Cleanup Order and Completion

Target write, immediate read-back, schema validation, semantic equality, and
journal binding are all required before the first legacy deletion. Then delete
one key at a time:

1. `timesats.vault-plans.v3`
2. `timesats.vault-plans.v2`
3. `timesats.archived-plan-identities.v1`
4. `timesats.hidden-deposit-indexes.v1`

After every `removeItem`, re-read/update the journal under the same exclusive
writer. A crash can leave a valid target and a subset of legacy keys, then
resume safely. This sequence is not a multi-key atomic delete.

`COMPLETE_XPUBLESS` is legitimate only when all are true:

- target envelope is present, strictly valid, and semantically valid;
- target and journal `stateId`/revision match when a journal exists;
- v3, v2, archive, and hidden legacy keys are all absent;
- journal is terminal and removable, or already absent after terminal
  verification;
- known-surface inventory finds no tpub-bearing legacy TimeSats surface;
- every migrated plan, UUID, preference mapping, `lastIssuedIndex`, and output
  commitment equals the verified preflight target.

Funding, balances, UTXO status, and whether a plan seems unused never take
part in this criterion. A valid target plus any surviving legacy tpub surface
is `PARTIAL_LEGACY_EXPOSURE`, never COMPLETE.

## Startup Authority Matrix

| Case | Authority and reads | Writes/resume | Status/action |
| --- | --- | --- | --- |
| A. target absent, journal absent, legacy present | Legacy only. | Current legacy behavior remains authority before activation; migration needs lock/preflight. | `LEGACY_ONLY`. |
| B. target valid, journal absent, legacy absent | Target is sole durable authority. | Future normal writes only under exclusive writer. | `COMPLETE_XPUBLESS`. |
| C. target valid, journal `CLEANUP_PENDING`, legacy present | Target is controlled resume source; legacy is exposure inventory. | Resume cleanup only; no normal mutation. | `PARTIAL_LEGACY_EXPOSURE`. |
| D. target valid, journal absent, legacy present | Do not infer completion. Legacy remains runtime authority. | No automatic cleanup or target mutation. | `BLOCKED_AMBIGUOUS_COEXISTENCE` and partial exposure. |
| E. target invalid, legacy intact | Legacy remains authority. | No cleanup; retain target for diagnosis. | `FAILED_RECOVERABLE`. |
| F. target invalid, any legacy removed | No representation is trusted as complete. | No automatic writes or cleanup. | `FAILED_RECOVERABLE`; recovery workflow. |
| G. valid journal, target absent | `PREPARED` plus intact legacy may retry; every other phase is inconsistent. | Only validated prepared retry. | `LEGACY_ONLY` or `FAILED_RECOVERABLE`. |
| H. journal invalid/corrupt | Do not infer phase from target/legacy. | No automatic cleanup or journal deletion. | `FAILED_RECOVERABLE`. |

Case D is deliberately fail-closed. A target with no valid journal might be an
abandoned or manually introduced state. Target existence alone never authorizes
legacy deletion.

## Rollback and Recovery

Before the first legacy deletion, rollback is simple: legacy remains authority;
a verified target/journal can be retained for diagnosis or removed only after
confirming all legacy entries are intact.

After any legacy deletion, complete rollback to a legacy VaultPlan is not
always possible because the target intentionally lacks tpub. The verified
target becomes critical recoverability state. P3 must not recreate legacy
tpub-bearing state from an xpubless target without separately validated public
reconnect, and must not use such recreation as a rollback shortcut.

Official recovery remains unchanged, is neither read nor rewritten by this
migration, and remains a separate recoverability surface.

## Persist Before Disclosure

P2 established that derivation is not disclosure. P3 must enforce this future
Deposit `#N+1` transaction:

```text
preconditions:
  valid state N
  publicly rehydrated V2 session
  exclusive writer acquired
  envelope reread after lock

1. derive canonical Deposit #N+1 in memory
2. appendIssuedDepositToXpublessV2PlanState(state N, session plan, commitment)
3. construct envelope revision +1
4. setItem target envelope
5. getItem target envelope
6. JSON parse + schema parse + semantic equality validation
7. only then return a committed deposit/address to UI
```

This is **PERSIST + READ-BACK BEFORE DISCLOSURE**. A future UI must not expose
a raw `getNextAddress()` that returns an address before committing. Its API
boundary is:

```text
P1/P2 pure core -> storage transaction layer -> committed-deposit UI result
```

### Issued versus disclosed

An output may be committed/issued in durable state before the user sees it. If
write/read-back for `#4` succeeds but the browser crashes before rendering,
`#4` remains reserved after restart and is not reused; the next session
proposes `#5`. A burned undisclosed index is safer than possible address reuse.
P3 does not add `wasDisplayed` to P1 state.

If `#N+1` is derived in memory, target write never occurs, and the address was
not disclosed, state remains N and retry can derive N+1 again.

If setItem may have happened but read-back throws, fails, or crashes, UI must
not disclose. On retry, acquire the writer and read state first:

- if state contains N+1, treat it as committed and do not append it again;
- if state remains N, reconstruct N+1 only after public reconnect;
- if state is malformed or uncertain, return `FAILED_RECOVERABLE` and do not
  disclose or reuse an uncertain index.

Immediate setItem/getItem is not fsync, power-loss durability, OS-crash
durability, or multi-key atomicity. It is only application-level persistent
write/read-back verification. Browser-real crash/reload testing remains a
release gate.

## Known-Surface Inventory and Privacy Boundary

P3 should provide a future `inventoryKnownLegacyExposure` helper. It inspects
only TimeSats-owned known keys: target envelope, journal, v3, v2, archive, and
hidden. It validates target/journal forbidden fields and records legacy residue.

It cannot prove absence in browser history, DevTools snapshots, extensions, OS
swap, crash dumps, manual exports, recovery files, screenshots, or another
application's storage. `COMPLETE_XPUBLESS` means only no tpub-bearing known
surface managed by this TimeSats storage schema remains. It does not mean
private state, RAM erasure, post-quantum security, or cryptographic migration.

## Status Model

| Status | Cleanup? | Old state retained? | Retry? | Meaning |
| --- | --- | --- | --- | --- |
| `LEGACY_ONLY` | No | Yes | Yes after preflight | No migration in progress. |
| `COMPLETE_XPUBLESS` | No | No legacy keys | Normal future writes | Target is sole known authority. |
| `PARTIAL_LEGACY_EXPOSURE` | Only valid cleanup journal | Some/all legacy | Yes | Target valid, but no no-tpub claim. |
| `BLOCKED_UNSUPPORTED_V1` | No | Yes | Separate V1 policy | V1 blocks entire snapshot. |
| `BLOCKED_DUPLICATE_SEMANTICS` | No | Yes | Dedupe decision | Canonical duplicate ambiguous. |
| `BLOCKED_ORPHAN_LEGACY_PREFERENCES` | No | Yes | Explicit preference policy | Legacy preference lacks one V2 mapping. |
| `BLOCKED_HIDDEN_INDEX_OUTSIDE_ISSUANCE` | No | Yes | Explicit policy | Legacy hidden index exceeds issued range. |
| `BLOCKED_AMBIGUOUS_COEXISTENCE` | No | Yes | Explicit reconciliation | Target and legacy lack valid journal. |
| `BLOCKED_CONCURRENT_WRITER` | No | Unchanged | Yes | Lock unavailable/stale state. |
| `FAILED_RECOVERABLE` | No | Preserve all available entries | Diagnosis then retry | Parse/write/read-back/journal/quota failure. |

## Failure Matrix

| Failure point | Expected persistent state | Startup action | Cleanup | Status |
| --- | --- | --- | --- | --- |
| Before journal | Legacy only. | Use legacy. | No. | `LEGACY_ONLY` |
| After `PREPARED` journal | Legacy intact, no target. | Revalidate and resume with same journal ID. | No. | `LEGACY_ONLY` |
| Before target write | Same as prepared. | Recompute only after lock/re-read. | No. | `LEGACY_ONLY` |
| During/after target write before read-back | Legacy intact; target absent/partial/untrusted. | Re-read target; retain legacy. | No. | `FAILED_RECOVERABLE` until verified. |
| After read-back before journal update | Valid target plus legacy; journal may be PREPARED. | Compare target to expected/preflight, advance journal. | No. | `PARTIAL_LEGACY_EXPOSURE` |
| During v3/v2/archive/hidden deletion | Valid target; journal lists remaining keys. | Resume under lock. | Only listed keys. | `PARTIAL_LEGACY_EXPOSURE` |
| After all cleanup before COMPLETE | Valid target, no legacy, nonterminal journal. | Final inventory then terminalize/remove journal. | No legacy left. | Partial until inventory. |
| Target corruption | Legacy intact or partially removed. | Retain all entries; no inference. | No. | `FAILED_RECOVERABLE` |
| Journal corruption | Target/legacy may exist. | Do not infer phase or delete. | No. | `FAILED_RECOVERABLE` |
| Concurrent writer/stale revision | No write should occur. | Release and retry from re-read state. | No. | `BLOCKED_CONCURRENT_WRITER` |
| Quota/setItem exception | Old state intact; target absent/untrusted. | Keep legacy, retry after storage availability. | No. | `FAILED_RECOVERABLE` |

## P3 Non-Negotiable Invariants

1. Write and verify target before any legacy delete.
2. Read back and semantically validate target before any legacy delete.
3. Never partially migrate a mixed V1/V2 snapshot.
4. Ambiguous canonical duplicates block rather than merge.
5. No canonical-identity preference keys remain after COMPLETE.
6. A persisted plan `localInstanceId` never changes during retry or resume.
7. `lastIssuedIndex` never decreases.
8. An issued index is never reused.
9. Derivation does not imply disclosure.
10. Persist and read back before disclosure.
11. Uncertain write means no disclosure.
12. Revision is not a lock.
13. Every write requires an exclusive writer.
14. Every writer re-reads after acquiring its lock.
15. No COMPLETE claim while legacy residue exists.
16. New envelope and journal contain no tpub or private material.
17. P3 does not change recovery format.
18. P3 does not change mainnet policy.
19. P3 never infers funding, UTXO status, balance, or safe deletion.
20. Current legacy storage remains runtime authority until a separate activation gate.

## Fake Storage Versus Browser-Real Gates

P3 should accept injected `StorageLike` and `ExclusiveWriter` interfaces for
deterministic tests of quota-like throws, failed writes, failed reads,
corruption, crash phases, journal resume, and stale revisions. This extends the
useful X2B fake-storage model without claiming browser behavior.

Browser-real validation remains mandatory before user-facing migration or UI
activation:

- quota semantics and write failures;
- reload and crash/restart behavior;
- actual lock behavior and browser support matrix;
- multi-tab conflicts;
- storage events if used for coordination;
- rollback/recovery workflow in actual browser engines.

P3 code remains unused/unwired or behind explicit dev/research activation until
those gates pass. It is storage/application infrastructure and must not be
exported by `src/bitcoin/index.ts`.

## Conservative Implementation Sequence

1. **P3A - Envelope and transition primitives.** Add isolated strict envelope
   and journal schemas, semantic validators, known-surface inventory types, and
   pure transition planning. No localStorage access, UI, or activation.
2. **P3B - Injected-storage migration rehearsal.** Implement journal-aware
   migration/resume against injected `StorageLike` and fake `ExclusiveWriter`.
   Cover every status and failure-matrix row. Still unused by the app.
3. **P3C - Committed issuance transaction.** Add injected-storage transaction
   logic around P2 append with re-read, revision, write/read-back, and a
   committed-deposit-only result. Still no UI activation.
4. **P3D - Browser-real concurrency and fault validation.** Prove selected lock
   behavior and browser storage behavior across supported engines and tabs.
5. **P3E - Separate activation decision.** Only after P3D and product gates,
   design UI/runtime migration, reconnect UX, errors, rollback, and authority
   cutover.

Official recovery remains unchanged in every phase. P3 does not create a
Bitcoin Core/Jade adapter, alter `ExternalSigner`, alter policy bytes, enable
mainnet, or infer blockchain state.

## Go / No-Go

**GO for P3A only, subject to these conditions:**

- implement the monolithic envelope and separate journal as isolated strict
  schemas and pure/injected-storage helpers;
- apply the exact preflight, status, journal, resume, and refusal rules above;
- do not modify current storage authority or wire P3 into the app;
- do not claim multi-tab safety, browser-real durability, recovery evolution,
  generic wallet support, physical Jade support, or mainnet readiness.

**NO-GO for user-facing migration, normal xpubless storage authority, UI
activation, or release.** Those require exclusive-writer proof, browser-real
fault/concurrency tests, a separate activation decision, V1/duplicate handling
policies, reconnect UX, and independent recovery/mainnet gates.
