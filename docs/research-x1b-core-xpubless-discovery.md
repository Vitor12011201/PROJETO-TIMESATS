# Pesquisa X1B - Bitcoin Core Watch-Only Discovery From Xpubless Output Commitments

## Goal

**RESEARCH EXPERIMENT.** X1B testa se Bitcoin Core pode localizar e acompanhar outputs TimeSats ja emitidos usando somente commitments explicitos `index + outputScript`, sem entregar ao watcher a `tpub`, child public keys, `witnessScript`, `masterFingerprint` ou `sourcePath`.

Isto continua X1A. Nao transforma o candidate em recovery oficial, nao altera Policy V1/V2, scripts Bitcoin, PSBT, derivacao, identidade, recovery atual ou proibicao de mainnet. O escopo e somente discovery/tracking de commitments P2WSH em Bitcoin Core Regtest isolado.

## Environment

Execucao observada em 2026-08-30:

```text
Bitcoin Core version: 310100
subversion: /Satoshi:31.1.0/
chain: regtest
RPC port: 8500
P2P port: 8501
```

Esses resultados sao da execucao isolada acima, nao uma claim generica para outras versoes do Core, mainnet, wallets externas ou signers.

## Isolation

O harness usa `regtestHarnessPorts(...)`, `resolveHarnessExecutable(...)`, datadir temporario `timesats-regtest-x1b-*`, `-regtest`, `-server=1`, `-listen=0`, `-connect=0`, `-dnsseed=0`, `-discover=0` e portas RPC/P2P explicitas. O `finally` chama `stop` somente com aquele datadir/RPC, faz fallback apenas pelo PID do daemon criado por X1B e remove somente seu diretorio temporario.

Faixas existentes inspecionadas:

| Familia | Faixa |
| --- | --- |
| Jade QEMU research | `20000..39998` |
| PSBT Regtest | `40000..47999` |
| CLTV Regtest | `48000..55999` |
| Policy V2 Core signer | `56000..63999` |
| X1B | `8000..15999` |

X1B nao usa `18443`, `18444` ou `18445`, nem interage com a chain manual, Jade, Docker ou Next.

## X1A candidate input

O lado **research fixture / producer** cria Policy V2 publica com a facade TimeSats e emite `#0..#3`. O lado **xpubless watcher input** recebe somente:

```json
{ "index": 0, "outputScript": "0020..." }
```

O harness verifica estruturalmente que cada item do watcher tem somente esses dois campos. Ele compara os descriptors contra os valores reais conhecidos do produtor e rejeita qualquer ocorrencia de tpub, master fingerprint, source path, child public key ou witness script. Esses dados existem apenas no lado produtor para derivar a fixture; nao sao passados ao watcher.

## raw() descriptor construction

Para cada commitment, X1B pede ao próprio Core:

```text
getdescriptorinfo raw(<P2WSH outputScript hex>)
```

O descriptor canonicalizado tem a forma sanitizada:

```text
raw(<P2WSH outputScript hex>)#<core-checksum>
```

O P2WSH outputScript v0 e `0x00 0x20 <32-byte SHA256(witnessScript)>`; em hex, `0020` seguido de 64 caracteres hexadecimais. O descriptor recebe esse outputScript inteiro, nao o witness script e nao uma public key.

Checksum nao e implementado manualmente. O harness confere que cada descriptor canonicalizado/listado pelo watcher corresponde exatamente ao `outputScript` fornecido e nao inclui tpub, xpub, public key, witness script ou key origin.

## scantxoutset result

Antes de importar qualquer descriptor na wallet watcher, X1B financiou e confirmou `#0` e `#1`. `#2`, `#3` e um `outputScript` P2WSH valido de controle permaneceram sem funding.

`scantxoutset start` recebeu somente os quatro descriptors `raw(outputScript)` do candidate e o controle. Core encontrou exatamente `#0` e `#1`; o harness comparou txid, vout, valor em sats e scriptPubKey com os fundings produzidos. `#2`, `#3` e o controle nao apareceram.

Isso prova somente busca no conjunto UTXO atual. Nao e historico de transacoes nem evidencia de output ja gasto.

## Descriptor wallet result

Depois dos fundings, X1B criou wallet descriptor separada com `disable_private_keys = true`. `getwalletinfo` retornou:

```text
private_keys_enabled = false
descriptors = true
```

Os quatro raw descriptors foram importados com `timestamp: 0`, portanto o Core fez rescan que inclui blocos anteriores aos fundings. `listunspent` encontrou exatamente `#0` e `#1`, com os mesmos outpoints, valores e scripts. Os outputs nao financiados `#2/#3` nao apareceram.

Assim, nesta execucao, wallet descriptor watch-only e rescan recuperaram UTXOs historicamente confirmados antes da importacao, usando apenas commitments de output.

## Post-import monitoring

Depois da importacao/rescan, X1B financiou e confirmou `#2`. Sem entregar tpub ao watcher, `listunspent` passou a encontrar `#2`. Isto prova monitoramento futuro para outputs cujos raw descriptors ja estavam explicitamente importados.

## Watch-only signing negative

O watcher raw-only possui `private_keys_enabled = false`. A tentativa de `walletcreatefundedpsbt` com `#0` falhou como Core reportou que o input P2WSH preselecionado nao e solvable: o watcher conhece o output, mas nao possui o witness script.

Em seguida, X1B construiu um PSBT bare com o outpoint conhecido e chamou `walletprocesspsbt` na wallet watcher. Core nao adicionou `partialSig`, nao finalizou e retornou `complete = false`. Logo:

```text
discovery capability != spending capability
```

Nenhuma chave privada foi extraida, exibida ou persistida.

## Wrong-script negative

O scan incluiu um `raw()` para output P2WSH valido, mas diferente do candidate. Ele nao produziu falso positivo para os UTXOs `#0/#1`. O watcher recebeu somente os raw descriptors do candidate, nao o descriptor de controle.

## Spent-history result

**SUBVERDICT: NOT PROVEN.** X1B nao criou um spend historico P2WSH V2 antes da importacao. Fazer isso com seguranca exigiria duplicar uma parte material do harness signer V2 ou criar outra fixture de signer; para evitar private-material exposure e ampliar escopo, essa linha foi adiada para X1C.

Portanto, X1B nao afirma que `raw(outputScript)` em watch-only recupera contabilizacao, historico de wallet ou evidencia de output ja gasto. `scantxoutset` continua limitado ao conjunto UTXO atual; descriptor wallet com rescan tem comportamento de tracking/historico conforme capacidades reais do Core que ainda precisam ser testadas para spent outputs.

## Scalability observations

Sem criar milhares de transacoes, X1B derivou commitments deterministicamente, pediu ao Core a canonicalizacao de cada raw descriptor e executou `scantxoutset` contra a chain Regtest pequena.

| Outputs | JSON watcher input | Build ms | Canonicalizacao Core ms | Scan Core ms | Aceito |
| ---: | ---: | ---: | ---: | ---: | --- |
| 1 | 99 B | 2,16 | 5,72 | 5,02 | Sim |
| 10 | 981 B | 29,13 | 48,62 | 5,14 | Sim |
| 100 | 9.891 B | 239,42 | 480,30 | 5,99 | Sim |
| 1.000 | 99.891 B | 2.229,81 | 5.091,35 | 11,98 | Sim |

Todos os conjuntos foram aceitos pelo Core atual. Estes valores sao observacoes operacionais desta maquina e cadeia pequena; nao sao benchmark de producao, estimativa de mainnet, limite RPC ou previsao de rescan. A canonicalizacao individual dominou esta medicao porque cada descriptor usa uma chamada RPC separada.

## Stale-backup behavior

O watcher recebeu inicialmente apenas `#0..#3`. Depois, o produtor emitiu e financiou `#4`, sem atualizar a lista de raw descriptors. Nem `listunspent` da wallet watcher nem `scantxoutset` com o conjunto antigo encontrou `#4`.

Quando `raw(outputScript#4)` foi explicitamente canonicalizado e importado com rescan, `#4` passou a aparecer. Isto confirma em Core real o trade-off X1A: watcher xpubless nao descobre automaticamente outputs que nao foram incluídos na lista de commitments.

## Privacy consequences

O watcher X1B nao recebe tpub e nao pode derivar a familia nao-hardened nem filhos futuros. Ele recebe, contudo, a lista agrupada de `outputScript`s e pode correlacionar esses outputs, procurar funding e monitorar spend usando infraestrutura externa.

Um watcher com tpub pode derivar familia e futuros children. Um watcher raw-output ve somente o conjunto explicitamente fornecido, mas esse conjunto agrupado nao e privado. X1B demonstra reduced public-key exposure, nao recovery privado.

## Security claim boundary

X1B nao prova quantum resistance, post-quantum spending, crypto migration, readiness para mainnet, autenticacao historica de identity/keyOrigin, recovery V1 ou uma trust anchor para candidate. Ele nao transforma `historicalIdentityCommitment` em autenticacao independente.

**CURRENT UTXO DISCOVERY PROVEN IN THIS SCOPE:**

```text
candidate X1A
    -> explicit P2WSH outputScripts
    -> raw(outputScript) descriptors
    -> Bitcoin Core 31.1 Regtest isolado
    -> current UTXO discovery
```

O watcher recebe os outputScripts explicitamente fornecidos, sem tpub, child public keys, witnessScript, key origin ou material privado. Isso prova discovery capability, nao spending capability.

O limite continua estrito: X1B nao prova performance mainnet, versoes anteriores/futuras do Core, spent historical recovery, quantum resistance, V1 xpubless recovery, historical identity authentication ou migracao antes de `H`.

## Findings

- `raw(outputScript)` canonicalizado por Core e suficiente para `scantxoutset` localizar UTXOs atuais conhecidos.
- Wallet descriptor sem chaves privadas pode importar os mesmos raw descriptors, rescannar fundings anteriores e acompanhar fundings posteriores.
- Raw-only tracking nao entrega capacidade de assinatura nem torna o P2WSH solvable sem witness script.
- Outputs nao fornecidos, como stale `#4`, nao sao descobertos automaticamente.
- X1B nao prova spent-history discovery nem qualquer semantica para V1.

## Verdict

**VERDICT: A - PROVEN FOR CURRENT-UTXO DISCOVERY.** Para Bitcoin Core 31.1 em Regtest isolado, `scantxoutset` e wallet descriptor watch-only localizaram/acompanharam outputs atuais TimeSats V2 usando somente commitments `raw(outputScript)` sem tpub entregue ao watcher.

**SPENT-HISTORY SUBVERDICT: NOT PROVEN.** Essa questao permanece para experimento separado.

## Next experiment

**X1C - spent-output history from xpubless raw commitments.** Em Regtest isolado, definir uma fixture P2WSH V2 que seja gasta por signer externo Core sem expor chave privada, importar raw descriptor somente depois do spend e registrar exatamente o que Core fornece em historico, accounting e wallet rescan.
