#!/usr/bin/env python3
"""Pass one BIP174 PSBT to Jade and return its signed PSBT on stdout."""

import base64
import os
import sys

from jadepy.jade import JadeAPI, JadeInterface


NETWORK = "localtest"
DEVICE = os.environ.get("TIMESATS_JADE_DEVICE", "tcp:127.0.0.1:30121")


def main() -> None:
    psbt_base64 = sys.stdin.read().strip()
    if not psbt_base64:
        raise SystemExit("missing PSBT on stdin")

    try:
        psbt = base64.b64decode(psbt_base64, validate=True)
    except ValueError as error:
        raise SystemExit("PSBT stdin must be valid Base64") from error

    interface = JadeInterface.create_serial(device=DEVICE)
    interface.connect()
    try:
        jade = JadeAPI(interface)
        signed = jade.sign_psbt(NETWORK, psbt)
        sys.stdout.write(base64.b64encode(signed).decode("ascii"))
    finally:
        interface.disconnect()


if __name__ == "__main__":
    main()
