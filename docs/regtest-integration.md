# Optional Regtest end-to-end integration

`npm run test:regtest` is intentionally separate from `npm test`. It requires official Bitcoin Core `bitcoind` and `bitcoin-cli`, and starts an isolated daemon with only:

```text
-regtest -server=1 -listen=0 -connect=0 -dnsseed=0 -discover=0
```

Every CLI RPC also receives `-regtest`; the script aborts if `getblockchaininfo.chain` is not `regtest`. It does not touch mainnet, Signet, a user wallet or product runtime data.

```bash
BITCOIND=/absolute/path/to/bitcoind BITCOINCLI=/absolute/path/to/bitcoin-cli npm run test:regtest
```

Unless `BITCOIN_REGTEST_DATADIR` is provided, the script owns a temporary datadir and attempts to delete it after stopping Core. `TIMESATS_KEEP_REGTEST_DATA=1` is only for debugging a disposable run.

## What the v0.2 harness proves

1. Generates a random BIP32 root **inside the harness process only**.
2. Sends only the root `tpub` to `createVaultPlan`; private child keys never enter `src/domain`, `src/bitcoin` production APIs, UI, localStorage or a bundle.
3. Derives Deposit #0 (`m/0`) and Deposit #1 (`m/1`) through TimeSats code, asserts different addresses, and verifies each public child against the harness-only BIP32 child.
4. Imports each exact TimeSats P2WSH output via Core `raw(<outputScript>)`, then verifies Core derives the same Regtest address.
5. Funds both addresses with Regtest coins and confirms both UTXOs.
6. Before `unlockHeight`, submits correctly signed spends for both to `testmempoolaccept`; Core returns a real rejection (`non-final`).
7. Separately proves, for Deposit #0, that final `nSequence = 0xffffffff` and `nLockTime < unlockHeight` fail CLTV; corrupted signature and witness script also fail.
8. Mines to the unlock height, builds both P2WSH witness spends with `nLockTime = unlockHeight` and `nSequence = 0xfffffffe`, gets Core mempool acceptance, broadcasts and mines them.
9. Calls `gettxout` for both original outputs and requires an empty result after confirmation.

The test uses `bitcoinjs-lib` for SegWit v0 sighash/transaction serialization and `@noble/curves` only for the memory-only harness signatures. Bitcoin Core remains the consensus authority. No production spending implementation is added.

## Expected output shape

Values change on every run because the BIP32 root is random. The output contains no private key, seed or WIF:

```text
CORE chain=regtest initialHeight=0
PLAN unlockHeight=111 Deposit#0=bcrt1... Deposit#1=bcrt1... addressesDifferent=true
FUNDING Deposit#0 txid=... vout=... amountBtc=1
FUNDING Deposit#1 txid=... vout=... amountBtc=1
NEGATIVE before-unlockHeight-Deposit#0: non-final
NEGATIVE before-unlockHeight-Deposit#1: non-final
NEGATIVE final-sequence-ffffffff-Deposit#0: mempool-script-verify-flag-failed (Locktime requirement not satisfied)
NEGATIVE nLockTime-below-unlockHeight-Deposit#0: mempool-script-verify-flag-failed (Locktime requirement not satisfied)
NEGATIVE incorrect-signature-Deposit#0: ...
NEGATIVE incorrect-witness-script-Deposit#0: Witness program hash mismatch
SPEND Deposit#0 accepted=true txid=... confirmedHeight=112 originalUtxoSpent=true
SPEND Deposit#1 accepted=true txid=... confirmedHeight=112 originalUtxoSpent=true
```

If Bitcoin Core is unavailable, the harness must not be represented as executed. Obtain the archive only from [bitcoin.org/bin](https://bitcoincore.org/bin/), verify its SHA-256 against the published manifest, and verify the manifest signature when GPG is available before running it.
