import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

const MIN_TCP_PORT = 1024;
const MAX_TCP_PORT = 65535;
const PORTS_PER_HARNESS = 4000;

export interface RegtestHarnessPorts {
  rpcPort: number;
  p2pPort: number;
}

function executableAt(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Resolves an explicit path or a command available through PATH without a shell. */
export function resolveHarnessExecutable(command: string, label: string, pathValue = process.env.PATH): string {
  if (!command) throw new Error(`${label} command is empty.`);
  if (command.includes("/")) {
    if (executableAt(command)) return command;
    throw new Error(`${label} is not executable: ${command}`);
  }
  for (const directory of pathValue?.split(delimiter) ?? []) {
    const candidate = join(directory || ".", command);
    if (executableAt(candidate)) return candidate;
  }
  throw new Error(`${label} was not found in PATH. Set the corresponding environment variable to an executable path.`);
}

function harnessPort(environmentName: string, value: string | undefined, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < MIN_TCP_PORT || port > MAX_TCP_PORT) {
    throw new Error(`${environmentName} must be a valid TCP port.`);
  }
  return port;
}

/**
 * Allocates a high, deterministic RPC/P2P pair for one Regtest harness family.
 * Explicit environment values take precedence for reproducible external setups.
 */
export function regtestHarnessPorts(
  rpcPortOverride: string | undefined,
  p2pPortOverride: string | undefined,
  processId: number,
  rangeStart: number,
): RegtestHarnessPorts {
  if (!Number.isInteger(processId) || processId < 0) throw new Error("Regtest harness process id must be a non-negative integer.");
  const portBase = rangeStart + (processId % PORTS_PER_HARNESS) * 2;
  const rpcPort = harnessPort("BITCOIN_REGTEST_RPC_PORT", rpcPortOverride, portBase);
  const p2pPort = harnessPort("BITCOIN_REGTEST_P2P_PORT", p2pPortOverride, portBase + 1);
  if (rpcPort === p2pPort) throw new Error("Regtest RPC and P2P ports must differ.");
  return { rpcPort, p2pPort };
}
