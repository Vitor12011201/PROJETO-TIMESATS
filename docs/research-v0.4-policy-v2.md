# Pesquisa v0.4 — Policy V2 interoperável

## Decisão e escopo

O experimento negativo da Policy V1 permanece em
[`research-v0.4-core-signer.md`](research-v0.4-core-signer.md). Ele mostrou que
uma wallet descriptor Core não assinou o script literal V1 apenas a partir de
`witnessScript`, UTXO e origem pública. Esta pesquisa não o reinterpreta nem o
substitui: V1 continua sendo o script histórico e seus planos/bundles continuam
V1.

A V2 é uma nova policy explicitamente versionada para planos novos:

```text
wsh(and_v(v:after(H),pk(P)))
```

Bitcoin Core 31.1 compilou-a, em Regtest, para o witness script exato:

```text
<minimal H> OP_CHECKLOCKTIMEVERIFY OP_VERIFY <compressed P> OP_CHECKSIG
```

Por exemplo, para `H = 107`, Core devolveu:

```text
016bb16921<P de 33 bytes>ac
```

`016b` é o push mínimo de 107, `b1` é CLTV, `69` é VERIFY, `21` é o
push da chave e `ac` é CHECKSIG. O harness compara esse hex byte a byte com a
compilação local antes de continuar. V1 usa `75` (`OP_DROP`) no mesmo ponto;
logo V1 e V2 não são byte-, endereço- nem script-hash-equivalentes.

## Equivalência semântica limitada

Esta afirmação é somente para o domínio TimeSats: `1 <= H <= 499999999`,
`nLockTime >= H` com tipo block-height, input com `nSequence != 0xffffffff` e
uma assinatura ECDSA válida de `P`.

Após `<H> OP_CHECKLOCKTIMEVERIFY`, CLTV deixa `H` na pilha.

- V1 executa `OP_DROP`, removendo `H`, e então `P OP_CHECKSIG`.
- V2 executa `OP_VERIFY`, que remove `H` apenas se ele for verdadeiro, e então
  o mesmo `P OP_CHECKSIG`.

Todo `H` aceito pelo schema é um Script number positivo, mínimo e não-zero;
portanto é verdadeiro para a regra de truthiness do Script. Se CLTV falha,
ambas falham antes de DROP/VERIFY. Se CLTV passa, V1 remove e V2 verifica/remove
o mesmo valor; ambas chegam a `OP_CHECKSIG` com a mesma assinatura e chave.
Assim, são semanticamente equivalentes **somente nesse domínio e com o witness
TimeSats de assinatura única**. Não se afirma equivalência para bytes,
endereços, hashes, políticas de relay fora desse fluxo ou witnesses arbitrários.

Os testes unitários exercitam `H = 1, 2, 16, 17, 100, 499999999`, confirmam
determinismo e diferença V1/V2. O Regtest usa uma altura prática e confirma
rejeição antes de H (`non-final`) e aceitação/confirmacão depois de H. Os casos
de `nSequence` final, assinatura errada e witness script errado continuam
cobertos pelo harness V1 de consenso e pela validação PSBT fechada.

## Bitcoin Core signer proof

`scripts/regtest-policy-v2-research.ts` inicia daemon e wallets descartáveis
somente com `-regtest`. Uma wallet Core cria a chave; o processo TimeSats recebe
somente sua pubkey, `tpub` pública, master fingerprint e caminho absoluto.
Nenhum seed, WIF, xprv/tprv ou private descriptor é exportado.

O experimento executado em Core 31.1 provou:

1. `decodepsbt` reconhece `witnessUtxo`, `witnessScript`, `SIGHASH_ALL`,
   `nLockTime=H`, `nSequence=0xfffffffe` e a origem BIP32 pública;
2. uma wallet Core de chave errada não adiciona assinatura;
3. a wallet que possui `P` acrescenta exatamente uma `partialSig` via
   `walletprocesspsbt(..., sign=true, sighashtype=ALL, bip32derivs=true,
   finalize=false)`;
4. a validação/finalização TimeSats aceita a assinatura e preserva a intenção;
5. Core rejeita a raw tx antes de H, aceita depois, confirma o gasto e o UTXO
   original desaparece de `gettxout`.

O experimento usa a mesma chave derivada também como endereço P2WPKH normal
apenas para obter metadata da wallet descartável. Isso cria correlação e reuso
de chave entre script types; é aceitável somente nesse harness. A V2 armazena
uma `tpub` de branch dedicada, fingerprint e caminho da fonte para que cada
depósito derive `m/<index>` e carregue o caminho absoluto legítimo no PSBT.

## Formato e recovery

Policy V1 usa VaultPlan/recovery bundle `version: 2`, key source sem origem e
nunca ganha V2 ao importar. Policy V2 usa `version: 3`,
`policyVersion: 2` e `bip32-testnet-xpub-with-origin`:

```json
{
  "keyOrigin": {
    "masterFingerprint": "8 hex characters",
    "sourcePath": "m/84'/1'/0'/0"
  }
}
```

`sourcePath` identifica a `tpub` fonte, não o child. Deposit `N` usa o caminho
absoluto `sourcePath/N`. Fingerprint e paths são públicos, porém podem
correlacionar wallets; são validados, fazem parte da identidade e nunca são
inventados. Recovery V2 continua sendo aceito sem migração silenciosa.

## Fontes primárias

- [BIP 65 — CLTV](https://bips.dev/65/)
- [BIP 174 — PSBT](https://bips.dev/174/)
- [BIP 32 — derivações e key origin](https://bips.dev/32/)
- [BIP 379 — Miniscript](https://bips.dev/379/)
- [Bitcoin Core 31.1 descriptors](https://github.com/bitcoin/bitcoin/blob/v31.1/doc/descriptors.md)
- [Bitcoin Core `miniscript.h`](https://github.com/bitcoin/bitcoin/blob/v31.1/src/script/miniscript.h)
- [Bitcoin Core `sign.cpp`](https://github.com/bitcoin/bitcoin/blob/v31.1/src/script/sign.cpp)
- [Bitcoin Core `walletprocesspsbt`](https://bitcoincore.org/en/doc/31.0.0/rpc/wallet/walletprocesspsbt/)
