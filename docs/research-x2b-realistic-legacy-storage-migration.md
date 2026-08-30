# Pesquisa X2B - Realistic Legacy Storage Migration Rehearsal

## Scope

**RESEARCH EXPERIMENT.** X2B ensaia, em storage em memoria com formatos legados reais, uma migracao do estado persistente atual para candidates V2 xpubless. Nao altera `src/`, storage oficial, recovery, `vaultPlanIdentity`, Policy V1/V2, scripts Bitcoin ou mainnet.

O prototype e `scripts/research-x2b-realistic-legacy-storage-migration.ts`. A key nova e research-only:

```text
timesats-research-x2b-monolithic-xpubless-state.v1
```

Ela nao e formato de produto ou recovery oficial.

## Real storage inspected

X2B leu `src/storage/vault-plan-storage.ts`, seus testes, `src/bitcoin/vault-plan.ts`, `src/domain/vault-plan.ts`, `src/components/timesats-app.tsx` e os artefatos X2A.

Os formatos aceitos hoje sao:

| Key | Formato real |
| --- | --- |
| `timesats.vault-plans.v3` | `{ format: "timesats-local-vault-plans", version: 3, plans: VaultPlan[] }` |
| `timesats.vault-plans.v2` | mesmo envelope com `version: 2`; e fallback se v3 nao existe |
| `timesats.archived-plan-identities.v1` | array de `vaultPlanIdentity` |
| `timesats.hidden-deposit-indexes.v1` | mapa `vaultPlanIdentity -> number[]` |

`saveVaultPlans()` grava somente v3; nao remove v2. Portanto v2 e v3 podem coexistir. O prototype constroi snapshots por `saveVaultPlans()` para v3, e pelo envelope v2 aceito pelo schema real para v2.

## Research-only target state

X2B adota **uma entry monolitica** contendo candidates V2, archive, hidden e journal:

```text
format + experiment marker
journal: CANDIDATE_WRITTEN | CLEANUP_PENDING | COMPLETE
candidates: V2 output commitments without tpub
archivedLocalInstanceIds
hiddenDepositIndexes keyed by localInstanceId
```

Cada candidate preserva network, unlock height, label, derivation, key origin, `historicalIdentityCommitment`, `lastIssuedIndex`, `index + outputScript` e UUID `localInstanceId`. Nao preserva tpub, canonical `vaultPlanIdentity`, child public key ou witness script.

O journal melhora rerun, diagnostico e cleanup parcial sem armazenar tpub. Ele nao cria transacao entre a nova entry e as quatro keys legadas.

## Scenario matrix

| Scenario | Resultado X2B |
| --- | --- |
| S1: V2 atual unico | Migra completo. |
| S2: multiplos V2 distintos | Migra completo, UUID unico por candidate. |
| S3: V2 com archive + hidden | Preferencias validas passam para UUID local. |
| S4: somente v2 legada | Migra completo. |
| S5: somente v3 atual | Migra completo. |
| S6: v2 + v3 coexistentes | Reconciliado somente se canonical identity e igual; maior `lastIssuedIndex`; label v3 pela precedencia atual do loader. |
| S7: multiplos V2 com labels diferentes e policies distintas | Migram como candidates distintos. |
| S8: identity canonica duplicada no mesmo snapshot | **BLOCKED_DUPLICATE_SEMANTICS**; nao deduplica. |
| S9: new state existente + old storage | Rerun preserva UUID e conclui cleanup. |
| S10: storage de planos parcialmente corrompido | **FAILED_RECOVERABLE**; nenhuma cleanup. |
| S11: somente V1 | **BLOCKED_UNSUPPORTED_V1**; old state intacto. |
| S12: V1 + V2 | **BLOCKED_UNSUPPORTED_V1**; nenhum V2 e limpo. |
| S13: V1 archived/hidden | **BLOCKED_UNSUPPORTED_V1**; preferencias e V1 intactos. |

## V1 policy

X1A/X2A nao provaram full V1 xpubless rehydration. X2B escolhe a politica experimental conservadora **A: bloquear toda a migracao quando existir V1**.

Migrar apenas V2 e regravar as keys mistas seria arriscado: a mesma entry pode conter V1 e V2, e manter qualquer key legada tambem preserva tpubs e identities antigos. Converter V1, inventar origin ou apagar V1 e proibido. O resultado correto nesses cenarios e:

```text
BLOCKED_UNSUPPORTED_V1
RESIDUAL TPUB EXPOSURE
```

Nao e permitido dizer que o browser ficou sem tpub persistida.

## Reconciliation and duplicate limits

Quando v2 e v3 contem a **mesma** `vaultPlanIdentity`, X2B provou uma reconciliacao limitada: escolher metadata da v3, pois ela tem precedencia no loader atual, e usar o maior `lastIssuedIndex`. Isso preserva monotonicidade para o mesmo policy bytes/identity:

```text
v2 #3 + v3 #5 -> #5
v2 #5 + v3 #3 -> #5
```

Nao e permitido associar policies apenas por `outputScript #0`.

Duplicatas da mesma identity dentro de uma unica entry sao estruturalmente aceitas pelo schema legado, mas possuem possiveis conflitos de label, indice, archive e hidden. X2B bloqueia antes de escrever. `historicalIdentityCommitment` pode sinalizar equivalencia experimental, mas nao escolhe qual metadata/preference sobrevivera e nao e autenticacao.

**DEDUPLICATION SEMANTICS: OPEN BLOCKER.**

## Preference behavior

Archive e hidden sao secundarios em relacao a recoverability Bitcoin:

- archive para identity V2 conhecida migra para o UUID do candidate;
- hidden e deduplicado, ordenado e filtrado para `index <= lastIssuedIndex`;
- hidden/archived para identity ausente e descartado;
- hidden invalido nao remove plano ou commitment;
- se candidate `CLEANUP_PENDING` ja existe, ele e a fonte de preferencias para rerun, evitando merge arbitrario durante uma migracao interrompida.

O modelo nao supoe UI concorrente durante a migracao. Uma futura implementacao precisaria excluir concorrencia ou ter regra explicita de conflito.

## Monolithic vs multi-key

| Opcao | X2B finding |
| --- | --- |
| A. Uma entry monolitica | Uma escrita/read-back valida candidates e preferencias juntos; journal permanece coeso; menos risco de mismatch. |
| B. Entries separadas | Exige multiplas escritas, mais estados intermediarios, mais quota temporaria e pode deixar candidate/preference/journal desencontrados. |

O prototype mede que envelopes separados para candidates, archive e hidden usam mais bytes que a entry monolitica equivalente. Isso nao e benchmark de browser nem numero universal de quota. A escolha X2B e A, apenas para pesquisa.

## Crash, quota and corruption rehearsal

A sequencia modelada e:

```text
read/parse legacy
construct candidate
write new state
read-back + validate
map preferences
remove v3, v2, archive, hidden
final inventory
mark COMPLETE
```

Falhas foram injetadas em leitura, construcao, write, read-back, preference migration, cada remocao e verificacao final. Rerun converge quando o new state valido permanece. Antes do cleanup, old state continua; durante coexistencia ainda ha exposicao de tpub.

O storage fake aplica quota com `setItem` all-or-nothing. Se a nova entry nao cabe enquanto old + new coexistem, a escrita falha e old state permanece intacto. O experimento tambem corrompeu novo state em:

- `localInstanceId`;
- `lastIssuedIndex`;
- `outputScript`;
- lista de outputs;
- `historicalIdentityCommitment`;
- preference para UUID inexistente;
- UUID duplicado.

Todos falham fechado antes de remover legacy.

Se v3 ja foi removida e a remocao v2 falha, o status e:

```text
PARTIAL_LEGACY_EXPOSURE
MIGRATION INCOMPLETE
```

Rerun remove a v2 restante e somente o inventario final permite `COMPLETE_XPUBLESS`.

## Exposure inventory and boundaries

Em uma migracao V2 completa, X2B verifica contra valores reais derivados que nenhuma entry research restante contem:

- tpub;
- current `vaultPlanIdentity`;
- child public keys;
- witness scripts.

Permanecem output commitments agrupados, origin publica, historical commitment, UUID local e preferencias. Isso nao e private state: outputScripts e historical commitment sao correlacionaveis. Nao persistir tpub tampouco garante zeroizacao de RAM, strings JS, GC heap, React state, DevTools, crash dumps ou extensoes.

O rehearsal usa storage fake. Ele nao prova semantica de falha, quota, persistencia ou recuperacao do motor `localStorage` de browsers reais.

Recovery/export continua fora do escopo. Browser migration nao modifica o recovery bundle oficial.

## Security status model

Uma futura implementacao deveria distinguir, ao menos conceitualmente:

| Status | Significado |
| --- | --- |
| `COMPLETE_XPUBLESS` | Novo state validado, legacy removido e inventario sem material conhecido. |
| `PARTIAL_LEGACY_EXPOSURE` | Candidate valido existe, mas alguma key antiga ainda contem material legado. |
| `BLOCKED_UNSUPPORTED_V1` | V1 impede cleanup seguro. |
| `FAILED_RECOVERABLE` | Read/write/validation falhou; old state deve permanecer. |
| `BLOCKED_DUPLICATE_SEMANTICS` | Duplicata canonica requer politica de dedupe antes de qualquer cleanup. |

Isso evita claim falso de "sem tpub persistida" quando V1, key v2, ou outra key legada ainda existir.

## Verdicts

- **V2 REALISTIC STORAGE MIGRATION MODEL: A - PROVEN IN RESEARCH**, somente para snapshots V2 validos e nao ambiguos em storage em memoria.
- **V1 STORAGE MIGRATION: BLOCKED.** Nenhuma V1 e removida, convertida ou chamada de xpubless.
- **MULTI-PLAN MIGRATION: PROVEN**, para policies V2 canonicamente distintas.
- **CRASH/QUOTA SAFETY: PROVEN IN RESEARCH**, para o modelo fake/all-or-nothing; nao para browser real.
- **DEDUPLICATION SEMANTICS: OPEN BLOCKER.**

Antes de qualquer migracao de producao permanecem bloqueadores: politica de dedupe, V1, semantica real de `localStorage` sob quota/falha, estrategia de concorrencia/UX, trust anchor historica, reconnect de wallet e decisao separada sobre recovery oficial.
