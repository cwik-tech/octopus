import { defineConfig } from "@playwright/test";

process.env.PIPELINE_DESKTOP_E2E_HEADLESS ??= "1";

export default defineConfig({
  testDir: "./tests/electron",
  testMatch: "**/*.live.spec.ts",
  timeout: 300_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    trace: "retain-on-failure",
  },
});
