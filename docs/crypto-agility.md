# Especificacao de Crypto Agility do TimeSats

## Status e principio

**ESPECIFICACAO ARQUITETURAL.** Este documento define como policies criptograficas podem evoluir sem reescrever historia on-chain. Nao altera schemas, recovery, scripts, consenso, Policy V1/V2 ou a proibicao de mainnet.

Principio central:

```text
Cryptographic policy may evolve.
Existing on-chain policy semantics may not be silently rewritten.
```

V1 continua V1 e V2 continua V2. Construcao futura exige nova policy version e prova independente. Importar V1 nunca vira V3 por atualizacao de software, normalizacao ou migracao de JSON: o UTXO continua comprometido com seus bytes originais.

Niveis deste documento:

- **CONFIRMED CURRENT BEHAVIOR:** TimeSats/consenso existentes.
- **THREAT MODEL:** risco que exige governanca, sem confirmar ataque.
- **RESEARCH PROPOSAL:** caminho de estudo sem compromisso de produto.
- **DEPENDS ON FUTURE BITCOIN CONSENSUS:** ideia nao presumivel nas regras atuais.

## Imutabilidade de policy

Uma policy financiada e historicamente imutavel. Software posterior deve ser capaz de:

1. parsear a versao historica;
2. derivar depositos conforme especificacao original;
3. reconstruir e explicar recovery publico;
4. declarar deprecacao sem fingir equivalencia com policy nova.

"Deprecated for new plans" nunca significa "incompreensivel". Pode significar que TimeSats deixa de criar/recomendar policy, preservando parse e recovery. "Recovery only" tampouco promete que o UTXO seja gastavel sob consenso futuro.

## Dimensoes futuras de versionamento

**RESEARCH PROPOSAL.** Nova policy nao deve deixar dimensoes criptograficas relevantes implicitas. Sem mudar schemas hoje, uma especificacao futura deve identificar explicitamente:

| Dimensao | Motivo |
| --- | --- |
| `policyVersion` | Separa semantica, validacao e recovery historicos. |
| output construction | Distingue P2WSH de construcao futura e seu commitment. |
| signature scheme | Distingue ECDSA/secp256k1 de esquema futuro. |
| key derivation scheme | Evita supor BIP32/tpub apropriado para sempre. |
| hash/commitment scheme | Documenta o que protege script, ownership ou migracao. |
| migration scheme | Declara precondicoes e limites de migracao. |
| recovery format version | Permite reproduzir policy sem inferir campos ausentes. |
| lifecycle status | Separa criacao nova de dever de parse/recovery historico. |

Nenhum campo e adicionado agora. A ausencia atual nao autoriza heuristica retroativa para V1/V2.

## Lifecycle conceitual de policy

| Estado | Significado |
| --- | --- |
| `RESEARCH` | Hipotese sem API, funding ou claim de interop. |
| `EXPERIMENTAL` | Testada no escopo declarado, por exemplo Regtest, sem aprovacao para compromissos duraveis. |
| `SUPPORTED_FOR_NEW_PLANS` | Aprovada explicitamente para criacao em escopo/horizonte declarados. |
| `DEPRECATED_FOR_NEW_PLANS` | Ainda parseavel/reconstruivel, mas nao recomendada para planos novos. |
| `RECOVERY_ONLY` | Dados historicos interpretaveis; gasto/interop nao prometidos. |
| `UNSAFE_OR_PROTOCOL_RESTRICTED` | Risco ou regra futura impede recomendacao e pode limitar spend. |

Estes sao estados de governanca, nao campos atuais de `VaultPlan`. O estado muda documentacao, nao os bytes do UTXO.

## Principio de migracao criptografica

Objetivo desejado:

```text
OLD_CRYPTO + H
        ↓
NEW_CRYPTO + SAME_TEMPORAL_COMMITMENT
```

Nao:

```text
OLD_CRYPTO + H
        ↓
FREE SPEND BEFORE H
```

**THREAT MODEL.** Para UTXO ja confirmado, isso pode ser impossivel sob regras atuais: app novo nao muda witness script nem permite gastar antes de `H`. Mecanismo que alegue resolver o problema deve provar, para policy concreta, preservacao de `H`, ausencia de chave de gasto precoce e aceitacao pelo consenso relevante.

## Chaves de emergencia

Chave de emergencia comum que gaste antes de `H` conflita com TimeSats. Ela converte commitment unilateral de altura em escape antecipado. Isso vale para chave do usuario, empresa, guardian ou multisig de emergencia.

Tais desenhos podem reduzir um risco e introduzir coercao, roubo, custodia implicita, dependencia de disponibilidade ou enfraquecimento do commitment. Pesquisa futura nao e proibida, mas deve registrar a regressao de trust/commitment e nao chama-la equivalente a timelock estrito.

## Estrategias de pesquisa

Nenhuma estrategia abaixo esta implementada, ativada ou comprovada para TimeSats. "UTXO existente" significa proteger UTXO ja financiado sem capability previamente codificada; em geral, nao.

| Estrategia | Preserva H? | Consenso futuro? | Novo trust? | UTXO existente? | Protecao quantica? | Problemas |
| --- | --- | --- | --- | --- | --- |
| A. Status quo com horizonte menor | Sim; nao cria escape. | Nao. | Nao. | Nao migra. | Nao para UTXO ja criado. | Escolha de horizonte e Q desconhecido. |
| B. Segunda chave de emergencia | Nao, se puder gastar antes de H. Se tambem estiver subordinada a H, sim, mas nao antecipa migracao. | Nao para ECC; sim para nova assinatura. | Sim. | Nao retroativamente. | Nao necessariamente. | Early spend viola commitment; chave subordinada a H nao resolve trap. |
| C. Migracao pre-assinada | Para V1/V2 atuais, nao permite migrar antes de H. | Nao em principio; destino pode exigir. | Nao necessariamente. | Nao como solucao retroativa para V1/V2. | Nao resolve gasto antes de H. | CLTV esta no input antigo; fee, outpoint, relay e obsolescencia. |
| D. P2MR ou leaf PQ futuro | Pode, se leaf preservar H. | Sim. | Nao por si. | Nao para P2WSH confirmado. | P2MR mira longa exposicao; curta requer assinatura PQ. | BIP360 Draft; ativacao, tamanho, custo e signer. |
| E. Covenant-like preservando H | Objetivo e sim. | Provavelmente. | Depende. | Nao sem capability previa ou mudanca que a alcance. | Talvez com verificacao PQ. | Consenso, DoS, interop e prova de nao-escape. |
| F. Hash/commit-reveal ownership | Objetivo e sim. | Sim ou equivalente. | Idealmente nao. | Nao demonstrado para scripts atuais. | Hipotetica assimetria antes da public key. | Ownership, front-running, replay, reveal, consenso e perda de assimetria por material divulgado. |

[BIP 360 - P2MR](https://bips.dev/360/) e **Draft**, nao consenso ativado. [BIP 361](https://bips.dev/361/) e Draft informacional de migracao/sunset e requer BIP PQ a definir. Nenhum permite afirmar que Bitcoin "vai usar" essa opcao.

### Limites explicitos de B e C

Se a segunda chave de emergencia puder gastar antes de `H`, ela **nao preserva** o commitment temporal. Se tambem estiver subordinada a `H`, ela preserva `H`, mas **nao resolve** a necessidade de migracao antecipada.

Nas Policies V1/V2 atuais, CLTV esta no input que seria gasto. Portanto uma transacao pre-assinada nao consegue migrar o UTXO antes de `H`: mesmo que seu output novo preserve `H`, o input antigo continua impossivel de gastar antes de `H`. Pre-signing pode continuar como pesquisa para outras constructions, mas nao e solucao retroativa para V1/V2. Capability alternativa teria de ser codificada antes do funding, ou mudanca futura de consenso teria de criar outro mecanismo.

## Recovery e crypto agility

**CONFIRMED CURRENT BEHAVIOR.** Recovery atual conserva policy publica, metadata e `lastIssuedIndex`; reconstrui V1/V2 sem chave privada. V2 inclui tpub e origem publica.

**RESEARCH PROPOSAL.** Recovery de longa duracao deve reconstruir policy historica sem site, empresa, GitHub ou frontend atual. Investigar separacao entre:

- **durable policy recovery:** versao, rede, `H`, construcao, derivacao, commitments/outputs, maior indice e checksums;
- **quantum-sensitive watch material:** tpub/xpub e dados que derivam/correlacionam familia de public keys.

Essa separacao nao pode reduzir recuperabilidade sem provar discovery e verificacao. Ela tambem nao pode apenas remover a `tpub` e armazenar permanentemente `P_i`, `witnessScript` contendo `P_i` ou equivalente que revele diretamente as mesmas public keys: isso pode anular a reducao de longa exposicao.

O experimento **xpubless / reduced-xpub-exposure recovery** deve preferir commitments duraveis, como `scriptPubKey`/`outputScript` P2WSH ou equivalente. Durante recovery, signer/wallet pode reapresentar material publico e um TimeSats experimental pode verificar se ele recompõe exatamente os commitments salvos. Isto e somente hipotese de pesquisa; nao altera recovery atual nem transforma backup de signer em dado recebido pelo TimeSats. Perguntas abertas: discovery, verificacao da fonte, gaps, checksums, privacidade e compatibilidade V1/V2.

## Agilidade de signer

Interop de signer e propriedade de policy/version, nao de marca de hardware. As provas atuais sao somente Policy V2 em Regtest: Bitcoin Core descriptor wallet e Jade em QEMU. Policy PQ, P2MR ou outra exigira vetores, PSBT/encoding, validacao de retorno nao confiavel, harness de consenso e prova independente por signer. Nao ha compatibilidade generica implicita.

## Gate de crypto agility para mainnet

**MAINNET BLOCKER.** Antes de mainnet, revisar e publicar:

- lista de policies suportadas e limites declarados;
- processo de deprecacao sem apagar parse/recovery historico;
- monitoramento de mudancas criptograficas e de consenso;
- politica de revisao de horizonte maximo sem numero magico;
- longevidade/verificacao de recovery;
- matriz de interoperabilidade de signer por policy/version;
- revisao de exposicao de public key e tpub/xpub;
- plano de resposta a mudanca de protocolo para UTXOs bloqueados;
- prova de que rota de emergencia nao viola commitment sem decisao explicita do usuario.

## Modelo de horizonte de lock

```text
L = horizonte do lock
M = janela esperada de migracao operacional/protocolo
Q = horizonte conservador de ameaca criptografica
```

TimeSats precisa de margem para reagir antes de `H`, mas `Q` e desconhecido e pode mudar antes de consenso, software e signer de migracao existirem. Isto nao produz garantia matematica nem maximo universal. Exposicoes de 6 meses, 1, 2, 5, 10 e 20 anos crescem progressivamente; nenhum numero e magicamente seguro.

## Hash-based migration commitment: pesquisa posterior

**HYPOTHESIS - DEPENDS ON FUTURE BITCOIN CONSENSUS.** Pesquisar commitments hash/commit-reveal, por vezes associados a variantes chamadas Guy Fawkes/Fawkescoin, sob requisitos: nao autorizar early spend antes de `H`; nao criar chave de empresa/guardian/signer interno; nao introduzir private key no TimeSats; explicar ownership/migracao; resistir a front-running, replay e reveal precoce; e depender de proposta/ambiente de consenso verificavel. Qualquer ownership asymmetry pode ser enfraquecida ou eliminada se o material que deveria permanecer desconhecido ja tiver sido divulgado por `tpub`, `witnessScript`, backup, descriptor ou outro canal.

Bitcoin atual nao oferece rescue para UTXO TimeSats por causa desta especificacao. Nao ha novo script, `OP_DROP`, Policy V3 ou recovery nesta fase. Experimento futuro deve ser Regtest isolado e comecar por especificacao de consenso, nao promessa de produto.

## Referencias externas

Consulta/status: 2026-08-29.

| Fonte | Layer | Type | Status e limite para TimeSats |
| --- | --- | --- | --- |
| [BIP 32](https://bips.dev/32/) | Applications | Informational | Deployed; extended public key e derivacao nao-hardened, nao consenso. |
| [BIP 65](https://bips.dev/65/) | Consensus (soft fork) | Specification | Deployed; CLTV atual. |
| [BIP 141](https://bips.dev/141/) | Consensus (soft fork) | Specification | Deployed; commitment P2WSH. |
| [BIP 174](https://bips.dev/174/) | Applications | Specification | Deployed; formato PSBT, nao consenso. |
| [BIP 360](https://bips.dev/360/) | Consensus (soft fork) | Specification | Draft; P2MR nao ativado nem implementado no TimeSats. |
| [BIP 361](https://bips.dev/361/) | Consensus (soft fork) | Informational | Draft; requires TBD Post Quantum Signature BIP; nao e consenso ativo. |
| [NIST FIPS 204](https://csrc.nist.gov/pubs/fips/204/final) | Padrao criptografico externo | FIPS | ML-DSA final em 2024; nao assinatura Bitcoin atual. |
| [NIST FIPS 205](https://csrc.nist.gov/pubs/fips/205/final) | Padrao criptografico externo | FIPS | SLH-DSA hash-based final em 2024; nao assinatura Bitcoin atual. |
