#!/usr/bin/env python3
"""Read only the public BIP32 information needed by the Jade research harness."""

import json
import os

from jadepy.jade import JadeAPI, JadeInterface


NETWORK = "localtest"
DEVICE = os.environ.get("TIMESATS_JADE_DEVICE", "tcp:127.0.0.1:30121")


def main() -> None:
    interface = JadeInterface.create_serial(device=DEVICE)
    interface.connect()

    try:
        jade = JadeAPI(interface)
        # Both RPCs return extended public keys. This helper never requests a
        # mnemonic, seed, private key, or any signing operation.
        print(json.dumps({
            "network": NETWORK,
            "rootTpub": jade.get_xpub(NETWORK, []),
            "deposit0Tpub": jade.get_xpub(NETWORK, [0]),
        }))
    finally:
        interface.disconnect()


if __name__ == "__main__":
    main()
