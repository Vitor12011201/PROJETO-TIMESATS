# TimeSats — permanent agent rules

## Project identity

**TimeSats** — “Seu Bitcoin. Seu prazo. Suas chaves.”

Software Bitcoin self-custodial para compromissos de longo prazo:

```text
CLIENTE  → possui as chaves
BITCOIN  → executa a regra
TIMESATS → constrói, explica, verifica e ajuda a reconstruir a política
```

TimeSats deve poder desaparecer amanhã sem levar nenhum sat de ninguém consigo. Não é custodiante, exchange, banco ou plataforma de trading.

## Security invariants

- Nunca pedir, receber ou persistir em código produtivo seed, mnemonic, private key, WIF, xprv ou tprv.
- Nunca colocar segredos em `src/`, frontend, localStorage, Git, documentação, fixtures, screenshots ou logs.
- Signers de teste podem ter segredo somente em infraestrutura Regtest isolada e nunca podem expô-lo ao código produtivo.
- Se uma solução requer private key dentro do TimeSats, pare e redesenhe.

## Network and Bitcoin policy

- Somente **Signet** e **Regtest**. Mainnet é explicitamente proibida; não habilite-a sem milestone e autorização explícitas. Nunca use BTC real.
- Preserve a primitive P2WSH v0 validada:

  ```text
  <unlockHeight> OP_CHECKLOCKTIMEVERIFY OP_DROP <compressedPublicKey> OP_CHECKSIG
  ```

  `unlockHeight` usa semântica de block height. Não substitua por Miniscript, outro descriptor, Taproot ou outra construção sem prova explícita de equivalência e decisão de milestone.
- `VaultPlan` usa `tpub` pública, derivação BIP32 não-hardened relativa `m/<index>`, mesmo `unlockHeight` por plano e pubkey/script/address próprios por depósito.
- A combinação de ancestor xpub com descendant private key em BIP32 não-hardened tem risco conhecido. `SECURITY.md` é a autoridade; prefira wallet/hardware signer externo para as chaves privadas.

## Versions and current PSBT state

- **v0.1.0:** primitive CLTV/P2WSH validada em Bitcoin Core Regtest.
- **v0.2.0:** VaultPlan, BIP32 pública, depósitos determinísticos, recovery bundle e UI.
- **v0.3.0:** verificação offline de funding, `VaultUtxo`, `SpendIntent`, PSBT BIP174, signer externo de teste, validação do PSBT assinado e finalização.

O PSBT atual é **v0 / BIP174**: 1 input, 1 output, sweep, fee explícita em sats, sem change, `SIGHASH_ALL`, `nLockTime = unlockHeight` e `nSequence = 0xfffffffe`.

Funding é `raw funding transaction + vout`; compare o `outputScript` ao `Deposit #N` derivado. Isso prova que o output existe naquela transação, **não** que continua não gasto offline. Nunca afirme o contrário na UI.

A `tpub` revela apenas `m/<index>` relativo; não invente master fingerprint, caminho absoluto ou `bip32Derivation` de PSBT.

## UI and money

- Preserve a identidade visual; não redesenhe arbitrariamente em milestones técnicas.
- Sem chain monitoring, não fabricar saldo, confirmação, histórico on-chain, status de UTXO, preço ou movimentações.
- Valores Bitcoin internos são satoshis inteiros; nunca use float para input, output ou fee. Respeite `bigint` quando a biblioteca exigir e não use casts inseguros.

## Development and validation

Antes de qualquer milestone: rode `git status`, inspecione o repositório, leia `README.md`, `SECURITY.md`, documentação relevante e testes; preserve stack e comportamento validado. Faça mudanças incrementais e não invente filenames. O repositório é a fonte de verdade: reporte divergências de prompts/contexto antes de substituir comportamento validado.

Quando aplicável, conclua com:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

O harness Regtest é separado. Nunca alegue execução de Bitcoin Core/Regtest sem executá-lo. `npm audit` pode servir para relatório, mas nunca rode `npm audit fix --force` ou upgrade major automaticamente.

Para baixar Bitcoin Core de teste: use origem oficial, verifique SHA-256 e a assinatura do manifest quando GPG estiver disponível; documente honestamente se não estiver. Bitcoin Core é a autoridade de consenso end-to-end.

## Dependencies, Git and interoperability

- Preserve a stack; justifique tecnicamente qualquer dependência nova. Prefira bibliotecas Bitcoin maduras e não implemente manualmente ECDSA, parser Bitcoin, PSBT ou BIP32 quando já houver biblioteca madura.
- Sem autorização explícita: não faça commit, push, tag, release, deploy, force-push, mudança de remote ou reset destrutivo. Não modifique outros repositórios.
- Nunca alegue compatibilidade com Sparrow, Electrum, Bitcoin Core wallet, Coldcard, Jade, Trezor, Ledger, Nunchuk, HWI ou hardware wallet genérica sem teste real da combinação específica. “Deveria funcionar” não é compatibilidade.

## Next milestone and documentation

v0.4 deve provar **uma** integração real: TimeSats prepara PSBT → signer real assina fora → TimeSats recebe e verifica a intenção → TimeSats finaliza. Não implemente vários signers; escolha o primeiro com pesquisa técnica e evidência.

Este arquivo resume regras. Para detalhes: `README.md` (visão/uso), `SECURITY.md` (threat model), `docs/` (pesquisa, arquitetura e integração), testes (comportamento esperado) e código (implementação efetiva). Em divergência, investigue e reporte; não assuma silenciosamente.
