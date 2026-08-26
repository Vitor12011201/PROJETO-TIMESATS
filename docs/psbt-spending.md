# PSBT offline v0.3

TimeSats prepara uma transação de sweep com **um UTXO do vault, uma saída de destino e fee explícita em sats inteiros**. Ele não recebe segredo, não assina e não transmite.

## Fluxo

```text
VaultPlan + Deposit #N
        ↓
raw funding transaction + vout
        ↓ validação offline do script/valor
VaultUtxo
        ↓ destino + fee inteira
unsigned BIP174 PSBT v0
        ↓
signer externo
        ↓ partial signature
validação rigorosa + finalização local
        ↓
raw transaction para exportação; broadcast fora do TimeSats
```

O raw funding transaction permite calcular TXID, localizar `vout`, valor em sats e output script. TimeSats deriva novamente Deposit #N e exige igualdade byte-a-byte entre o script do output e o P2WSH esperado. Isso prova que **aquele output existiu naquela transação**; offline não prova que ele ainda não foi gasto.

## Campos relevantes

- `witnessUtxo`: output script P2WSH e valor do UTXO em `bigint` dentro de `bitcoinjs-lib`.
- `witnessScript`: o script CLTV literal do plano.
- `nLockTime`: sempre `unlockHeight` do plano.
- `nSequence`: sempre `0xfffffffe`, não-final e sem opt-in RBF.
- `sighashType`: somente `SIGHASH_ALL` (`0x01`).
- `partialSig`: deve ser uma assinatura ECDSA da public key esperada, com byte `SIGHASH_ALL`.

O PSBT não possui `bip32Derivation`: a `tpub` v0.2 não contém origem absoluta verificável. Não há fingerprint nem path inventado.

## Verificação após o signer

Antes de finalizar, TimeSats rejeita mudanças em input count, output count, outpoint, sequence, locktime, `witnessUtxo`, `witnessScript`, sighash, destino, valor de destino, fee implícita e public key da assinatura. A assinatura DER é validada contra o sighash SegWit v0 por `@noble/curves`. O witness final é:

```text
<signature + SIGHASH_ALL byte>
<witnessScript>
```

Preparar ou assinar antes do `unlockHeight` é possível; a rede continuará rejeitando a transação até o locktime. TimeSats não transmite a transação final.

## Privacidade e retenção

PSBTs revelam outpoint, valores, scripts, chave pública, destino e política temporal. Compartilhe-os apenas com o signer escolhido. Raw funding, PSBT unsigned/signed e raw tx final existem somente na memória da sessão e são exportados apenas por ação explícita; localStorage continua contendo apenas VaultPlans públicos.
