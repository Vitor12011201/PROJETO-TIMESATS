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
  projects: [
    {
      name: "chromium",
      testIgnore: [
        "**/xpubless-v2-browser-matrix.spec.ts",
        "**/xpubless-v2-quota.spec.ts",
      ],
    },
    {
      name: "chromium-quota",
      testMatch: "**/xpubless-v2-quota.spec.ts",
      use: { browserName: "chromium" },
    },
    {
      name: "matrix-chromium",
      testMatch: "**/xpubless-v2-browser-matrix.spec.ts",
      use: { browserName: "chromium" },
    },
    {
      name: "matrix-firefox",
      testMatch: "**/xpubless-v2-browser-matrix.spec.ts",
      use: { browserName: "firefox" },
    },
    {
      name: "matrix-webkit",
      testMatch: "**/xpubless-v2-browser-matrix.spec.ts",
      use: { browserName: "webkit" },
    },
  ],
  webServer: {
    command: "npx next dev tests/browser/harness --hostname 127.0.0.1 --port 4179",
    url: "http://127.0.0.1:4179",
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
