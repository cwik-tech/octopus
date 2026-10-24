/**
 * Live OpenRouter acceptance audit for every distinct desktop chat surface.
 *
 * The real provider is required because a deterministic local stream proves
 * wiring, while this suite proves that OpenRouter chunks become visible before
 * the turn finishes. The test copies the existing encrypted connection into an
 * isolated Electron profile; it never reads, prints, or rewrites the API key.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";
import { developmentElectronLaunchOptions } from "../../services/development/development-electron-bundle.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const LIVE_CAPABILITY = "openrouter-streaming";
const GROWTH_TIMEOUT_MS = 180_000;
const LONG_REPLY_PROMPT = [
  "Answer with exactly 24 short numbered lines.",
  "Use a different two-word phrase on every line.",
  "Do not call tools and do not ask questions.",
].join(" ");

interface OpenRouterFixture {
  connection: Record<string, unknown>;
  connectionId: string;
  modelId: string;
  modelName: string;
  version: number;
}

type FixtureDiscovery =
  | { fixture: OpenRouterFixture; reason?: never }
  | { fixture?: never; reason: string };

const fixtureDiscovery = await discoverOpenRouterFixture();
const desktopLaunch = await developmentElectronLaunchOptions(repoRoot);

test("Run Agents shows a selected OpenRouter agent reply growing before completion", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const fixture = requireFixture();
  const paths = await prepareRunPaths(
    testInfo.outputPath.bind(testInfo),
    "run-agent",
    fixture,
  );
  await createLiveAgent(paths.projectRootPath, fixture);
  const session = await new FileSystemSessionStore(
    paths.workspacePath,
  ).createSession({ title: "Live Run Agent Streaming" });
  const app = await launchDesktop(paths);

  try {
    const page = await app.firstWindow();
    await openRunSession(page, session.title);
    await showInspector(page);
    await page.getByRole("button", { name: /^Live Stream Agent/i }).click();

    const chat = page.getByRole("region", { name: "Run chat" });
    await expect(
      chat.getByPlaceholder(/Send a message to the selected agents/i),
    ).toBeVisible();
    await expect(page.getByLabel("Agent chat model")).toContainText(
      fixture.modelName,
    );
    await proveVisibleGrowth(page, {
      scopeSelector: 'section[aria-label="Run chat"]',
      candidateSelector: ".is-assistant",
      busySelector: '[aria-label="Waiting for response"]',
      submit: async () => {
        await chat
          .getByPlaceholder(/Send a message to the selected agents/i)
          .fill(LONG_REPLY_PROMPT);
        await chat.getByRole("button", { name: "Send message" }).click();
      },
    });
  } finally {
    await app.close();
  }
});

test("Create Workflow Architect shows its OpenRouter reply growing before completion", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const fixture = requireFixture();
  const paths = await prepareCreatePaths(
    testInfo.outputPath.bind(testInfo),
    "create-workflow",
    fixture,
  );
  const app = await launchDesktop(paths);

  try {
    const page = await app.firstWindow();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    const chat = page.getByRole("region", { name: "Workflow Architect chat" });
    await expect(page.getByLabel("Workflow Architect model")).toContainText(
      fixture.modelName,
    );
    await proveVisibleGrowth(page, {
      scopeSelector: 'section[aria-label="Workflow Architect chat"]',
      candidateSelector: ".is-assistant",
      busySelector: '[aria-label="Architect is thinking"]',
      submit: async () => {
        await chat
          .getByPlaceholder(/Describe the workflow you want to build/i)
          .fill(LONG_REPLY_PROMPT);
        await chat.getByRole("button", { name: "Submit" }).click();
      },
    });
  } finally {
    await app.close();
  }
});

test("Create Agent Architect shows its OpenRouter reply growing before completion", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const fixture = requireFixture();
  const paths = await prepareCreatePaths(
    testInfo.outputPath.bind(testInfo),
    "create-agent-team",
    fixture,
  );
  const app = await launchDesktop(paths);

  try {
    const page = await app.firstWindow();
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await showInspector(page);
    await page
      .getByRole("tablist", { name: "Resource type" })
      .getByRole("tab", { name: "Agents", exact: true })
      .click();
    const chat = page.getByRole("region", {
      name: "Agent Architect chat",
    });
    await expect(
      page.getByLabel("Agent Architect model"),
    ).toContainText(fixture.modelName);
    await proveVisibleGrowth(page, {
      scopeSelector: 'section[aria-label="Agent Architect chat"]',
      candidateSelector: ".is-assistant",
      busySelector: '[aria-label="Architect is thinking"]',
      submit: async () => {
        await chat
          .getByPlaceholder(/Describe the Agents or Team you need/i)
          .fill(LONG_REPLY_PROMPT);
        await chat.getByRole("button", { name: "Submit" }).click();
      },
    });
  } finally {
    await app.close();
  }
});

test("Run Teams shows OpenRouter participant text growing before the Team finishes", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const fixture = requireFixture();
  const paths = await prepareTeamPaths(testInfo.outputPath.bind(testInfo), fixture);
  const session = await new FileSystemSessionStore(
    paths.workspacePath,
  ).createSession({ title: "Live Run Team Streaming" });
  const app = await launchDesktop(paths);

  try {
    const page = await app.firstWindow();
    await openRunSession(page, session.title);
    await showInspector(page);
    await page
      .getByRole("tablist", { name: "Run target type" })
      .getByRole("tab", { name: "Teams", exact: true })
      .click();
    await page.getByRole("radio", { name: "Line Team" }).click();

    const chat = page.getByRole("region", { name: "Run chat" });
    await proveVisibleGrowth(page, {
      scopeSelector: 'section[aria-label="Run chat"]',
      candidateSelector: ".is-assistant",
      busySelector:
        '[aria-label="Waiting for response"], textarea[placeholder="Wait for the current Team response to finish..."]',
      submit: async () => {
        await chat.getByPlaceholder(/Send a message/i).fill(LONG_REPLY_PROMPT);
        await chat.getByRole("button", { name: "Send message" }).click();
      },
    });
  } finally {
    await app.close();
  }
});

test("Run Workflows shows the OpenRouter receptionist reply growing before completion", async ({}, testInfo) => {
  test.setTimeout(300_000);
  const fixture = requireFixture();
  const paths = await prepareRunPaths(
    testInfo.outputPath.bind(testInfo),
    "run-workflow",
    fixture,
  );
  const session = await new FileSystemSessionStore(
    paths.workspacePath,
  ).createSession({ title: "Live Run Workflow Streaming" });
  const app = await launchDesktop(paths);

  try {
    const page = await app.firstWindow();
    await openRunSession(page, session.title);
    await showInspector(page);
    await page
      .getByRole("tablist", { name: "Run target type" })
      .getByRole("tab", { name: "Workflows", exact: true })
      .click();

    const chat = page.getByRole("region", { name: "Run chat" });
    await expect(page.getByLabel("Run chat model")).toContainText(
      fixture.modelName,
    );
    await proveVisibleGrowth(page, {
      scopeSelector: 'section[aria-label="Run chat"]',
      candidateSelector: ".is-assistant",
      busySelector: '[aria-label="Waiting for response"]',
      submit: async () => {
        await chat.getByPlaceholder(/Send a message/i).fill(LONG_REPLY_PROMPT);
        await chat.getByRole("button", { name: "Send message" }).click();
      },
    });
  } finally {
    await app.close();
  }
});

async function proveVisibleGrowth(
  page: Page,
  options: {
    scopeSelector: string;
    candidateSelector: string;
    busySelector: string;
    submit: () => Promise<void>;
  },
): Promise<void> {
  await page.evaluate(
    ({ busySelector, candidateSelector, scopeSelector, timeoutMs }) => {
      const root = document.body;
      const scope = document.querySelector(scopeSelector);
      if (!(scope instanceof HTMLElement)) {
        throw new Error(`Streaming scope is missing: ${scopeSelector}`);
      }

      const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
      const initialTexts = new Set(
        Array.from(scope.querySelectorAll<HTMLElement>(candidateSelector))
          .map((element) => normalize(element.innerText))
          .filter(Boolean),
      );
      const pendingCopy =
        /Thinking|Preparing|Reviewing|Starting the Team|responding/i;
      let busySeen = false;
      let previous = "";
      const samples: string[] = [];

      root.dataset.liveStreamStatus = "waiting";
      root.dataset.liveStreamDetail = "No reply text has appeared yet.";

      const finish = (
        status: "grown" | "completed" | "error",
        detail: string,
      ) => {
        if (root.dataset.liveStreamStatus !== "waiting") return;
        root.dataset.liveStreamStatus = status;
        root.dataset.liveStreamDetail = detail;
        observer.disconnect();
        window.clearTimeout(timeout);
      };

      const inspect = () => {
        if (root.dataset.liveStreamStatus !== "waiting") return;
        const currentScope = document.querySelector(scopeSelector);
        if (!(currentScope instanceof HTMLElement)) return;
        const busy = currentScope.querySelector(busySelector) !== null;
        if (busy) busySeen = true;

        const alert = currentScope.querySelector<HTMLElement>('[role="alert"]');
        const alertText = normalize(alert?.innerText ?? "");
        if (alertText) {
          finish("error", `The chat failed before visible growth: ${alertText}`);
          return;
        }

        const candidates = Array.from(
          currentScope.querySelectorAll<HTMLElement>(candidateSelector),
        )
          .map((element) => normalize(element.innerText))
          .filter(
            (text) =>
              text.length > 0 &&
              !initialTexts.has(text) &&
              !pendingCopy.test(text),
          );
        const candidate = candidates[candidates.length - 1] ?? "";
        if (candidate && candidate !== previous) {
          samples.push(candidate.slice(0, 160));
          if (
            previous.length > 0 &&
            candidate.length > previous.length &&
            candidate.startsWith(previous)
          ) {
            finish(
              "grown",
              `Visible reply grew from ${previous.length} to ${candidate.length} characters.`,
            );
            return;
          }
          previous = candidate;
        }

        if (busySeen && !busy && previous) {
          finish(
            "completed",
            `The reply completed without two increasing visible states. Samples: ${samples.join(" | ")}`,
          );
        }
      };

      const observer = new MutationObserver(inspect);
      observer.observe(root, {
        childList: true,
        characterData: true,
        subtree: true,
      });
      const timeout = window.setTimeout(() => {
        finish(
          "completed",
          `Timed out without two increasing visible states. Samples: ${samples.join(" | ") || "none"}`,
        );
      }, timeoutMs);
      inspect();
    },
    {
      busySelector: options.busySelector,
      candidateSelector: options.candidateSelector,
      scopeSelector: options.scopeSelector,
      timeoutMs: GROWTH_TIMEOUT_MS,
    },
  );

  await options.submit();
  await page.waitForFunction(
    () => document.body.dataset.liveStreamStatus !== "waiting",
    undefined,
    { timeout: GROWTH_TIMEOUT_MS + 5_000 },
  );
  const result = await page.evaluate(() => ({
    detail: document.body.dataset.liveStreamDetail ?? "No diagnostic was recorded.",
    status: document.body.dataset.liveStreamStatus ?? "missing",
  }));
  expect(result.status, result.detail).toBe("grown");
}

async function prepareCreatePaths(
  outputPath: (name: string) => string,
  prefix: string,
  fixture: OpenRouterFixture,
): Promise<DesktopPaths> {
  const paths = {
    projectRootPath: repoRoot,
    userDataPath: outputPath(`${prefix}-user-data`),
    workspacePath: outputPath(`${prefix}-workspace`),
  };
  await Promise.all([
    fs.mkdir(paths.workspacePath, { recursive: true }),
    seedProviderSettings(paths.userDataPath, fixture),
  ]);
  return paths;
}

async function prepareRunPaths(
  outputPath: (name: string) => string,
  prefix: string,
  fixture: OpenRouterFixture,
): Promise<DesktopPaths> {
  const paths = {
    projectRootPath: outputPath(`${prefix}-project`),
    userDataPath: outputPath(`${prefix}-user-data`),
    workspacePath: outputPath(`${prefix}-workspace`),
  };
  await Promise.all([
    fs.mkdir(path.join(paths.projectRootPath, "agents"), { recursive: true }),
    fs.mkdir(path.join(paths.projectRootPath, "workflows"), { recursive: true }),
    fs.mkdir(paths.workspacePath, { recursive: true }),
    seedProviderSettings(paths.userDataPath, fixture),
  ]);
  await Promise.all([
    fs.writeFile(
      path.join(paths.projectRootPath, "teams.yaml"),
      "{}\n",
      "utf8",
    ),
    fs.writeFile(
      path.join(paths.projectRootPath, "workflows", "registry.yaml"),
      "{}\n",
      "utf8",
    ),
  ]);
  return paths;
}

async function prepareTeamPaths(
  outputPath: (name: string) => string,
  fixture: OpenRouterFixture,
): Promise<DesktopPaths> {
  const paths = {
    projectRootPath: outputPath("run-team-project"),
    userDataPath: outputPath("run-team-user-data"),
    workspacePath: outputPath("run-team-workspace"),
  };
  await Promise.all([
    fs.cp(
      path.join(repoRoot, "tests", "fixtures", "team-chat-e2e"),
      paths.projectRootPath,
      { recursive: true },
    ),
    fs.mkdir(paths.workspacePath, { recursive: true }),
    seedProviderSettings(paths.userDataPath, fixture),
  ]);
  const providerName = `connection:${fixture.connectionId}`;
  const registryPath = path.join(paths.projectRootPath, "teams.yaml");
  const teamPath = path.join(
    paths.projectRootPath,
    "teams",
    "line-team",
    "team.yaml",
  );
  const [registrySource, teamSource] = await Promise.all([
    fs.readFile(registryPath, "utf8"),
    fs.readFile(teamPath, "utf8"),
  ]);
  await Promise.all([
    // A configured connection is an agent provider, not a supported Team host
    // bridge. Codex only starts the Team runtime; every visible participant
    // reply below still uses the selected OpenRouter connection.
    fs.writeFile(
      registryPath,
      registrySource.replaceAll(
        "host_provider: openai",
        "host_provider: codex",
      ),
      "utf8",
    ),
    fs.writeFile(
      teamPath,
      teamSource
        .replaceAll("provider: openai", `provider: ${providerName}`)
        .replaceAll("model: gpt-5.4-mini", `model: ${fixture.modelId}`),
      "utf8",
    ),
  ]);
  await Promise.all(
    ["line-one", "line-two"].map(async (agentName) => {
      const agentPath = path.join(
        paths.projectRootPath,
        "agents",
        agentName,
        `${agentName}.md`,
      );
      await fs.writeFile(
        agentPath,
        `You are ${agentName}. Answer every request with at least 24 short numbered lines. Do not call tools or access the network.\n`,
        "utf8",
      );
    }),
  );
  return paths;
}

async function createLiveAgent(
  projectRootPath: string,
  fixture: OpenRouterFixture,
): Promise<void> {
  const directory = path.join(projectRootPath, "agents", "live-stream-agent");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, "live-stream-agent.md"),
    [
      "---",
      "name: live-stream-agent",
      "description: Live OpenRouter streaming acceptance fixture.",
      "tier: execution",
      `provider: connection:${fixture.connectionId}`,
      `model: ${fixture.modelId}`,
      "thinking: low",
      "tools: none",
      "---",
      "",
      "# Live Stream Agent",
      "",
      "Answer with at least 24 short numbered lines. Do not call tools.",
      "",
    ].join("\n"),
    "utf8",
  );
}

interface DesktopPaths {
  projectRootPath: string;
  userDataPath: string;
  workspacePath: string;
}

async function launchDesktop(
  paths: DesktopPaths,
): Promise<ElectronApplication> {
  return electron.launch({
    args: desktopLaunch.executablePath ? [desktopLaunch.electronCliPath] : ["."],
    cwd: repoRoot,
    ...(desktopLaunch.executablePath
      ? { executablePath: desktopLaunch.executablePath }
      : {}),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PIPELINE_DESKTOP_E2E: "1",
      PIPELINE_DESKTOP_PROJECT_ROOT: paths.projectRootPath,
      PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
      PIPELINE_DESKTOP_USER_DATA: paths.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: paths.workspacePath,
    },
  });
}

async function openRunSession(page: Page, title: string): Promise<void> {
  await page.getByRole("tab", { name: "Run", exact: true }).click();
  await page
    .getByRole("button", {
      name: new RegExp(`^${escapeRegExp(title)}\\b`),
    })
    .first()
    .click();
}

async function showInspector(page: Page): Promise<void> {
  const show = page.getByRole("button", { name: "Show inspector" });
  if (await show.isVisible()) await show.click();
}

async function seedProviderSettings(
  userDataPath: string,
  fixture: OpenRouterFixture,
): Promise<void> {
  await fs.mkdir(userDataPath, { recursive: true });
  const rawModels = fixture.connection.models;
  if (!Array.isArray(rawModels)) {
    throw new Error("The selected OpenRouter connection has no model catalog.");
  }
  const models = rawModels.map((model) =>
    isRecord(model)
      ? { ...model, enabled: model.id === fixture.modelId }
      : model,
  );
  await fs.writeFile(
    path.join(userDataPath, "provider-settings.json"),
    JSON.stringify(
      {
        version: fixture.version,
        connections: [
          {
            ...fixture.connection,
            enabled: true,
            status: "connected",
            models,
          },
        ],
        cliEnabled: {},
        cliModelEnabled: {},
        defaultModel: {
          provider: `connection:${fixture.connectionId}`,
          model: fixture.modelId,
        },
      },
      null,
      2,
    ),
    { encoding: "utf8", mode: 0o600 },
  );
}

function requireFixture(): OpenRouterFixture {
  if (fixtureDiscovery.fixture) return fixtureDiscovery.fixture;
  const reason = fixtureDiscovery.reason;
  const required = new Set(
    (process.env.PIPELINE_LIVE_REQUIRE ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (required.has("all") || required.has(LIVE_CAPABILITY)) {
    throw new Error(
      `Required live capability '${LIVE_CAPABILITY}' is unavailable: ${reason}`,
    );
  }
  test.skip(true, reason);
  throw new Error(reason);
}

async function discoverOpenRouterFixture(): Promise<FixtureDiscovery> {
  const sourcePath = configuredSettingsPath();
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(sourcePath, "utf8"));
    if (!isRecord(parsed) || !Array.isArray(parsed.connections)) {
      return {
        reason: `Provider settings at ${sourcePath} have no connection list.`,
      };
    }
    const connection = parsed.connections.find(
      (candidate) =>
        isRecord(candidate) &&
        candidate.kind === "openrouter" &&
        candidate.enabled === true &&
        candidate.status === "connected",
    );
    if (!isRecord(connection)) {
      return {
        reason: `No enabled, connected OpenRouter connection exists in ${sourcePath}.`,
      };
    }
    if (
      typeof connection.id !== "string" ||
      typeof connection.encryptedApiKey !== "string" ||
      connection.encryptedApiKey.length === 0 ||
      !Array.isArray(connection.models)
    ) {
      return {
        reason:
          "The connected OpenRouter setting has no reusable encrypted key or model catalog.",
      };
    }

    const enabledModels = connection.models.filter(
      (candidate): candidate is Record<string, unknown> =>
        isRecord(candidate) &&
        candidate.enabled === true &&
        typeof candidate.id === "string" &&
        typeof candidate.name === "string",
    );
    const preferredModel = process.env.PIPELINE_LIVE_OPENROUTER_MODEL?.trim();
    const model =
      enabledModels.find((candidate) => candidate.id === preferredModel) ??
      enabledModels.find(
        (candidate) => candidate.id === "google/gemini-3.6-flash",
      ) ??
      enabledModels.find((candidate) =>
        typeof candidate.id === "string" && candidate.id.endsWith(":free"),
      ) ??
      enabledModels[0];
    if (
      !model ||
      typeof model.id !== "string" ||
      typeof model.name !== "string"
    ) {
      return {
        reason: "The connected OpenRouter setting has no enabled chat model.",
      };
    }

    return {
      fixture: {
        connection,
        connectionId: connection.id,
        modelId: model.id,
        modelName: model.name,
        version: typeof parsed.version === "number" ? parsed.version : 3,
      },
    };
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    return { reason: `Could not read the configured OpenRouter settings: ${detail}` };
  }
}

function configuredSettingsPath(): string {
  const override = process.env.PIPELINE_LIVE_OPENROUTER_SETTINGS_PATH?.trim();
  if (override) return path.resolve(override);
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "pipeline-template",
      "provider-settings.json",
    );
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA?.trim();
    return path.join(
      appData || path.join(os.homedir(), "AppData", "Roaming"),
      "pipeline-template",
      "provider-settings.json",
    );
  }
  const configHome =
    process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(configHome, "pipeline-template", "provider-settings.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
