# Pesquisa - Quantum Security Threat Model

## Status e escopo

**THREAT MODEL.** Este documento analisa obsolescencia criptografica e computadores quanticos criptograficamente relevantes (CRQC) para o TimeSats. Ele nao afirma que CRQC exista hoje, nao implementa solucao pos-quantica e nao muda consenso Bitcoin.

**CONFIRMED CURRENT BEHAVIOR.** TimeSats e Signet/Regtest only; mainnet continua proibida. As policies usam P2WSH v0, `OP_CHECKLOCKTIMEVERIFY` e `OP_CHECKSIG`; o signer e externo. Nada aqui declara seguranca para decadas ou orienta uso de BTC real.

O estado de propostas foi consultado em 2026-08-29. BIP em Draft e pesquisa externa nao sao consenso ativado nem suporte TimeSats.

## Modelo criptografico atual

**CONFIRMED CURRENT BEHAVIOR.** Cada deposito deriva public key comprimida secp256k1 `P_i` de uma `tpub` BIP32 testnet publica no caminho nao-hardened `m/i`. A private key nunca entra no TimeSats.

Policy V1:

```text
<H> OP_CHECKLOCKTIMEVERIFY OP_DROP <P_i> OP_CHECKSIG
```

Policy V2:

```text
<H> OP_CHECKLOCKTIMEVERIFY OP_VERIFY <P_i> OP_CHECKSIG
```

V2 preserva `tpub`, fingerprint mestre e `sourcePath`; o deposito usa `sourcePath/i`. V1 nao recebe origem inventada. Ambas sao P2WSH v0: `OP_0 <SHA256(witnessScript)>`. V1 e V2 nao sao byte-equivalentes, nao possuem o mesmo endereco e nunca podem ser convertidas silenciosamente.

O gasto usa PSBT v0/BIP174 com um input, uma saida, `SIGHASH_ALL`, `nLockTime = H` e `nSequence = 0xfffffffe`. TimeSats verifica funding contra script derivado, valida a resposta nao confiavel do signer e finaliza localmente. Recovery publico conserva policy, metadata e maior indice emitido para reconstruir scripts/enderecos.

Fontes atuais: [BIP 32](https://bips.dev/32/), [BIP 65](https://bips.dev/65/), [BIP 141](https://bips.dev/141/) e [BIP 174](https://bips.dev/174/).

## Primitivas quanticas

### Shor e secp256k1

**THREAT MODEL.** Um CRQC capaz de executar Shor contra secp256k1 poderia resolver o logaritmo discreto de public key ECDSA e obter a private key correspondente. Isso atinge `OP_CHECKSIG`. Nao basta dizer que "quantum quebra Bitcoin": capacidade pratica, custo, tempo de execucao e disponibilidade permanecem desconhecidos.

### Grover e hashes

**THREAT MODEL.** Grover da aceleracao quadratica idealizada para busca nao estruturada; nao equivale a Shor. Contra preimage SHA256, a ordem ideal cai de 2^256 para aproximadamente 2^128 consultas quanticas, sem tornar SHA256 trivial. O commitment P2WSH mantem margem substancial nesse modelo, mas custo, memoria, paralelizacao e alvo de seguranca exigem revisao independente.

ML-DSA e SLH-DSA sao padroes externos de assinatura pos-quantica do NIST, FIPS 204 e FIPS 205. Isso **nao** os torna opcodes, witness programs ou assinaturas aceitos pelo consenso Bitcoin atual. WOTS/Winternitz e outras assinaturas hash-based sao familias de pesquisa, nao capacidade TimeSats.

## Classes de exposicao de public key

| Classe | Descricao | Aplicacao TimeSats |
| --- | --- | --- |
| A. Diretamente on-chain | A chave esta no scriptPubKey ou dado on-chain persistente. | P2WSH nao publica `P_i` diretamente no scriptPubKey. |
| B. Atras de hash de script | O output compromete um script; a chave aparece no witness. | Esta e a propriedade P2WSH antes do gasto. |
| C. Derivavel de xpub/tpub | Material externo permite derivar familia de public keys. | `tpub` permite derivar todos os `P_i` nao-hardened. |
| D. Revelada ao gastar | A chave aparece no witness de spend. | Spend P2WSH revela `P_i` antes de confirmacao. |

### Analise P2WSH

**CONFIRMED CURRENT BEHAVIOR.** BIP141 define P2WSH como `0 <32-byte-hash>`; no gasto, witnessScript e hasheado com SHA256 e comparado ao commitment. Antes do witness, observador exclusivamente on-chain nao ve diretamente `P_i`.

**THREAT MODEL.** Isto e **on-chain public-key concealment**, nao post-quantum spend security, quantum resistance ou future-proofing. P2WSH continua ocultando a public key de um observador exclusivamente on-chain enquanto o `witnessScript` nao tiver sido revelado por outra fonte. O witness a revela na janela curta de mempool; essa propriedade por si so nao resolve uma corrida quantica de spend.

### Family-wide exposure versus per-deposit exposure

**FAMILY-WIDE EXPOSURE - tpub/xpub.** Uma `tpub` BIP32 exportada permite derivar a familia de public keys nao-hardened abaixo daquele no. Recovery, backup ou localStorage que contenham essa `tpub` carregam essa exposicao de familia.

**PER-DEPOSIT EXPOSURE - PSBT/reveal.** O PSBT atual pode expor dados do deposito especifico: public key filha via `witnessScript`, `witnessScript`, `witnessUtxo`, outpoint e, em V2, a metadata de origem publica do deposito. Ele nao contem necessariamente a `tpub` nem um global xpub; o PSBT V1 nao recebe `bip32Derivation` inventada. Revelar o witness em uma spend tambem e exposicao por deposito, nao exposicao automatica da familia inteira.

## Ameaca BIP32/tpub

**CONFIRMED CURRENT BEHAVIOR.** Extended public key BIP32 serializa version bytes, depth, parent fingerprint, child number, chain code de 32 bytes e public key comprimida de 33 bytes. Ela permite `CKDpub` para filhos nao-hardened; TimeSats usa isso em `m/<index>`.

**THREAT MODEL.** Uma `tpub` nao autoriza gasto sob ECDSA classica, mas nao e security-neutral para sempre. Ela correlaciona enderecos, revela public key e chain code e permite calcular filhos nao-hardened.

Se DLP secp256k1 se tornar praticamente quebravel e um atacante possuir a extended public key exportada `(K, chainCode)`, ele pode hipoteticamente recuperar a private key correspondente a `K`. Com esse `chainCode` ja publico, pode ao menos derivar os descendentes nao-hardened daquele no, incluindo a branch dedicada TimeSats `m/<index>`. Esse e o blast radius relevante para esta arquitetura: comeca no no BIP32 exportado e nos descendentes que podem ser derivados a partir dele.

Isto nao afirma revelacao automatica de ancestors hardened, sibling hardened branches, seed inteira ou toda a wallet. A `tpub` pode ser raiz ou descendente; o alcance depende do no efetivamente exportado. O TimeSats usa somente os descendentes nao-hardened da branch fornecida.

Classificacao desta fase: **nao secreta, sensivel para privacidade e sensivel para seguranca quantica**. Isso nao muda recovery nem terminologia atual; define a razao para reavaliar retencao/distribuicao em planos longos. `parentFingerprint` e fingerprint mestre sao identificadores publicos, nao segredos, e tpub descendente nao prova por si toda cadeia de ancestrais.

## Armadilha de migracao por timelock

**THREAT MODEL.**

```text
2030: UTXO TimeSats confirmado com unlock H em 2045.
2040: migracao criptografica Bitcoin torna-se crivel.
2040-2045: proprietario quer migrar.
```

Um UTXO sem CLTV pode migrar se rede e carteira permitirem. UTXO TimeSats pode permanecer impossivel de gastar antes de `H`: CLTV e consenso, nao configuracao da interface. Atualizar site, app, signer ou recovery nao reescreve policy confirmada. O lock que reduz decisoes de curto prazo pode bloquear resposta criptografica necessaria.

## Estados de ameaca quantica

Esta matriz e governanca, nao previsao nem gatilho automatico. "Parar" suspende criacao/recomendacao de novos planos; nao move UTXOs ja bloqueados.

| Estagio | Novos planos | UTXOs existentes, tpubs e scripts P2WSH | Usuarios elegiveis agora | Usuarios com H no futuro | Mitigacao e acoes a cessar |
| --- | --- | --- | --- | --- | --- |
| 0. Teorico | Somente Signet/Regtest; nao alegar resistencia quantica. | P2WSH fornece ocultacao on-chain enquanto o witness nao e revelado; tpub permanece sensivel. | Gastam pelas regras atuais. | Permanecem sob CLTV atual. | Cessar claims "quantum safe" e "future proof". |
| 1. Preocupacao crivel | Revisar horizonte; nao normalizar locks longos. | Inventariar tpub/recovery; ocultacao on-chain nao protege tpub vazada. | Podem migrar voluntariamente se houver destino suportado. | Nao podem migrar antes de H. | Cessar promessas de decadas; preparar governanca e inventario. |
| 2. CRQC aproximando | Suspender recomendacao de novos locks longos. | Reduzir divulgacao nova de tpub e revisar recovery; script escondido so oculta public key de observador on-chain sem outra fonte. | Migrar somente para construcao realmente suportada. | Continuam bloqueados; documentar explicitamente essa incapacidade. | Cessar planos que atravessem janela sem decisao de migracao. |
| 3. secp256k1 atacavel | Parar planos apenas ECDSA/secp256k1. | tpub e witness revelado viram risco; P2WSH pode continuar ocultando chave apenas on-chain ate reveal, sem oferecer seguranca PQ de spend. | Mover somente UTXO ja elegivel. | Podem ficar simultaneamente bloqueados e expostos se a tpub/script vazar. | Cessar novas derivacoes, divulgacao ampla e claims legados. |
| 4. Migracao em curso | Aceitar somente policy aprovada/testada. | UTXO legado pode ter janela/restricao definida pelo protocolo real. | Seguir processo de migracao real. | Exigem analise por policy, H e regra ativada; nenhum resgate automatico. | Cessar suposicoes de retrocompatibilidade. |
| 5. Pos-migracao | Policy legada fica deprecated/recovery-only conforme regra real. | Preservar parse/recovery, sem prometer spend. | Elegibilidade depende de regra vigente e policy original. | Mesmo depois de H, gasto pode ser restrito pelo protocolo. | Cessar criacao legada e ocultacao de limitacoes. |

## Failure modes

- **Q-001:** tpub divulgada torna-se spend-risk sob ECC quebrada.
- **Q-002:** timelock impede migracao criptografica de emergencia.
- **Q-003:** lock muito longo excede horizonte de planejamento criptografico.
- **Q-004:** policy legada nao pode ser atualizada silenciosamente.
- **Q-005:** Bitcoin futuro pode congelar/deprecar spends de assinatura legada.
- **Q-006:** race de curta exposicao apos witness revelar public key.
- **Q-007:** recovery sobrevive ao ecossistema sem manter interpretacao ou retencao segura de material de observacao.

Q-005 e hipotese de protocolo, nao comportamento atual.

## Garantias atuais e limites

**CONFIRMED CURRENT BEHAVIOR.** V1/V2 determinam P2WSH por deposito, requerem assinatura ECDSA derivada e impedem gasto antes de `H` por CLTV. V2 preserva origem BIP32 publica legitima para signer externo comprovado em Regtest. Recovery reconstrui policy publica; TimeSats nao recebe private key nem possui chave de empresa.

**NAO GARANTE.** V1/V2 nao sao "quantum resistant", "future proof" ou "safe for decades". Nenhuma oferece migracao antecipada, protecao pos-quantica, monitoramento de ameaca, resgate antes de `H`, compatibilidade mainnet ou suporte generico de hardware wallet.

## Implicacoes para mainnet

**MAINNET BLOCKER.** Antes de uso mainnet com locks materialmente longos, deve existir decisao explicita sobre migracao criptografica. Nao existe hoje rota TimeSats confirmada para mover UTXO CLTV antes de `H` sem enfraquecer o compromisso temporal. Esta pesquisa nao escolhe prazo maximo nem habilita mainnet.

## Proximas pesquisas, nao implementadas

### Xpubless / reduced-xpub-exposure recovery

**RESEARCH PROPOSAL.** Investigar se recuperacao independente por decadas pode evitar reter `tpub` capaz de derivar a familia inteira. O experimento nao deve apenas remover a `tpub` e guardar permanentemente `P_i`, `witnessScript` contendo `P_i` ou equivalente que revele diretamente as mesmas public keys: isso pode anular a reducao de longa exposicao.

Um modelo inicial deve preferir commitments duraveis, como `scriptPubKey`/`outputScript` P2WSH ou commitment equivalente, junto de policy version, rede, unlock, descricao de derivacao, maior indice e checksums. Durante recovery, signer/wallet pode reapresentar material publico; um TimeSats experimental verificaria se ele recompõe exatamente os commitments salvos. Isto e hipotese de pesquisa, nao alteracao do recovery atual. Perguntas abertas: discovery sem tpub, commitments suficientes, verificacao da wallet reapresentada, privacidade e compatibilidade V1/V2.

### Hash-based migration commitment

**HYPOTHESIS - DEPENDS ON FUTURE BITCOIN CONSENSUS.** Pesquisar commitment por hash, inerte sob regras atuais, que nao autorize gasto antes de `H`, nao pertença a empresa, nao exija private key no TimeSats e possa criar assimetria futura de ownership/migracao. Qualquer ownership asymmetry pode ser enfraquecida ou eliminada se o material que deveria permanecer desconhecido ja tiver sido divulgado por `tpub`, `witnessScript`, backup, descriptor ou outro canal. Isso nao afirma rescue em Bitcoin atual, nao adiciona `OP_DROP`, nao cria Policy V3 e nao e instrucao de funding.

## Referencias e status de propostas

Consulta/status: 2026-08-29.

| Fonte | Layer | Type | Status e limite para TimeSats |
| --- | --- | --- | --- |
| [BIP 32](https://bips.dev/32/) | Applications | Informational | Deployed; derivacao usada pelo TimeSats, nao consenso. |
| [BIP 65](https://bips.dev/65/) | Consensus (soft fork) | Specification | Deployed; CLTV atual. |
| [BIP 141](https://bips.dev/141/) | Consensus (soft fork) | Specification | Deployed; SegWit/P2WSH atual. |
| [BIP 174](https://bips.dev/174/) | Applications | Specification | Deployed; PSBT atual, nao consenso. |
| [BIP 360 - P2MR](https://bips.dev/360/) | Consensus (soft fork) | Specification | Draft; nao ativado e nao suportado. |
| [BIP 361](https://bips.dev/361/) | Consensus (soft fork) | Informational | Draft; requires TBD Post Quantum Signature BIP; nao ativado. |
| [NIST FIPS 204](https://csrc.nist.gov/pubs/fips/204/final) | Padrao criptografico externo | FIPS | ML-DSA final em 2024; nao e suporte Bitcoin. |
| [NIST FIPS 205](https://csrc.nist.gov/pubs/fips/205/final) | Padrao criptografico externo | FIPS | SLH-DSA final em 2024; nao e suporte Bitcoin. |
