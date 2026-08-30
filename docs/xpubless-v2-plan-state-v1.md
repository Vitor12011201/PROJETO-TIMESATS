# Xpubless V2 Plan State v1 and HIC v1

## Scope

This specification freezes the isolated P1 durable plan-state contract. It is not a `VaultPlan`, Policy V3, recovery bundle, storage envelope, migration journal, wallet descriptor, Bitcoin identity or public Bitcoin facade.

`XpublessV2PlanState` represents one future durable local Policy V2 plan without persistent tpub. It has:

```text
format: "timesats-xpubless-v2-plan-state"
version: 1
policyVersion: 2
```

Version 1 is the first xpubless plan-state version, not Policy V1.

## Durable shape

The state contains `localInstanceId`, V2 policy metadata, canonical origin, label, versioned HIC envelope, `lastIssuedIndex`, and contiguous `{ index, outputScript }` commitments. It intentionally does not contain tpub/xpub, canonical `vaultPlanIdentity`, child public keys, witness scripts, descriptors, funding data, archive, hidden preferences, a storage key, a migration journal or private material.

`localInstanceId` is validated as lowercase canonical UUID text only. It is an opaque local-instance identifier, not canonical Bitcoin identity, dedupe key or historical commitment. P1 does not generate it; uppercase UUID aliases are rejected.

`issuedOutputs` must be exactly `#0..#lastIssuedIndex` in order. Each output script is lowercase P2WSH v0 `0020` plus the 32-byte SHA256 witness-script commitment. Issuance remains monotonic; no parser reconciles or reuses an index.

## Canonical origin

`masterFingerprint` is eight lowercase hexadecimal characters. `sourcePath` is an absolute BIP32 path with canonical apostrophe hardening markers only: `m`, `m/44'`, `m/44'/1'/0'`, and so on. `h`, `H`, uppercase fingerprint and out-of-range child-number aliases are rejected rather than normalized.

The durable state does not contain a tpub. HIC input does contain a session/public tpub and is deliberately a different type. The P1 domain module validates only its canonical testnet extended-public-key shape. P2 must supply a BIP32-validated, normalized tpub from the existing VaultPlan boundary; P1 does not become a second BIP32 parser.

## Historical identity commitment v1

The HIC envelope is:

```json
{
  "scheme": "timesats-historical-identity",
  "version": 1,
  "algorithm": "sha256",
  "digest": "64 lowercase hexadecimal characters"
}
```

HIC v1 provides binding and conditional integrity only when the original digest remains trustworthy. It is not authentication, a trust anchor, tamper-proof state, secret, secure backup or post-quantum claim. The digest is correlatable.

Its preimage is UTF-8 bytes of `JSON.stringify` of exactly this ordered JSON array, with no whitespace or object-key ordering:

```text
[
  "timesats-historical-identity",
  1,
  2,
  network,
  unlockHeight,
  "bip32-testnet-xpub-with-origin",
  extendedPublicKey,
  masterFingerprint,
  sourcePath,
  "m/<index>",
  false
]
```

Array order and JSON types are part of HIC v1. String inputs are canonical before serialization. Any incompatible change requires a new HIC scheme/version; HIC v1 is never reinterpreted.

HIC intentionally excludes label, `localInstanceId`, `lastIssuedIndex`, `issuedOutputs`, archive, hidden state and migration status. It commits historical public policy/key-source identity, not mutable local state or issuance history.

The fixed public-fixture vector is:

```text
preimage = ["timesats-historical-identity",1,2,"regtest",250,"bip32-testnet-xpub-with-origin","tpubDDjsCRDQ9YzyaAq9rspCfq8RZFrWoBpYnLxK6sS2hS2yukqSczgcYiur8Scx4Hd5AZatxTuzMtJQJhchufv1FRFanLqUP7JHwusSSpfcEp2","6f53d49c","m/44'/1'/0'","m/<index>",false]
sha256 = 4c97d12818326f873a3e3628f754e542ef55679cdd2789f0205e5650cdcf168a
```

The production domain module serializes but does not hash. P1 tests use Node `crypto` only to verify the fixed SHA256 vector. A browser-compatible runtime hashing decision belongs to P2 and must not change the v1 tuple.

## Boundaries

P1 does not create `VaultPlan -> candidate`, `candidate -> VaultPlan`, wallet reconnect, localStorage, migration, UI, adapter, Core RPC, Jade, recovery, PSBT, funding, spending or broadcast. Policy V1 remains structurally excluded and mainnet remains rejected.
