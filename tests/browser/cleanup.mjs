import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const browserTestsDirectory = dirname(fileURLToPath(import.meta.url));

export default async function cleanP3D3HarnessArtifacts() {
  await Promise.all([
    rm(resolve(browserTestsDirectory, "harness/.next"), { recursive: true, force: true }),
    rm(resolve(browserTestsDirectory, "harness/next-env.d.ts"), { force: true }),
  ]);
}
