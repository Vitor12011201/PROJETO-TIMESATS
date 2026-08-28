# Pesquisa v0.5 - Blockstream Jade como signer externo

## Status

**Phase 0 QEMU concluída.**

O resultado da Phase 0 e a infraestrutura deste documento cobrem somente uma
Jade oficial executada em QEMU. A prova exercitou o PSBT BIP174 real do
TimeSats com a Policy V2 já existente. Ela nao altera o produto, nao declara
uma release v0.5 e nao demonstra interoperabilidade de uma Jade fisica.

**Jade física continua obrigatória para Phase 1 e para qualquer release v0.5.**

## Ambiente observado

| Componente | Valor observado |
| --- | --- |
| Jade | QEMU, transporte `tcp:127.0.0.1:30121` |
| Firmware Jade | `1.0.41-66-g15ce915a-dirty` |
| Commit Jade | `15ce915a20898dda4ca0e3d7ba55ca556f5271f2` |
| Rede Jade | `localtest` |
| Bitcoin Core | `31.1.0`, executado somente com `-regtest` |

`localtest` e `regtest` sao os nomes de rede distintos usados respectivamente
pela API Jade e pelo Bitcoin Core. O harness confere ambos em seus limites e
nao chama mainnet nem Signet.

## Policy e derivacao preservadas

A pesquisa nao cria um descriptor, branch ou policy alternativos para a Jade.
O plano real criado no harness e Policy V2:

```text
wsh(and_v(v:after(H),pk(P)))
```

Sua `tpub` fonte e a `tpub` raiz publica lida da Jade; a origem publica e
`sourcePath: "m"`; Deposit #0 deriva exatamente `m/0`. A verificacao exige que
a `tpub` raiz derive a mesma pubkey que a Jade devolve explicitamente para
`m/0`, calcula o master fingerprint a partir da raiz publica e exige que o
PSBT tenha essa origem e o caminho `m/0`.

Portanto nao foi introduzido `<0;1>/*`, uma branch de change ou qualquer outra
alteracao de `sourcePath/index`. A derivacao V2 existente continua sendo
`sourcePath/index`; para uma fonte raiz, `m/0`, `m/1` e assim por diante.

O harness pede a Bitcoin Core que compile o descriptor acima em uma wallet
watch-only descartavel. Antes do funding, exige que o endereco P2WSH e o
`witnessScript` compilados por Core sejam identicos, byte a byte, aos derivados
pelos helpers reais `createVaultPlan` e `deriveDeposit` do TimeSats. O funding
e revalidado por `verifyFundingTransaction`; o PSBT e construido por
`buildUnsignedVaultPsbt` e finalizado somente apos
`validateSignedVaultPsbt` e `finalizeVaultPsbt`.

## Registro de descriptor: resultado negativo

Foi investigado o fluxo `register_descriptor` da Jade antes do fluxo final de
assinatura. Ele nao e necessario nem usado por `scripts/regtest-jade-v2-research.ts`.

- A forma de origem raiz sem um path vazio explicito nao foi aceita neste
  fluxo de registro.
- O processamento de registro tentou os dois lados de carteira, external e
  change, com `multi_index=0` e `multi_index=1`.
- Ajustar o TimeSats para `<0;1>/*` apenas para acomodar esse comportamento
  violaria a derivacao V2 estabelecida e nao foi feito.
- Enviar diretamente o PSBT BIP174 V2 para
  `jade.sign_psbt("localtest", psbt)` funcionou sem descriptor registrado e
  devolveu uma `partialSig`.

Assim, o registro e um resultado negativo documentado, nao um requisito oculto
do fluxo de assinatura. A wallet watch-only do Core usada para comparar scripts
nao e registro de descriptor na Jade.

## Infraestrutura reproduzivel

Os dois helpers Python vivem no proprio repositorio; o harness nao depende de
`/tmp/timesats-jade-sign.py`.

- `scripts/jade-public-info.py` abre o transporte configurado por
  `TIMESATS_JADE_DEVICE` (por padrao, o TCP QEMU), chama somente
  `get_xpub("localtest", [])` e `get_xpub("localtest", [0])`, e imprime JSON
  com `tpub` publica.
- `scripts/jade-sign-psbt.py` recebe uma PSBT Base64 por stdin, chama somente
  `sign_psbt("localtest", psbt)` e devolve a PSBT retornada por stdout. Ele nao
  recebe nem conhece material privado.
- `scripts/regtest-jade-v2-research.ts` executa a prova isolada. Por padrao ele
  espera o checkout Jade em `$HOME/Jade`; `TIMESATS_JADE_PYTHON` e
  `TIMESATS_JADE_PYTHONPATH` permitem apontar para o Python e checkout usados
  no ambiente de pesquisa.

Com QEMU acessivel e as dependencias Python do checkout Jade disponiveis:

```bash
BITCOIND=/usr/bin/bitcoind BITCOINCLI=/usr/bin/bitcoin-cli npm run test:regtest:jade
```

O script inicia um `bitcoind` temporario com `-regtest` e portas altas por
processo, para coexistir com outro Core Regtest local. `BITCOIN_REGTEST_RPC_PORT`
e `BITCOIN_REGTEST_P2P_PORT` permitem sobrescrever essas portas. Ele aborta se o
RPC nao for Regtest e remove o datadir temporario ao final, salvo quando
`TIMESATS_KEEP_REGTEST_DATA=1` e definido para depuracao descartavel.

## Prova QEMU executada

A execucao bem-sucedida da Phase 0 exigiu todos os itens abaixo:

1. descoberta dinamica de `tpub` raiz e de `m/0` diretamente na Jade;
2. verificacao publica de que a raiz deriva `m/0` e calculo legitimo do
   fingerprint raiz;
3. equivalencia byte a byte entre o `witnessScript` TimeSats V2 e o compilado
   por Bitcoin Core;
4. PSBT BIP174 com um input, uma saida, `witnessUtxo`, `witnessScript`,
   `SIGHASH_ALL`, `nLockTime=H`, `nSequence=0xfffffffe` e key origin `m/0`;
5. wallet Core de chave errada sem assinatura;
6. exatamente uma `partialSig` retornada por `sign_psbt`, aceita pelo validador
   TimeSats e finalizada pelo finalizador TimeSats;
7. rejeicao de consenso antes de H como `non-final`, seguida de aceitacao,
   broadcast, confirmacao em altura 108 e consumo do UTXO original depois de H.

O log de sucesso incluiu:

```text
V2 jadeSignPsbt=true descriptorRegistration=false partialSignature=true TimeSatsValidation=true
V2 SPEND accepted=true ... finalizerTxidMatchesCore=true confirmations=1 confirmedHeight=108 originalUtxoSpent=true
```

O numero de altura e identificadores de transacao variam entre execucoes; o
significado dos checks acima e o criterio de sucesso, nao um fixture.

## Prova manual do vertical slice da UI

Depois da prova isolada, foi observada uma prova manual adicional do fluxo de
produto em Regtest. Ela nao substitui o harness: registra que a UI real chegou
ate a transacao confirmada usando a mesma combinacao Jade QEMU/Policy V2.

| Dado publico | Valor observado |
| --- | --- |
| Plano | Policy V2, Regtest, `unlockHeight=103`, fonte raiz `m` |
| Fonte publica Jade | `tpubD6NzVbkrYhZ4Yeqkh5GKpfjjeB9cqLnnXzBvPB8g3qsRuUFvXe754t4g6rNhyw8vK7isRuwR9Vz3NeCd4LhS1rk8eHtBJERoSaLacdVSFnv` |
| Key origin | fingerprint `35885c45`, `sourcePath: "m"` |
| Deposit #0 | `bcrt1q0wduxpqwpjpsraezz0ynacv6hs7ukndpc53xayegmujy6j3v9chsmcu7gc` |
| Funding | `d61905be9d7cf5fd27bc5f20e3f0febc4f0c90a751d3c83a7aa63dafd4b9192d:1`, `500000` sats |
| Spend | destino `bcrt1qj4gq549vgqncha7g54u6q4uw02zh5yu983gcsq`, fee `500` sats, saida `499500` sats |
| Transacao final | `910024c03e79f67250e9fc795a966442412bb693cbde19f231fa03b7ac04bccf` |
| Confirmacao Core | 1 confirmacao, bloco 104, `7586bde419181108e678e3e1fbd721a7651daf533ae86ad4a529bcdb7a5dfa16` |

O fluxo manual foi:

1. a UI criou o VaultPlan V2 e derivou Deposit #0;
2. a transacao real de funding e o `vout` foram informados a UI, que executou
   `verifyFundingTransaction`;
3. a UI construiu o PSBT unsigned com `nLockTime=103`, `nSequence=0xfffffffe`
   e `SIGHASH_ALL`;
4. a Jade em QEMU assinou externamente pelo helper `jade-sign-psbt.py`;
5. o PSBT assinado foi importado na UI, que executou
   `validateSignedVaultPsbt` e `finalizeVaultPsbt`;
6. a raw transaction foi transmitida manualmente, fora do TimeSats, por Bitcoin
   Core; o Core retornou o mesmo TXID mostrado pela UI;
7. o bloco 104 confirmou a transacao apos o timelock.

Portanto, a Policy V2 do TimeSats completou um fluxo manual end-to-end em
Regtest usando a UI do TimeSats e firmware Jade em QEMU como signer externo.
O TimeSats verificou o funding, produziu o PSBT, validou e finalizou o PSBT
assinado; a raw transaction resultante foi aceita e confirmada pelo Bitcoin
Core apos o timelock.

O broadcast e a descoberta do funding foram manuais e externos. A seed
descartavel da Jade QEMU ficou somente em RAM; nenhuma chave privada entrou no
TimeSats, na UI, nos scripts do repositorio ou nesta documentacao.

O harness ja cobre tecnicamente derivacao, funding, PSBT, `sign_psbt`,
validacao, finalizacao, rejeicao antes de H, aceitacao depois de H, broadcast,
confirmacao e consumo do outpoint. A prova manual acrescenta a orquestracao do
vertical slice pela UI, nao uma nova propriedade de consenso. Por isso nao foi
criado teste E2E de browser: os testes de UI cobrem a orquestracao local e o
harness cobre o signer e consenso. O harness agora tambem exige igualdade entre
o TXID do finalizador TimeSats e o retornado pelo Core, alem de uma confirmacao
explicita no bloco minerado.

## Fronteira de segredo e limitacoes

O TimeSats recebeu e persistiu somente dados publicos: `tpub`, pubkey,
fingerprint, caminho BIP32, scripts, endereco e PSBT. Nenhum mnemonic, seed,
WIF, chave privada, `xprv`, `tprv` ou descriptor privado entra em codigo de
produto, UI, fixture, log ou documentacao. A chave de assinatura permanece no
ambiente Jade QEMU isolado.

Esta prova nao avalia nem afirma:

- comportamento de uma Jade fisica, USB, BLE, QR ou qualquer transporte fisico;
- anti-exfil, autenticacao, PIN, attestation, atualizacao de firmware ou
  seguranca do ambiente QEMU;
- suporte de wallets, hardware wallets ou software alem da combinacao exata
  Jade QEMU observada e Bitcoin Core 31.1 em Regtest;
- uso em mainnet, BTC real, monitoramento automatico de cadeia, broadcast de
  produto ou automacao E2E de browser para a UI;
- comportamento de uma Jade fisica, mesmo que o fluxo manual da UI tenha usado
  uma Jade em QEMU.

Phase 1 deve repetir a prova relevante com uma Jade fisica antes de qualquer
alegacao de compatibilidade fisica ou release v0.5.
