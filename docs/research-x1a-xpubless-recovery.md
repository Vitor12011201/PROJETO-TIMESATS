# Pesquisa X1A - Reduced-Xpub / Xpubless Recovery Offline Feasibility

## Goal

**RESEARCH EXPERIMENT.** X1A pergunta se um artefato de recovery de longa duracao pode identificar e verificar todos os outputs ja emitidos de um `VaultPlan` sem reter permanentemente a `tpub`, child public keys, `witnessScript` com essas chaves, ou qualquer material privado.

Isto nao altera o recovery atual, Policy V1/V2, scripts Bitcoin, PSBT, derivacao, schema de producao ou proibicao de mainnet. O candidate existe somente no script `scripts/research-x1a-xpubless-recovery.ts`; nao usa `timesats-vault-plan`, nao e uma nova versao de recovery e nao e uma Policy V3.

## Current recovery exposure

**CONFIRMED CURRENT BEHAVIOR.** O recovery atual de `VaultPlan` preserva policy publica, metadata e `lastIssuedIndex`. Para V2, a policy inclui `tpub`, `masterFingerprint` e `sourcePath`. A `tpub` permite derivar a familia nao-hardened abaixo do no exportado, inclusive a branch relativa TimeSats `m/<index>`.

Essa propriedade permite recomputar outputs novos ate `lastIssuedIndex` a partir de uma copia do recovery. Tambem deixa o material de observacao/public-key exposto pelo tempo em que o recovery for guardado. X1A testa somente a reducao desta exposicao causada pelo proprio artefato; nao remove copias da tpub em wallet, descriptor, localStorage, PSBT, screenshot, backup ou qualquer outro canal.

## Candidate format

O candidate local do experimento tem o marcador inequívoco:

```text
format: "timesats-research-x1a-reduced-xpub-recovery"
experiment: "X1A"
```

Para Policy V2 ele contem:

```text
network
policyVersion: 2
unlockHeight
derivation: { pathTemplate: "m/<index>", hardened: false }
keyOrigin: { masterFingerprint, sourcePath }
historicalIdentityCommitment: "sha256..."
lastIssuedIndex
issuedOutputs: [
  { index: 0, outputScript: "0020..." },
  ...,
  { index: N, outputScript: "0020..." }
]
```

`issuedOutputs` e estritamente ordenado e contiguo: deve conter exatamente `#0` ate `#lastIssuedIndex`. Cada `outputScript` e um P2WSH v0 `OP_0 <SHA256(witnessScript)>`, validado no prototype como `0020` seguido de 32 bytes hexadecimais.

`historicalIdentityCommitment` e uma investigacao adicional de X1A, nao um campo de produto. O prototype aplica SHA256 a uma representacao JSON manualmente ordenada, com domain-separation tag, de `policyVersion`, rede, unlock height, tipo e valor da fonte publica, key origin e derivacao. Ele nao usa simplesmente `SHA256(vaultPlanIdentity())`: a string de identidade atual e uma API de produto, enquanto este preimage experimental precisa declarar de forma explicita seu dominio e os campos comprometidos.

Terminologia X1A: esse commitment fornece **binding** e **integrity checking** condicionais. Se o digest original for preservado, uma combinacao diferente de tpub/origin nao deve recompor o mesmo commitment; corrupcao ou adulteracao parcial tambem e detectada quando o digest original nao foi substituido. Ele nao fornece, sozinho, autenticacao independente do candidate, recovery autenticado, backup tamper-proof ou qualquer garantia equivalente.

## Why outputScript differs from public-key exposure

`outputScript` P2WSH e um commitment de hash do `witnessScript`. Ele nao contem diretamente `P_i`, o `witnessScript` que inclui `P_i`, nem a `tpub` que deriva a familia. Portanto, sob este threat model, guardar o commitment nao equivale a guardar esses materiais de public key.

Isso e somente reducao de long-exposure de public-key material no artefato X1A. Nao e post-quantum spend security, quantum resistance, future-proofing, nem afirmacao de que uma preimage SHA256 nunca sera encontrada. Tambem nao protege qualquer tpub ou witness script ja divulgado fora do candidate.

## V2 feasibility

**EXPERIMENT RESULT.** Policy V2 e viavel para esta prova offline. Ela ja possui `masterFingerprint` e `sourcePath` publicos legitimos; ao reapresentar a `tpub`, a wallet/signer informa novamente a fonte publica da qual cada child relativo `m/<index>` e derivado. O prototype usa a facade publica do TimeSats para:

1. criar um plano V2 da fixture publica existente;
2. emitir `#0` ate `#3`;
3. derivar os outputs existentes;
4. gravar somente os commitments no candidate;
5. criar de novo o plano com a `tpub` reapresentada;
6. derivar `#0..#3` e comparar cada `outputScript` byte por byte;
7. comparar a `vaultPlanIdentity` reidratada com a identidade historica.

O candidate sozinho nao calcula a `vaultPlanIdentity` atual: a identidade atual inclui a `tpub`, que X1A deliberadamente nao armazena. Isso e uma limitacao esperada, nao uma divergencia de identidade.

## V1 limitation

**RESEARCH FINDING.** V1 nao e incluida no candidate. A Policy V1 historica nao conserva a mesma origem BIP32 publica legitima (`masterFingerprint` e `sourcePath`) que V2 conserva. Sem `tpub` e sem contexto externo adicional confiavel, X1A nao consegue pedir de maneira independente uma fonte publica especifica nem provar que uma fonte reapresentada corresponde a uma origem V1 historica.

Nao foi inventado `sourcePath` retroativo, nao houve conversao V1 para V2 e nenhum bundle V1 foi modificado. Uma recuperacao V1 reduced-xpub exigiria pesquisa separada e dados externos adicionais; X1A nao afirma que ela seja confiavel.

## Rehydration protocol

O protocolo experimental e:

1. validar estritamente marker, rede permitida, Policy V2, origem, `lastIssuedIndex`, `outputScript` e sequencia contigua;
2. receber da wallet/signer a `tpub` e a origem publica V2, sem receber chave privada;
3. exigir que a origem reapresentada corresponda aos campos do candidate;
4. recriar o plano com a facade publica TimeSats e emitir em memoria ate `lastIssuedIndex`;
5. comparar cada `outputScript` derivado com seu commitment correspondente;
6. aceitar apenas se todos coincidirem; depois da tpub correta, comparar a identidade historica.

Um candidate correto mais uma `tpub` publica sintaticamente valida, mas diferente, falha pela comparacao de commitments. O teste nao depende apenas de fingerprint: a tpub adversarial tem depth/index compativeis com a origem declarada e e valida como extended public key, mas seus outputs derivados nao batem.

## Historical identity and key origin

**CONFIRMED CURRENT BEHAVIOR.** A validacao atual de V2 verifica apenas o que uma `tpub` pode provar localmente:

- para uma root tpub (`depth = 0`, `sourcePath = m`), verifica depth zero e exige que `masterFingerprint` seja os primeiros quatro bytes de HASH160 da compressed root public key;
- para uma descendant tpub (`depth > 0`), verifica que o numero de componentes de `sourcePath` coincide com depth e que o ultimo componente, incluindo hardened bit, coincide com o child number serializado na tpub.

Uma descendant tpub nao fornece os ancestor public keys. Portanto ela nao prova `masterFingerprint`, `parentFingerprint` nem os componentes anteriores de `sourcePath`. A validacao atual nao finge fazer essas comparacoes.

**EXPERIMENT RESULT.** Com a mesma tpub V2 correta, X1A alterou somente `masterFingerprint` para outro hex de quatro bytes e, separadamente, trocou `m/44'/1'/0'` por `m/84'/1'/0'`. Ambos os caminhos preservam depth tres e ultimo child hardened `0'`. Em ambos os casos:

1. o schema experimental aceita a forma estrutural;
2. o parser de `VaultPlan` aceita a tpub descendant com essa origem estruturalmente compativel;
3. os `outputScript`s derivados continuam exatamente iguais, pois a derivacao TimeSats e relativa a tpub em `m/<index>`;
4. `vaultPlanIdentity` muda, porque V2 inclui fingerprint e `sourcePath`.

Logo, **output commitment verification proves output reconstruction, but does not by itself authenticate every historical V2 key-origin field.** A reidratacao pratica X1A primeiro exige que a origem apresentada seja igual a do candidate; isso impede uma discrepancia acidental entre os dois inputs, mas nao autentica retrospectivamente o campo que ja estava gravado no candidate.

O `historicalIdentityCommitment` experimental faz a reidratacao falhar para cada uma dessas alteracoes quando o commitment original permanece intacto. Ele fornece binding entre a combinacao reapresentada e esse digest, e integrity checking contra corrupcao ou adulteracao parcial. Ele nao autentica um candidate que um atacante possa reescrever por inteiro, inclusive recomputando seu hash.

### Open trust-anchor question

Autenticacao contra reescrita integral exigiria uma ancora independente do candidate. Hipoteses conceituais incluem segunda copia do digest, midia fisica, assinatura, secret/MAC, commitment externo ou outro mecanismo verificavel. Nenhuma e implementada ou escolhida por X1A. Cada uma acrescenta requisito de backup, trust, gerenciamento de segredo ou dependencia externa; essa decisao pertence a pesquisa posterior.

SHA256 oferece compromisso de preimage/collision sob as premissas criptograficas atuais; sob o modelo idealizado de Grover, sua margem de preimage tambem exige revisao. O hash nao e claim de seguranca pos-quantica. Guardar esse hash tambem pode permitir testar offline se uma tpub conhecida corresponde ao candidate, portanto e um dado de correlacao, nao uma solucao de privacidade.

## Negative cases

O prototype falha fechado para:

- `outputScript` alterado;
- indice duplicado;
- indice ausente;
- indice extra;
- ordem fora da sequencia `#0..#N`;
- `lastIssuedIndex` incoerente com a lista;
- `mainnet` ou rede fora da allowlist;
- `policyVersion` diferente de 2;
- tpub reapresentada que nao recompõe commitments.

O JSON serializado e auditado contra valores reais da fixture: ele nao contem a tpub de entrada, nem qualquer `publicKey` filha ou `witnessScript` derivado. O schema tambem proibe estruturalmente campos como `extendedPublicKey`, `publicKey`, `witnessScript`, chave privada, seed, mnemonic, WIF, xprv e tprv.

## Stale-backup problem

**EXPERIMENT RESULT.** Um candidate criado em `lastIssuedIndex = 3` continua valido para `#0..#3`, mas nao conhece `#4` e `#5` emitidos depois. O prototype emite esses dois depositos no plano original e prova que o candidate antigo ainda reidrata somente ate `#3`.

Backup desatualizado nao e exclusivo do candidate X1A. O recovery atual tambem conserva `lastIssuedIndex`, e sua documentacao ja exige novo export depois de cada emissao: uma tpub com indice registrado antigo nao garante discovery de indices posteriores. Uma futura ferramenta poderia pesquisar uma faixa maior com a tpub, mas gap scanning nao faz parte da garantia nem da implementacao atual.

A diferenca e estrutural. O recovery atual ainda possui a tpub, portanto conserva a capacidade matematica de derivar filhos futuros caso uma ferramenta/politica futura escolha uma faixa. O candidate X1A nao possui tpub nem commitments `#4/#5`; dentro do proprio artefato nao ha informacao para reconstruir outputs desconhecidos. Cada emissao nova exige atualizar a lista de commitments. A perda de completude no candidate explicito e mais rigida, mesmo que ambos sofram risco operacional de backup stale.

Preferencias locais de UI nao alteram essa regra: archive de plano e hidden deposits nao entram no candidate. Se um indice foi emitido, o candidate deve registrar seu commitment independentemente de estar visivel ou oculto na interface.

## Size and privacy trade-offs

O candidate tem um `outputScript` por deposito emitido. Seu tamanho e, portanto, O(N). O prototype mediu o JSON serializado com o mesmo header V2 e commitments P2WSH:

| Outputs emitidos | Bytes serializados |
| --- | ---: |
| 1 | 497 |
| 10 | 1.379 |
| 100 | 10.290 |
| 1.000 | 100.291 |

Estes numeros sao somente medicao desta serializacao experimental; nao sao limite de produto, nem justificam otimizar com Merkle tree ou outro desenho nesta fase.

Reduced-key-exposure nao significa recovery privado. Quem obtiver o candidate recebe uma lista agrupada de todos os `outputScript`s explicitamente salvos e pode correlaciona-los entre si, procura-los on-chain e monitorar funding/spending por infraestrutura externa. A tpub expoe a familia nao-hardened e pode derivar filhos futuros; a lista de outputs expoe somente o conjunto salvo, mas agrupa esse conjunto. Ambos sao trade-offs de privacidade distintos.

Nao foi adicionado endereco redundante. Para o objetivo X1A, `network + outputScript` identifica o commitment P2WSH e permite futura apresentacao ou pesquisa. Duplicar endereco cria outro campo derivado que pode ficar stale sem aumentar a prova de commitment.

## Discovery limitations

O candidate preserva `outputScript` exato e, em memoria, poderia ser expresso como `raw(<outputScript>)`. Isso parece um **candidate for future watch-only discovery research**, mas X1A nao importou descriptor, nao fez rescan e nao executou Bitcoin Core. Nenhuma compatibilidade watch-only e alegada nesta fase.

O proximo experimento recomendado e **X1B - Bitcoin Core watch-only discovery from xpubless output commitments**, em Regtest isolado, para verificar importacao e discovery reais a partir desses commitments.

## Comparison of recovery designs

| Desenho | Recuperabilidade | Exposicao quantica/public-key pelo artefato | Atualizacao | Discovery | V1/V2 |
| --- | --- | --- | --- | --- | --- |
| A. Recovery atual com tpub | Reconstroi faixa ate `lastIssuedIndex`. | Family-wide: tpub deriva filhos nao-hardened do no. | Atualizar maior indice. | Ranged derivation disponivel. | V1 e V2 atuais. |
| B. X1A xpubless + outputScripts | Verifica somente commitments registrados apos reapresentar tpub. | Nao retem tpub, `P_i` ou witness script; retem commitments P2WSH. | Atualizar lista a cada emissao. | Nao comprovado; objeto de X1B. | V2 viavel; V1 nao demonstrada. |
| C. `raw(outputScript)` por deposito | Equivale a B para discovery por output exato. | Mesmo commitment do output, sem tpub. | Um descriptor novo por emissao. | Nao comprovado nesta fase. | Pode listar outputs, mas nao resolve origem V1. |
| D. Durable public recovery + watch material separado | Durable verifica commitments quando watch material e reapresentado. | Reduz a retencao no durable, nao em copias do watch material. | Commitments e material separado exigem governanca. | Depende de ferramenta futura. | V2 e o alvo inicial. |
| E. tpub criptografada separadamente | Depende do segredo/cifra e da longevidade do mecanismo. | Pode reduzir exposicao em repouso, nao se o segredo/cifra falhar ou a chave for divulgada. | Similar ao recovery atual. | Possivel apos decriptar. | Conceitual; nao implementado. |

## Quantum-security limits

X1A nao muda a seguranca de um UTXO, assinatura, CLTV ou migracao antes de `H`. Ele reduz somente a exposicao de public-key material causada pelo candidate quando comparado a reter uma tpub no mesmo artefato.

Ele nao ajuda se a fonte ja foi divulgada em outro backup, wallet export, localStorage, descriptor com public key, screenshot, PSBT ou servico externo. Nao oferece rescue quantico, nao resolve a armadilha de migracao por timelock e nao torna TimeSats quantum safe.

## Findings

- **F1 - Output reconstruction.** V2 mais tpub/origem reapresentadas reproduz exatamente os `outputScript`s emitidos; uma tpub publica valida errada falha contra os commitments.
- **F2 - Reduced exposure.** O candidate pode evitar guardar tpub, `P_i` e `witnessScript` diretamente, conservando somente commitments P2WSH por output.
- **F3 - Historical identity.** Commitments de output nao autenticam cada campo de origem historica de uma tpub descendant: fingerprint e ancestors de `sourcePath` podem mudar sem mudar outputs. O commitment de identidade experimental pode vincular a reapresentacao se o digest original for confiavel, mas nao autentica sozinho um arquivo totalmente reescrito.
- **F4 - Discovery.** Watch-only blockchain discovery a partir de commitments xpubless ainda nao foi provado.
- A emissao precisa ser tratada como sequencia contigua permanente; esconder UI nao pode omitir commitments.
- V1 nao possui origem publica historica suficiente para esta reidratacao independente sem pesquisa/contexto adicional.
- Backup stale afeta recovery atual e X1A; no candidate sem tpub, outputs ainda nao comprometidos nao podem ser reconstruidos internamente.
- A lista explicita cresce O(N) e divulga o conjunto agrupado de outputs salvos.

## Decision

**VERDICT: PARTIALLY FEASIBLE.** X1A prova a viabilidade offline para Policy V2 como candidate de reduced long-exposure: o artefato nao retem a tpub e valida reidratacao correta contra commitments P2WSH exatos. Ele nao e pronto para recovery oficial devido a stale backups, ausencia de discovery comprovado, limitacao V1, dependencia de reapresentacao da tpub/origem, autenticacao historica ainda sem trust anchor e crescimento O(N).

Nenhuma mudanca de produto e recomendada a partir deste experimento. O recovery atual continua sendo o unico formato suportado.

## Next experiment

**X1B - Bitcoin Core watch-only discovery from xpubless output commitments.** Em Regtest isolado, testar se `raw(<outputScript>)` ou equivalente pode ser importado por Bitcoin Core e localizar funding sem reintroduzir tpub, child pubkeys ou witness scripts no candidate durable.
