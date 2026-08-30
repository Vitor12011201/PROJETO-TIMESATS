# Pesquisa X3B - Bitcoin Core Live Public Reconnect Adapter

## Goal

**RESEARCH EXPERIMENT.** X3B prova, em Bitcoin Core 31.1 real e Regtest isolado, que uma wallet descriptor normal pode satisfazer o contrato minimo X3A sem entregar material privado ao TimeSats:

```text
request
  capability: PUBLIC_KEY_SOURCE
  network: regtest
  sourcePathHint

response
  capability: PUBLIC_KEY_SOURCE
  extendedPublicKey: source tpub
```

O experimento nao altera `src/`, `ExternalSigner`, storage, recovery, `vaultPlanIdentity`, Policy V1/V2, scripts Bitcoin ou a proibicao de mainnet. O prototype `scripts/research-x3b-core-public-reconnect.ts` nao e adapter de producao, UI, browser RPC integration ou claim de compatibilidade generica.

## Environment and isolation

O run aprovado observou:

```text
Bitcoin Core version: 310100
subversion: /Satoshi:31.1.0/
chain: regtest
RPC/P2P: 16386 / 16387
```

As portas sao dinamicas por PID e reservadas na faixa X3B `16000-19999`. O helper calcula `rangeStart + (slot % 4000) * 2`; X3B limita explicitamente `slot = process.pid % 2000`, portanto `slot` esta em `0..1999`, `RPC = 16000 + 2 * slot` e `P2P = RPC + 1`. Para qualquer PID, o menor par e `16000/16001` e o maior e `19998/19999`; nunca alcanca `20000+`. O harness faz assertion fail-closed do par exato, portanto overrides de ambiente fora desse par deterministico sao rejeitados. Isso mantem essa faixa dentro do espaco reservado e sem sobrepor:

| Familia | Faixa observada |
| --- | --- |
| X1B | `8000-15999` |
| X3B | `16000-19999` |
| Jade research legado | aproximadamente `20000-39999` |
| PSBT | `40000-47999` |
| CLTV | `48000-55999` |
| Policy V2 | `56000-63999` |

O harness usa `resolveHarnessExecutable(...)`, datadir temporario `timesats-regtest-x3b-core-reconnect-*`, nomes de wallet com PID e somente `-regtest -listen=0 -connect=0 -dnsseed=0 -discover=0`. Ele aborta se a chain nao for `regtest`. No `finally`, chama `stop` apenas nesse daemon, usa fallback apenas no PID que criou e remove apenas seu datadir temporario. Nenhum Jade, Docker, Next, chain manual ou outro `bitcoind` e tocado.

## Existing Core behavior inspected

X3B leu `scripts/research-x3a-wallet-public-reconnect.ts`, `docs/research-x3a-wallet-public-reconnect.md`, `scripts/regtest-core-signer.ts`, `scripts/regtest-policy-v2-research.ts`, `scripts/regtest-harness.ts`, `docs/bitcoin-core-signer.md`, `docs/research-v0.4-policy-v2.md`, `src/bitcoin/bip32.ts`, `src/bitcoin/vault-plan.ts`, `src/bitcoin/index.ts`, `src/domain/vault-plan.ts` e `src/bitcoin/external-contracts.ts`.

Antes de extrair fonte publica, o harness interrogou no Core em execucao:

- `help listdescriptors` para confirmar a opcao de privacidade;
- `help getaddressinfo`;
- `help getdescriptorinfo`.

As RPCs realmente usadas para a fronteira publica foram:

```text
listdescriptors false
getaddressinfo
getdescriptorinfo
getblockchaininfo
```

`listdescriptors true`, `dumpprivkey`, `dumpwallet`, PSBT, signing, funding, mineracao, CLTV e broadcast nao foram usados. A wallet source descartavel e uma wallet Core normal e pode possuir chaves privadas **internamente**. O subveredito **PUBLIC-ONLY RPC BOUNDARY: PROVEN** significa somente que, nas RPCs usadas por X3B, nenhum material privado cruzou a fronteira Core/adaptor: o adapter solicitou e recebeu apenas descritores publicos, metadata publica e tpubs publicas. Ele nao afirma que a wallet Core contem zero chaves privadas.

## Descriptor shape observed

O address externo `bech32` gerado pela wallet normal correspondeu, de forma sanitizada, a:

```text
wpkh([<fingerprint>/<origin>]tpub.../0/*)#<checksum>
```

O `getaddressinfo` devolveu o descriptor concreto de um child, enquanto `listdescriptors(false)` preservou o descriptor ranged com `/*`. Por isso X3B nao comparou strings literalmente. Ele canonicalizou ambos com `getdescriptorinfo`, verificou fingerprint/path publico e relacionou o caminho concreto do address a `sourcePath/0`.

No Core observado:

```text
descriptor public node depth = 3
fixed external suffix      = /0
returned source depth      = 4
sourcePath                 = m/84'/1'/0'/0
```

Esse path e resultado observado deste Core/wallet temporario; nao e um path prescrito para produto. O parser research suporta somente esse shape estrutural: `wpkh`, origin bracket, tpub testnet publica, suffix fixa nao-hardened, wildcard, descriptor ativo e externo. Shapes desconhecidos, descriptor interno, zero matches e mais de um match falham fechado. Um descriptor `tr(...)` publico canonicalizado pelo Core foi rejeitado pelo parser, portanto X3B nao declara suporte generico a descriptors.

## Source-node selection and adapter algorithm

O `CorePublicKeySourceAdapter` recebe o request X3A. Ele:

1. valida schema e exige request/chain `regtest`;
2. chama `listdescriptors false` na wallet;
3. executa canary de marcadores `xprv`/`tprv` e similares em cada descriptor retornado;
4. canonicaliza cada descriptor com `getdescriptorinfo`;
5. aceita somente external ranged `wpkh` do shape observado;
6. calcula `origin sourcePath + suffix fixa` e exige igualdade exata com `sourcePathHint`;
7. exige exatamente um match;
8. deriva a suffix nao-hardened a partir da tpub publica do descriptor;
9. retorna somente a response minima X3A.

A response real tem somente:

```text
format, experiment, capability, extendedPublicKey
```

Ela nao inclui descriptor, fingerprint, path, rede, H, policy, output, pubkey filha ou witness script. O candidate X3A continua autoridade para todos esses campos historicos.

## Public-only security boundary

O harness nao imprimiu descriptor integral, tpub integral, child pubkey, identity canonica, WIF, seed, mnemonic, xprv, tprv ou chave privada. Logs registram apenas tipo de descriptor, profundidades, path publico e resultado. O canary aborta caso um descriptor retornado pelas chamadas publicas contenha marcador `xprv`/`tprv` ou similar; ele e defensivo e nao solicita nem faz parse de private material.

Descriptor publico/tpub nao e chave privada. Ainda assim e privacy-sensitive, family-derivation-sensitive e quantum-security-sensitive; nao deve ser tratado como dado inofensivo.

## Session 1 and candidate

X3B criou wallet descriptor normal descartavel, obteve somente origin/fingerprint/tpub publicos pelo descriptor e `getaddressinfo`, e derivou publicamente a source tpub da suffix externa nao-hardened `/0`.

Com APIs publicas TimeSats, criou VaultPlan V2 Regtest, emitiu `#0..#3` e montou candidate research-only com policy V2, rede, `H`, derivacao, keyOrigin historico, historical commitment, `lastIssuedIndex` e `index + outputScript` para cada emissao.

O JSON foi validado contra valores reais e nao contem:

- source tpub;
- account/ancestor tpub;
- descriptor;
- `vaultPlanIdentity` canonica;
- child pubkeys;
- witness scripts;
- material privado.

Ao fim da Session 1, somente candidate serializado, digest de comparacao de identity e metadata estrutural de profundidade/path passam adiante. O `VaultPlan`, source tpub, account tpub, descriptor e child keys nao sao reutilizados para reconnect. Isso nao declara zeroizacao de RAM.

## Session 2 reconnect

X3B executou `unloadwallet` e `loadwallet` na wallet source antes de Session 2. Com candidate serializado e novo adapter, obteve novamente a response minima. A validacao local X3A:

- aceitou a tpub testnet publica;
- aplicou o keyOrigin historico do candidate;
- recompos `#0..#3` byte a byte;
- confirmou `historicalIdentityCommitment`;
- confirmou a identity canonica historica por digest deterministico;
- declarou o plano publicamente reidratado em memoria.

Nenhuma tpub e regravada no candidate.

## Negatives

| Caso | Resultado observado |
| --- | --- |
| Wallet Core independente | Retornou fonte publica sintaticamente valida; TimeSats rejeitou pelos output commitments. |
| `sourcePathHint` inexistente | Adapter rejeitou zero matches. |
| Internal/change path | Adapter rejeitou; somente descriptor externo ativo e elegivel. |
| Ultimo child diferente | Adapter rejeitou zero matches. |
| Path malformado | Schema X3A rejeitou. |
| Request `signet` contra chain Regtest | Adapter rejeitou antes de retornar fonte. |
| Descendente hardened sob account tpub publica | BIP32 public derivation rejeitou; adapter nao satisfaz o request. |
| Outro script type `tr(...)` | Parser research rejeitou o shape desconhecido. |

Assim, X3B distingue `ADAPTER CANNOT SATISFY REQUEST` de uma wallet que retorna tpub valida, mas e rejeitada pelos commitments do TimeSats.

## Ancestor versus returned-source exposure

No Core observado, o descriptor expos transitoriamente uma account/ancestor tpub de depth 3. O adapter derivou e entregou ao TimeSats apenas a source tpub de depth 4. Portanto:

```text
Core wallet:                    possui estado e chaves internamente
Core public descriptor RPC:     account/ancestor tpub publico observada
X3B adapter:                    observa transitoriamente descriptor + ancestor tpub + source tpub
TimeSats minimal response:      recebe somente source tpub descendant
Durable xpubless candidate:     nao persiste nenhuma dessas tpubs
```

**CORE ADAPTER BROADER-PUBLIC-MATERIAL EXPOSURE: OBSERVED.** Response minima nao significa que o adapter nunca observa material publico mais amplo.

## Deposit #4 and session persistence

Depois de reconnect, X3B emitiu `Deposit #4`. O candidate atualizado preserva somente `lastIssuedIndex = 4` e `outputScript #4`; novamente nao retem source/account tpub, descriptor, identity canonica, child pubkeys ou witness script. Reload conhece `#4`, mas `#5` falha explicitamente ate novo reconnect publico.

## Dedicated hardened source implications

O run real provou que o Core observado pode derivar uma source nao-hardened ja abaixo de tpub publica do descriptor. Uma future dedicated hardened TimeSats source branch teria dois casos:

- se a wallet ja expuser essa branch como no publico em descriptor/export, o adapter pode potencialmente retornar a tpub desse no, sujeito a nova prova real;
- se for necessario derivar essa branch hardened a partir de ancestor tpub publica, BIP32 public derivation nao consegue faze-lo. X3B confirmou essa rejeicao no Core/public-key path observado.

Isso e direcao de onboarding futura, nao mudanca de V2 historica e nao promessa de interoperabilidade universal.

## Limits

X3B nao prova compatibilidade generica Bitcoin Core, mainnet, remote RPC security, browser RPC integration, production adapter safety, Jade, hardware fisico, V1 reconnect xpubless, autenticacao historica de candidate substituido, quantum resistance, migracao antes de H, recovery oficial, signing, spending ou broadcast.

**PHYSICAL JADE: NOT TESTED.**

## Verdicts

- **BITCOIN CORE X3A PUBLIC RECONNECT ADAPTER: A - PROVEN**, limitado a Bitcoin Core 31.1 observado, Regtest isolado e external ranged `wpkh` publico do shape validado.
- **PUBLIC-ONLY RPC BOUNDARY: PROVEN.**
- **EXACT SOURCE-PATH SELECTION: PROVEN.**
- **MINIMAL TPUB-ONLY RESPONSE FROM CORE: PROVEN.**
- **CORRECT CORE WALLET REHYDRATION: PROVEN.**
- **WRONG CORE WALLET REJECTION: PROVEN.**
- **HARDENED-DESCENT REQUEST: UNSUPPORTED.**
- **SESSION-ONLY NO-TPUB REPERSISTENCE: PROVEN.**
- **PUBLIC NEW-DEPOSIT #4: PROVEN.**
- **CORE ADAPTER BROADER-PUBLIC-MATERIAL EXPOSURE: OBSERVED.**
- **PHYSICAL JADE: NOT TESTED.**
- **V1: NOT PROVEN.**

## Next research

Testar outro shape publico explicitamente suportado, sem ampliar silenciosamente o parser. Depois, provar a mesma response minima com Jade QEMU usando somente chamadas publicas quando a infraestrutura estiver disponivel. Nenhum desses passos transforma X3B em contrato de producao.
