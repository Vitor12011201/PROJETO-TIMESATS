# Pesquisa técnica v0.4 — Bitcoin Core como signer externo

## Pergunta e método

Pergunta: uma descriptor wallet Bitcoin Core consegue assinar, por
`walletprocesspsbt`, o P2WSH TimeSats literal?

```text
<unlockHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <compressedPublicKey> OP_CHECKSIG
```

Documentação não é prova suficiente. A resposta desta milestone depende de um
harness isolado Regtest que mantenha a private key somente na wallet Core,
verifique o script/PSBT produzido pelo TimeSats e peça aceitação ao consenso
antes e depois da altura de unlock.

## Fontes primárias

- [Bitcoin Core 31.0 `walletprocesspsbt`](https://bitcoincore.org/en/doc/31.0.0/rpc/wallet/walletprocesspsbt/): atualiza um PSBT, assina inputs que a wallet conhece e aceita `bip32derivs` e `finalize`. O harness usa `sign=true`, `sighashtype=ALL`, `bip32derivs=true`, `finalize=false`.
- [Bitcoin Core 31.0 `importdescriptors`](https://bitcoincore.org/en/doc/31.0.0/rpc/wallet/importdescriptors/): importa descriptor com timestamp e pode rescandir; em Regtest novo o harness usa `timestamp: "now"` antes do funding.
- [Documentação de descriptors do Bitcoin Core v31.1](https://github.com/bitcoin/bitcoin/blob/v31.1/doc/descriptors.md): Core suporta `wsh`, chaves públicas e key-origin metadata; também documenta o fluxo de `walletprocesspsbt` com signer wallets.
- [PSBT howto do Bitcoin Core](https://github.com/bitcoin/bitcoin/blob/master/doc/psbt.md): `walletprocesspsbt` pode atuar como updater, signer e finalizer. TimeSats deliberadamente solicita `finalize=false` e finaliza somente depois da própria validação.
- [BIP 174](https://bips.dev/174/): define PSBT e os papéis Creator/Updater/Signer/Finalizer.
- [BIP 65](https://bips.dev/65/): define `OP_CHECKLOCKTIMEVERIFY` e o requisito de sequence não-final.

## Descriptor sob teste

O experimento pede a Core que aceite o descriptor Miniscript abaixo **somente
como representação da wallet**, sem migrar a policy TimeSats:

```text
wsh(and_v(v:after(H),pk(P)))
```

O harness exige que o endereço derivado por Core seja exatamente o endereço
P2WSH derivado pelo TimeSats para a mesma chave `P` e altura `H`; também exige
que o PSBT devolvido preserve byte a byte o `witnessScript` TimeSats. Não há
troca de primitive, Taproot ou novo descriptor de recovery.

## Chaves e metadata

A wallet Core gera a chave. O harness extrai somente o `tpub`, a chave pública,
o fingerprint e o caminho público disponibilizados pelo descriptor da wallet.
O plano v2 continua usando apenas sua `tpub` relativa; não recebe migration nem
`bip32Derivation` inventado. Core pode acrescentar key-origin metadata legítima
ao PSBT retornado, pois essa metadata pública não muda a unsigned transaction,
o `SpendIntent`, `witnessUtxo`, `witnessScript`, sighash ou assinatura exigida.

Fingerprint e derivation path não são segredo, mas podem ajudar a correlacionar
wallets e têm implicação de privacidade. Private key, seed, WIF, xprv e tprv não
podem sair da wallet Core.

## Critérios de prova

O harness deve falhar fechado se a wallet sem chave não assinar, se o signer
com chave errada assinar, se Core não adicionar a assinatura esperada, ou se
TimeSats rejeitar invariantes. Ele só pode declarar sucesso se a mesma raw tx
for rejeitada antes do unlock e aceita, transmitida e confirmada depois dele.
RPC Core existe exclusivamente no harness Regtest, nunca em `src/` ou no
browser.

## Resultado experimental — bloqueado em Core 31.1

O harness Regtest separado foi executado com Bitcoin Core 31.1 oficial. O ZIP
foi conferido contra `SHA256SUMS`; `SHA256SUMS.asc` também foi obtido, mas GPG
não estava disponível para conferir sua assinatura.

O experimento confirmou que Core 31.1:

1. roda somente em `regtest` no harness;
2. fornece chave pública, `tpub`, master fingerprint e caminho absoluto
   públicos da wallet descriptor;
3. reconhece via `decodepsbt` o `witnessUtxo`, `witnessScript`, `SIGHASH_ALL`,
   locktime e sequence produzidos pelo TimeSats;
4. não assina com wallet watch-only, wallet de chave errada ou signer sem
   key-origin metadata — comportamentos esperados.

Mas a integração falha de forma fechada na propriedade central:

- `importdescriptors` rejeita o descriptor P2WSH somente público na descriptor
  wallet que possui private keys: **“Cannot import descriptor without private
  keys to a wallet with private keys enabled”**. Fornecer um `tprv` para vencer
  isso violaria a fronteira TimeSats/Core.
- O candidato Miniscript `wsh(and_v(v:after(H),pk(P)))` é aceito por Core, mas
  deriva endereço diferente do P2WSH TimeSats e portanto não é equivalência
  byte a byte da primitive com `OP_DROP`.
- `raw(<outputScript>)` reconstrói exatamente o endereço P2WSH, porém descreve
  somente o output e não fornece um signing provider para a policy.
- Mesmo com `witnessScript`, `witnessUtxo`, `SIGHASH_ALL` e
  `bip32Derivation` legítimo (fingerprint e caminho fornecidos pela wallet),
  `walletprocesspsbt` retornou sem `partialSig` para o script TimeSats.

Assim, nesta configuração, uma Bitcoin Core **descriptor wallet** não provou
capacidade de assinar a primitive literal TimeSats por `walletprocesspsbt` sem
expor material privado. V0.4 não está pronta: não houve mudança de primitive,
schema, UI ou versão. Uma próxima experiência, somente após nova decisão de
milestone, pode investigar separadamente o suporte de wallet legacy ou uma
mudança upstream no Core; nenhuma dessas alternativas deve ser apresentada
como compatibilidade da v0.4 atual.
