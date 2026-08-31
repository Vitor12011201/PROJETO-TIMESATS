import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
  globalTeardown: "./tests/browser/cleanup.mjs",
  outputDir: "/tmp/timesats-playwright-results",
  timeout: 15_000,
  retries: 0,
  use: {
    browserName: "chromium",
    headless: true,
    screenshot: "off",
    trace: "off",
    video: "off",
  },
  projects: [{ name: "chromium" }],
  webServer: {
    command: "npx next dev tests/browser/harness --hostname 127.0.0.1 --port 4179",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
