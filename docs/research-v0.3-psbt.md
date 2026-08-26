# Pesquisa técnica v0.3 — PSBT offline

## Fontes primárias consultadas

- [BIP 174 — PSBT](https://bips.dev/174/): formato, papéis Creator/Updater/Signer/Finalizer, `witnessUtxo`, `witnessScript`, `partialSig`, `SIGHASH_ALL` e metadata BIP32.
- [BIP 370 — PSBT v2](https://bips.dev/370/): formato PSBT v2 e campos de transação distribuídos.
- [BIP 32](https://bips.dev/32/): somente derivação pública não-hardened depois da `tpub`.
- [BIP 65 — CHECKLOCKTIMEVERIFY](https://bips.dev/65/): locktime absoluto e requisito de sequence não-final.
- [bitcoinjs-lib 7.0.1 `Psbt`](https://bitcoinjs.github.io/bitcoinjs-lib/classes/Psbt.html): construção, parse, assinatura, finalização e extração.
- [Bitcoin Core `testmempoolaccept`](https://bitcoincore.org/en/doc/31.0.0/rpc/rawtransactions/testmempoolaccept/): validação local sem broadcast.
- [Bitcoin Core `finalizepsbt`](https://bitcoincore.org/en/doc/31.0.0/rpc/rawtransactions/finalizepsbt/): referência de papel de finalização.

## Decisão: BIP174 PSBT v0

TimeSats v0.3 usa **PSBT v0/BIP174**. A transação unsigned global é natural para o escopo de um input e uma saída; `bitcoinjs-lib` 7.0.1 oferece suporte maduro e o formato é a escolha de compatibilidade mais conservadora. BIP370/PSBT v2 é padronizado, mas não adiciona uma propriedade de segurança necessária nesta milestone. A versão da transação Bitcoin é `2`; isso não muda a versão PSBT, que permanece v0.

Cada input P2WSH contém `witnessUtxo` (scriptPubKey e valor em sats), `witnessScript`, `sighashType=SIGHASH_ALL` e, depois do signer, exatamente uma `partialSig`. O produto não inclui `nonWitnessUtxo`, pois o input é SegWit v0 e o `witnessUtxo` é suficiente para a construção e assinatura neste caso controlado. O raw funding tx é mantido para verificação offline no fluxo, não persistido automaticamente.

## Key origin: propositalmente ausente

O plano v0.2 registra uma `tpub` e o caminho **relativo** `m/<index>`. Uma extended public key contém profundidade, fingerprint do pai e child number, mas não revela com segurança a fingerprint da master ou o caminho absoluto anterior à `tpub`. BIP174 define `bip32Derivation` como *master fingerprint + caminho completo*; preencher esses campos com `m/<index>` ou um fingerprint calculado da `tpub` seria falso.

Assim, v0.3 não inclui `bip32Derivation` ou global xpub. Isso não impede o signer de teste, que já conhece sua própria raiz e recebe a chave pública esperada no witness script. Também não promete compatibilidade com hardware wallet. Uma milestone futura poderá introduzir metadata de origem explicitamente fornecida, pública, versionada e validada — sem alterar retroativamente o bundle v2.

## P2WSH/CLTV e finalização

A primitive v0.1 não muda:

```text
<unlockHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <compressedPublicKey> OP_CHECKSIG
```

O unsigned tx recebe `nLockTime=unlockHeight` e `nSequence=0xfffffffe`. Esse sequence não é final para CLTV e não sinaliza opt-in RBF por padrão. A assinatura usa `SIGHASH_ALL`; a finalização produz witness `[signature || sighash-byte, witnessScript]` com o helper de witness do `bitcoinjs-lib`.

## Interoperabilidade

| Opção | Estado v0.3 |
| --- | --- |
| Bitcoin Core PSBT RPC | Formato BIP174 pesquisado; não usado na UI; Regtest usa Core para consenso. |
| PSBT test signer isolado | Comprovado pelo harness Regtest. |
| Hardware wallets / HWI | Requer teste; key origin ausente deliberadamente. |
| Sparrow / Electrum / Nunchuk | Requer teste; nenhuma promessa. |
| Miniscript | Não adotado: raw P2WSH CLTV da v0.1 permanece fonte de verdade. |
