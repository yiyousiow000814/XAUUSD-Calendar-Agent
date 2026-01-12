import { defineConfig } from "@playwright/test";

const baseURL = process.env.UI_BASE_URL || "http://127.0.0.1:4173";
const shouldStartServer = !process.env.UI_BASE_URL;

export default defineConfig({
  testDir: "./tests",
  timeout: 60000,
  expect: { timeout: 10000 },
  outputDir: "./artifacts/test-results",
  reporter: [
    ["list"],
    ["html", { outputFolder: "playwright-report", open: "never" }]
  ],
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure"
  },
  webServer: shouldStartServer
    ? {
        command: "node scripts/launch-ui.mjs",
        port: 4173,
        reuseExistingServer: true,
        timeout: 120000
      }
    : undefined,
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" }
    }
  ]
});
