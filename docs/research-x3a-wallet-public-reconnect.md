# Pesquisa X3A - Wallet Public Reconnect Contract

## Goal

**RESEARCH EXPERIMENT.** X3A testa um contrato minimo para uma wallet reapresentar somente material publico necessario para reidratar em memoria um `VaultPlan` V2 que foi persistido no modelo xpubless de X2A/X2B. O objetivo de UX futuro e "Reconectar wallet", nao pedir que a pessoa copie `tpub`, fingerprint ou path manualmente.

Isto nao altera `src/`, `ExternalSigner`, storage, recovery, `vaultPlanIdentity`, Policy V1/V2, scripts Bitcoin ou a proibicao de mainnet. O prototype e `scripts/research-x3a-wallet-public-reconnect.ts`; seus schemas com `timesats-research-x3a-*` sao somente pesquisa, nao formato oficial, policy, recovery ou API de produto.

## Architecture inspected

X3A leu:

- `src/bitcoin/external-contracts.ts`, `src/bitcoin/index.ts`, `src/bitcoin/vault-plan.ts`, `src/bitcoin/bip32.ts` e `src/domain/vault-plan.ts`;
- `scripts/research-x1a-xpubless-recovery.ts`, `scripts/research-x2a-xpubless-browser-state.ts` e `scripts/research-x2b-realistic-legacy-storage-migration.ts`;
- `docs/research-x1a-xpubless-recovery.md`, `docs/research-x2a-xpubless-browser-state.md` e `docs/research-x2b-realistic-legacy-storage-migration.md`;
- `docs/research-v0.5-jade.md`, `docs/bitcoin-core-signer.md`, `scripts/jade-public-info.py`, `scripts/regtest-jade-v2-research.ts`, `scripts/regtest-core-signer.ts`, `scripts/regtest-policy-v2-research.ts` e `scripts/regtest-harness.ts`.

## Separate contracts

**CONFIRMED CURRENT BEHAVIOR.** `ExternalSigner` e um limite de I/O para:

```text
unsigned PSBT -> signed PSBT
```

Sua resposta continua nao confiavel e precisa passar por `validateSignedVaultPsbt`. X3A nao altera, reutiliza ou amplia esse contrato.

X3A estuda outra capability explicita:

```text
xpubless persistent candidate
  -> PUBLIC_KEY_SOURCE request
  -> wallet public response
  -> local validation
  -> VaultPlan V2 somente em memoria
```

`PUBLIC_REHYDRATED` significa que material publico foi validado e que o plano existe somente na sessao. Nao significa chave privada, assinatura, PSBT assinado, autenticacao do dispositivo ou confianca fisica na wallet. Uma wallet pode oferecer `PUBLIC_KEY_SOURCE`, `PSBT_SIGNER`, ambos, ou apenas uma das capabilities; uma nao implica a outra.

## Candidate authority and contract

O candidate xpubless e a autoridade para `policyVersion: 2`, rede, unlock height `H`, derivacao `m/<index>`, `lastIssuedIndex`, output commitments, **master fingerprint e sourcePath historicos** e `historicalIdentityCommitment`. A wallet nao pode sugerir policy, outputs, regras temporais ou substituir o origin historico.

O request research-only e construido do candidate:

```text
format: timesats-research-x3a-wallet-public-reconnect-request
experiment: X3A
capability: PUBLIC_KEY_SOURCE
network: candidate.network
sourcePathHint: candidate.keyOrigin.sourcePath
```

A `sourcePathHint` e instrucao do candidate para o adapter: "obtenha a fonte publica deste path esperado". Ela nao e escolhida pela wallet.

A resposta minima research-only e estrita:

```text
format: timesats-research-x3a-wallet-public-reconnect-response
experiment: X3A
capability: PUBLIC_KEY_SOURCE
extendedPublicKey: tpub da source branch
```

Ela nao tem campos para origin, rede, `H`, policy version, derivacao, `lastIssuedIndex` ou outputs. Campos extras sao rejeitados. Isso reduz o risco de um adapter bug tentar injetar semantica de policy que pertence ao candidate.

Uma variante opcional pode ecoar `{ masterFingerprint, sourcePath }`. Esse echo e metadata nao confiavel do adapter: deve ser igual ao candidate, pode ajudar diagnostico ou interoperabilidade, e **nao acrescenta autenticacao historica independente**. O contrato minimo nao precisa desse echo.

O candidate usado pelo prototype contem somente V2, rede, `H`, label, derivacao, origin publico, historical commitment, `lastIssuedIndex` e `#0..#N` como `index + P2WSH outputScript`. Ele nao persiste `tpub`, `vaultPlanIdentity` atual, `P_i`, witness script ou material privado.

## Reconnect proof

Para fixture V2 publica com `#0..#3`, X3A:

1. cria e serializa o candidate sem a tpub;
2. recria request de `PUBLIC_KEY_SOURCE`;
3. recebe a resposta publica correta;
4. usa o origin historico do candidate e aplica a validacao real atual de V2 (`createVaultPlan` e parser de tpub/origin);
5. deriva `#0..#3` e compara todo `outputScript` byte a byte;
6. compara `historicalIdentityCommitment`;
7. recupera exatamente a `vaultPlanIdentity` canonica em memoria;
8. entra em `PUBLIC_REHYDRATED`.

O adapter e sempre nao confiavel. A alegacao "esta e sua wallet" nunca basta: TimeSats deve recomputar tpub/origin, outputs e commitment localmente.

### Historical origin boundary

Uma tpub descendente prova, pelas regras reais atuais, a profundidade e o ultimo child number informado em `sourcePath`. Ela nao prova seus ancestors nem master fingerprint sem ancestors publicos. X3A confirma a limitacao X1A:

- um origin echo com fingerprint ou ancestor diferente do candidate e rejeitado como metadata inconsistente;
- se o **candidate** for alterado para um ancestor estruturalmente compativel, os outputs podem continuar iguais;
- o historical commitment preservado rejeita essa combinacao porque a identidade historica mudou;
- path com depth errada ou ultimo child incompativel e rejeitado diretamente pelo parser V2.

O historical commitment continua somente binding/integrity condicional. Sem trust anchor externa, um atacante que substitui o candidate inteiro e seu digest tambem nao e autenticado por ele.

## Negative cases

O harness rejeita, sem converter nenhum dado privado:

- tpub BIP32 valida mas errada, por divergencia dos output commitments;
- origin echo com fingerprint ou ancestor diferente; candidate com origin alterado;
- `sourcePath` com depth ou child final incompativel;
- resposta com `network`, `unlockHeight`, `policyVersion`, derivacao ou outputs injetados;
- resposta parcial, tpub vazia ou origin ausente;
- canaries sintaticos para `xprv`, `tprv`, WIF-like, xpub mainnet e campos `seed`, `mnemonic`, `privateKey` e `wif`.

O erro de produto futuro deve ser generico: **"Esta wallet nao corresponde a este plano."** Ele nao deve ecoar a tpub completa esperada. O prototype verifica esse limite de mensagem.

## Two independent decisions

X3A separa duas decisoes que nao devem ser confundidas:

1. **Qual no BIP32 a wallet reapresenta?** Root tpub ou tpub descendente/source branch. Esta escolha determina o blast radius.
2. **Quais campos a response carrega?** Apenas tpub, tpub mais fingerprint, ou tpub mais origin completo. Esta escolha determina tamanho e ergonomia da mensagem, nao o blast radius do no retornado.

Uma root tpub pode expor uma arvore nao-hardened muito maior. Uma tpub descendente limita o blast radius ao no exportado e seus descendentes nao-hardened. A direcao futura recomendavel para onboarding de novos planos e uma source branch hardened dedicada ao TimeSats, **caso adapters reais comprovem interoperabilidade**. Isto nao modifica V2 historica, Jade/QEMU existente nem promete suporte universal de wallets.

## Response variants

| Opcao | Analise |
| --- | --- |
| A. Apenas tpub da source solicitada | **Minima e provada no prototype.** Candidate fornece origin historico; TimeSats usa commitments e historical commitment para validar a fonte. |
| B. tpub + fingerprint | Echo parcial nao confiavel. Pode ajudar diagnostico, mas nao prova historical origin nem e necessario para reconnect. |
| C. tpub + origin publica completa | Echo completo nao confiavel. Deve ser comparado ao candidate; pode ajudar interoperabilidade, nao autentica ancestry historica. |
| D. root tpub + sourcePath | Alternativa de **no**, nao mero formato de response. Inadequada como regra geral: source paths podem ter ancestors hardened e root tpub aumenta blast radius. |

O X3A recomenda, somente para pesquisa:

```text
minimal reconnect contract
  = candidate authority + requested sourcePath + returned source tpub

optional adapter metadata
  = fingerprint/origin echo, always untrusted

future key-source design
  = dedicated hardened TimeSats branch, if real adapters support it
```

Uma tpub descendente serializada nao contem o master fingerprint. Em onboarding futuro, obter fingerprint do device pode exigir API publica especifica, leitura publica de root xpub para calcular fingerprint, ou mecanismo proprio da wallet. Em reconnect de candidate que ja preserva o fingerprint historico, receber esse campo novamente nao e automaticamente necessario.

## Session-only material and issuance

Depois do reconnect correto, tpub e `VaultPlan` ficam somente em memoria do prototype. O candidato reserializado e novamente verificado contra tpub real, identity canonica, child public keys e witness scripts: nenhum deles reaparece no JSON.

Sem reconnect, o candidate continua capaz de listar label/rede/H, emissao conhecida e output commitments para watcher X1B, mas falha explicitamente ao tentar derivar proximo deposito, `P_i`, witness script, identity canonica ou preparo completo de gasto.

Depois de `PUBLIC_REHYDRATED`, X3A emite somente `#4`, atualiza `lastIssuedIndex` e acrescenta somente o output commitment de `#4`. Apos descartar a sessao, reload conhece `#4` como output watchable, mas nao pode derivar `#5` ate novo reconnect. Isso preserva a emissao monotona e nao reapresenta tpub em persistencia.

O plano reidratado tambem possui `P_i`, witness script, key origin e identity que o fluxo V2 atual precisa para preparar dados publicos de gasto. Portanto **PUBLIC SPEND PREPARATION DATA: PROVEN** para a fixture V2 no escopo do prototype. Isto nao produz PSBT novo, nao assina e nao transmite; assinatura continua um contrato `ExternalSigner` separado.

## Wallet feasibility

### Bitcoin Core

**PARTIAL.** `scripts/regtest-core-signer.ts` ja usa `listdescriptors false` para obter descriptor publico e `getaddressinfo` para `pubkey`, `hdkeypath` e `hdmasterfingerprint`, sem `dumpprivkey`, `dumpwallet`, WIF ou descriptor privado. `scripts/regtest-policy-v2-research.ts` tambem comprova `hdkeypath` e fingerprint publicos em Regtest para Policy V2.

Essas evidencias tornam plausivel um adapter que obtenha publicamente uma tpub da source branch solicitada. Mas X3A nao iniciou Core nem provou nesta rodada uma chamada isolada que retorne a response minima para um candidate X3A; isso fica para uma prova adapter separada. Nenhuma compatibilidade generica ou mainnet foi afirmada.

### Jade QEMU

**INFRASTRUCTURE UNAVAILABLE.** `scripts/jade-public-info.py` chama `get_xpub("localtest", [])` e `get_xpub("localtest", [0])`; `scripts/regtest-jade-v2-research.ts` ja verificou que a raiz publica deriva o filho publico e calcula fingerprint da raiz. Logo, uma Jade QEMU pode conceitualmente obter tpub da source path por chamada publica; se onboarding precisar fingerprint, a raiz publica pode ser lida e processada dentro do adapter.

Nenhum endpoint Jade/QEMU ativo foi encontrado nesta rodada, e X3A nao reiniciou Jade, gerou seed ou mudou firmware. Portanto nao ha live proof X3A. **PHYSICAL JADE: NOT TESTED.**

## V1, dedupe and UX limits

**V1 FULL PUBLIC RECONNECT WITHOUT STORED TPUB: NOT PROVEN.** V1 nao ganha retrospectivamente key origin publica legitima. O contrato V2 nao converte V1, nao inventa origin e nao remove bloqueio X2B de migracao V1.

Deduplicacao tambem nao e X3A. Reconnect de uma wallet nao escolhe qual instancia local duplicada deve sobreviver; candidate ambiguo deve falhar fechado ate a politica X2B existir.

O fluxo de produto futuro, ainda nao implementado, seria:

```text
public reconnect required
  -> usuario escolhe/conecta wallet
  -> adapter pede somente fonte publica
  -> TimeSats valida localmente
  -> "Wallet conectada a este plano"
  -> gerar endereco ou preparar gasto
  -> nao persistir a fonte publica
```

Um manual fallback nao foi decidido. Nem o reconnect nem o historical commitment criam trust anchor contra reescrita integral do candidate.

## Claim boundary and verdicts

X3A nao prova resistencia quantica, migracao criptografica antes de `H`, recovery oficial xpubless, apagamento de RAM/GC, autenticacao fisica de dispositivo, assinatura, broadcast, Core/Jade genericos, V1 ou mainnet. "Nao persistir" tambem nao significa que strings, heap, DevTools, crash dumps ou extensoes foram apagados.

- **V2 WALLET PUBLIC RECONNECT CONTRACT: A - FEASIBLE**, para fixture publica V2, candidate valido e adapter research-only nao confiavel validado localmente.
- **CORRECT WALLET REHYDRATION: PROVEN.**
- **WRONG WALLET REJECTION: PROVEN.**
- **SESSION-ONLY NO-TPUB REPERSISTENCE: PROVEN.**
- **PUBLIC NEW-DEPOSIT AFTER RECONNECT: PROVEN.**
- **PUBLIC SPEND PREPARATION DATA: PROVEN.**
- **MINIMAL TPUB-ONLY RESPONSE: PROVEN.** Candidate authority, `sourcePathHint` e tpub da source solicitada bastam para a fixture V2; origin echo continua opcional e nao confiavel.
- **BITCOIN CORE ADAPTER FEASIBILITY: PARTIAL.** Evidencia publica existente, sem prova X3A live dedicada.
- **JADE QEMU ADAPTER FEASIBILITY: INFRASTRUCTURE UNAVAILABLE.**
- **PHYSICAL JADE: NOT TESTED.**
- **V1: NOT PROVEN.**

## Next research

Uma proxima rodada deve testar um adapter Bitcoin Core isolado que entregue exatamente a resposta D sem expor descriptor privado. Depois, com infraestrutura disponivel, repetir somente chamadas Jade QEMU publicas e validar o mesmo contrato. Ambos precisam manter a separacao entre reconnect publico e assinatura PSBT.
