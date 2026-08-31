# Xpubless V2 Production Authority Transition Design

**P3E1 DESIGN AND INVENTORY. NOT USER-FACING. NOT ACTIVATED.**

This document defines the authority transition required before the real app can
use xpubless V2 storage. It records current production readers and writers at
commit `52f80b4`, and designs later P3E work. It does not change the app,
storage engines, recovery, wallet connectivity, network policy, or mainnet.

```text
legacy VaultPlan authority
        -> journaled P3B migration
        -> xpubless envelope authority
```

One logical local profile must have exactly one normal write authority. The
only permitted coexistence of target and legacy surfaces is P3B's journaled
migration protocol. It is not a dual-runtime mode.

## Storage Surfaces And Production Search

| Surface | Current contents | Current role |
| --- | --- | --- |
| `timesats.vault-plans.v3` | Full V3 `VaultPlan[]`, including V2 public source. | Legacy authority. |
| `timesats.vault-plans.v2` | Legacy plan fallback. | Legacy authority/input to P3B. |
| `timesats.archived-plan-identities.v1` | `vaultPlanIdentity[]`; V2 identity has source/origin. | Legacy archive preference. |
| `timesats.hidden-deposit-indexes.v1` | `vaultPlanIdentity -> index[]`. | Legacy hidden preference. |
| `timesats.xpubless-local-state.v1` | P3A xpubless envelope. | Future authority. |
| `timesats.xpubless-migration-journal.v1` | P3A/P3B journal. | Transitional coordination only. |

The production search covered `src/**` for browser storage, all legacy helper
names, issuance/preference functions, and TimeSats keys. The only production
direct browser-storage access is in `src/components/timesats-app.tsx`; it
delegates serialization to `src/storage/vault-plan-storage.ts`. Test files,
research scripts, and browser harnesses are not production writer paths.

`LegacyCreatePlanDialog` is exported from `timesats-sections.tsx`, but no
production component imports or renders it. `CreatePlanDialog` is active and
still offers Policy V1 and V2.

After `COMPLETE_XPUBLESS`, for the known xpub-related local-state surfaces
covered by this transition, the durable target is
`timesats.xpubless-local-state.v1` and the four legacy surfaces are absent.
Archive and hidden preferences then live inside the envelope and must not
reappear as legacy keys. This is not a claim about unrelated TimeSats keys.

No storage-mode flag is proposed. P3A/P3B already provide the canonical target,
journal, and full legacy inventory needed to classify authority. A separate
`timesats.storage-mode` value could diverge from those facts.

## Reader Inventory

| Reader | File/function | Storage surface | Purpose | Legacy-only? | Xpubless equivalent exists? | Activation action |
| --- | --- | --- | --- | --- | --- |
| Plans startup load | `timesats-app.tsx` effect, `loadVaultPlans` | V3, then V2 fallback | Populate `VaultPlan[]` and error. | Yes | No production loader | Replace after classification/view model exist. |
| Archive startup load | `loadArchivedPlanIdentities` | Legacy archive key | Filter visible plans. | Yes | Envelope field exists | Read `archivedLocalInstanceIds` for xpubless. |
| Hidden startup load | `loadHiddenDepositIndexes` | Legacy hidden key | Filter issued rows. | Yes | Envelope field exists | Read map by local instance ID. |
| Migration inventory | P3B `readRelevantRawState` | Target, journal, four legacy keys | Strict preflight/resume. | Transitional | Injected engine exists | Call via P3D wrapper under lock. |
| Issuance authority read | P3C persisted-state parse | Target, journal, four legacy keys | Require ready xpubless authority. | No | Injected engine exists | Call via P3D wrapper; no pre-read authority. |

The convenience loader's `v3 ?? v2` fallback must not become P3E authority
classification. It cannot inspect all legacy surfaces or apply P3B coexistence
rules.

## Writer Inventory

| Operation | UI entry point | Current function | Storage writes | Authority | Public source? | Xpubless operation today? | P3E action |
| --- | --- | --- | --- | --- | --- | --- |
| Create plan | Header/Hero/PlansGrid -> create dialog | `createVaultPlan -> upsertAndPersist` | V3 plans | Legacy | Yes | Pure conversion only | Typed committed create. |
| Import recovery | PlansGrid file input | `reconstructVaultPlan -> upsertAndPersist` | V3 plans | Legacy | Bundle contains it | Pure conversion only | Typed committed import. |
| Issue next deposit | Active plan -> new-deposit dialog | `issueNextDeposit -> upsertAndPersist` | V3 plans | Legacy | Yes | P3C/P3D1 | Prohibit legacy path for xpubless. |
| Archive | Plan menu/dialog | `archivePlanIdentity -> persistArchived` | Archive key | Legacy | No | No | Typed preference mutation. |
| Restore plan | Archived plan menu | `restorePlanIdentity -> persistArchived` | Archive key | Legacy | No | No | Typed preference mutation. |
| Hide deposit | Deposit menu/dialog | `hideDepositIndex -> persistHiddenDeposits` | Hidden key | Legacy | No | No | Typed preference mutation. |
| Restore hidden | Hidden list | `restoreHiddenDepositIndex -> persistHiddenDeposits` | Hidden key | Legacy | No | No | Typed preference mutation. |
| Remove locally | Plan menu/dialog | `removePlan` | V3, archive, hidden separately | Legacy | No | No | One envelope remove. |
| Rename metadata | Not currently exposed | None | None | N/A | No | P3A permits revision | Reserve typed mutation. |
| Export recovery | Plan menu/remove dialog | `createVaultPlanRecoveryBundle` | None | Session/UI | Yes, full plan | No xpubless export path. |
| Prepare spend | Deposit row -> spend dialog | Funding/PSBT functions | None | Session/UI | Yes, current API needs plan | No xpubless spend path. |

`timesats-app.tsx` writes V3 through `persist`/`upsertAndPersist` for create,
import, and legacy issuance. It writes archive/hidden independently, while
`removePlan` directly writes all three legacy keys. These paths are not corrupt
today. They become a coexistence risk only if P3E lets them remain available for
the same logical profile after xpubless becomes authority.

## Startup Authority Classification

Startup must inspect target, journal, and all four legacy surfaces before it
selects a view model or enables an operation. This is a pure design, not a new
runtime enum.

| Observed surfaces | Authority classification | Allowed reads | Allowed writes | Required action |
| --- | --- | --- | --- | --- |
| No target, no journal, no legacy | `EMPTY_LOCAL_STATE` | Empty xpubless-capable view. | Approved initial V2 create only. | Do not create legacy staging state. |
| No target, no journal, valid legacy | `LEGACY_AUTHORITY` / `MIGRATION_CANDIDATE` | Legacy view is a product decision. | No ordinary write once migration selected. | Offer approved P3B transition. |
| Valid target, no journal, all legacy absent | `XPUBLESS_AUTHORITY` | Xpubless summary view. | Typed xpubless operations only. | Never call legacy writers. |
| Journal present | `MIGRATION_IN_PROGRESS_OR_RESUMABLE` | Migration status only. | Migration resume only. | Lock, resume, or show blocker/retry. |
| Valid target plus legacy, no journal | `AMBIGUOUS_BLOCKED` | Diagnostic only. | None. | No heuristic authority choice. |
| Corrupt target | `FAILED_RECOVERABLE_OR_BLOCKED` | Diagnostic/error only. | None. | Preserve bytes; do not overwrite/fall back. |
| Legacy contains V1 | `LEGACY_UNSUPPORTED_FOR_AUTOMATIC_MIGRATION` | Legacy blocked path. | No partial migration/cleanup. | Retain data and explain blocker. |

`NO_LEGACY_STATE` and `COMPLETE_XPUBLESS` are storage-transition results only.
They say nothing about funding, balance, UTXOs, safe removal, or the existence
of Bitcoin.

When a journal exists, no create, import, issue, archive, hidden, remove, or
rename operation may write in parallel. Migration owns the common lock and must
first resume, complete, or return a blocker.

## One Authority And One Lock Domain

All xpubless mutations use exactly:

```text
timesats:xpubless-local-state:v1
```

This includes migration, create, import, issue, archive, restore archive, hide,
restore hidden, remove, rename, and future envelope mutations. There is no
per-plan/per-operation lock. Revision is stale-state material, not a lock/CAS.

Legacy helpers may remain for a clearly classified legacy-only/backward path.
They must not receive writes for xpubless, journal-present, or ambiguous
profiles. After complete migration, reinitialize React state from the target;
a retained legacy `VaultPlan` must not remain a writer.

Storage events may notify a tab that its React state is stale. They are
notification only, never a lock, CAS, authority decision, or commit
acknowledgment. A tab must re-read the authoritative envelope before acting.

Automatic rollback to legacy is prohibited after `COMPLETE_XPUBLESS`. It would
reintroduce public-source persistence and dual authority.

## Operation Design

### Create V2

The legacy `createVaultPlan -> upsertAndPersist -> saveVaultPlans` sequence is
not authority for an xpubless profile. The target sequence is:

```text
session public source
-> create VaultPlan in memory
-> createXpublessV2PlanState(plan, caller localInstanceId)
-> initial/next envelope transition
-> write/read-back/schema verification
-> product success
```

For `EMPTY_LOCAL_STATE`, create the first xpubless envelope directly. Do not
write a legacy record merely to migrate it. `createInitialXpublessV2LocalState`
and `createXpublessV2PlanState` already build pure values. Missing are committed
persistence, state/local-ID source policy, browser wrapper, and tests.

The active dialog permits V1. Xpubless is V2-only. Recommended boundary: no new
V1 creation in an xpubless-authority profile. A separate legacy-only V1 route
would prevent xpubless authority for that shared storage profile and needs an
explicit product decision; V1 is never silently converted.

### Import Recovery

Preferred design: reconstruct and validate a V2 recovery bundle in memory, then
convert it directly to xpubless state under a typed committed import. Do not use
V3 as a staging area.

Import must define duplicate semantics, a caller-generated `localInstanceId`
for a new local instance, default archive/hidden preferences, state revision,
and recovery freshness. The bundle source is transient and never enters the
envelope. An equivalent plan requires a typed blocker or separately reviewed
reconciliation; it must not silently regress `lastIssuedIndex`. V1 bundle
import cannot use xpubless and remains a legacy/blocked product decision.

### Issuance And Local Preferences

For `XPUBLESS_AUTHORITY`, `issueNextDeposit` and `upsertAndPersist` are
prohibited. The only issuance path is:

```text
browserCommitNextXpublessV2Deposit
-> P3C re-read and source rehydration
-> verified write/read-back
-> COMMITTED result
-> address disclosure
```

Only P3C's `COMMITTED` result may supply a newly shown address. Existing output
commitments never authorize a candidate `#N+1` address.

Archive/restore changes `archivedLocalInstanceIds`. Hide/restore changes
`hiddenDepositIndexes` by `localInstanceId`, validating plan and issued index.
They need no public source and do not change policy/recovery. Remove is one
envelope transaction: remove plan, archive reference, hidden entry, increment
revision once, write/read-back one target. Local removal says nothing about
Bitcoin or safety to delete. Rename is not exposed; if added it is another typed
locked envelope mutation.

## Public Source And View-Model Boundaries

| Operation | Needs a presented public source? | Reason |
| --- | --- | --- |
| List plans/archive/hidden | No | Envelope holds labels, network, height, commitments, and preferences. |
| Display existing address | Not intrinsically, but helper missing | Known P2WSH output script plus network can be encoded without a tpub. |
| Create V2 plan | Yes | `createVaultPlan` and P2 conversion validate public policy. |
| Import V2 recovery | Yes, supplied by bundle transiently | Bundle reconstructs a full in-memory plan. |
| Issue next deposit | Yes | P3C rehydrates and validates source. |
| Archive/restore/hide/restore/remove/rename | No | Local envelope mutations. |
| Export recovery | Yes | Existing helper requires `VaultPlan`. |
| Prepare spend/PSBT | Yes | Current funding verifier derives witness script, pubkey, and origin. |

The current React model is `VaultPlan[]`, `activePlan: VaultPlan`, and
`DerivedDeposit[]`. It derives every visible address from a plan containing a
tpub. It cannot be the durable UI model after an xpubless reload.

Recommended boundary:

- Normal xpubless state uses summaries keyed by `localInstanceId`, envelope
  archive/hidden preferences, issued output commitments, and optional existing
  address summaries.
- A rehydrated `VaultPlan` is transient session material for issuance, recovery
  export, and the current spend flow.
- Listing plans must work without retaining a tpub in React state after reload.

`deriveVault` maps a policy public key to P2WSH address/script, while
`deriveDeposit` needs a complete plan and returns public key, witness script,
descriptor, and address. The repository has no tested helper that converts a
committed `outputScript` plus network into an address summary. P3E should add
and test a narrow pure helper before using it. It must not derive a next address
or expose child public material. Until then `ActivePlanCard` cannot simply be
fed xpubless state.

The current spend dialog needs a full `VaultPlan` for funding verification and
PSBT metadata. P3E must require public-source reconnect before that flow or
design a separately reviewed xpubless spend bridge. This is a reconnect/P4
boundary, not a reason to persist a tpub.

Recovery export similarly requires session rehydration. Recovery import is
easier because the bundle carries public source, but freshness still matters:
`lastIssuedIndex` covers known issuance and never authorizes a future index.

## Required Typed Xpubless Mutation APIs

P3C is specific to committed issuance. It must not become a generic preference
or plan mutator. The app cannot replace current writers with P3C alone.

P3E needs small, typed, committed operations for:

1. create the initial envelope with a V2 plan;
2. add/import a V2 plan into an existing envelope;
3. archive and restore archive;
4. hide and restore hidden issuance indexes;
5. remove a local plan and its preferences in one envelope transition;
6. rename metadata if and when UI exposes it.

Each operation must acquire the one outer browser lock, re-read inside it,
parse/validate the full envelope, use P3A's next-revision builder, serialize,
set, get, schema-parse, structurally compare, then return `COMMITTED`. A
private shared implementation may reduce duplication, but exports must be typed
operations with narrow invariants. There must be no public "run any mutation"
escape hatch.

Likely per-operation statuses include `COMMITTED`, `BLOCKED_CONCURRENT_WRITER`,
`BLOCKED_STALE_STATE`, `BLOCKED_PLAN_NOT_FOUND`,
`BLOCKED_DUPLICATE_SEMANTICS`, `FAILED_RECOVERABLE`, and
`UNSUPPORTED_EXCLUSIVE_WRITER`. Exact status sets should stay narrow; P3E must
not hide P3B/P3C semantics in one mega-enum.

## Migration And UI State

| Product state | Underlying result/surface | Permitted behavior |
| --- | --- | --- |
| `EMPTY` | Empty known inventory | Empty view; approved initial V2 create only after capability gate. |
| `LEGACY_READY` | Legacy-only before migration is selected | Legacy UX decision pending; do not call it xpubless. |
| `MIGRATION_REQUIRED` | Valid P3B candidate | Begin/resume only through P3D lock path after product decision. |
| `MIGRATION_BLOCKED` | `BLOCKED_UNSUPPORTED_V1`, `BLOCKED_DUPLICATE_SEMANTICS`, `BLOCKED_ORPHAN_LEGACY_PREFERENCES`, `BLOCKED_HIDDEN_INDEX_OUTSIDE_ISSUANCE`, or `BLOCKED_AMBIGUOUS_COEXISTENCE` | Explain and retain data; no cleanup/normal write. |
| `MIGRATION_RETRYABLE` | `FAILED_RECOVERABLE` or interrupted journal | Preserve state; retry/resume under lock. |
| `XPUBLESS_READY` | Valid target, no journal, no legacy | Xpubless summary model and typed writers only. |

On `COMPLETE_XPUBLESS`, discard legacy React authority and reinitialize from
the target. A React snapshot from before migration must not write. During
journal presence, resolve migration before every normal operation, including
create and import.

## Operation Authority Table

| Operation | Legacy authority path | Xpubless target path | Available today? | Public source? | Lock? | P3E phase | Blocker |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Startup list | Legacy loaders | Xpubless loader/view model | No | No | Read only | P3E4 | View model/helper missing. |
| Migrate | None in app | P3B via P3D1 | Engine yes, app no | Existing legacy source | Yes | P3E4 | UX/authority gate. |
| Create | `createVaultPlan -> saveVaultPlans` | Typed initial/add | No | Yes | Yes | P3E2 | Mutation missing. |
| Import | `reconstructVaultPlan -> saveVaultPlans` | Typed import | No | Yes, bundle | Yes | P3E2 | Duplicate/freshness rules. |
| Issue | `issueNextDeposit -> saveVaultPlans` | P3C via P3D1 | Yes, isolated | Yes | Yes | P3E5 | Reconnect/app integration. |
| Archive/restore | Legacy archive key | `archivedLocalInstanceIds` | No | No | Yes | P3E2 | Mutation missing. |
| Hide/restore | Legacy hidden key | `hiddenDepositIndexes` | No | No | Yes | P3E2 | Mutation missing. |
| Remove local | Three legacy writes | One envelope transition | No | No | Yes | P3E2 | Mutation/recovery UX missing. |
| Rename | Not exposed | Metadata revision | No | No | Yes | Later P3E | No UI/API. |
| Export recovery | Full plan helper | Rehydrate then helper | No | Yes | No mutation | P3E5 | Reconnect UX. |
| Prepare spend | Full plan flow | Rehydrate then existing flow/bridge | No | Yes | No mutation | P3E5/P4 | Reconnect/view boundary. |

## Proposed P3E Sequence

1. **P3E2 - committed local mutations:** implement/test isolated typed
   create/import/preference/remove transitions and browser wrappers, unused.
2. **P3E3 - environment binding:** implement capability detection and startup
   classification, still unused by normal UI. Do not activate migration.
3. **P3E4 - read model and migration:** implement xpubless loader/view model
   and development-gated migration with every P3B blocker/retry state.
4. **P3E5 - issuance and preferences:** development-gate P3C issuance,
   reconnect boundary, archive/hidden/remove operations, and recovery/spend
   boundaries. Remove legacy writer access for xpubless profiles.
5. **P3E6 - real app E2E:** exercise upgrade, reload, blockers, partial resume,
   two tabs, quota, issuance, stale state, unsupported writer, and no-bypass
   writer assertions in the actual app.
6. **P3E7 - activation audit:** decide limited enablement, browser policy,
   recovery/export policy, and remaining P3D/P3E gates.

P3E2 is the recommended next coding phase, not UI wiring. It fills the
committed xpubless mutation gap while keeping P3C dedicated to issuance and
P3D1's coordination model intact.

## Non-Negotiable Invariants

1. One logical profile has one normal write authority.
2. Target/legacy coexistence is permitted only under P3B's journal protocol.
3. Every xpubless mutation uses `timesats:xpubless-local-state:v1`.
4. No legacy write is permitted after xpubless authority is selected.
5. No tpub, identity, child public key, witness script, or descriptor is
   durable in xpubless state or preference keys.
6. A next address is disclosed only after P3C returns `COMMITTED`.
7. Storage failure never discloses an address and fails closed.
8. Archive/hidden preferences are envelope fields, not separate legacy keys.
9. No operation infers funding, balance, UTXO state, or safe local removal.
10. No operation accepts seed, mnemonic, private key, WIF, xprv, or tprv.
11. V1 is never automatically migrated or silently converted to V2.
12. There is no automatic rollback from complete xpubless authority to legacy.
13. Public-source acquisition happens outside the writer lock and is session-only.
14. Storage events are notification only.
15. Mainnet remains blocked; Signet/Regtest policy is unchanged.

The presented extended public key is never included in the xpubless envelope,
preference keys, lock name, `localInstanceId`, `stateId`, or migration journal.

## Decisions Required Before P3E2/P3E3

- Confirm initial-envelope and local-instance/state-ID source policy for create/import.
- Define equivalent-plan duplicate behavior and recovery freshness handling.
- Approve V1 behavior once xpubless authority exists; recommended default is no
  new V1 creation in xpubless mode.
- Define recovery export/pre-cleanup UX without making browser state the sole
  recovery anchor.
- Define reconnect UX for issuance, export, and spending without adding wallet
  adapters to P3E core.
- Specify startup behavior for legacy-only users before migration is selected.
- Confirm the narrow existing-address-from-output-script helper before adopting
  an xpubless address list.

P4A may proceed in parallel on `PUBLIC_KEY_SOURCE`, `PSBT_SIGNER`, and generic
transports because those contracts do not depend on this UI authority
transition. Direct wallet adapters/UI must respect these boundaries and may not
bypass P3C, typed envelope mutations, or the shared lock.
