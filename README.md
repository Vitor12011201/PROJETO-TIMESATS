# TimeSats

> Seu Bitcoin. Seu prazo. Suas chaves.

## EXPERIMENTAL SOFTWARE — SIGNET/REGTEST ONLY — DO NOT SEND REAL BITCOIN

## NEVER ENTER A SEED OR PRIVATE KEY

TimeSats é uma prova técnica local de autocustódia. Não é exchange, banco, corretora, carteira custodial ou serviço de recuperação. O usuário escolhe um plano e o Bitcoin executa a regra temporal; TimeSats só constrói, explica e preserva dados **públicos** da política.

Se TimeSats desaparecer, não tem seed, chave privada, chave da empresa, conta ou banco de dados que possa levar fundos. Também não tem como recuperar uma chave perdida ou desbloquear um UTXO antes do prazo.

## O que cada versão prova

- **v0.1:** primitive P2WSH/CLTV real, validada end-to-end em Bitcoin Core Regtest: funding, rejeição antes do prazo e spend após o prazo.
- **v0.2:** um **Vault Plan** com um unlock block fixo e múltiplos endereços P2WSH determinísticos, derivados de uma extended public key BIP32 de teste (`tpub`).
- **v0.3:** preparação offline de gasto por PSBT BIP174: verificação de funding raw, um input/um output, signer externo e finalização sem receber chave privada.
- **v0.4:** Policy V2 versionada e prova Regtest com `walletprocesspsbt` de uma wallet Bitcoin Core externa; a Policy V1 histórica permanece intacta.

Exemplo conceitual:

```text
Plano: Casa
Unlock block: H
Deposit #0 -> child m/0 -> endereço A -> script com H
Deposit #1 -> child m/1 -> endereço B -> script com H
Deposit #2 -> child m/2 -> endereço C -> script com H
```

Cada depósito é um UTXO independente. A interface apenas os agrupa conceitualmente; ela não sabe se houve funding, não consulta blockchain e não mostra saldo.

## Modelo Bitcoin

Planos V1 mantêm a primitive v0.1:

```text
<unlockHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <P_i> OP_CHECKSIG
```

O witness script é encapsulado em P2WSH v0. Para gastar no futuro, uma transação deve usar `nLockTime >= unlockHeight` com tipo de altura de bloco, e um `nSequence` não-final no input do vault. `OP_CHECKLOCKTIMEVERIFY` (BIP 65) faz a rede Bitcoin verificar essas condições. Blocos não são relógios civis, portanto não há promessa de uma hora exata.

Detalhes byte-a-byte: [docs/bitcoin-script.md](docs/bitcoin-script.md). Planos e recovery: [docs/vault-plans.md](docs/vault-plans.md).

Planos V2 são explicitamente versionados e usam `wsh(and_v(v:after(H),pk(P_i)))`, compilado pelo Core como `<H> OP_CHECKLOCKTIMEVERIFY OP_VERIFY <P_i> OP_CHECKSIG`. V1 e V2 não têm os mesmos bytes/endereço; a análise demonstra equivalência semântica somente no domínio TimeSats. V2 inclui origem BIP32 pública legítima para o signer Core; nunca converta um plano V1. Veja [docs/research-v0.4-policy-v2.md](docs/research-v0.4-policy-v2.md).

## Dados públicos e derivação

O plano aceita somente uma `tpub` BIP32 válida para a rede de testes. Signet e Regtest compartilham os bytes BIP32 públicos de testnet (`0x043587cf`), mas geram endereços com HRP diferente (`tb` e `bcrt`).

O template fixo é `m/<index>` relativo à `tpub`; somente índices normais `0..2^31-1` são aceitos. Não há derivação hardened depois de uma chave pública. O BIP 32 permite que `CKDpub` derive esses filhos sem a chave privada; um child private key do mesmo caminho é necessário apenas ao gastar, fora do TimeSats.

Uma extended public key não permite gastar, mas pode correlacionar endereços. Trate-a como informação privada de observação. Nunca a envie a um serviço não confiável.

## Gasto offline por PSBT (v0.3)

```text
VaultPlan + Deposit #N
        -> raw funding transaction + vout
        -> TimeSats valida o output P2WSH
        -> PSBT não assinado
        -> signer externo assina
        -> TimeSats valida/finaliza
        -> usuário transmite em outro software
```

O escopo é deliberadamente um sweep: um UTXO, uma saída de destino e fee inteira em sats. `nLockTime` vem sempre do `unlockHeight`, `nSequence` é `0xfffffffe` e o sighash é somente `SIGHASH_ALL`. TimeSats não recebe seed, mnemonic, private key, WIF, xprv ou tprv; também não assina nem transmite. Um PSBT pode revelar UTXO, valores, scripts e destino; compartilhe-o somente com o signer escolhido.

A importação de funding prova que o output existiu na transação raw e corresponde ao Depósito selecionado. Sem uma fonte de blockchain, não prova que o UTXO ainda não foi gasto. Veja [docs/psbt-spending.md](docs/psbt-spending.md).

## Recovery bundle v2

O export é JSON público, local e estritamente validado. Sua estrutura real é:

```json
{
  "format": "timesats-vault-plan",
  "version": 2,
  "policy": {
    "policyVersion": 1,
    "network": "signet",
    "unlockHeight": 840000,
    "keySource": {
      "type": "bip32-testnet-xpub",
      "extendedPublicKey": "tpub..."
    },
    "derivation": { "pathTemplate": "m/<index>", "hardened": false }
  },
  "recovery": { "lastIssuedIndex": 2 },
  "metadata": { "label": "Casa" }
}
```

Ele não contém seed, mnemonic, private key, WIF, xprv ou tprv. Para reconstruir sem servidores TimeSats: valide o JSON, derive `m/0` até `m/lastIssuedIndex` a partir da `tpub`, aplique o script CLTV acima usando o `unlockHeight`, e localize os UTXOs por software compatível. O bundle não substitui o backup da chave/seed do usuário e deve ser atualizado após cada novo endereço emitido.

Cada depósito também exibe `raw(<outputScript>)`, um output descriptor BIP 385 exato para aquele output P2WSH. Isso é recuperação de saída, não uma promessa de fluxo de assinatura em outra wallet.

## Redes e privacidade

Somente `signet` e `regtest` são aceitos no tipo, Zod schema, derivação e UI. `mainnet` falha explicitamente no limite de domínio/Bitcoin. Não existem API routes de usuário, analytics, trackers, telemetry, contas, login, banco, cloud sync ou chamadas de rede no núcleo de derivação. O app pode ser exportado estaticamente; a hospedagem escolhida no futuro ainda pode registrar requisições HTTP normais.

O localStorage é apenas conveniência e contém somente o schema público de planos. Dados corrompidos são ignorados e reportados; o recovery bundle é o registro portátil, mas não é um backup de chaves.

## Desenvolvimento

Requer Node.js LTS e npm.

```bash
npm install
npm run dev
npm run lint
npm run typecheck
npm test
npm run build
npm audit
```

`npm run build` produz o export estático em `out/`. A suíte unitária não requer Bitcoin Core nem rede. O harness isolado abaixo é opcional:

```bash
BITCOIND=/caminho/bitcoind BITCOINCLI=/caminho/bitcoin-cli npm run test:regtest
```

Ele inicia daemon descartável exclusivamente com `-regtest`, inicia signer isolado que gera raiz BIP32 aleatória em memória e entrega apenas sua `tpub` à implementação TimeSats, financia Deposit #0, prepara/assina/valida PSBT, demonstra rejeição antes do unlock e confirma o spend depois do unlock. O harness v0.2 continua disponível em `npm run test:regtest:v0.2`. Leia [docs/regtest-integration.md](docs/regtest-integration.md).

## Dependências Bitcoin

- `bitcoinjs-lib` 7.0.1: Script number, serialização Script, P2WSH, endereço SegWit e sighash do harness.
- `@noble/curves` 2.3.0: validação de ponto secp256k1; assinatura somente no harness Regtest descartável.
- `@scure/bip32` 2.3.0: parse/serialização de extended key e derivação pública BIP32. Não há BIP32, Base58Check ou secp256k1 escrito pelo projeto.

Veja a avaliação de dependências, descriptors e Miniscript em [docs/research-v0.2.md](docs/research-v0.2.md).

## Limitações deliberadas

Não há mainnet, BTC real, geração/importação de seed, private key, WIF, signing de produção, broadcast na UI, hardware wallet física, Sparrow/Electrum integration, chain monitoring, saldo, preço, fiat, conta, backend, cloud ou recuperação social. As combinações comprovadas exclusivamente para Policy V2 em Regtest são Bitcoin Core 31.1 `walletprocesspsbt` e Blockstream Jade em QEMU via `sign_psbt`. A prova Jade é somente Phase 0; Jade física continua obrigatória para Phase 1 e antes de qualquer release v0.5. Outros signers continuam requerendo teste. Veja [docs/bitcoin-core-signer.md](docs/bitcoin-core-signer.md), [docs/research-v0.5-jade.md](docs/research-v0.5-jade.md) e [SECURITY.md](SECURITY.md).

## Próximo passo — não implementado

A próxima milestone de signer é repetir a prova relevante com uma Jade física na Phase 1; não há promessa de compatibilidade genérica, USB/BLE/QR físico ou de hardware wallet além da Jade QEMU comprovada.
