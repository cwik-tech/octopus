import { _electron as electron, expect, test, type ElectronApplication, type TestInfo } from "@playwright/test";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { ResourceArchitectStore } from "../../server/resource-architect-store.js";
import { startFakeChatCompletionsServer, type FakeChatCompletionsRequest, type FakeChatCompletionsTurn } from "../support/fake-chat-completions-server.js";
import { APP_DEFAULT_MODEL, desktopEnvironment, repoRoot, seedProviderSettings, writeAgentPersona } from "./support/model-selection-fixture.js";

const PROMPT = "Help me design a team that reviews furniture plans.";
const REPLY = "Which furniture materials should this team specialize in?";
const FOLLOW_UP = "Focus on solid wood and traditional joinery.";
const SECOND_REPLY = "The team will specialize in solid wood and traditional joinery.";
const EMPTY_MESSAGE = "Describe the Agents or Team you need. I will decide whether to create standalone Agents or a Team, show the planned names first, and then build them.";
const TURN_PATH = "/create/resource-architect/turn";

function isArchitect(request: FakeChatCompletionsRequest) {
  return request.systemPrompt?.includes("You are the Agent Architect") ?? false;
}

// A skill update of an Agent the fixture already seeds. It creates no Agent, so
// the proposal carries no new-Agent fields.
const SKILL_TARGET = "previous-checker";
const SKILL_NAME = "joinery-check";
const SKILL_PROMPT = `Give ${SKILL_TARGET} a new ${SKILL_NAME} skill.`;
const SKILL_CARD = `Update agent ${SKILL_TARGET}`;
const UNSENT_DRAFT = "Retry it once the provider is back.";
// The card's own status, beside its title, rather than the word anywhere on the
// card: a status on each skill row would match the same word a second time.
const CARD_STATUS = '[data-slot="card-action"]';

function isSkillAuthor(request: FakeChatCompletionsRequest) {
  return request.systemPrompt?.trimStart().startsWith("# Skill Author") ?? false;
}

function skillUpdateTurns(planId: string, author: FakeChatCompletionsTurn): FakeChatCompletionsTurn[] {
  return [
    { content: "Preparing the skill update.\n[[proposal-requested]]", match: isArchitect },
    { content: JSON.stringify({
      message: `I will add ${SKILL_NAME} to ${SKILL_TARGET}.`, warnings: [],
      outcome: { id: planId, kind: "resource_updates", operations: [{
        kind: "update_agent_skills", target: { kind: "agent", id: SKILL_TARGET },
        skillUpdates: [{ action: "create", name: SKILL_NAME, instruction: "Check mortise and tenon joints for fit and glue coverage." }],
      }] },
    }), match: isArchitect },
    { ...author, match: author.match ?? isSkillAuthor },
  ];
}

function deferred() {
  let resolve: () => void = () => { throw new Error("Gate is not initialized"); };
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function launchFixture(testInfo: TestInfo, script: readonly FakeChatCompletionsTurn[]) {
  const paths = {
    projectRoot: testInfo.outputPath("project"),
    userDataPath: testInfo.outputPath("user-data"),
    workspacePath: testInfo.outputPath("workspace"),
  };
  // Only the paid, nondeterministic model is replaced, at its HTTP boundary.
  // The desktop, authoring API, and filesystem stores are real.
  const provider = await startFakeChatCompletionsServer({ script: [...script, { content: "Ready." }] });
  await seedProviderSettings({ userDataPath: paths.userDataPath, baseUrl: provider.url, defaultModel: APP_DEFAULT_MODEL });
  await writeAgentPersona(paths.projectRoot, { name: "previous-agent", description: "An earlier completed creation.", marker: "Old build." });
  await writeAgentPersona(paths.projectRoot, { name: "previous-checker", description: "Reviews furniture plans.", marker: "Existing reviewer." });
  const store = new ResourceArchitectStore(paths.workspacePath);
  await store.savePlan({
    id: "previous-plan", kind: "standalone_agents",
    agents: [{ name: "previous-agent", role: "Reviewer", description: "An earlier completed creation.", rationale: "Requested earlier." }],
  });
  await store.saveJob({
    jobId: "00000000-0000-4000-8000-000000000001", planId: "previous-plan",
    startedAt: "2026-09-19T10:00:00.000Z", status: "completed",
    items: [], selectedResource: { kind: "agent", id: "previous-agent" }, events: [],
  });
  const app = await electron.launch({
    args: ["."], cwd: repoRoot,
    env: { ...desktopEnvironment(paths), PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: "false" },
  });
  try {
    const page = await app.firstWindow();
    await expect(page.getByRole("tab", { name: "Create", exact: true })).toBeVisible({ timeout: 10_000 });
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Teams", exact: true }).click();
    const chat = page.getByRole("region", { name: "Agent Architect chat" });
    await expect(chat.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
    return { app, page, chat, provider, paths };
  } catch (error) {
    await testInfo.attach("desktop-startup", { body: await (await app.firstWindow()).screenshot(), contentType: "image/png" });
    await closeDesktop(app);
    await provider.close();
    throw error;
  }
}

async function closeDesktop(app: ElectronApplication) {
  const desktopProcess = app.process();
  const exited = desktopProcess.exitCode === null && desktopProcess.signalCode === null
    ? once(desktopProcess, "exit", { signal: AbortSignal.timeout(5_000) })
    : Promise.resolve();
  desktopProcess.kill("SIGKILL");
  await exited;
}

test("typing in Create deselects the previous Agent and clears its inspector before submission", async ({}, testInfo) => {
  const fixture = await launchFixture(testInfo, [{ content: REPLY, match: isArchitect }]);
  try {
    const { page, chat } = fixture;
    await page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    const previousAgent = page.getByRole("button", { name: /^Previous Checker(?: —|$)/ });
    const inspector = page.locator('[data-slot="agent-editor-header"]');
    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    await previousAgent.click();
    await expect(inspector).toContainText("Previous Checker");
    await expect(previousAgent).toHaveClass(/ring-sidebar-primary/);

    // Focusing an empty draft is not typing, and must not drop the selection.
    await composer.click();
    await expect(inspector).toContainText("Previous Checker");
    await composer.fill(PROMPT);
    await expect(previousAgent).not.toHaveClass(/ring-sidebar-primary/);
    await expect(inspector).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Copy persona", exact: true })).toHaveCount(0);
    await expect(composer).toHaveValue(PROMPT);
    await expect(composer).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("create-typing-clears-inspector.png") });

    const turn = page.waitForRequest((request) => request.url().endsWith(TURN_PATH) && request.method() === "POST");
    await chat.getByRole("button", { name: "Submit", exact: true }).click();
    const body: unknown = (await turn).postDataJSON();
    expect(body).not.toHaveProperty("selectedResource");
    await expect(chat.getByText(REPLY, { exact: true })).toBeVisible();
    await expect(inspector).toHaveCount(0);

    await previousAgent.click();
    await expect(inspector).toContainText("Previous Checker");
  } finally {
    await closeDesktop(fixture.app);
    await fixture.provider.close();
  }
});

test("restarting Create restores the unfinished conversation and its follow-up context", async ({}, testInfo) => {
  const fixture = await launchFixture(testInfo, [
    { content: REPLY, match: isArchitect },
    { content: SECOND_REPLY, match: isArchitect },
  ]);
  let app = fixture.app;
  try {
    const firstTurn = fixture.page.waitForRequest((request) => request.url().endsWith(TURN_PATH) && request.method() === "POST");
    const firstResponse = fixture.page.waitForResponse((response) => response.url().endsWith(TURN_PATH) && response.request().method() === "POST");
    await fixture.page.getByPlaceholder("Describe the Agents or Team you need…").fill(PROMPT);
    await fixture.chat.getByRole("button", { name: "Submit", exact: true }).click();
    const originalRequest: unknown = (await firstTurn).postDataJSON();
    await expect(fixture.chat.getByText(REPLY, { exact: true })).toBeVisible();
    // The server stores the finished turn before it answers, and the streamed
    // reply can show before that; closing earlier restores an unfinished turn.
    expect((await firstResponse).status()).toBe(200);
    await closeDesktop(app);

    // Reuse the real workspace and profile, but start a new Electron/API process.
    app = await electron.launch({
      args: ["."], cwd: repoRoot,
      env: { ...desktopEnvironment(fixture.paths), PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: "false" },
    });
    const page = await app.firstWindow();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Teams", exact: true }).click();
    const chat = page.getByRole("region", { name: "Agent Architect chat" });
    await expect(chat.getByText(PROMPT, { exact: true })).toBeVisible();
    await expect(chat.getByText(REPLY, { exact: true })).toBeVisible();

    const followUp = page.waitForRequest((request) => request.url().endsWith(TURN_PATH) && request.method() === "POST");
    await page.getByPlaceholder("Describe the Agents or Team you need…").fill(FOLLOW_UP);
    await chat.getByRole("button", { name: "Submit", exact: true }).click();
    const resumedRequest: unknown = (await followUp).postDataJSON();
    expect(resumedRequest).toMatchObject({ history: [
      { role: "user", text: PROMPT }, { role: "assistant", text: `${REPLY}\n\nContext notes:\n- Review disabled. Reviewer of Agent Architect was not used.` },
      { role: "user", text: FOLLOW_UP },
    ] });
    expect(resumedRequest).toHaveProperty("draftId", z.object({ draftId: z.string() }).parse(originalRequest).draftId);
    await expect(chat.getByText(SECOND_REPLY, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("conversation-after-restart.png") });

    await page.getByRole("button", { name: "New team", exact: true }).click();
    await expect(chat.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
    await page.reload();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Teams", exact: true }).click();
    await expect(chat.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
    await expect(chat.getByText(PROMPT, { exact: true })).toHaveCount(0);
  } finally {
    await closeDesktop(app);
    await fixture.provider.close();
  }
});

test("typing after reload drops the old Agent context from the restored conversation", async ({}, testInfo) => {
  const fixture = await launchFixture(testInfo, [{ content: REPLY, match: isArchitect }]);
  try {
    const store = new ResourceArchitectStore(fixture.paths.workspacePath);
    await store.conversation.start({
      draftId: "selected-agent-draft", jobId: "selected-agent-turn", operation: "conversation",
      history: [{ role: "user", text: "Tell me about the selected Agent." }],
      planId: null, selectedResource: { kind: "agent", id: SKILL_TARGET },
      documentReader: null, updatedAt: "2026-09-24T12:00:00.000Z",
    });
    await store.conversation.settle({
      draftId: "selected-agent-draft", jobId: "selected-agent-turn", status: "completed",
      assistant: { role: "assistant", text: "It reviews furniture plans." },
      updatedAt: "2026-09-24T12:00:01.000Z",
    });
    await fixture.page.reload();
    await fixture.page.getByRole("tab", { name: "Create", exact: true }).click();
    await fixture.page.getByLabel("Resource type").getByRole("tab", { name: "Agents", exact: true }).click();
    await expect(fixture.chat.getByText("It reviews furniture plans.", { exact: true })).toBeVisible();
    const request = fixture.page.waitForRequest((entry) => entry.url().endsWith(TURN_PATH) && entry.method() === "POST");
    await fixture.page.getByPlaceholder("Describe the Agents or Team you need…").fill(PROMPT);
    await fixture.chat.getByRole("button", { name: "Submit", exact: true }).click();
    const body: unknown = (await request).postDataJSON();
    expect(body).not.toHaveProperty("selectedResource");
    await expect(fixture.chat.getByText(REPLY, { exact: true })).toBeVisible();
  } finally {
    await closeDesktop(fixture.app);
    await fixture.provider.close();
  }
});

test("closing the app during a reply restores the conversation with an interrupted status", async ({}, testInfo) => {
  const started = deferred();
  const release = deferred();
  const fixture = await launchFixture(testInfo, [
    { content: REPLY, gate: release.promise, deltaGates: [release.promise], match: (request) => {
      if (!isArchitect(request)) return false;
      started.resolve();
      return true;
    } },
    { content: SECOND_REPLY, match: isArchitect },
  ]);
  let app = fixture.app;
  try {
    await fixture.page.getByPlaceholder("Describe the Agents or Team you need…").fill(PROMPT);
    await fixture.chat.getByRole("button", { name: "Submit", exact: true }).click();
    await started.promise;
    await closeDesktop(app);
    release.resolve();
    app = await electron.launch({ args: ["."], cwd: repoRoot,
      env: { ...desktopEnvironment(fixture.paths), PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: "false" } });
    const page = await app.firstWindow();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Teams", exact: true }).click();
    const chat = page.getByRole("region", { name: "Agent Architect chat" });
    await expect(chat.getByText(PROMPT, { exact: true })).toBeVisible();
    await expect(chat.getByText("The app closed before the last reply finished. Your conversation was restored; send a message to continue.", { exact: true })).toBeVisible();
    await expect(chat.getByRole("button", { name: "Stop generation", exact: true })).toHaveCount(0);
    await page.getByPlaceholder("Describe the Agents or Team you need…").fill(FOLLOW_UP);
    await chat.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(chat.getByText(SECOND_REPLY, { exact: true })).toBeVisible();
  } finally {
    release.resolve();
    await closeDesktop(app);
    await fixture.provider.close();
  }
});

test("Create keeps its pending conversation and follow-up context when switching workspaces", async ({}, testInfo) => {
  const started = deferred();
  const release = deferred();
  const fixture = await launchFixture(testInfo, [
    { content: REPLY, gate: release.promise, deltaGates: [release.promise], match: (request) => {
      if (!isArchitect(request)) return false;
      started.resolve();
      return true;
    } },
    { content: SECOND_REPLY, match: isArchitect },
  ]);
  const { app, page, chat, provider } = fixture;
  try {
    await page.getByPlaceholder("Describe the Agents or Team you need…").fill(PROMPT);
    await chat.getByRole("button", { name: "Submit", exact: true }).click();
    await started.promise;

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await expect(chat).toBeHidden();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await expect(chat.getByText(PROMPT, { exact: true })).toBeVisible();
    await expect(chat.getByRole("button", { name: "Stop generation", exact: true })).toBeEnabled();

    // The reply arrives while another workspace is visible.
    await page.getByRole("tab", { name: "Library", exact: true }).click();
    await expect(chat).toBeHidden();
    const firstResponse = page.waitForResponse((response) => response.url().endsWith(TURN_PATH) && response.request().method() === "POST");
    release.resolve();
    expect((await firstResponse).status()).toBe(200);
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await expect(chat.getByText(REPLY, { exact: true })).toBeVisible();

    const followUp = page.waitForRequest((request) => request.url().endsWith(TURN_PATH) && request.method() === "POST");
    await page.getByPlaceholder("Describe the Agents or Team you need…").fill(FOLLOW_UP);
    await chat.getByRole("button", { name: "Submit", exact: true }).click();
    expect((await followUp).postDataJSON()).toMatchObject({
      history: [
        { role: "user", text: PROMPT }, { role: "assistant", text: expect.stringContaining(REPLY) },
        { role: "user", text: FOLLOW_UP },
      ],
    });
    await expect(chat.getByText(SECOND_REPLY, { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await expect(chat.getByText(PROMPT, { exact: true })).toHaveCount(1);
    await expect(chat.getByText(REPLY, { exact: true })).toHaveCount(1);
    await expect(chat.getByText(SECOND_REPLY, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("conversation-after-navigation.png") });

    await page.getByRole("button", { name: "New team", exact: true }).click();
    await expect(chat.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
    await expect(chat.getByText(PROMPT, { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await expect(chat.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
  } finally {
    release.resolve();
    await closeDesktop(app);
    await provider.close();
  }
});

test("a conversation reopened during generation still stops the original turn", async ({}, testInfo) => {
  const started = deferred();
  const release = deferred();
  const { app, page, chat, provider } = await launchFixture(testInfo, [
    { content: REPLY, gate: release.promise, deltaGates: [release.promise], match: (request) => {
      if (!isArchitect(request)) return false;
      started.resolve();
      return true;
    } },
  ]);
  try {
    const response = page.waitForResponse((entry) => entry.url().endsWith(TURN_PATH) && entry.request().method() === "POST");
    await page.getByPlaceholder("Describe the Agents or Team you need…").fill(PROMPT);
    await chat.getByRole("button", { name: "Submit", exact: true }).click();
    await started.promise;
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await chat.getByRole("button", { name: "Stop generation", exact: true }).click();
    await expect(chat.getByRole("button", { name: "Submit", exact: true })).toBeVisible();
    release.resolve();
    expect(await (await response).json()).toMatchObject({ operation: "conversation", cancelled: true });
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await expect(chat.getByText(PROMPT, { exact: true })).toBeVisible();
    await expect(chat.getByText(REPLY, { exact: true })).toHaveCount(0);
    await expect(chat.getByRole("button", { name: "Submit", exact: true })).toBeVisible();
  } finally {
    release.resolve();
    await closeDesktop(app);
    await provider.close();
  }
});

test("an unfinished proposal survives restart but its completed build reopens blank", async ({}, testInfo) => {
  const proposal = {
    message: "Here is the furniture review team.", warnings: [],
    outcome: {
      id: "furniture-proposal", kind: "team",
      team: {
        teamId: "furniture-review", description: "Reviews furniture plans.", tags: [],
        existingAgents: [
          { name: "previous-agent", role: "Lead", rationale: "Already available." },
          { name: "previous-checker", role: "Reviewer", rationale: "Already available." },
        ],
        newAgents: [], documentDomains: null, questionsResolved: [],
        shape: { kind: "chain", rationale: "Prepare and review the plans.", depth: "quick", order: ["previous-agent", "previous-checker"] },
      },
    },
  };
  const fixture = await launchFixture(testInfo, [
    { content: "Preparing your team proposal.\n[[proposal-requested]]", match: isArchitect },
    { content: JSON.stringify(proposal), match: isArchitect },
  ]);
  let { app, page, chat } = fixture;
  try {
    await page.getByPlaceholder("Describe the Agents or Team you need…").fill(PROMPT);
    await chat.getByRole("button", { name: "Submit", exact: true }).click();
    await expect(chat.getByRole("button", { name: "Create", exact: true })).toBeEnabled();
    await closeDesktop(app);
    app = await electron.launch({ args: ["."], cwd: repoRoot,
      env: { ...desktopEnvironment(fixture.paths), PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: "false" } });
    page = await app.firstWindow();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Teams", exact: true }).click();
    chat = page.getByRole("region", { name: "Agent Architect chat" });
    await expect(chat.getByText(PROMPT, { exact: true })).toBeVisible();
    await chat.getByRole("button", { name: "Create", exact: true }).click();
    await expect(chat.getByRole("button", { name: "Open furniture-review", exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await expect(chat.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
    await expect(chat.getByText(PROMPT, { exact: true })).toHaveCount(0);
  } finally {
    await closeDesktop(app);
    await fixture.provider.close();
  }
});

test("a failed Agent update stays readable now but does not survive navigation or New", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const fixture = await launchFixture(testInfo, [
    ...skillUpdateTurns("joinery-skill-plan-first", { failStatus: 500 }),
    ...skillUpdateTurns("joinery-skill-plan-second", { failStatus: 500 }),
  ]);
  let { page, chat } = fixture;
  const { app, provider, paths } = fixture;
  try {
    const composer = () => page.getByPlaceholder("Describe the Agents or Team you need…");
    const card = () => chat.getByLabel(SKILL_CARD, { exact: true });
    // The chat's own error line, told apart from the same message on the card.
    const banner = () => chat.locator(`[role="alert"]:not([aria-label="${SKILL_CARD}"] *)`);
    const reproduceFailure = async () => {
      await composer().fill(SKILL_PROMPT);
      await chat.getByRole("button", { name: "Submit", exact: true }).click();
      await card().getByRole("button", { name: "Apply update", exact: true }).click();
      await expect(card().locator(CARD_STATUS).getByText("failed", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(banner()).toContainText("The skill author did not answer");
      await expect(card().getByRole("button", { name: "Retry", exact: true })).toBeVisible();
    };
    const listJobsAfterRemount = () => page.waitForResponse((response) =>
      response.url().endsWith("/create/resource-architect/jobs") && response.request().method() === "GET");

    await reproduceFailure();

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await expect(chat).toBeHidden();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    // A fresh Create disables its composer until restoration has settled.
    await expect(composer()).toBeEnabled();
    await expect(chat.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
    await expect(card()).toHaveCount(0);
    await expect(banner()).toHaveCount(0);

    await reproduceFailure();
    const remountedJobs = listJobsAfterRemount();
    await page.getByRole("button", { name: "New team", exact: true }).click();
    await remountedJobs;
    await expect(composer()).toBeEnabled();
    await expect(chat.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
    await expect(card()).toHaveCount(0);
    await expect(banner()).toHaveCount(0);

    await page.reload();
    page = await app.firstWindow();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Teams", exact: true }).click();
    chat = page.getByRole("region", { name: "Agent Architect chat" });
    await expect(composer()).toBeEnabled();
    await expect(chat.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
    await expect(chat.getByText(SKILL_PROMPT, { exact: true })).toHaveCount(0);
    await expect(card()).toHaveCount(0);

    // Hiding the failures is not deleting them: both receipts stay on disk
    // while the active conversation record is cleared.
    const activeConversation: unknown = JSON.parse(await readFile(
      join(paths.workspacePath, "resource-architect-conversation", "active.json"), "utf8"));
    expect(activeConversation).toBeNull();
    const receipts = await new ResourceArchitectStore(paths.workspacePath).listJobs();
    expect(receipts.filter((job) => job.planId !== "previous-plan").map((job) => job.status))
      .toEqual(["failed", "failed"]);
  } finally {
    await closeDesktop(app);
    await provider.close();
  }
});

test("a build that fails while another workspace is open is still there to read on return", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const authoring = deferred();
  const release = deferred();
  const fixture = await launchFixture(testInfo, skillUpdateTurns("joinery-skill-plan-hidden", {
    failStatus: 500, gate: release.promise,
    match: (request) => {
      if (!isSkillAuthor(request)) return false;
      authoring.resolve();
      return true;
    },
  }));
  const { app, page, chat, provider } = fixture;
  try {
    const card = chat.getByLabel(SKILL_CARD, { exact: true });
    const banner = chat.locator(`[role="alert"]:not([aria-label="${SKILL_CARD}"] *)`);
    await page.getByPlaceholder("Describe the Agents or Team you need…").fill(SKILL_PROMPT);
    await chat.getByRole("button", { name: "Submit", exact: true }).click();
    await card.getByRole("button", { name: "Apply update", exact: true }).click();
    await authoring.promise;

    // The user leaves while the build runs, and it fails while Run is open.
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await expect(chat).toBeHidden();
    const failedSnapshot = page.waitForResponse(async (response) =>
      /\/create\/resource-architect\/jobs\/[^/]+$/.test(new URL(response.url()).pathname) &&
      response.request().method() === "GET" &&
      z.object({ job: z.object({ status: z.string() }) }).safeParse(await response.json()).data?.job.status === "failed");
    release.resolve();
    await failedSnapshot;
    // The hidden Create has taken the failure in. Role queries skip hidden
    // content, so this one asks for it explicitly.
    const hiddenCard = page.getByRole("region", { name: "Agent Architect chat", includeHidden: true })
      .getByLabel(SKILL_CARD, { exact: true });
    await expect(hiddenCard.locator(CARD_STATUS).getByText("failed", { exact: true })).toBeAttached();

    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await expect(card.locator(CARD_STATUS).getByText("failed", { exact: true })).toBeVisible();
    await expect(banner).toContainText("The skill author did not answer");
    await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible();

    // Read now, so it does not follow the user to the next visit.
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await expect(chat.getByText(EMPTY_MESSAGE, { exact: true })).toBeVisible();
    await expect(card).toHaveCount(0);
  } finally {
    release.resolve();
    await closeDesktop(app);
    await provider.close();
  }
});

test("an API-restart interruption keeps the Agent update recoverable", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const authoring = deferred();
  const release = deferred();
  const fixture = await launchFixture(testInfo, skillUpdateTurns("joinery-skill-plan-restart", {
    content: "The API stopped before this answer.", gate: release.promise,
    match: (request) => {
      if (!isSkillAuthor(request)) return false;
      authoring.resolve();
      return true;
    },
  }));
  let app = fixture.app;
  try {
    await fixture.page.getByPlaceholder("Describe the Agents or Team you need…").fill(SKILL_PROMPT);
    await fixture.chat.getByRole("button", { name: "Submit", exact: true }).click();
    await fixture.chat.getByLabel(SKILL_CARD, { exact: true })
      .getByRole("button", { name: "Apply update", exact: true }).click();
    await authoring.promise;
    await closeDesktop(app);
    release.resolve();

    app = await electron.launch({ args: ["."], cwd: repoRoot,
      env: { ...desktopEnvironment(fixture.paths), PIPELINE_AGENT_ARCHITECT_REVIEW_ENABLED: "false" } });
    const page = await app.firstWindow();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await page.getByLabel("Resource type").getByRole("tab", { name: "Teams", exact: true }).click();
    const chat = page.getByRole("region", { name: "Agent Architect chat" });
    const card = chat.getByLabel(SKILL_CARD, { exact: true });
    await expect(card.locator(CARD_STATUS).getByText("interrupted", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible();

    // Recoverable work stays mounted across workspace navigation. A remount
    // would restore the same card from disk, so the proof is what only the
    // mounted screen holds: a message typed but not sent.
    const composer = page.getByPlaceholder("Describe the Agents or Team you need…");
    await composer.fill(UNSENT_DRAFT);
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await expect(composer).toHaveValue(UNSENT_DRAFT);
    await expect(card.locator(CARD_STATUS).getByText("interrupted", { exact: true })).toBeVisible();
    await expect(card.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
  } finally {
    release.resolve();
    await closeDesktop(app);
    await fixture.provider.close();
  }
});
