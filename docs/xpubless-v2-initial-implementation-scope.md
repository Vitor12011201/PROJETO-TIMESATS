# Escopo Conservador - Primeira Implementacao Xpubless V2

## Status

**IMPLEMENTATION SCOPE DECISION - PROPOSED.** Este documento define o corte conservador para iniciar P1 e P2 da direcao xpubless V2. Ele nao aprova migracao de storage no produto, UI, adapter de wallet, recovery novo, mudanca de Policy V1/V2 ou mainnet.

Principio central:

```text
FAIL CLOSED
PRESERVE RECOVERABILITY
NO SILENT SEMANTIC MIGRATION
```

A primeira implementacao nao precisa resolver automaticamente todos os estados historicos. Quando nao puder provar uma transformacao, deve bloquear de forma recuperavel, manter estado legado e expor um status preciso em vez de adivinhar, descartar informacao ou normalizar uma policy historica.

## Decision inputs

Esta decisao aplica a direcao definida em `docs/xpubless-v2-architecture-decision.md` e usa as evidencias de X1A, X1B, X2A, X2B, X3A e X3B. Ela tambem respeita o comportamento atual de `src/storage/vault-plan-storage.ts`, `src/bitcoin/vault-plan.ts`, `src/domain/vault-plan.ts` e `src/bitcoin/external-contracts.ts`.

Hoje o storage contem `VaultPlan` completo, archive e hidden keyed por `vaultPlanIdentity`. Para V2, essa identity contem tpub e origin. O recovery oficial tambem conserva a policy atual com tpub. Nenhuma dessas superficies e modificada por este documento.

## Initial direction

A primeira implementacao futura deve preparar somente as bases puras para:

```text
durable xpubless V2 candidate
  +
session-only public wallet reconnect
```

O candidate duravel representara outputs V2 ja emitidos por `index + outputScript`, metadata publica necessaria e preferencias locais futuras por `localInstanceId`. A source tpub reapresentada existe somente durante uma sessao reidratada e validada. Esse corte reduz exposicao duravel causada pelo estado do browser, mas nao e recovery oficial xpubless, seguranca pos-quantica, mecanismo de migracao criptografica ou permissao para gasto antes de `H`.

## Initial V1 policy

**DECISION: ACCEPT.**

Na primeira implementacao:

- V1 continua no storage e recovery legados;
- V1 nao e convertida para V2;
- V1 nao recebe `masterFingerprint` ou `sourcePath` inventados;
- V1 nao entra no schema xpubless V2;
- se um snapshot elegivel para migracao contiver qualquer V1, a migracao automatica V2 retorna `BLOCKED_UNSUPPORTED_V1`;
- nenhum estado legado e removido nesse caso.

Essa politica preserva recuperabilidade e permite desenvolver V2 sem criar semantica retroativa. Uma futura superficie de produto pode informar que a instalacao requer tratamento legado/manual especifico; ela nao pode chamar o browser de xpubless enquanto V1 ou outro legado com tpub permanecer.

V1 full xpubless rehydration continua **NOT PROVEN** e V1 storage migration continua **BLOCKED**. Esta decisao nao resolve V1 e nao a esconde no happy path V2.

## Initial deduplication policy

**DECISION: ACCEPT.**

Nao existe merge automatico no primeiro corte. Antes de qualquer migracao, uma canonical duplicate detectada produz `BLOCKED_DUPLICATE_SEMANTICS`:

- nenhuma copia e apagada;
- nenhuma label e escolhida automaticamente;
- nenhum `lastIssuedIndex` conflitante e reduzido;
- archive e hidden nao sao mesclados arbitrariamente;
- estado legado recuperavel permanece intacto.

Isso e suficiente para P1 e P2, pois ambos sao puros e nao migram storage. Tambem e suficiente para desenvolver um P3 restrito: o engine so pode operar sobre snapshots V2 canonicamente nao ambiguos. Dedupe continua bloqueador para migracao ampla e para release de uma migracao user-facing.

## Initial trust-anchor posture

**DECISION: ACCEPTABLE INITIAL POSTURE FOR P1/P2.**

A primeira arquitetura xpubless V2 nao promete autenticacao contra atacante que substitui integralmente o persistent candidate. Se usado, `historicalIdentityCommitment` oferece somente:

- binding quando o commitment original foi preservado;
- deteccao de corrupcao ou adulteracao parcial sob essa mesma condicao.

Claims proibidos nesta fase:

- authenticated backup;
- tamper-proof state;
- malicious replacement protection;
- trust anchor implicito.

Essa postura limitada e aceitavel para iniciar tipos, conversoes e reidratacao pura porque o recovery oficial atual continua separado e o produto nao afirma protecao contra substituicao integral do candidate. Ela nao encerra a pesquisa de trust anchor: assinatura, secret/MAC, segunda copia de digest, midia fisica, commitment externo ou outra ancora continuam escolhas abertas, cada qual com novos custos de backup, trust, segredo ou dependencia externa.

Uma migracao user-facing ou release deve passar por revisao de threat model que aceite explicitamente esse limite. A postura nao pode ser alterada silenciosamente por microcopy ou por chamar o candidate de backup autenticado.

## Historical identity commitment in the first schema

**DECISION: B - VERSIONED, INTEGRITY-ONLY FIELD.**

P1 deve reservar o papel de um historical identity commitment versionado para binding de reconnect e integridade parcial, sem elevar o prototipo SHA256 de pesquisa a formato oficial por acidente. O desenho de schema P1 deve definir de modo explicito:

- se o field e requerido para todo candidate V2 do schema inicial;
- identificador de algoritmo/domain version;
- serializacao canonica que o calcula;
- regra de validacao e de evolucao.

Este documento nao define esses bytes ou a serializacao de producao. Ate essa definicao, P2 pode trabalhar contra o contrato/tipo proposto em testes puros, nao contra uma promessa de autenticacao. O field e correlacionavel e nao e segredo.

## Official recovery decision

**DECISION: KEEP CURRENT RECOVERY INITIALLY.**

A primeira implementacao nao muda o bundle de recovery oficial. Browser persistent state pode ganhar uma representacao xpubless no futuro, mas export/import atual continua no formato existente, com a policy publica atual.

Consequencias assumidas honestamente:

- reduz-se a exposicao duravel causada pelo browser quando o estado novo for ativado;
- nao se elimina a exposicao de tpub em recovery oficial enquanto esse formato permanecer;
- preserva-se compatibilidade retroativa e rollback;
- evita-se misturar migracao de browser com versionamento de recovery.

Browser persistent-state migration **nao implica** official recovery migration. Evolucao de recovery exige decisao, schema, versionamento, testes de recuperabilidade e threat model proprios.

## Wallet adapter policy

`PUBLIC_KEY_SOURCE` e um capability contract distinto de `PSBT_SIGNER`. O core puro recebe uma response publica nao confiavel e a valida; I/O fica fora dele.

P1/P2 nao dependem de Bitcoin Core RPC, Jade, browser RPC ou adapter real. Cada adapter futuro deve obter prova propria antes de ser suportado.

Bitcoin Core X3B provou somente Bitcoin Core 31.1.0 em Regtest isolado e o shape external active ranged `wpkh` observado. Um adapter futuro deve ter matriz explicita de versao/shape, parser limitado e fail-closed para descriptor desconhecido, zero match ou match ambiguo. Isso nao autoriza claim de suporte generico Core.

Jade fisica permanece **NOT TESTED**. Ela nao entra como public reconnect adapter fisico suportado. Jade QEMU assinou Policy V2 em Regtest, mas signing nao prova reconnect e nao prova dispositivo fisico.

## Migration eligibility and refusal

Uma futura migration engine so e elegivel para operar quando todos os requisitos abaixo forem provados antes de qualquer escrita destrutiva:

1. todos os planos relevantes sao V2 explicitamente suportados;
2. o storage legado parseia e valida;
3. nao existe canonical duplicate ambigua;
4. cada candidate xpubless pode ser construida e validada;
5. preferences podem ser associadas sem aliasing por `localInstanceId`;
6. nenhum status blocker se aplica.

Caso contrario, a acao inicial e nao migrar. Em especial:

```text
mixed V1 + V2 -> BLOCKED_UNSUPPORTED_V1 -> no cleanup
duplicate canonical V2 -> BLOCKED_DUPLICATE_SEMANTICS -> no cleanup
corrupt/incomplete state -> FAILED_RECOVERABLE -> no cleanup
```

P3 nao pode migrar parcialmente por conveniencia para tentar limpar somente V2 de uma instalacao mista. Estado legado permanece ate que uma politica separada seja aprovada.

## Concurrency and browser fault gates

Multi-tab e semantica de falha de browser sao gates distintos:

| Gate | P1 types/schema | P2 pure functions | P3 engine behind dev/research flag | User-facing migration / release |
| --- | --- | --- | --- | --- |
| Multi-tab concurrency | Nao bloqueia | Nao bloqueia | Bloqueia ativacao sobre storage real | Bloqueia |
| Browser quota/crash/reload semantics | Nao bloqueia | Nao bloqueia | Bloqueia ativacao sobre storage real | Bloqueia |
| Storage fake fault model | Evidencia de design | Evidencia de design | Necessaria, mas insuficiente sozinha | Insuficiente |

P1/P2 podem ser desenvolvidos como codigo deterministico sem browser. P3 pode ser desenhado e exercitado sob flag dev/research com storage fake e contrato de single-writer explicito, mas nao pode migrar o storage real de usuarios ate haver testes reais de quota, crash/reload, rollback e concorrencia multi-tab.

## Physical Jade gate

Jade fisica nao bloqueia P1/P2: esses passos nao conectam wallet e nao assinam. Ela bloqueia claim de adapter fisico e, conforme `docs/research-v0.5-jade.md`, Phase 1 fisica continua obrigatoria antes de qualquer release v0.5. A prova de reconnect Core nao muda esse release gate.

## Mainnet boundary

Nada neste escopo altera mainnet. Mainnet continua bloqueada pelos gates independentes de quantum security, crypto agility, lifecycle, signer interoperability e politica de release. Xpubless persistent state nao e mainnet unlock.

## Exact P1 scope

P1 pode introduzir somente desenho e implementacao de types/schema V2 xpubless isolados, ainda sem substituir storage atual:

- tipo discriminado research-to-production para candidate V2, com format/version explicitamente novos;
- validacao de network permitida, policy V2, `unlockHeight`, derivacao publica nao-hardened, key origin, `lastIssuedIndex` e outputs contiguos `#0..#N`;
- definicao de `localInstanceId` opaco para preferencias futuras, sem reusar `vaultPlanIdentity`;
- campo de commitment versionado com semantica integrity-only, apos especificacao canonica propria;
- rejeicao estrutural de tpub/xpub, `vaultPlanIdentity` canonica, child pubkeys, witness scripts e todo private material;
- testes de parse/serializacao e falha fechada em schemas invalidos.

P1 nao le nem escreve `localStorage`, nao move plans existentes, nao altera recovery, nao apresenta UI e nao chama adapter.

## Exact P2 scope

P2 pode adicionar somente funcoes puras e testes para Policy V2:

```text
current V2 VaultPlan
  -> xpubless candidate

candidate + PublicReconnectResponse
  -> rehydrated in-memory V2 VaultPlan

candidate + newly issued deposit
  -> updated candidate
```

As funcoes devem validar response publica nao confiavel contra todos os `outputScript`s emitidos e contra a semantica versionada do commitment. Elas devem reconstruir identity canonica apenas em memoria, preservar `lastIssuedIndex`, nunca reutilizar indice e falhar fechado para wallet errada, output divergente, network/path invalido, lista nao contigua ou private material proibido.

P2 nao altera `vaultPlanIdentity`, `VaultPlan`, derivacao, script, PSBT, recovery, storage, UI, Core RPC, Jade, `ExternalSigner`, funding, spending ou broadcast.

## Out of scope for the first implementation

- automatic V1 migration ou V1 xpubless rehydration;
- automatic dedupe/merge;
- trust-anchor system;
- official recovery evolution;
- migration de `localStorage` de usuario;
- browser multi-tab, quota, crash/reload e rollback de producao;
- Core RPC adapter de producao;
- Jade physical reconnect support;
- generic wallet support;
- watch-only spent-history research;
- mainnet;
- post-quantum spend mechanism ou escape antes de `H`.

## Blocker reclassification

| Item | Current status | Initial policy | Blocks P1? | Blocks P2? | Blocks migration? | Blocks release? |
| --- | --- | --- | --- | --- | --- | --- |
| Schema/versioning | Required design work | Define explicitly in P1 before activation | No | Yes until P1 contract exists | Yes | Yes |
| V1 | BLOCKED | Retain legacy; block whole mixed snapshot | No | No | Yes for affected snapshot | Yes for broad migration |
| Dedupe | OPEN BLOCKER | Detect and refuse; no merge | No | No | Yes for affected snapshot | Yes for broad migration |
| Trust anchor | OPEN BLOCKER | Integrity-only HIC; no authentication claim | No | No | No for dev-only eligible V2 model | Yes pending security review/accepted posture |
| Official recovery | Separate decision | Keep current recovery initially | No | No | No | No, but no xpubless recovery claim |
| Browser fault semantics | NOT PROVEN | Test before real-storage activation | No | No | Yes for user storage | Yes |
| Multi-tab concurrency | NOT PROVEN | Single-writer research only until resolved | No | No | Yes for user storage | Yes |
| Core adapter | Limited X3B proof | Keep outside P1/P2; explicit support matrix | No | No | No | Yes for Core reconnect claim |
| Physical Jade | NOT TESTED | Exclude physical reconnect support | No | No | No | Yes for release v0.5 / physical claim |
| Mainnet | BLOCKED | No scope change | No | No | Yes for mainnet migration | Yes for mainnet |
| Spent history | NOT PROVEN | Keep watch scope to proven current-UTXO discovery | No | No | No | No, unless product claims spent history |

## GO / NO-GO

**GO, with strict conditions.** Existe evidencia suficiente para iniciar:

- **P1 - production schema/type design**, isolado e sem storage real;
- **P2 - pure conversion/rehydration implementation**, V2-only e sem adapter I/O.

Esse GO depende de manter todas as politicas deste documento: V1 e duplicates bloqueiam em vez de migrar, HIC permanece integrity-only ate decisao de trust anchor, recovery oficial continua separado, P1/P2 nao ativam migration e nenhum claim de adapter generico, Jade fisica, mainnet ou seguranca pos-quantica e introduzido.

Nao ha GO para P3 sobre storage real, UI, adapter de producao, recovery novo ou release. Esses passos aguardam seus gates explicitamente classificados acima.
