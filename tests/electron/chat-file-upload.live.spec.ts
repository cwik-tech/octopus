import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { _electron as electron, expect, test } from "@playwright/test";

import { validateCodexSubscriptionAuth } from "../../core/codex-subscription-auth.js";
import { cliPathEntries } from "../../core/cli-path.js";
import { FileSystemSessionStore } from "../../domains/sessions/session-store.js";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const capabilityId = "file-grounding-codex";
const codexCapability = await resolveCodexCapability();

test("Run uploads two files and grounds one real Codex response in both", async ({}, testInfo) => {
  requireOrSkipCodex();
  test.setTimeout(6 * 60_000);

  const workspacePath = testInfo.outputPath("live-multifile-workspace");
  const projectRootPath = testInfo.outputPath("live-multifile-project");
  const userDataPath = testInfo.outputPath("live-multifile-user-data");
  const alphaToken = `MULTIFILE_ALPHA_${randomUUID().replaceAll("-", "").toUpperCase()}`;
  const betaToken = `MULTIFILE_BETA_${randomUUID().replaceAll("-", "").toUpperCase()}`;

  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, "tests", "fixtures", "packaged-workflow-smoke"),
      projectRootPath,
      { recursive: true },
    ),
  ]);
  await fs.writeFile(
    path.join(userDataPath, "provider-settings.json"),
    JSON.stringify({
      version: 3,
      connections: [],
      cliEnabled: { codex: true },
      cliModelEnabled: { codex: { default: true } },
      defaultModel: { provider: "codex", model: "default" },
    }),
  );

  const sessionStore = new FileSystemSessionStore(workspacePath);
  const session = await sessionStore.createSession({
    title: "Live multifile grounding E2E",
  });
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : null;
  const app = await electron.launch({
    args: executablePath ? [] : ["."],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...process.env,
      NODE_ENV: "test",
      PIPELINE_DESKTOP_E2E: "1",
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  });

  try {
    const page = await app.firstWindow();
    const pageErrors: Error[] = [];
    page.on("pageerror", (error) => pageErrors.push(error));

    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await expect
      .poll(async () => (await sessionStore.listSessions()).length, {
        timeout: 15_000,
      })
      .toBe(2);
    await page
      .getByRole("button", { name: /^Live multifile grounding E2E\b/ })
      .first()
      .click();
    await page.getByRole("tab", { name: "Workflows", exact: true }).click();

    const chat = page.getByRole("region", { name: "Run chat" });
    const picker = chat.getByLabel("Upload files");
    await expect(picker).toHaveAttribute("multiple", "");
    await picker.setInputFiles([
      {
        name: "alpha-evidence.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(
          `Alpha evidence document.\nGROUNDING_ALPHA: ${alphaToken}\n`,
        ),
      },
      {
        name: "beta-evidence.txt",
        mimeType: "text/plain",
        buffer: Buffer.from(
          `Beta evidence document.\nGROUNDING_BETA: ${betaToken}\n`,
        ),
      },
    ]);

    await expect(chat.getByTestId("file-message-card")).toHaveCount(2);
    for (const filename of ["alpha-evidence.txt", "beta-evidence.txt"]) {
      const card = chat.getByTestId("file-message-card").filter({
        hasText: filename,
      });
      await expect(card).toHaveAttribute("data-state", "current");
      await expect(card).toContainText("parsed");
    }

    await expect(chat.getByLabel("Run chat model")).toBeEnabled({
      timeout: 30_000,
    });
    const question = [
      "Read both uploaded files.",
      "Return the complete value after GROUNDING_ALPHA and the complete value after GROUNDING_BETA.",
      "Include both values exactly and do not start a workflow.",
    ].join(" ");
    await chat.getByPlaceholder("Send a message...").fill(question);

    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/sessions/${session.id}/messages`),
      { timeout: 5 * 60_000 },
    );
    await chat.getByRole("button", { name: "Send message" }).click();
    const response = await responsePromise;
    expect(response.ok()).toBe(true);

    const request = response.request().postDataJSON() as {
      provider?: string;
      model?: string;
      text?: string;
    };
    expect(request).toMatchObject({
      provider: "codex",
      model: "default",
      text: question,
    });

    const payload = (await response.json()) as {
      assistant?: { text?: string };
      meta?: { fallback?: boolean; model?: string; reason?: string };
    };
    expect(payload.meta?.fallback, payload.meta?.reason).toBe(false);
    expect(payload.meta?.model).not.toBe("fallback");
    expect(payload.assistant?.text).toContain(alphaToken);
    expect(payload.assistant?.text).toContain(betaToken);

    await expect(chat).toContainText(alphaToken);
    await expect(chat).toContainText(betaToken);
    const persisted = await sessionStore.listChatMessages(session.id);
    const persistedAssistant = persisted.find(
      (message) => message.role === "assistant",
    );
    expect(persistedAssistant?.text).toContain(alphaToken);
    expect(persistedAssistant?.text).toContain(betaToken);
    expect(pageErrors).toEqual([]);
  } finally {
    await app.close();
  }
});

async function resolveCodexCapability(): Promise<{
  available: boolean;
  reason: string;
}> {
  const executable = await findCodexExecutable();
  if (!executable) {
    return { available: false, reason: "Codex CLI is not installed on PATH" };
  }
  const authError = validateCodexSubscriptionAuth();
  return authError
    ? { available: false, reason: authError }
    : { available: true, reason: `authenticated Codex CLI at ${executable}` };
}

async function findCodexExecutable(): Promise<string | undefined> {
  for (const directory of cliPathEntries()) {
    const candidate = path.join(directory, "codex");
    try {
      await fs.access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue through the real CLI search path.
    }
  }
  return undefined;
}

function requireOrSkipCodex(): void {
  if (codexCapability.available) return;
  const required = new Set(
    (process.env.PIPELINE_LIVE_REQUIRE ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (required.has("all") || required.has(capabilityId)) {
    throw new Error(
      `Required live capability '${capabilityId}' is unavailable: ${codexCapability.reason}`,
    );
  }
  test.skip(true, codexCapability.reason);
}
