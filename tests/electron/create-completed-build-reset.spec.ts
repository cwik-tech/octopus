import { _electron as electron, expect, test } from "@playwright/test";
import { once } from "node:events";
import * as fs from "node:fs/promises";

import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import { startFakeChatCompletionsServer } from "../support/fake-chat-completions-server.js";
import {
  APP_DEFAULT_MODEL,
  desktopEnvironment,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
} from "./support/model-selection-fixture.js";

test("completed builds leave Create empty after reopening and pressing New", async ({}, testInfo) => {
  const paths = {
    projectRoot: testInfo.outputPath("project"),
    userDataPath: testInfo.outputPath("user-data"),
    workspacePath: testInfo.outputPath("workspace"),
  };
  const agentName = "finished-product-reviewer";
  const reply = "Tell me which products your next Agent should review.";
  const emptyMessage = "Describe the Agents or Team you need. I will decide whether to create standalone Agents or a Team, show the planned names first, and then build them.";
  // Replace the paid, nondeterministic model at its HTTP boundary only.
  const provider = await startFakeChatCompletionsServer({ script: [{ content: reply }] });
  await fs.mkdir(paths.workspacePath, { recursive: true });
  await seedProviderSettings({ userDataPath: paths.userDataPath, baseUrl: provider.url, defaultModel: APP_DEFAULT_MODEL });
  await writeAgentPersona(paths.projectRoot, { name: agentName, description: "Reviews products.", marker: "Completed build fixture." });
  const store = new ResourceArchitectStore(paths.workspacePath);
  await store.savePlan({
    id: "finished-plan", kind: "standalone_agents",
    agents: [{ name: agentName, role: "Reviewer", description: "Reviews products.", rationale: "Requested." }],
  });
  await store.saveJob({
    jobId: "00000000-0000-4000-8000-000000000001", planId: "finished-plan",
    startedAt: "2026-09-20T10:00:00.000Z", status: "completed",
    items: [{ plannedResource: { kind: "agent", id: agentName }, resource: { kind: "agent", id: agentName }, planIndex: 0, status: "created" }],
    selectedResource: { kind: "agent", id: agentName }, events: [],
  });
  const app = await electron.launch({
    args: ["."], cwd: repoRoot,
    env: { ...desktopEnvironment(paths), PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: "false" },
  });

  try {
    const page = await app.firstWindow();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    // Let restoration finish so a transient empty mount cannot satisfy this.
    await page.waitForLoadState("networkidle");
    const chat = page.getByRole("region", { name: "Agent Architect chat" });
    await expect(chat.getByText(emptyMessage, { exact: true })).toBeVisible();
    await expect(chat.getByRole("button", { name: `Open ${agentName}` })).toHaveCount(0);

    await page.getByPlaceholder("Describe the Agents or Team you need…").fill("I need another product reviewer.");
    await chat.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(chat.getByText(reply, { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "New agent", exact: true }).click();
    await page.waitForLoadState("networkidle");
    await expect(chat.getByText(emptyMessage, { exact: true })).toBeVisible();
    await expect(chat.getByText(reply, { exact: true })).toHaveCount(0);

    await page.getByLabel("Resource type").getByRole("tab", { name: "Teams", exact: true }).click();
    await page.getByRole("button", { name: "New team", exact: true }).click();
    await page.waitForLoadState("networkidle");
    await expect(chat.getByText(emptyMessage, { exact: true })).toBeVisible();

    await page.reload();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await page.waitForLoadState("networkidle");
    await expect(chat.getByText(emptyMessage, { exact: true })).toBeVisible();
    await expect(page.getByText(/Persona file does not exist/)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("empty-create-after-completed-build.png") });
    const saved = await new ResourceArchitectStore(paths.workspacePath)
      .getJob("00000000-0000-4000-8000-000000000001");
    expect(saved?.status).toBe("completed");
  } finally {
    // End only this isolated fixture process. Waiting for desktop API shutdown
    // can mask an assertion failure with the test's overall timeout.
    const desktopProcess = app.process();
    const exited = desktopProcess.exitCode === null && desktopProcess.signalCode === null
      ? once(desktopProcess, "exit", { signal: AbortSignal.timeout(5_000) })
      : Promise.resolve();
    desktopProcess.kill("SIGKILL");
    await Promise.all([provider.close(), exited]);
  }
});
