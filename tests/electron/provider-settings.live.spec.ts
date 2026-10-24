import { _electron as electron, expect, test, type Page } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { loadDotEnv } from "../../core/env-loader.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
loadDotEnv(process.env.PIPELINE_LIVE_ENV_DIR?.trim() || repoRoot);

const LM_STUDIO_BASE_URL =
  process.env.LM_STUDIO_BASE_URL?.trim() || "http://127.0.0.1:1234/v1";
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const lmStudioModels = await readLiveModels(`${LM_STUDIO_BASE_URL}/models`);
const lmStudioModel = selectLiveModel(
  lmStudioModels,
  process.env.LM_STUDIO_LIVE_MODEL,
);
const lmStudioModelForTest = lmStudioModel as LiveModel;
const openRouterModels = await readLiveModels(`${OPENROUTER_BASE_URL}/models`);
const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();

test.describe.configure({ mode: "serial" });

test("live OpenRouter rejects an invalid API key and keeps models hidden", async ({}, testInfo) => {
  requireOrSkip(
    openRouterModels.length > 0,
    "openrouter-network",
    "OpenRouter live model endpoint is unreachable",
  );
  const userDataPath = testInfo.outputPath("openrouter-invalid-user-data");
  const app = await launchDesktop(userDataPath);
  const page = await app.firstWindow();
  try {
    await openSettings(page);
    await addConnection(page, {
      kind: "openrouter",
      name: "OpenRouter Invalid Live",
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: `invalid-live-key-${Date.now()}`,
    });
    await page.getByRole("button", { name: "Save & Validate" }).click();
    await expect(page.getByText(/^HTTP 401/i)).toBeVisible();
    await expect(page.getByPlaceholder("Search models...")).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("live LM Studio survives restart, protects its key, and feeds every shared picker", async ({}, testInfo) => {
  requireOrSkip(
    Boolean(lmStudioModel),
    "lm-studio",
    "LM Studio is not running with a usable chat model",
  );
  const userDataPath = testInfo.outputPath("lm-studio-user-data");
  const secret = `live-safe-storage-${Date.now()}`;
  await fs.mkdir(userDataPath, { recursive: true });

  let app = await launchDesktop(userDataPath);
  let page = await app.firstWindow();
  try {
    await openSettings(page);
    for (const [agent, logo] of [
      ["codex", "codex"],
      ["claude", "claudecode"],
      ["gemini", "geminicli"],
      ["kimi-cli", "moonshot"],
      ["qwen", "qwen"],
      ["pi", "pi"],
    ] as const) {
      await expect(
        page.locator(
          `[data-cli-agent="${agent}"] [data-provider-logo="${logo}"]`,
        ),
      ).toBeVisible();
    }
    await addConnection(page, {
      kind: "openai-compatible",
      name: "LM Studio Secure Live",
      baseUrl: LM_STUDIO_BASE_URL,
      apiKey: secret,
    });
    await expect(page.getByLabel(`Enable ${lmStudioModelForTest.name}`)).toHaveCount(0);
    await page.getByRole("button", { name: "Save & Validate" }).click();
    await page.getByRole("button", { name: /LM Studio Secure Live/ }).click();
    await expect(page.getByLabel(`Enable ${lmStudioModelForTest.name}`)).toBeVisible();

    const search = page.getByPlaceholder("Search models...");
    await search.fill(lmStudioModelForTest.id);
    await expect(page.getByLabel(`Enable ${lmStudioModelForTest.name}`)).toBeVisible();
    await search.fill("model-that-does-not-exist-live-contract");
    await expect(page.getByText("No models match.")).toBeVisible();
    await search.fill("");
    await page.getByLabel(`Enable ${lmStudioModelForTest.name}`).click();
    await page.getByRole("button", { name: "Close" }).click();

    await page.getByRole("tab", { name: "Create" }).click();
    await expectModelInPicker(page, "Workflow Architect model", lmStudioModelForTest.name);

    await page.getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByRole("tab", { name: "Teams" }).click();
    await expectModelInPicker(page, "Team Architect model", lmStudioModelForTest.name);
    const teamButton = page.getByRole("button", { name: /writing-team/i }).first();
    if (await teamButton.isVisible().catch(() => false)) {
      await teamButton.click();
      await expectModelInPicker(page, "Strategic model", lmStudioModelForTest.name);
      await page.getByLabel("Add agent").click();
      await expectModelInPicker(page, "Agent model", lmStudioModelForTest.name);
      await page.getByRole("button", { name: "Cancel" }).click();
    }

    await page.getByRole("tab", { name: "Agents" }).click();
    await expectModelInPicker(page, "Agent Architect model", lmStudioModelForTest.name);
    const agentButton = page.getByRole("button", { name: /contrarian/i }).first();
    if (await agentButton.isVisible().catch(() => false)) {
      await agentButton.click();
      await expectModelInPicker(page, "Agent model", lmStudioModelForTest.name);
    }

    await page.getByRole("tab", { name: "Run" }).click();
    await page.getByLabel("New chat").click();
    await expectModelInPicker(page, "Agent chat model", lmStudioModelForTest.name);
  } finally {
    await app.close();
  }

  const persisted = await fs.readFile(
    path.join(userDataPath, "provider-settings.json"),
    "utf8",
  );
  expect(persisted).not.toContain(secret);

  app = await launchDesktop(userDataPath);
  page = await app.firstWindow();
  try {
    await openSettings(page);
    await expect(page.getByText("LM Studio Secure Live", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /LM Studio Secure Live/ }).click();
    await expect(page.getByLabel(`Enable ${lmStudioModelForTest.name}`)).toBeVisible();
    await page.getByRole("button", { name: "Validate" }).click();
    await expect(page.getByText(/enabled ·/)).toBeVisible();

    await page.getByLabel("Enable LM Studio Secure Live").click();
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("tab", { name: "Create" }).click();
    await page.getByLabel("Workflow Architect model").click();
    await expect(page.getByText(lmStudioModelForTest.name, { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");

    await openSettings(page);
    await page.getByLabel("Enable LM Studio Secure Live").click();
    await page.getByRole("button", { name: /LM Studio Secure Live/ }).click();
    await page.getByLabel(`Enable ${lmStudioModelForTest.name}`).click();
    await page.getByLabel(`Enable ${lmStudioModelForTest.name}`).click();
    await page.getByRole("button", { name: "Close" }).click();
    await expectModelInPicker(page, "Workflow Architect model", lmStudioModelForTest.name);

    await openSettings(page);
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByLabel("Delete LM Studio Secure Live").click();
    await expect(page.getByText("LM Studio Secure Live", { exact: true })).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test("live OpenRouter supports search, Free only, enablement, and shared picker publication", async ({}, testInfo) => {
  requireOrSkip(Boolean(openRouterKey), "openrouter", "OPENROUTER_API_KEY is not configured");
  requireOrSkip(
    openRouterModels.length > 0,
    "openrouter-network",
    "OpenRouter live model endpoint is unreachable",
  );
  const freeModel =
    openRouterModels.find((model) => model.id === "openrouter/free") ??
    openRouterModels.find((model) => model.free);
  const paidModel = openRouterModels.find((model) => !model.free);
  requireOrSkip(
    Boolean(freeModel && paidModel),
    "openrouter",
    "OpenRouter did not expose both free and paid models",
  );
  const selectedFreeModel = freeModel as LiveModel;
  const selectedPaidModel = paidModel as LiveModel;

  const userDataPath = testInfo.outputPath("openrouter-live-user-data");
  const app = await launchDesktop(userDataPath);
  const page = await app.firstWindow();
  try {
    await openSettings(page);
    await addConnection(page, {
      kind: "openrouter",
      name: "OpenRouter Live",
      baseUrl: OPENROUTER_BASE_URL,
      apiKey: openRouterKey as string,
    });
    await page.getByRole("button", { name: "Save & Validate" }).click();
    await page.getByRole("button", { name: /OpenRouter Live/ }).click();
    const search = page.getByPlaceholder("Search models...");
    await search.fill(selectedFreeModel.id);
    await expect(page.getByLabel(`Enable ${selectedFreeModel.name}`)).toBeVisible();
    await page.getByText("Free only").click();
    await expect(page.getByLabel(`Enable ${selectedFreeModel.name}`)).toBeVisible();
    await search.fill(selectedPaidModel.id);
    await expect(page.getByText("No models match.")).toBeVisible();
    await page.getByText("Free only").click();
    await expect(page.getByLabel(`Enable ${selectedPaidModel.name}`)).toBeVisible();
    await search.fill(selectedFreeModel.id);
    await page.getByLabel(`Enable ${selectedFreeModel.name}`).click();
    await page.getByRole("button", { name: "Close" }).click();
    await page.getByRole("tab", { name: "Create" }).click();
    await expectModelInPicker(page, "Workflow Architect model", selectedFreeModel.name);
  } finally {
    await app.close();
  }
});

async function launchDesktop(userDataPath: string) {
  await fs.mkdir(userDataPath, { recursive: true });
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null;
  return electron.launch({
    args: executablePath ? [] : ["."],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...process.env,
      PIPELINE_DESKTOP_E2E: "1",
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
    },
  });
}

async function openSettings(page: Page): Promise<void> {
  await page.getByLabel("Settings").click();
  await expect(page.getByRole("heading", { name: "AI Providers" })).toBeVisible();
}

async function addConnection(
  page: Page,
  connection: {
    kind: "openrouter" | "openai-compatible";
    name: string;
    baseUrl: string;
    apiKey: string;
  },
): Promise<void> {
  await page.getByRole("button", { name: "Add" }).click();
  await page.getByLabel("Connection type").selectOption(connection.kind);
  await page.getByLabel("Name").fill(connection.name);
  await page.getByLabel("Base URL").fill(connection.baseUrl);
  await page
    .getByRole("textbox", { name: "API key", exact: true })
    .fill(connection.apiKey);
}

async function expectModelInPicker(
  page: Page,
  label: string,
  modelName: string,
): Promise<void> {
  const trigger = page.getByLabel(label);
  await expect(trigger).toBeVisible();
  await expect(trigger).toBeEnabled();
  await trigger.click();
  await expect(page.getByText(modelName, { exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
}

interface LiveModel {
  id: string;
  name: string;
  free: boolean;
}

async function readLiveModels(url: string): Promise<LiveModel[]> {
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      data?: Array<{
        id?: string;
        name?: string;
        pricing?: { prompt?: string; completion?: string };
      }>;
    };
    return (payload.data ?? [])
      .filter((model): model is typeof model & { id: string } => Boolean(model.id))
      .map((model) => ({
        id: model.id,
        name: model.name || model.id,
        free:
          Number(model.pricing?.prompt) === 0 &&
          Number(model.pricing?.completion) === 0,
      }));
  } catch {
    return [];
  }
}

function selectLiveModel(
  models: LiveModel[],
  preferred: string | undefined,
): LiveModel | undefined {
  if (preferred) return models.find((model) => model.id === preferred);
  return (
    models.find((model) => model.id.includes("gemma-4-e4b")) ??
    models.find(
      (model) =>
        !/embed|embedding|rerank|image|vision|reasoning|omni|safety/i.test(
          model.id,
        ),
    )
  );
}

function requireOrSkip(
  available: boolean,
  capabilityId: string,
  reason: string,
): void {
  if (available) return;
  const required = new Set(
    (process.env.PIPELINE_LIVE_REQUIRE ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (required.has("all") || required.has(capabilityId)) {
    throw new Error(`Required live capability '${capabilityId}' is unavailable: ${reason}`);
  }
  test.skip(true, reason);
}
