# Optional Regtest CLTV semantic integration

This is an optional local Bitcoin Core integration check, intentionally excluded from `npm test`. It starts an isolated `bitcoind -regtest`, uses a new disposable **Regtest** wallet and freshly generated local test key, and derives the vault through TimeSats’ `deriveVault` implementation. That key is created inside Bitcoin Core for the harness and is never part of TimeSats’ application flow, source tree, or recovery bundle.

## Prerequisites

- Bitcoin Core with `bitcoind` and `bitcoin-cli`;
- `bitcoind`, `bitcoin-cli`, and a Node.js installation;
- no mainnet configuration: the script invokes every RPC with `-regtest`.

Run:

```bash
npm run test:regtest
```

The harness starts Core with `-regtest -listen=0 -connect=0 -dnsseed=0`, generates one memory-only secp256k1 **Regtest test key** through `@noble/curves`, derives the P2WSH address using TimeSats, and imports Core’s top-level `raw(<TimeSats outputScript>)` descriptor into a disposable watch-only Regtest wallet. This is the exact P2WSH locking output, not an equivalent Miniscript expression. The harness uses `bitcoinjs-lib`'s SegWit-v0 sighash and `@noble/curves` to sign the test transaction locally; Core is the authority that accepts or rejects it. No private key/WIF is exported, logged, or persisted.

- `nLockTime = H`;
- the vault input `nSequence = 0xfffffffe` (non-final);

It asserts `testmempoolaccept` rejects: the normal pre-height spend, final sequence (`0xffffffff`), inadequate `nLockTime`, a corrupted signature, and an incorrect witness script. It then mines to the lock height, asserts the correct spend is accepted, broadcasts it, mines its confirmation, and asserts `gettxout` returns null for the original vault UTXO.

The script stops on any unexpected result. It does not start a daemon, download software, access a public network, or use mainnet.
