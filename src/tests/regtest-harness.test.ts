import { describe, expect, it } from "vitest";
import { regtestHarnessPorts } from "../../scripts/regtest-harness";

describe("Regtest harness ports", () => {
  it("derives a high adjacent pair from the process id", () => {
    expect(regtestHarnessPorts(undefined, undefined, 1234, 40_000)).toEqual({ rpcPort: 42_468, p2pPort: 42_469 });
  });

  it("allows explicit reproducible port overrides", () => {
    expect(regtestHarnessPorts("61000", "61001", 1, 40_000))
      .toEqual({ rpcPort: 61_000, p2pPort: 61_001 });
  });

  it.each(["0", "1023", "65536", "not-a-port"])("rejects an invalid RPC port override: %s", (port) => {
    expect(() => regtestHarnessPorts(port, undefined, 1, 40_000)).toThrow(/RPC_PORT/i);
  });

  it("rejects equal RPC and P2P overrides", () => {
    expect(() => regtestHarnessPorts("61000", "61000", 1, 40_000))
      .toThrow(/must differ/i);
  });
});
