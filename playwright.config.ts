import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/browser",
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
    command: "node tests/browser/server.mjs",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
