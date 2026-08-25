import { networks, type Network } from "bitcoinjs-lib";
import { assertAllowedNetwork, type AllowedNetwork } from "@/domain/vault-policy";

// Signet uses the standard test-network address prefixes (tb). It is kept as a
// named object to prevent a caller from silently selecting mainnet.
const signetNetwork: Network = { ...networks.testnet };

export function bitcoinNetworkFor(network: string): Network {
  assertAllowedNetwork(network);
  const mapping: Record<AllowedNetwork, Network> = {
    signet: signetNetwork,
    regtest: networks.regtest,
  };
  return mapping[network];
}
