# Bitcoin Core signer externo — v0.4

TimeSats não conecta RPC Core no browser e não transmite transações. A fronteira
continua manual: ele exporta PSBT BIP174, a wallet Bitcoin Core assina fora do
app e o usuário importa o PSBT assinado para validação/finalização local.

## Policy V2

Somente um plano V2 (`policyVersion: 2`, bundle `version: 3`) é o fluxo Core
comprovado. O plano contém uma `tpub` de branch, master fingerprint e caminho
absoluto público dessa fonte. Para Deposit `N`, TimeSats deriva `m/N`, constrói
`wsh(and_v(v:after(H),pk(P_N)))` e inclui a origem absoluta `sourcePath/N` em
`bip32Derivation`. Não invente fingerprint/path: obtenha-os da própria wallet
Core junto da `tpub` correspondente.

O PSBT contém um input/uma saída, `witnessUtxo`, witness script, `SIGHASH_ALL`,
`nLockTime=H` e `nSequence=0xfffffffe`. Ele não contém segredo. A wallet que
possui a chave chama `walletprocesspsbt` localmente, por exemplo:

```text
bitcoin-cli -regtest -rpcwallet=<wallet-local> walletprocesspsbt <psbt-base64> true ALL true false
```

Não coloque RPC host, cookie, usuário, senha, seed, WIF, xprv/tprv ou private
descriptor na UI. O comando é um modelo para ambiente Regtest local; não é
instrução para mainnet.

Ao importar, TimeSats aceita metadata pública adicional inofensiva, mas exige
que a unsigned transaction, outpoint, contagens, locktime, sequence, destino,
valor, fee, UTXO, witness script, sighash, origem esperada e assinatura ECDSA
permaneçam corretos. A finalização é local; o broadcast é responsabilidade de
software externo. Assinar antes de H não desbloqueia o UTXO: consenso aplica
CLTV no mempool/bloco.

V1 continua recuperável e gastável pelo fluxo v0.3, mas não deve ser anunciada
como compatível com Core descriptor wallet. Veja a prova e limitações em
[research-v0.4-policy-v2.md](research-v0.4-policy-v2.md).
