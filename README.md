# TimeSats

> Seu Bitcoin. Seu prazo. Suas chaves.

## EXPERIMENTAL SOFTWARE — SIGNET/REGTEST ONLY — DO NOT SEND REAL BITCOIN

## NEVER ENTER A SEED OR PRIVATE KEY

TimeSats v0.1 is a small, static-first technical proof for a self-custodial Bitcoin absolute timelock. Given a **test public key** and an **unlock block height**, it deterministically derives a P2WSH test-vault address. It does not generate keys, sign transactions, broadcast transactions, run a wallet, or hold funds.

## The problem and proposal

Someone planning to hold bitcoin long-term may want a voluntary rule: “do not spend these sats before block X.” TimeSats expresses that rule as Bitcoin Script. The user remains the only holder of the signing key; the Bitcoin network evaluates the timelock. TimeSats is not a custodian and cannot unlock, recover, or move bitcoin.

## What v0.1 does

- accepts only a compressed secp256k1 **public key** and a block-height locktime;
- supports **Signet** (default) and **Regtest** only;
- derives a deterministic native SegWit v0 P2WSH address and public recovery bundle;
- validates inputs locally in the browser;
- contains no application API routes, analytics, accounts, database, or secret handling.

It deliberately does **not** create seed phrases, request private keys/WIF/xprv, sign, broadcast, estimate fees, query a chain, or accept mainnet.

## Timelock model

The witness script is documented precisely in [docs/bitcoin-script.md](docs/bitcoin-script.md). In policy form it is:

```text
<unlockHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <compressedUserPublicKey> OP_CHECKSIG
```

It is wrapped in P2WSH (`OP_0 <SHA256(witnessScript)>`). A future spending transaction must use a block-height `nLockTime` at least `unlockHeight` and a non-final sequence for the spending input. CLTV enforces those facts in consensus; it is not an application timer.

Block heights are not civil-clock deadlines. TimeSats does not turn dates into promised block heights.

## Architecture

```text
src/domain/   policy shape and allow-list boundary
src/bitcoin/  Bitcoin network mapping, key validation, Script and P2WSH derivation
src/components/ client-only form and local export UX
src/app/      static Next.js page and styles
```

The React component has no Bitcoin Script construction. `src/bitcoin/vault.ts` is pure and has no fetch or server dependency.

## Networks

`signet` and `regtest` are the only valid domain values. `mainnet` is absent from the UI/type/schema and is explicitly rejected at runtime in the Bitcoin network boundary. Signet uses the `tb` Bech32 HRP; Regtest uses `bcrt`.

## Recovery bundle

The UI can view, copy, or download a JSON file locally. Example shape:

```json
{
  "version": 1,
  "network": "signet",
  "publicKey": "02…",
  "unlockHeight": 840000,
  "address": "tb1q…",
  "witnessScript": "…",
  "outputScript": "0020…",
  "outputType": "p2wsh-v0"
}
```

It contains only public reconstruction data—never a seed, mnemonic, private key, WIF, or xprv. Keep independent backups of the bundle and, separately, the actual key material in the user’s chosen wallet/hardware wallet. A bundle does not restore a lost signing key.

## Run and test

Requires a current Node.js LTS and npm.

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
npm audit
```

`npm run build` produces a static export (`out/`). No server-side wallet endpoint is present.

### Optional Regtest integration

The regular unit suite does not require Bitcoin Core. When `bitcoind`, `bitcoin-cli`, Bash, and `jq` are installed and a local Regtest daemon is already running, use:

```bash
npm run test:regtest
```

The isolated harness described in [docs/regtest-integration.md](docs/regtest-integration.md) creates a disposable Regtest wallet/key and proves mempool rejection before the selected height and acceptance after mining. It never targets mainnet and is not part of the product runtime.

## Library choice

- `bitcoinjs-lib` **7.0.1**: mature, widely used TypeScript library for Script compilation, native SegWit P2WSH output/address construction, and test/regtest network encoding.
- `@noble/curves` **2.3.0**: audited, pure-JavaScript secp256k1 implementation used only to validate that supplied compressed public-key bytes are an actual curve point.
- `zod` **3.24.2**: strict policy/input validation.

TimeSats delegates Script-number encoding, Script serialization, SHA256/P2WSH construction, Bech32 address encoding, and secp256k1 point validation to those libraries. It does not implement cryptography or ECDSA itself.

## Privacy

The v0.1 policy derivation is entirely local. There are no analytics, trackers, accounts, intentional fingerprinting, database, or user endpoints. A static Next.js site still involves normal HTTP delivery by whichever host is chosen in the future; hosting/server logs are outside this repository’s control. The app itself does not send a public key or recovery bundle anywhere.

## Limitations and threat model

This prototype has no chain-height lookup, hardware-wallet workflow, transaction construction, signing, broadcast, fee handling, or automated recovery verification. It makes no security guarantee and must not receive real bitcoin. See [SECURITY.md](SECURITY.md) for risks including supply-chain compromise, altered frontend, incorrect policy review, wrong key, key loss, and wrong height.

## Roadmap (not implemented)

After independent review of this core, the next milestone should be an offline/hardware-wallet-compatible **test-network-only spending-plan verifier** that displays the required `nLockTime` and `nSequence` without accepting secret keys or broadcasting.
