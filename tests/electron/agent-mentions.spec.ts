import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { fixtureDesktopEnvironment } from "../support/desktop-journey-environment.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { startOpenAiToolLoopFixture } from "../support/openai-tool-loop-fixture.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

test("a new chat searches the full agent catalog in a focused, scrollable mention menu", async ({}, testInfo) => {
  const userDataPath = testInfo.outputPath("new-chat-user-data");
  const projectRoot = testInfo.outputPath("new-chat-project");
  const workspacePath = testInfo.outputPath("new-chat-workspace");
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.mkdir(workspacePath, { recursive: true });
  for (let index = 0; index < 24; index += 1) {
    await createFixtureAgent(projectRoot, `catalog-agent-${String(index).padStart(2, "0")}`, "CATALOG_FIXTURE");
  }
  const app = await launchDesktop({ projectRoot, userDataPath, workspacePath });
  const page = await app.firstWindow();

  try {
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    const composer = page.getByPlaceholder("Send a message...");
    await composer.pressSequentially("Ask @");

    const search = page.getByRole("combobox", { name: "Search agents to mention" });
    const menu = page.getByRole("listbox", { name: "Agent mentions" });
    await expect(search).toBeFocused();
    const apiBaseUrl = await page.evaluate(() => new URLSearchParams(window.location.hash.slice(1)).get("pipeline-api-base-url"));
    if (!apiBaseUrl) throw new Error("Desktop API URL is unavailable");
    const catalogResponse = await page.request.get(`${apiBaseUrl}/create/agents`, { timeout: 5_000 });
    expect(catalogResponse.ok()).toBe(true);
    const catalog = z.object({ agents: z.array(z.object({ name: z.string() })) }).parse(await catalogResponse.json());
    await expect(menu.getByRole("option")).toHaveCount(catalog.agents.length);
    await page.screenshot({ path: testInfo.outputPath("mention-full-catalog.png") });
    await search.fill("catalog agent");
    await expect(menu.getByRole("option")).toHaveCount(24);
    const bounds = await menu.boundingBox();
    if (!bounds) throw new Error("Mention menu has no visible bounds");
    expect(bounds.height).toBeLessThanOrEqual(288);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(await menu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);

    await search.press("ArrowUp");
    await expect(menu.getByRole("option", { name: "Catalog Agent 23", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect.poll(() => menu.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    await expect(search).toBeVisible();
    await search.fill("Agent 23");
    await expect(menu.getByRole("option")).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("mention-search.png") });
    await search.press("Enter");
    await expect(composer).toHaveValue("Ask @catalog-agent-23 ");
    await expect(composer).toBeFocused();
    await expect(menu).toHaveCount(0);

    await composer.pressSequentially("and @");
    await expect(search).toBeFocused();
    await expect(search).toHaveValue("");
    await search.fill("does not exist");
    await search.press("Enter");
    await expect(menu).toBeVisible();
    await expect(composer).toHaveValue("Ask @catalog-agent-23 and @");
    await search.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(composer).toBeFocused();
  } finally {
    await app.close();
  }
});

test("Run Chat inserts an agent mention from the composer dropdown without changing the agent sidebar", async ({}, testInfo) => {
  const userDataPath = testInfo.outputPath("agent-mentions-user-data");
  const projectRoot = testInfo.outputPath("agent-mentions-project");
  const workspacePath = testInfo.outputPath("agent-mentions-workspace");
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(workspacePath, { recursive: true }),
    copyAgent(projectRoot, "problem-decomposer"),
    copyAgent(projectRoot, "contrarian"),
    copyAgent(projectRoot, "brief-builder"),
  ]);

  const sessionStore = new FileSystemSessionStore(workspacePath);
  const session = await sessionStore.createSession({
    title: "Agent mention participant E2E",
  });
  await sessionStore.appendChatMessage(session.id, {
    id: "problem-decomposer-participant",
    role: "assistant",
    text: "I decomposed the problem into testable parts.",
    createdAt: "2026-08-07T12:00:00.000Z",
    speaker: {
      type: "agent",
      id: "problem-decomposer",
      name: "Problem Decomposer",
    },
  });
  await sessionStore.appendChatMessage(session.id, {
    id: "contrarian-participant",
    role: "assistant",
    text: "I challenged the initial assumptions.",
    createdAt: "2026-08-07T12:00:01.000Z",
    speaker: {
      type: "agent",
      id: "contrarian",
      name: "Contrarian",
    },
  });

  const app = await launchDesktop({
    projectRoot,
    userDataPath,
    workspacePath,
  });
  const page = await app.firstWindow();

  try {
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await page
      .getByRole("button", { name: /^Agent mention participant E2E\b/ })
      .first()
      .click();

    await expect(page.getByRole("button", { name: "Search Agents", exact: true })).toBeVisible();
    const input = page.getByPlaceholder("Send a message...");
    await expect(input).toBeEnabled();
    await input.click();
    await input.pressSequentially("@");

    const menu = page.getByRole("listbox", { name: "Agent mentions" });
    await expect(menu).toBeVisible();
    const search = page.getByRole("combobox", { name: "Search agents to mention" });
    await expect(search).toBeFocused();
    const contrarianOption = menu.getByRole("option", {
      name: "Contrarian",
      exact: true,
    });
    const problemDecomposerOption = menu.getByRole("option", {
      name: "Problem Decomposer",
      exact: true,
    });
    await expect(contrarianOption).toHaveAttribute("aria-selected", "true");
    await expect(problemDecomposerOption).toBeVisible();
    await expect(menu.getByRole("group", { name: "In this chat" }).getByRole("option")).toHaveText(["Contrarian", "Problem Decomposer"]);
    await expect(menu.getByRole("group", { name: "Other agents" }).getByRole("option", { name: "Brief Builder", exact: true })).toBeVisible();
    await expect(menu.getByRole("group", { name: "Other agents" }).getByRole("option", { name: "Contrarian", exact: true })).toHaveCount(0);
    const inactiveBackground = await problemDecomposerOption.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(
      await contrarianOption.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).not.toBe(inactiveBackground);

    await search.press("ArrowDown");
    await expect(problemDecomposerOption).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect.poll(async () =>
      problemDecomposerOption.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    ).not.toBe(
      await contrarianOption.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      ),
    );

    const [inputBox, menuBox] = await Promise.all([
      input.boundingBox(),
      menu.boundingBox(),
    ]);
    expect(inputBox).not.toBeNull();
    expect(menuBox).not.toBeNull();
    if (!inputBox || !menuBox) throw new Error("Composer or mention menu has no visible bounds");
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(inputBox.y + 1);
    expect(menuBox.width).toBeLessThanOrEqual(480);

    await page.screenshot({ path: testInfo.outputPath("mention-groups.png") });
    await search.press("Enter");
    await expect(input).toHaveValue("@problem-decomposer ");
    await expect(menu).toHaveCount(0);

    await input.fill("");
    await input.pressSequentially("@");
    await menu.getByRole("option", { name: "Contrarian", exact: true }).click();
    await expect(input).toHaveValue("@contrarian ");
    await expect(
      page.getByRole("button", { name: "Search Agents" }),
    ).toBeVisible();

    // The full catalog remains available when switching target tabs.
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();
    const workflowInput = page.getByPlaceholder("Send a message...");
    await workflowInput.fill("");
    await workflowInput.pressSequentially("Ask @");
    await expect(
      page.getByRole("listbox", { name: "Agent mentions" }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});

test("Run Chat routes mentions through the loopback API while preserving the limit and sidebar fallback", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const requestLogPath = testInfo.outputPath("agent-mentions-provider.jsonl");
  const providerFixture = await startOpenAiToolLoopFixture(repoRoot, undefined, {
    env: { PROVIDER_FIXTURE_REQUEST_LOG: requestLogPath },
  });
  const userDataPath = testInfo.outputPath("agent-mention-routing-user-data");
  const projectRoot = testInfo.outputPath("agent-mention-routing-project");
  const providerSecret = `agent-mentions-secret-${Date.now()}`;
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    createFixtureAgent(projectRoot, "mention-target", "MENTION_TARGET_SYSTEM_MARKER"),
    createFixtureAgent(projectRoot, "mention-sidebar", "MENTION_SIDEBAR_SYSTEM_MARKER"),
    ...Array.from({ length: 9 }, (_, index) =>
      createFixtureAgent(
        projectRoot,
        `mention-limit-${index + 1}`,
        `MENTION_LIMIT_${index + 1}_SYSTEM_MARKER`,
      ),
    ),
  ]);

  const app = await launchDesktop({
    projectRoot,
    userDataPath,
    env: {
      OPENAI_API_KEY: providerSecret,
      OPENAI_BASE_URL: `${providerFixture.url}/v1`,
    },
  });
  const page = await app.firstWindow();

  try {
    await configureProvider(page, providerFixture.url, providerSecret);
    await page.getByRole("tab", { name: "Run", exact: true }).click();

    // One composer, addressed by target rather than by mode, so it is located
    // by role instead of by a placeholder that used to name the mode.
    const input = page.getByRole("textbox").last();
    const sendButton = page.getByRole("button", { name: "Send message" });
    await expect(input).toBeEnabled();
    await input.fill(
      `${Array.from(
        { length: 9 },
        (_, index) => `@mention-limit-${index + 1}`,
      ).join(" ")} review this`,
    );
    await sendButton.click();
    await expect(
      page.getByText("A message can mention up to 8 agents."),
    ).toBeVisible();
    expect(await providerRequestCount(requestLogPath, "MENTION_LIMIT_")).toBe(0);

    await page.getByRole("button", { name: "Search Agents" }).click();
    const search = page.getByRole("searchbox", { name: "Search Agents" });
    await search.fill("mention-sidebar");
    const mentionSidebar = page.getByRole("button", {
      name: /^Mention Sidebar/i,
    });
    await mentionSidebar.click();
    await expect(mentionSidebar).toHaveAttribute("aria-pressed", "true");

    await input.fill("Ask @mention-target to review this.");
    await sendButton.click();
    // One displayed turn: a buffered tool-capable round, then the streamed
    // tool-free request that carries the answer.
    await expect.poll(async () =>
      providerRequestKinds(requestLogPath, "MENTION_TARGET_SYSTEM_MARKER"),
    ).toEqual(["buffered", "streamed final"]);
    await expect(sendButton).toBeEnabled();
    await expect(
      page.getByText("Ask @mention-target to review this.", { exact: true }),
    ).toBeVisible();
    expect(
      await providerRequestCount(requestLogPath, "MENTION_SIDEBAR_SYSTEM_MARKER"),
    ).toBe(0);

    await input.fill("Use the selected sidebar agent for this follow-up.");
    await sendButton.click();
    await expect.poll(async () =>
      providerRequestKinds(requestLogPath, "MENTION_SIDEBAR_SYSTEM_MARKER"),
    ).toEqual(["buffered", "streamed final"]);
    await expect(sendButton).toBeEnabled();
  } finally {
    await app.close();
    await providerFixture.close();
  }
});

async function copyAgent(projectRoot: string, name: string): Promise<void> {
  const directory = path.join(projectRoot, "agents", name);
  await fs.mkdir(directory, { recursive: true });
  await fs.copyFile(
    path.join(repoRoot, "agents", name, `${name}.md`),
    path.join(directory, `${name}.md`),
  );
}

async function createFixtureAgent(
  projectRoot: string,
  name: string,
  marker: string,
): Promise<void> {
  const directory = path.join(projectRoot, "agents", name);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, `${name}.md`),
    [
      "---",
      `name: ${name}`,
      `description: Deterministic ${name} mention-routing fixture.`,
      "tier: strategic",
      "provider: openai",
      "model: fixture/tool-loop",
      "thinking: low",
      "---",
      "",
      `# ${name}`,
      "",
      marker,
      "",
    ].join("\n"),
    "utf8",
  );
}

async function configureProvider(
  page: Page,
  providerUrl: string,
  providerSecret: string,
): Promise<void> {
  await page.getByLabel("Settings").click();
  await expect(page.getByRole("heading", { name: "AI Providers" })).toBeVisible();
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await page.getByLabel("Connection type").selectOption("openai-compatible");
  await page.getByLabel("Name").fill("Mention Fixture Provider");
  await page.getByLabel("Base URL").fill(`${providerUrl}/v1`);
  await page.getByRole("textbox", { name: "API key", exact: true }).fill(providerSecret);
  await page.getByRole("button", { name: "Save & Validate" }).click();
  await page.getByRole("button", { name: /^Mention Fixture Provider/ }).click();
  await page.getByRole("switch", { name: "Enable fixture/tool-loop" }).click();
  await page.getByRole("button", { name: "Close" }).click();
}

async function readProviderRequests(filePath: string): Promise<unknown[]> {
  try {
    return (await fs.readFile(filePath, "utf8"))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function providerRequestCount(
  filePath: string,
  marker: string,
): Promise<number> {
  return (await readProviderRequests(filePath)).filter((request) =>
    JSON.stringify(request).includes(marker),
  ).length;
}

/** How each request carrying `marker` was asked, in arrival order. */
async function providerRequestKinds(
  filePath: string,
  marker: string,
): Promise<string[]> {
  return (await readProviderRequests(filePath))
    .filter((request) => JSON.stringify(request).includes(marker))
    .map((request) => (isStreamedFinalRequest(request) ? "streamed final" : "buffered"));
}

function isStreamedFinalRequest(request: unknown): boolean {
  return (
    typeof request === "object" &&
    request !== null &&
    "stream" in request &&
    request.stream === true &&
    "tool_choice" in request &&
    request.tool_choice === "none"
  );
}

async function launchDesktop(params: {
  projectRoot: string;
  userDataPath: string;
  workspacePath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ElectronApplication> {
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null;
  return electron.launch({
    args: executablePath
      ? ["--disable-gpu", "--no-sandbox"]
      : [".", "--disable-gpu", "--no-sandbox"],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...fixtureDesktopEnvironment(),
      PIPELINE_DESKTOP_E2E: "1",
      PIPELINE_DESKTOP_PROJECT_ROOT: params.projectRoot,
      PIPELINE_DESKTOP_USER_DATA: params.userDataPath,
      ...(params.workspacePath
        ? { PIPELINE_DESKTOP_WORKSPACE_PATH: params.workspacePath }
        : {}),
      ...params.env,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  });
}
