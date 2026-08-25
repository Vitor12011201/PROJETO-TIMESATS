# Security notes and threat model

## EXPERIMENTAL — SIGNET/REGTEST ONLY — DO NOT SEND REAL BITCOIN

TimeSats v0.2 creates public descriptions of fixed-height P2WSH/CLTV plans. It is not a wallet, signer, broadcaster, recovery service or security guarantee. Never enter a seed phrase, mnemonic, private key, WIF, xprv, tprv, password or API token.

| Risk | What v0.2 does | Remaining risk / user action |
| --- | --- | --- |
| Loss of seed or signing key | TimeSats never receives it. | Funds remain inaccessible even after CLTV. Back up wallet keys independently. |
| Loss of recovery bundle | Export/import is local and public. | Backup the bundle independently; it is not a key backup. |
| Outdated `lastIssuedIndex` | Bundle records the highest issued index. | Export again after issuing addresses; missing index records can impede discovery. |
| xpub privacy leakage | UI warns that a `tpub` correlates its derived addresses. | Treat it as private observation data; do not share or upload it. |
| Parent xpub plus child private-key exposure | Public-only derivation is non-hardened by necessity. | Do not expose a descendant private key together with its ancestor xpub; BIP32 describes the escalation risk. |
| Wrong derivation path | Template is fixed and recorded as `m/<index>`. | Verify the exported key source is the intended account/branch before funding. |
| Address reuse | Each issued index derives a distinct child/address. | Do not manually send repeatedly to one displayed address; issue the next one. |
| Wrong unlock height | Schema restricts to block-height locktimes. | Blocks are not a clock; independently review the integer. Hard timelocks can be harmful in emergencies. |
| Corrupted localStorage | Strict schema validation fails closed and does not use corrupt data. | localStorage is convenience only; keep exported bundle backups. |
| Altered frontend / clipboard | Data is derived locally and displayed in full. | A hostile host, extension or XSS can still substitute an address. Verify script/address on an independent trusted system. |
| Incorrect script generation | v0.1 unit vectors and Bitcoin Core Regtest integration validate the literal Script. | This prototype can still contain bugs; do not use real funds. |
| Compromised dependency / supply chain | Uses pinned lockfile dependencies and mature Bitcoin libraries. | Review lockfile, package provenance, build environment and releases independently. |
| Descriptor misinterpretation | Each deposit exports exact `raw(<outputScript>)`; Miniscript is not silently substituted. | A raw descriptor alone does not provide a tested signer workflow. |
| Future wallet incompatibility | Documentation labels interoperability as unproven unless tested. | Do not assume hardware wallet, Sparrow or Electrum can sign this policy. |
| False sense of recovery | Bundle reconstructs public policy only. | It cannot restore lost keys, discover funds automatically, or produce signatures. |
| TimeSats unavailable | No server, account or company key is part of the script. | Keep code/policy/bundle instructions independently; recovery tooling remains a future compatibility task. |
| Mainnet misuse | Mainnet is rejected in schemas, derivation and UI. | Software or a compromised build can still be unsafe; never send real bitcoin to experimental software. |
| Misleading balance | UI intentionally has no chain source or total balance. | Do not infer funding from issued addresses; verify on-chain with independent infrastructure. |

## Scope boundary

The only signing condition in the output is the user-derived public key plus CLTV. There is no TimeSats key, company recovery key, multisig, social recovery, backend, analytics, account, database or cloud sync. P2WSH output construction is deterministic, but a future signing/recovery workflow needs separate compatibility tests and security review.
