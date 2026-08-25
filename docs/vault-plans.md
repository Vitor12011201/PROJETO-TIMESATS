# Vault Plans v0.2

## Security-critical policy versus metadata

`VaultPlan` is a strict, versioned object:

```text
format: "timesats-vault-plan"
version: 2
policy:
  policyVersion: 1
  network: signet | regtest
  unlockHeight: integer 1..499999999
  keySource: { type: "bip32-testnet-xpub", extendedPublicKey: tpub... }
  derivation: { pathTemplate: "m/<index>", hardened: false }
lastIssuedIndex: integer >= 0
metadata: { label: string }
```

`policy` and `lastIssuedIndex` are reconstruction-critical. `metadata.label` is explicitly not: renaming “Minha Casa” to “Aposentadoria” does not alter a child key, script, output script or address. At creation, `lastIssuedIndex` is `0`, so Deposit #0 is already issued.

## BIP32 public derivation

The source is a BIP32 test-network extended **public** key. `@scure/bip32` parses its Base58Check representation and derives each normal child; TimeSats does not implement BIP32, HMAC, Base58Check or curve arithmetic.

```text
source tpub (the supplied node)
  m/0 -> P_0 -> witnessScript_0 -> P2WSH address_0
  m/1 -> P_1 -> witnessScript_1 -> P2WSH address_1
  ...
```

The relative path is always `m/<index>` and `index` is `0..0x7fffffff`. Hardened children are deliberately rejected because BIP32 public derivation cannot produce them. A user must supply a `tpub` located at the account/branch they intend to use; TimeSats does not infer BIP44/84 paths or create an account.

BitcoinJS defines both `networks.testnet` and `networks.regtest` with BIP32 public version `0x043587cf` (`tpub`) and private version `0x04358394` (`tprv`). Signet uses the testnet network parameters here. This shared key encoding does not make the resulting addresses cross-network: address derivation uses `tb` for Signet and `bcrt` for Regtest.

## Per-deposit Bitcoin policy

For plan height `H` and child public key `P_i`, the exact v0.1 source of truth remains:

```text
<minimal Script-number H> OP_CHECKLOCKTIMEVERIFY OP_DROP <compressed P_i> OP_CHECKSIG
```

`bitcoinjs-lib` compiles the Script number/opcodes and wraps it as P2WSH v0. The resulting deposit includes `index`, path, public key, witness script hex, output script hex, address and exact `raw(<outputScript>)` descriptor.

`raw()` is standardized by BIP 385 and is intentionally an exact per-output descriptor. It is not a ranged policy descriptor and does not claim signer support. A future tool can recreate all deposits from the plan’s public data, then use a wallet/signer that actually supports P2WSH CLTV spends.

## Recovery bundle

The v2 bundle contains the `policy`, `metadata` and `recovery.lastIssuedIndex`. Import uses a strict Zod schema and re-parses the extended key through `@scure/bip32`; unknown fields, mainnet, private key formats, hardened template, invalid height and invalid indexes fail. Derived fields are intentionally not duplicated in the bundle: all are deterministically recomputed, avoiding a stale-address field being trusted.

To reconstruct independently:

1. Retain the user’s own signing wallet/key material separately; TimeSats never has it.
2. Retain the public v2 bundle, and read `network`, `unlockHeight`, source `tpub`, path template and highest index.
3. Derive children `m/0` through `m/lastIssuedIndex` from that public source.
4. Recompile the documented P2WSH CLTV script for every child, or use each computed exact `raw()` descriptor.
5. Locate UTXOs on the stated test network with independently chosen infrastructure.
6. Only after the height is eligible, use signing software proven to construct the required P2WSH witness and transaction fields.

The bundle is public policy metadata, not a seed backup, transaction history, balance proof, or a promise that any specific wallet can sign it.

## Local persistence

The browser writes `{ format: "timesats-local-vault-plans", version: 2, plans: [...] }` under `timesats.vault-plans.v2`. It holds only the same public data as the plan. If parsing fails, v0.2 returns no plans and reports an error without trying to “repair” untrusted data. No localStorage value is sent to a TimeSats server because there is no such application API.
