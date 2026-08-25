# V0.2 technical research and architecture decision

Research was performed before adding public derivation. Sources are linked so claims can be independently checked.

| Subject | What was learned | V0.2 decision |
| --- | --- | --- |
| [BIP32](https://github.com/bitcoin/bips/blob/master/bip-0032.mediawiki) | `CKDpub` is defined only for normal children; extended public keys expose a subtree and have privacy implications. Parent xpub + descendant private key is dangerous. | Accept only test `tpub`; use normal `m/<index>` derivation; warn about privacy; reject tprv/xprv/WIF/mnemonic-like input. |
| [Bitcoin output descriptors / BIP380](https://github.com/bitcoin/bips/blob/master/bip-0380.mediawiki) and [BIP382](https://github.com/bitcoin/bips/blob/master/bip-0382.mediawiki) | Descriptors represent scripts/keys; `wsh()` produces P2WSH and supports compressed keys. Bitcoin Core has descriptor support. | Export exact per-output `raw(<outputScript>)` (BIP385) for deterministic recovery, but do not claim ranged descriptor signer interoperability. |
| [Miniscript / BIP379](https://github.com/bitcoin/bips/blob/master/bip-0379.md) | Miniscript can describe structured timelock/key policies in `wsh()` and supports policy analysis. Bitcoin Core’s implementation is mature. | Investigated only. No Miniscript compiler/parser is added because v0.1’s literal script is Bitcoin-Core-Regtest-validated and v0.2 does not need policy composition. |
| [Liana / Wizardsardine](https://lianawallet.com/) | Liana uses Miniscript and timelocked recovery paths, descriptors and reproducible recovery-oriented architecture. | Adopt the independence principle and explicit recovery data; do **not** adopt recovery keys, multisig, inheritance or hardware integration. |
| [Nunchuk](https://nunchuk.io/) | Nunchuk is a broader collaborative/multisig wallet ecosystem. | No wallet/account/service architecture is adopted; its integration surface is outside v0.2. Future compatibility requires direct tests. |
| [BitcoinerLAB Miniscript vault guide](https://bitcoinerlab.com/guides/miniscript-vault) | Illustrates policy compilation, descriptors and BIP32 key expressions for a vault. | It supports the value of descriptors/miniscript for a later interoperability milestone; no code is copied and no additional descriptor dependency is needed now. |
| [bit21](https://bit21.app/) | It presents a self-custodial timelock vault where Bitcoin Script, not the company, enforces the lock. | Adopt only the product principle of network-enforced self-custody. TimeSats differs: it never accepts a seed and has no production wallet flow. |

## Chosen representation

1. **Raw v0.1 Script:** source of truth. It is simple, exact and already proved against Bitcoin Core. Every deposit uses a different derived public key with the same CLTV height.
2. **BIP32 public key source:** adopted because it produces new addresses without a private key, is standardized, deterministic and usable locally. `@scure/bip32` 2.3.0 is a browser-compatible, minimal library in the Noble ecosystem already used by the project.
3. **Output descriptor:** adopted only as exact output metadata (`raw()`), useful for independent reconstruction and Bitcoin Core validation. The full ranged policy descriptor is not required to produce safe deterministic addresses.
4. **Miniscript:** not adopted for compilation. A candidate source-policy representation would need a reference parser/compiler plus exact script-equivalence proof. The extra dependency and unexecuted signer claims would not improve v0.2’s verified primitive.

### Raw Script versus Miniscript

The likely semantic family is an absolute-height `after(H)` combined with a public-key check inside `wsh()`. However, wrapper selection and Script serialization affect exact bytes. V0.1 previously observed a serialization difference with a descriptor/Miniscript attempt, so it deliberately remains literal Script. The exact P2WSH output is independently checked in Bitcoin Core through `raw(<outputScript>)`; no claim is made that a non-raw Miniscript descriptor compiles byte-for-byte to it in v0.2.

## Interoperability matrix — research, not a product claim

| Target | Status | Basis / remaining work |
| --- | --- | --- |
| Bitcoin Core descriptors | **Proved for output reconstruction** | Regtest harness calls `getdescriptorinfo`, `deriveaddresses` and imports exact `raw()` output descriptors. A full descriptor-wallet signing flow is not implemented. |
| Sparrow | **Requires test** | No Sparrow import/signature test was executed for this literal P2WSH CLTV policy. |
| Electrum | **Requires test** | No Electrum descriptor/custom P2WSH signing test was executed. |
| Hardware wallets | **Requires test** | Key origin metadata, PSBT and firmware support must be tested per device; no hardware integration exists. |
| PSBT | **Requires test** | V0.2 has no PSBT construction or signing. |
| Miniscript | **Apparently supported by Bitcoin Core, requires TimeSats proof** | BIP379 and Core document support, but v0.2 does not compile/import an equivalent non-raw policy descriptor. |

No entry above authorizes funding any real bitcoin. The next compatibility decision must be based on executed testnet/regtest vectors, not marketing compatibility lists.
