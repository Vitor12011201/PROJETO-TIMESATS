# Decisao Arquitetural - Estado Persistente Xpubless V2 e Public Reconnect

## Status

**ARCHITECTURE CANDIDATE - PROPOSED PRODUCTION DIRECTION.** Esta e uma sintese de decisao para desenho posterior, nao uma arquitetura final de producao, schema aprovado, recovery novo ou mudanca de Policy V1/V2.

As pesquisas X1A, X1B, X2A, X2B, X3A e X3B demonstraram viabilidade substancial para Policy V2 dentro dos limites declarados. Ainda existem bloqueadores antes de qualquer implementacao de migracao de produto e antes de release. Policy V1 nao faz parte desta direcao positiva.

Este documento nao altera `src/`, storage, recovery, `vaultPlanIdentity`, `ExternalSigner`, scripts Bitcoin, Policy V1/V2 ou a proibicao de mainnet.

## Decision inputs

Esta decisao consolida:

- `docs/research-quantum-security.md`;
- `docs/crypto-agility.md`;
- `docs/research-x1a-xpubless-recovery.md`;
- `docs/research-x1b-core-xpubless-discovery.md`;
- `docs/research-x2a-xpubless-browser-state.md`;
- `docs/research-x2b-realistic-legacy-storage-migration.md`;
- `docs/research-x3a-wallet-public-reconnect.md`;
- `docs/research-x3b-core-public-reconnect.md`.

Tambem foram considerados o storage e os contratos atuais em `src/storage/vault-plan-storage.ts`, `src/bitcoin/vault-plan.ts`, `src/bitcoin/external-contracts.ts`, `src/domain/vault-plan.ts` e `src/bitcoin/index.ts`, alem das provas de signer em `docs/bitcoin-core-signer.md` e `docs/research-v0.5-jade.md`.

## Problem

Hoje o browser persiste o `VaultPlan` completo V2 em `timesats.vault-plans.v3`. Esse plano contem a `tpub`. Alem disso, `vaultPlanIdentity` inclui a `tpub` e, em V2, o origin; por isso as preferencias atuais tambem podem persistir esse material literalmente em:

- `timesats.archived-plan-identities.v1`;
- chaves de `timesats.hidden-deposit-indexes.v1`.

`timesats.vault-plans.v2` ainda pode existir como fallback legado. `saveVaultPlans()` escreve v3, mas nao remove v2; portanto uma copia legada adicional pode continuar presente quando essa key existir.

Uma tpub nao e segredo nem private key. Ela e, porem, **public**, **privacy-sensitive**, **family-derivation-sensitive** e **quantum-security-sensitive**: permite derivar a familia nao-hardened abaixo do no exportado e cria exposicao duravel de material de public key. Para timelocks longos, minimizar a exposicao prolongada causada pelo proprio estado persistente e uma direcao prudente. Isso nao transforma tpub em segredo e nao altera a criptografia de um UTXO ja confirmado.

## Proposed architecture

Para Policy V2, a direcao proposta separa explicitamente dois estados:

```text
durable xpubless state
  -> persistido no browser
  -> watch/recovery de outputs conhecidos

publicly rehydrated session
  -> somente memoria apos public reconnect validado
  -> derivacao e preparo publico de spend
```

O estado duravel nao substitui o recovery oficial. O estado de sessao nao e uma wallet, nao possui private key e nao substitui `ExternalSigner`.

### Durable xpubless state

Um schema futuro, ainda nao decidido, deve conter somente o necessario para descrever e observar a representacao V2 local:

- format e versionamento futuros explicitos;
- `policyVersion`;
- network;
- `unlockHeight`;
- descricao de derivacao;
- key origin historico V2: `masterFingerprint` e `sourcePath`;
- label e metadata local necessaria;
- `lastIssuedIndex`;
- outputs emitidos contiguos, cada um como `{ index, outputScript }`;
- `historicalIdentityCommitment` experimental ou um equivalente futuro deliberadamente escolhido;
- `localInstanceId` opaco;
- archive, hidden deposits e outras preferencias locais indexadas por `localInstanceId`;
- migration/security status, quando uma migracao existir.

O schema final, sua versao, serializacao e limites de tamanho ainda nao foram decididos. A lista de outputs deve representar todos os indices emitidos `#0..#lastIssuedIndex`, inclusive aqueles ocultos na UI. Ocultar um deposito nunca desfaz sua emissao.

Por design, esse estado nao deve conter:

- tpub/xpub;
- a `vaultPlanIdentity` canonica atual, pois ela contem tpub;
- child public keys `P_i`;
- witness scripts;
- xprv/tprv, seed, mnemonic, WIF ou private keys.

"Nao persistido" nao significa zeroizacao garantida de RAM. JavaScript e browser nao oferecem garantia simples de apagar strings, React state, heap de GC, DevTools snapshots, crash dumps ou extensoes. O objetivo e minimizar a persistencia duravel, nao alegar apagamento comprovado de memoria.

### Local instance ID

Tres conceitos permanecem deliberadamente separados:

```text
localInstanceId != vaultPlanIdentity != historicalIdentityCommitment
```

- `vaultPlanIdentity` e a identidade publica canonica atual de produto/Bitcoin. Ela inclui tpub e origin V2.
- `historicalIdentityCommitment` e um commitment experimental de binding/integrity condicional.
- `localInstanceId` e um UUID/opaco de uma instancia persistida naquele browser. Ele associa archive, hidden e estado de UI.

`localInstanceId` nao identifica canonicamente um plano Bitcoin e nao resolve deduplicacao. X2A refutou o identificador deterministico baseado em `outputScript #0`: duas identidades historicas V2 diferentes podem recompor os mesmos outputs e fazer alias de archive/hidden. Isso e **LOCAL-REFERENCE ALIASING**, nao colisao Bitcoin ou SHA256. A direcao de pesquisa para associacao local e UUID opaco por instancia; uma nova importacao pode receber outro UUID.

### Historical identity commitment

O commitment experimental de X1A pode oferecer:

- **binding**, se o digest original for preservado;
- **integrity checking** contra corrupcao ou adulteracao parcial quando esse digest permanece confiavel.

Ele nao oferece sozinho authentication, backup tamper-proof ou trust anchor. Um atacante que substitui o candidate inteiro pode substituir e recomputar o commitment. O commitment tambem e correlacionavel: quem conhece uma tpub/origin candidata pode testa-la offline contra o preimage experimental. A escolha de um trust anchor e **OPEN BLOCKER**; o prototipo SHA256 nao deve ser elevado automaticamente a formato oficial.

## Public wallet reconnect

O candidate e autoridade para policy, `H`, network, derivacao, origin historico, outputs emitidos, `lastIssuedIndex` e commitment historico. A wallet nunca pode substituir esses valores.

O contrato minimo proposto, ainda research-only, e:

```text
request
  capability: PUBLIC_KEY_SOURCE
  network
  sourcePathHint

response
  capability: PUBLIC_KEY_SOURCE
  extendedPublicKey
```

A response e sempre nao confiavel. Origin/fingerprint echoed por um adapter, se futuramente existir, e metadata opcional de diagnostico/interoperabilidade: deve coincidir com o candidate, mas nao autentica ancestry historica de uma tpub descendant.

### Rehydration validation

Ao receber a source public key, uma implementacao futura deve:

1. parsear e validar a extended public key para a network esperada;
2. reconstruir Policy V2 somente em memoria, usando a policy do candidate;
3. verificar apenas o origin estruturalmente verificavel;
4. derivar todos os outputs `#0..#lastIssuedIndex`;
5. comparar cada `outputScript` byte a byte com os commitments persistidos;
6. verificar o historical identity commitment conforme a postura de trust definida;
7. reconstruir `vaultPlanIdentity` somente em memoria;
8. somente entao marcar a sessao como publicamente reidratada.

Uma wallet errada deve falhar fechado. A mensagem futura deve ser generica, por exemplo: `Esta wallet nao corresponde a este plano.` Ela nao deve ecoar tpub completa ou outro material desnecessario.

Depois de uma reidratacao valida, a sessao pode manter temporariamente source tpub, `VaultPlan`, `P_i`, witness scripts e identity canonica. Isso permite emitir `Deposit #N+1` e preparar dados publicos que o fluxo V2 de spend exige. Ao persistir a emissao, o estado duravel recebe somente o novo `lastIssuedIndex` e o novo `outputScript`; tpub de sessao nunca pode ser repersistida silenciosamente.

Reconnect publico e assinatura sao capabilities separadas:

```text
PUBLIC_KEY_SOURCE  -> reapresenta fonte publica para reidratacao
PSBT_SIGNER        -> assina PSBT fora do TimeSats
```

Uma wallet pode suportar uma, ambas ou nenhuma. `ExternalSigner` continua sendo o contrato separado de PSBT assinado; public reconnect nao autentica dispositivo, nao produz assinatura e nao disponibiliza private key.

### Source-node scope

A direcao desejavel e pedir a menor source node utilizavel:

- root tpub tem blast radius nao-hardened maior;
- descendant/source tpub limita o escopo ao no exportado e aos seus descendentes nao-hardened.

Para novos planos, uma dedicated hardened TimeSats source branch pode ser uma direcao de onboarding, somente se adapters reais conseguirem exportar a tpub daquele no depois da derivacao hardened interna. Uma ancestor tpub publica nao pode derivar um child hardened. Isso nao modifica V2 historica nem promete interoperabilidade universal.

## Watch and discovery model

X1B provou no escopo declarado:

```text
outputScript
  -> raw(outputScript)
  -> Bitcoin Core watch-only / scantxoutset
  -> current UTXO discovery
```

Portanto o candidate pode fornecer targets de observacao sem tpub. Esse resultado e limitado a outputs explicitamente salvos: uma lista stale nao conhece outputs novos, spent-history continua **NOT PROVEN**, a lista cresce O(N) e agrupa outputs correlacionaveis. A lista reduz exposicao de public key de familia, mas nao cria estado privado nem capacidade de assinatura.

## Adapter evidence and scope

X3B provou o adapter minimo somente para Bitcoin Core 31.1.0 em Regtest isolado e para o shape observado de descriptor external active ranged `wpkh([<fingerprint>/<origin>]tpub.../0/*)#<checksum>`. O public node observado tinha depth 3 e a source tpub retornada depth 4. Isso nao e uma regra universal de path ou descriptor.

O limite de exposicao possui quatro camadas distintas:

```text
Core wallet                 -> possui estado e chaves internamente
Core public descriptor RPC  -> expoe account/ancestor tpub publica observada
X3B adapter                 -> observa transitoriamente descriptor + ancestor + source tpub
TimeSats minimal response   -> recebe somente source tpub descendant
Durable candidate           -> nao persiste nenhuma dessas tpubs
```

Assim, response minima TimeSats nao significa exposicao transitoria minima no adapter. O resultado `PUBLIC-ONLY RPC BOUNDARY: PROVEN` significa que as RPCs usadas pelo adapter solicitaram e retornaram somente material publico; ele nao afirma que a wallet Core normal nao tenha private keys internamente. O parser X3B foi deliberadamente limitado e fail-closed; nao ha claim de suporte generico Bitcoin Core, descriptor, Core remoto ou browser RPC.

## Migration model

X2B recomenda como direcao de pesquisa uma nova entry monolitica, pois candidates, preferencias e journal podem ser escritos e validados juntos. Isso reduz estados intermediarios comparado a varias keys, mas nao cria transacao multi-key em `localStorage`.

Uma futura migracao deve ser **crash-safe, idempotent e fail-closed**, nao "atomica" entre keys:

```text
read old state
  -> validate
  -> construct new candidate state
  -> write new state
  -> read-back and validate exact state
  -> migrate preferences to localInstanceId
  -> cleanup legacy v3/v2/archive/hidden keys
  -> final exposure inventory
  -> COMPLETE
```

Se qualquer etapa critica falhar, o estado legado recuperavel permanece. Durante coexistencia, a migracao deve declarar exposicao residual, nao sucesso xpubless. Estados conceituais uteis incluem:

- `COMPLETE_XPUBLESS`;
- `PARTIAL_LEGACY_EXPOSURE`;
- `BLOCKED_UNSUPPORTED_V1`;
- `FAILED_RECOVERABLE`;
- `BLOCKED_DUPLICATE_SEMANTICS`.

Nao se pode declarar "sem tpub persistida" enquanto v2, v3, archive/hidden baseados em identity, ou outra key legada com material conhecido ainda existir.

## V1 is not in the migration path

**V1 FULL XPUBLESS REHYDRATION: NOT PROVEN. V1 STORAGE MIGRATION: BLOCKED.**

V1 nao recebe origin publico historico retroativamente. A proposta nao pode inventar `sourcePath`, converter V1 para V2, remover a tpub necessaria nem esconder V1 dentro do fluxo V2. X2B bloqueou integralmente snapshots mistos V1+V2 para evitar cleanup que prejudique recuperabilidade. Antes de producao deve existir uma politica V1 explicita; ela e separada da direcao V2.

## Open blockers

### Deduplication semantics

**OPEN BLOCKER.** Uma mesma identity canonica duplicada pode ter labels, `lastIssuedIndex`, archive e hidden conflitantes. A reconciliacao limitada v2/v3 somente e segura quando a mesma policy canonica foi provada e o maior indice preserva monotonicidade. Ela nao define qual instancia duplicada deve sobreviver. Nenhum merge automatico deve ser inventado aqui.

### Trust anchor

**OPEN BLOCKER.** Historical identity commitment nao autentica um candidate inteiramente substituido. Segunda copia de digest, assinatura, secret/MAC, midia fisica, commitment externo ou outro mecanismo verificavel sao alternativas conceituais; cada uma adiciona requisito de backup, trust, segredo ou dependencia externa. Nenhuma foi escolhida.

### Browser-real migration

**OPEN VALIDATION GAP.** X2A/X2B provaram modelo de storage fake/in-memory, nao comportamento de `localStorage` real. Ainda faltam quota e falhas reais de browser, multi-tab/concurrency, crash/reload, rollback operacional e UX de migracao. Model proof nao e browser-engine proof.

### Physical Jade

**OPEN RELEASE BLOCKER.** Jade QEMU assinou Policy V2 em Regtest, mas Jade fisica permanece **NOT TESTED**. Phase 1 fisica continua obrigatoria antes de qualquer claim de compatibilidade fisica ou release v0.5. A prova Core reconnect nao muda esse fato.

## Official recovery remains separate

Browser durable state e durable user recovery artifact sao problemas distintos. X1A/X2A/X2B nao modificaram o recovery oficial. A decisao de substituir o recovery atual por um formato reduced-xpub/xpubless ainda **NAO FOI TOMADA**.

Enquanto essa decisao nao existir, recovery/export legado deve continuar disponivel e qualquer implementacao futura precisa separar migration de browser de evolucao/versionamento de recovery. Nenhuma migracao pode ser destructive-first ou perder output commitments; rollback deve preservar recuperabilidade e nunca afetar fundos ou UTXOs.

## Quantum and mainnet boundary

Esta arquitetura reduz somente a exposicao prolongada de material de public key causada pelo estado persistente do TimeSats. Ela nao e post-quantum spend security, quantum resistance, mecanismo de crypto migration, garantia contra Shor ou garantia eterna de SHA256.

UTXOs V1/V2 confirmados continuam presos a criptografia e ao CLTV da policy Bitcoin original. A armadilha de migracao por timelock permanece: atualizar software ou estado local nao altera bytes on-chain nem permite gasto antes de `H`. Mainnet continua explicitamente bloqueada; esta arquitetura nao remove os gates de crypto agility ou quantum threat model.

## Non-negotiable invariants

1. TimeSats nunca recebe seed, mnemonic, private key, WIF, xprv ou tprv.
2. Toda wallet response e nao confiavel e deve ser validada localmente.
3. O candidate define policy; wallet nao define policy, H, network, derivacao, origin historico, outputs ou indices.
4. OutputScript emitido nunca muda silenciosamente.
5. `lastIssuedIndex` nunca regride.
6. Indice emitido nunca e reutilizado.
7. Material tpub de sessao nunca volta automaticamente para persistencia.
8. Wallet errada falha fechado.
9. V1 nao e convertida, recebe origin inventado ou e apagada por esta direcao.
10. Estado legado nao e removido antes de novo estado ser escrito, relido e validado.
11. Nenhum status declara ausencia de tpub enquanto houver exposicao legada conhecida.
12. Mainnet continua bloqueada.
13. Recovery oficial nao muda sem decisao e versionamento proprios.
14. Policies V1/V2 historicas sao imutaveis.
15. Nao existe claim de interoperabilidade sem prova real da combinacao especifica.

## Evidence matrix

| Property | Evidence | Status | Limit |
| --- | --- | --- | --- |
| Quantum long-lock threat model | Quantum threat model e crypto agility | PARTIAL | Risco documentado; nao ha migracao antecipada nem solucao PQ. |
| V2 xpubless output reconstruction | X1A | PROVEN | Requer source tpub reapresentada; V1 nao demonstrada; trust anchor aberto. |
| Core current-UTXO discovery | X1B | PROVEN | Core 31.1 Regtest; raw outputs explicitos; spent history nao provado. |
| Persistent browser candidate offline | X2A | PROVEN | Candidate V2 research-only; nao e storage de produto. |
| V2 storage migration model | X2B | PROVEN IN RESEARCH | Storage fake/in-memory e snapshots V2 validos nao ambiguos. |
| Minimal wallet public reconnect | X3A | PROVEN | Contract research-only e fixture V2. |
| Core live public reconnect | X3B | PROVEN | Core 31.1 Regtest, shape `wpkh` observado e parser limitado. |
| Jade QEMU signing | Research v0.5 Jade | PROVEN | Signing V2 em QEMU; nao e reconnect X3A. |
| Physical Jade | Nenhuma prova Phase 1 | NOT TESTED | Release/claim fisico bloqueado. |
| V1 xpubless migration | X1A/X2A/X2B | BLOCKED | Sem origin historico legitimo; nao converter. |
| Deduplication semantics | X2B | BLOCKED | Conflictos de identity/metadata/preferences sem politica. |
| Trust anchor for historical identity | X1A/X3A | NOT PROVEN | Commitment sozinho permite substituicao integral. |
| Browser-real migration | X2A/X2B | NOT PROVEN | Quota, crash, multi-tab e rollback reais ainda ausentes. |
| Spent-output historical discovery | X1B | NOT PROVEN | X1C permanece pesquisa futura. |
| Official recovery xpubless | X1A/X2A/X2B | NOT PROVEN | Recovery atual nao foi alterado. |
| Mainnet | README, security e crypto research | BLOCKED | Signet/Regtest only; gates independentes permanecem. |

## Production gates

### Must solve before user-facing implementation

- decidir schema e versionamento exatos do estado V2 xpubless;
- decidir politica de dedupe para identities canonicas duplicadas;
- definir politica explicita para V1, inclusive comportamento de migracao bloqueada;
- definir postura de historical identity commitment/trust anchor, incluindo seus limites de integridade;
- definir semantica de concorrencia, crash/falha e status de migracao;
- decidir explicitamente se recovery oficial permanece inalterado na primeira fase;
- definir adapters e shapes de descriptor oficialmente suportados, todos fail-closed.

### Must solve before release

- executar testes de migracao, quota, crash/reload e multi-tab em browsers reais;
- endurecer adapter de producao e validar suas fronteiras de I/O/public data;
- construir e testar UX de reconnect sem exibir ou repersistir tpub;
- executar regressao completa de policy, derivacao, recovery, storage, signing e lifecycle;
- revisar threat model, privacidade, exposicao residual e mensagens de erro;
- realizar Phase 1 com Jade fisica antes de claim de compatibilidade fisica/release v0.5;
- manter mainnet como gate separado: esta arquitetura nao o habilita.

## Conservative implementation sequence

Nenhuma fase abaixo esta implementada por esta decisao.

1. **P0 - Accept architecture direction.** Aprovar esta direcao e os bloqueadores explicitos.
2. **P1 - Define isolated types.** Introduzir schema/tipos V2 xpubless em area isolada, ainda sem uso pela UI.
3. **P2 - Pure conversions.** Criar conversao, validation, rehydration e testes puros sem migrar storage real.
4. **P3 - Migration engine.** Adicionar migracao sob flag explicita de dev/research, com journal e inventory.
5. **P4 - Public reconnect interface.** Definir capability `PUBLIC_KEY_SOURCE` sem alterar o contrato de signer existente.
6. **P5 - Narrow adapters.** Implementar adapter Core fora do core puro para shapes comprovados e fail-closed.
7. **P6 - UI state machine.** Implementar reconnect, erro de wallet errada e lifecycle de sessao.
8. **P7 - Browser E2E/fault testing.** Provar migration e rollback em browser real antes de release.
9. **P8 - Physical wallet proof.** Executar Jade fisica e demais provas de adapter realmente suportado.
10. **P9 - Recovery decision.** Decidir separadamente evolucao/versionamento do recovery oficial.

Cada fase deve preservar rollback sem perda de fundos: nao apagar estado legado antes de validar o novo, manter export/recovery legado enquanto a nova arquitetura nao estiver comprovada no produto e nunca introduzir downgrade que perca commitments emitidos.

## Decision

**ACCEPTED FOR FURTHER DESIGN; NOT READY FOR PRODUCTION IMPLEMENTATION.**

Adotar, para desenho futuro de Policy V2, a direcao de estado persistente xpubless com commitments explicitos de outputs e public wallet reconnect somente em memoria. Essa direcao e sustentada para V2 pelos experimentos declarados, mas nao autoriza migracao de producao, mudanca de recovery, conversao V1, claim de mainnet ou claim de seguranca pos-quantica.

Implementacao de produto so pode comecar apos as decisoes e bloqueadores de implementacao acima. Release so pode ocorrer apos os gates de browser real, adapter/UX, regressao, threat-model review e Jade fisica, mantendo mainnet separadamente bloqueada.
