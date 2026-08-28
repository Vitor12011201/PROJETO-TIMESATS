import { describe, expect, it } from "vitest";
import { Psbt } from "bitcoinjs-lib";
import { decodePsbtFile, psbtBase64ToBytes } from "./psbt-file";

function samplePsbtBase64(): string {
  return new Psbt().toBase64();
}

describe("PSBT file boundary", () => {
  it("exports the core Base64 PSBT as binary BIP174 bytes", () => {
    const base64 = samplePsbtBase64();
    const bytes = psbtBase64ToBytes(base64);

    expect(bytes.slice(0, 5)).toEqual(Uint8Array.of(0x70, 0x73, 0x62, 0x74, 0xff));
    expect(Psbt.fromBuffer(bytes).toBase64()).toBe(base64);
  });

  it("imports a binary BIP174 PSBT into the core Base64 representation", () => {
    const base64 = samplePsbtBase64();

    expect(decodePsbtFile(psbtBase64ToBytes(base64))).toBe(base64);
  });

  it("keeps legacy textual Base64 PSBT files compatible", () => {
    const base64 = samplePsbtBase64();
    const legacyText = new TextEncoder().encode(`\n ${base64} \n`);

    expect(decodePsbtFile(legacyText)).toBe(base64);
  });

  it("rejects arbitrary files instead of treating them as a PSBT", () => {
    expect(() => decodePsbtFile(new TextEncoder().encode("not a psbt"))).toThrow(/BIP174|Base64/i);
    expect(() => psbtBase64ToBytes("bm90IGEgcHNidA==")).toThrow(/BIP174/i);
  });
});
