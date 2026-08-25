# Security notes and threat model

TimeSats v0.1 is experimental software, not a security guarantee. It is Signet/Regtest-only and must not receive real bitcoin.

## What it is designed to do

It locally derives a P2WSH output whose witness script requires a valid signature for the supplied public key and a CLTV-compatible transaction locktime. It does not receive or generate secret material.

## Important risks not solved by v0.1

- **Supply-chain compromise:** npm packages, a lockfile, a build system, or a hosting pipeline could be malicious or altered.
- **Compromised Bitcoin library:** a defect or compromise in `bitcoinjs-lib` or `@noble/curves` could cause invalid validation, serialization, or an unexpected address.
- **Altered frontend:** a malicious host, browser extension, XSS, or substituted static asset could display one policy while constructing another.
- **Incorrect script generation/review:** this prototype can contain bugs. Independently verify the policy, witness script, and P2WSH address before any future real use.
- **Wrong public key:** the application cannot prove that an entered public key belongs to the user or their hardware wallet.
- **Lost key:** loss of the signing private key permanently removes access after the timelock too. TimeSats has no recovery capability.
- **Wrong unlock height:** a height may be earlier/later than intended; Bitcoin block production is not a clock and the app does not estimate calendar dates.
- **Insufficient backups:** a recovery bundle is public metadata, not a key backup. Losing independent records can make later reconstruction difficult.
- **Future hardware-wallet integration:** wallet firmware/UI may reject, mis-display, or incompletely support custom P2WSH/CLTV spends. Such integration needs separate review.
- **Misleading interface:** labels, copied addresses, clipboard substitution, and visual confusion are all threats. Review data on an independent trusted device.

Do not enter a seed phrase, mnemonic, private key, WIF, xprv, password, or API token into TimeSats. This version has no recovery, no support channel for funds, and no promise that funds cannot be lost.
