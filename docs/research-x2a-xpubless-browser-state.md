# Pesquisa X2A - Persistent Browser State Without TPUB

## Goal

**RESEARCH EXPERIMENT.** X2A investiga estado persistente de browser para TimeSats V2 sem reter tpub, child public keys, witness scripts, a `vaultPlanIdentity` atual ou material privado. Ele nao altera `VaultPlan`, storage, recovery, Policy V1/V2, scripts Bitcoin ou a proibicao de mainnet.

O prototype isolado e `scripts/research-x2a-xpubless-browser-state.ts`. Seu formato `timesats-research-x2a-xpubless-browser-state` nao e schema oficial, recovery, policy ou caminho de runtime.

## Current persistence audit

**CONFIRMED CURRENT BEHAVIOR.** `src/components/timesats-app.tsx` usa `window.localStorage` por meio de `src/storage/vault-plan-storage.ts`:

| Key | Conteudo | Exposicao V2 |
| --- | --- | --- |
| `timesats.vault-plans.v3` | `VaultPlan` completo | tpub direta. |
| `timesats.archived-plan-identities.v1` | identities arquivadas | `vaultPlanIdentity` contem tpub literalmente. |
| `timesats.hidden-deposit-indexes.v1` | mapa identity para indexes | a chave contem tpub literalmente. |

O loader usa `timesats.vault-plans.v2` apenas como fallback quando v3 nao existe. **`saveVaultPlans()` escreve v3 e nao remove v2.** Portanto, se uma key v2 antiga existir, ela pode coexistir com v3 e manter uma copia residual adicional de tpub. Isto e uma *possible residual exposure when legacy storage exists*, nao afirmacao de que todo browser possua v2.

No snapshot real de funcoes de storage, um V2 publico `#0..#3` salvo, arquivado e com `#2` oculto produz tres entries e tres ocorrencias da tpub: plano, archive identity e chave do hidden map. Nao foram encontrados `sessionStorage`, IndexedDB, Cache Storage, cookies, URL/query/hash para estado de plano, telemetry, analytics, `console.*`, `fetch` ou beacon em `src/`. Blob de exportacao, importacao JSON e clipboard sao superficies locais separadas.

## Three distinct concepts

Estes conceitos nao sao intercambiaveis:

| Conceito | Papel | Propriedade |
| --- | --- | --- |
| **Canonical Vault Identity** | `vaultPlanIdentity` atual | Identidade de produto/Bitcoin atual; inclui tpub e, em V2, origin. |
| **Historical Identity Commitment** | hash experimental X1A | Binding/integrity condicionais quando o digest original e confiavel; nao autentica sozinho candidate totalmente substituido. |
| **Local Persistence Instance ID** | chave local para archive, hidden e UI | Nao e identidade canonica nem commitment historico; identifica apenas uma instancia persistida naquele browser. |

O historical commitment nao revela diretamente a tpub, mas seu preimage experimental inclui tpub/origin. Ele e um token estavel de correlacao entre copias da mesma identity: quem ja conhece uma candidata tpub/origin pode testá-la offline contra o digest. Ele nao e segredo, nem exposicao equivalente a tpub.

## Deterministic local-reference aliasing

O primeiro candidate X2A usava SHA256 de domain separator, policyVersion, rede, unlock height e `outputScript #0`. X2A reproduziu a limitacao X1A:

```text
Plan A: tpub fixture + m/44'/1'/0'
Plan B: mesma tpub + m/84'/1'/0'
```

Ambos sao estruturalmente aceitos para a descendant tpub: depth tres e ultimo child `0'` coincidem. Os resultados observados foram:

| Propriedade | A vs B |
| --- | --- |
| `outputScript #0` | igual |
| todos os outputScripts emitidos | iguais |
| `vaultPlanIdentity` | diferente |
| `historicalIdentityCommitment` | diferente |
| reference output-only antigo | igual |

Consequentemente, archive e hidden indexados por essa reference poderiam ser aplicados aos dois planos. Isto e **LOCAL-REFERENCE ALIASING**, uma colisao semantica do identificador local escolhido, nao colisao Bitcoin, SHA256 ou de outputs.

## Candidate state and local instance ID

O candidate persistido X2A agora contem somente:

```text
format + experiment marker
policyVersion, network, unlockHeight, label, derivation, keyOrigin
historicalIdentityCommitment
lastIssuedIndex
issuedOutputs: [{ index, outputScript }]
localInstanceId: random UUID
archivedPlanInstanceIds / hiddenDepositIndexes keyed by localInstanceId
```

Cada output e apenas o P2WSH v0 `0x00 0x20 <32-byte SHA256(witnessScript)>`. O JSON nao contem tpub, `vaultPlanIdentity`, child public key, witness script, seed, mnemonic, WIF, xprv ou tprv. `network + outputScript` continuam suficientes para o input xpubless de discovery X1B.

`localInstanceId` e UUID aleatorio gerado pela API criptografica do ambiente de pesquisa (`randomUUID`; equivalente conceitual de Web Crypto no browser). Ele permanece estavel enquanto aquela instancia serializada existe: restart, archive, hidden, reconnect, troca de label e emissao de `#4` preservam o mesmo ID. Duas instancias A/B recebem IDs distintos mesmo quando seus output commitments coincidem.

## Local-ID options

| Opcao | Aliasing A/B | Emissao / label | Export/import e reimport | Dedupe | Privacidade/correlacao |
| --- | --- | --- | --- | --- | --- |
| 1. Hash de `outputScript #0` | Falha: A/B fazem alias. | Estavel. | Deterministico, reaparece em outra copia. | Pode agrupar casos semanticamente distintos. | Token deterministico ligado ao output. |
| 2. Hash incluindo historical commitment | Evita o alias A/B enquanto commitment original for preservado. | Estavel. | Reproduzivel em import. | Pode ser sinal experimental de dedupe. | Forte correlator; nao autentica candidate reescrito. |
| 3. UUID aleatorio por instancia local | Evita alias A/B no mesmo browser. | Estavel enquanto persistido. | Nova importacao pode criar novo ID. | Nao resolve dedupe. | Correlaciona apenas entries locais que usam o mesmo UUID. |

Para **associar archive/hidden/UI**, X2A recomenda apenas para pesquisa a opcao 3: `localInstanceId` opaco aleatorio. Ela modela corretamente "same local instance", nao "same Bitcoin plan". A opcao 2 pode ser avaliada separadamente como sinal de deduplicacao, mas historical commitment nao deve ser rebatizado como autenticacao. Nenhuma politica de dedupe foi implementada.

## Restart and reconnect

Depois do restart sem tpub, o candidate ainda lista label/rede/unlock, emissao `#0..#3`, commitments, archive, hidden e input `index + outputScript` de X1B. Ele falha explicitamente ao tentar derivar `#4`, recuperar `P_i`, reconstruir witness script, calcular identity canonica ou preparar gasto completo.

Com tpub/origin corretas reapresentadas em memoria, o prototype reconstroi V2, compara commitments e historical commitment, recupera a mesma `vaultPlanIdentity`, emite `#4` e reserializa somente o novo output commitment. Uma tpub publica valida errada falha pelos commitments. A identidade historica continua dependente de uma trust anchor externa para resistir a candidate totalmente reescrito.

State stale continua limitacao: candidate `#0..#3` nao conhece `#4` emitido em outro contexto. Sem tpub persistida, ele exige candidate atualizado ou reconnect com politica futura explicita; X2A nao implementa gap scanning.

## Migration model: crash-safe, idempotent, fail-closed

LocalStorage nao oferece transacao multi-key. Portanto a meta **nao e atomic migration** entre candidate, v3, v2, archive e hidden. A meta e **crash-safe + idempotent + fail-closed**:

```text
1. read + validate old v3/v2 state
2. construct candidate in memory
3. write research candidate
4. read back + validate it
5. rewrite archive/hidden under localInstanceId
6. remove old v3/v2/archive/hidden keys
7. verify no known tpub-bearing entry remains
```

O prototype usa storage em memoria e nomes research-only. Ele testa v2 e v3 coexistindo com o mesmo plano, archive e hidden. Depois do sucesso ficam somente a entry research xpubless; v2, v3 e preferencias antigas foram removidas. O inventario final confirma ausencia da tpub fixture, `vaultPlanIdentity`, child public keys e witness scripts. Permanecem output commitments, origin publica, historical commitment, local instance ID e preferencias.

Crash foi injetado apos cada fase 1..6. Reexecutar a migracao conclui sem perder candidate valido. Antes da fase 6, as keys antigas continuam; duplicidade temporaria e exposicao de tpub sao esperadas. Se crash ocorrer apos cleanup, rerun continua seguro. A operacao nao declara sucesso no-tpub enquanto qualquer key antiga existir.

O teste tambem corrompe a nova entry depois da escrita e antes do cleanup. O read-back falha e v2/v3 permanecem para recovery. Em outro caso, a remocao de v2 falha: o candidate valido fica junto de estado antigo, a migracao falha explicitamente como incompleta e um rerun conclui a limpeza. Isso prova somente o modelo em memoria, nao garantias do browser real, UI ou formato de producao.

## Limits, privacy and V1

No durable tpub **nao** significa estado privado. OutputScripts agrupados continuam correlacionaveis; historical commitment tambem e correlator; UUID pode correlacionar entries da mesma instancia local. O browser tambem nao garante zeroizacao de strings, React state, heap GC, DevTools, crash dumps ou extensoes. O objetivo e **MINIMIZE DURABLE PERSISTENCE**, nao apagamento comprovado de RAM.

Uma representacao V1 somente para watch commitments e hipotese separada. V1 nao tem origin publica historica legitima para pedir/autenticar fonte reapresentada. **Full rehydration V1: NOT PROVEN.**

## Decision

- **X2A principal: A - FEASIBLE FOR XPUBLESS PERSISTENT WATCH STATE**, limitado ao candidate V2 offline.
- **FULL VAULT REHYDRATION AFTER WALLET RECONNECT: PROVEN**, para a fixture V2 publica e commitments testados; nao prova V1, mainnet, autenticacao independente ou discovery stale.
- **LOCAL PERSISTENCE ID ISOLATION: PROVEN**, no modelo de UUID local aleatorio; a reference output-only deterministica foi refutada por aliasing A/B.
- **MIGRATION CRASH-SAFETY MODEL: PROVEN IN RESEARCH**, somente para storage em memoria, com rerun, candidate corrompido e remove failure. Nao e transacao multi-key nem implementacao de produto.

Nenhuma mudanca de producao e recomendada. Dedupe, UX de reconnect, trust anchor, migracao real de localStorage e regras de recovery permanecem pesquisa futura.
