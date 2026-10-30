// Adapted from listmonk tests/playwright.config.js at 6fcd95f. test/e2e/run.ts starts the servers
// and supplies their addresses. Spec files end in .e2e.js because `bun test` claims .spec.js.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  testMatch: "**/*.e2e.js",
  outputDir: "../../dist/e2e-results",
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: process.env.E2E_ORIGIN,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1400, height: 950 } },
    },
  ],
});
