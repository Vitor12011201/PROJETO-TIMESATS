const PSBT_MAGIC = Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff);

function hasPsbtMagic(bytes: Uint8Array): boolean {
  return PSBT_MAGIC.every((byte, index) => bytes[index] === byte);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("O arquivo não contém um PSBT BIP174 binário nem Base64 válido.");
  }
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

/** Converts a core Base64 PSBT into the binary BIP174 file representation. */
export function psbtBase64ToBytes(base64: string): Uint8Array {
  const bytes = base64ToBytes(base64.trim());
  if (!hasPsbtMagic(bytes)) throw new Error("O PSBT deve começar com os bytes mágicos BIP174.");
  return bytes;
}

/** Accepts either a binary BIP174 file or legacy Base64 text and normalizes to Base64. */
export function decodePsbtFile(bytes: Uint8Array): string {
  if (hasPsbtMagic(bytes)) return bytesToBase64(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error("O arquivo não contém um PSBT BIP174 binário nem Base64 válido.");
  }
  return bytesToBase64(psbtBase64ToBytes(text));
}
