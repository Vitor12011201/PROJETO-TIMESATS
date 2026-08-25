# Bitcoin Script construction

## Output type

TimeSats v0.1 constructs a native SegWit v0 **P2WSH** output. The address encodes this output script:

```text
OP_0 OP_PUSHBYTES_32 SHA256(witnessScript)
```

The Signet address uses Bech32 HRP `tb`; Regtest uses `bcrt`. The address is derived by `bitcoinjs-lib` from the witness script and the explicitly allow-listed network.

## Witness script

For a compressed user public key `P` and block-height `H`, the exact compiled script is:

```text
<minimal Script-number encoding of H>
OP_CHECKLOCKTIMEVERIFY
OP_DROP
<P>
OP_CHECKSIG
```

`bitcoinjs-lib`'s `script.number.encode(H)` performs the minimal Script-number encoding, then its `script.compile` serializes the opcodes. TimeSats does not hand-roll either encoding.

Deterministic test vector used in unit tests:

```text
H = 840000
P = 0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798
witnessScript = 0340d10cb175210279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798ac
```

Opcode walkthrough:

1. `03 40d10c` pushes the minimally encoded positive integer 840000 (little-endian Script number).
2. `b1` (`OP_CHECKLOCKTIMEVERIFY`) fails unless the spending transaction meets BIP 65’s absolute-locktime rules.
3. `75` (`OP_DROP`) removes the height so it does not interfere with signature verification.
4. `21 <33-byte P>` pushes the user’s compressed public key. Compressed keys are required for SegWit v0 policy.
5. `ac` (`OP_CHECKSIG`) requires a signature matching that public key.

## CLTV semantics

`OP_CHECKLOCKTIMEVERIFY` does not itself advance time or set a transaction field. It compares its stack argument with the spending transaction:

- the stack value must be non-negative;
- its locktime type and the transaction `nLockTime` type must match;
- the stack value must be less than or equal to transaction `nLockTime`;
- the spending input’s `nSequence` must not be `0xffffffff` (final).

This v0.1 accepts `1..499,999,999`, so its script argument is always interpreted as a **block height**, never a Unix timestamp. A future spend must use a block-height `nLockTime >= unlockHeight` and give the vault input a non-final sequence such as `0xfffffffe`. At least one transaction input must be non-final for transaction-level `nLockTime` to take effect; making the CLTV input non-final satisfies both requirements.

The lock is absolute: validation occurs against the candidate block height. It is not “exactly at a time of day,” and a transaction with a higher compatible `nLockTime` can also satisfy this script.

## Future spending transaction (not implemented)

This app does not build or sign a transaction. A future compatible signer would need to:

1. spend the P2WSH UTXO with `nLockTime` set to a block height at least `unlockHeight` and below 500,000,000;
2. set the vault input `nSequence` to a non-final value (for example `0xfffffffe`);
3. calculate the SegWit v0 signature hash using the witness script and prevout amount;
4. place the resulting signature and the full witness script in the input witness;
5. let a fully validating node enforce CLTV and `OP_CHECKSIG`.

No private key is needed to construct the address, and no TimeSats key appears in the script.

## V0.2 Vault Plans

V0.2 does not alter this construction. For every issued deposit index `i`, it derives a different compressed BIP32 child public key `P_i` from the plan's public `tpub` at relative path `m/i`, then applies the exact same script with the plan's single fixed `unlockHeight`. Thus the outputs differ because `P_i` differs, while their CLTV requirement is identical. The BIP32 source, path template and issued indexes are documented in [vault-plans.md](vault-plans.md).

Primary references: [BIP 65](https://github.com/bitcoin/bips/blob/master/bip-0065.mediawiki) and [Bitcoin Developer Guide: transactions](https://developer.bitcoin.org/devguide/transactions.html).
