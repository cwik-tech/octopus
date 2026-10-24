import { defineConfig } from "@playwright/test";

// Keep routine Electron verification from raising windows or stealing focus.
// Set PIPELINE_DESKTOP_E2E_HEADLESS=0 for an explicit visible-window check.
process.env.PIPELINE_DESKTOP_E2E_HEADLESS ??= "1";

export default defineConfig({
  testDir: "./tests/electron",
  testIgnore: "**/*.live.spec.ts",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
});
