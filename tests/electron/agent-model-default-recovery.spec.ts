/**
 * The desktop half of consented recovery: a run stops, asks, and continues.
 *
 * Every other test of this decision ends at the API. This one is about what a
 * person actually sees and does. A workflow finishes one step, the next step's
 * Agent cannot run on the pair it names, and the run stops rather than quietly
 * using something else. The desktop has to say so — which Agent, which pair
 * failed, exactly which pair is offered, why, and that agreeing does not
 * repoint the Agent — survive a reload, and then run exactly one more attempt
 * when the person agrees.
 *
 * Deliberately distinct from `team-mixed-model-selection.spec.ts` and
 * `agent-model-selection-history.spec.ts`: those cover which pair a run uses
 * and what history says afterwards. This covers the decision itself.
 *
 * The failing Agent names a connection that is not configured, so the adapter
 * refuses before it builds a request. That is one of several model-specific
 * failures an offer may follow — an unknown model and a provider rejection are
 * others — and it is chosen here because it makes "no request reached the app
 * default before consent" checkable: the fake provider sees every request, so
 * the default's model id appearing before approval would be visible.
 */
import {
  _electron as electron,
  expect,
  test,
  type Page,
} from "@playwright/test";
import { fixtureDesktopEnvironment } from "../support/desktop-journey-environment.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { FileSystemWorkflowStateStore } from "../../workflows/workflow-state-store.js";
import { replaceRequiredText } from "../support/config-rewrite.js";
import { startFakeChatCompletionsServer } from "../support/fake-chat-completions-server.js";
import {
  APP_DEFAULT_MODEL,
  FIXTURE_PROVIDER,
  repoRoot,
  seedProviderSettings,
  writeAgentPersona,
} from "./support/model-selection-fixture.js";

/** Not in provider settings, so the adapter refuses before sending anything. */
const ABSENT_PROVIDER = "connection:absentconnection";
const ABSENT_MODEL = "fake/never-configured";
const FAILING_AGENT = "defaultrecoveryworker";
const DRAFT_ANSWER = "Deterministic first-step draft.";
const RETRY_ANSWER = "Answered on the application default after approval.";
const FAILING_AGENT_MARKER = "Default recovery worker.";
const TERMINAL_TASK_STATUSES = ["done", "failed", "blocked", "cancelled"];

/**
 * Requests for the affected Agent's own attempt.
 *
 * Scoped by the Agent's marker on purpose: planning and title generation
 * legitimately run on the application default, so counting every request that
 * carried the default pair would confuse the run's own housekeeping with the
 * substitution this journey is about consenting to.
 */
function agentAttemptsOnDefault(
  requests: readonly {
    model: string | undefined;
    systemPrompt: string | undefined;
  }[],
): readonly { model: string | undefined }[] {
  return requests.filter(
    (request) =>
      request.model === APP_DEFAULT_MODEL.id &&
      (request.systemPrompt?.includes(FAILING_AGENT_MARKER) ?? false),
  );
}

interface TaskSnapshot {
  readonly id: string;
  readonly assignmentPath: string;
  readonly status: string;
  /** Present on a failed task; carried so a failure says why it failed. */
  readonly error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows the task the desktop API returns rather than trusting its shape. */
function requireTaskSnapshot(value: unknown): TaskSnapshot {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.assignmentPath !== "string" ||
    typeof value.status !== "string"
  ) {
    throw new Error(`Unexpected task payload: ${JSON.stringify(value)}`);
  }
  return {
    id: value.id,
    assignmentPath: value.assignmentPath,
    status: value.status,
    ...(typeof value.error === "string" ? { error: value.error } : {}),
  };
}

function requireSessionId(value: unknown): string {
  if (!isRecord(value) || typeof value.id !== "string") {
    throw new Error(`Unexpected session payload: ${JSON.stringify(value)}`);
  }
  return value.id;
}

test("a workflow stops for a model choice, survives reload, and continues once", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const workspacePath = testInfo.outputPath("default-recovery-workspace");
  const projectRoot = testInfo.outputPath("default-recovery-project");
  const userDataPath = testInfo.outputPath("default-recovery-user-data");
  const piStatePath = testInfo.outputPath("default-recovery-pi-state");
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(piStatePath, { recursive: true }),
    fs.cp(
      path.join(repoRoot, "tests", "fixtures", "packaged-workflow-smoke"),
      projectRoot,
      { recursive: true },
    ),
  ]);

  // The Agent whose own pair cannot run. Written through the shared persona
  // helper so its explicit pair is expressed exactly as the editor writes one.
  await writeAgentPersona(projectRoot, {
    name: FAILING_AGENT,
    description: "Names a connection that is not configured.",
    marker: FAILING_AGENT_MARKER,
    provider: ABSENT_PROVIDER,
    model: ABSENT_MODEL,
    tier: "execution",
  });
  const agentFilePath = path.join(
    projectRoot,
    "agents",
    FAILING_AGENT,
    `${FAILING_AGENT}.md`,
  );
  const agentFileBefore = await fs.readFile(agentFilePath);

  const teamPath = path.join(
    projectRoot,
    "teams",
    "packaged-smoke-team",
    "team.yaml",
  );
  // Inserted into the roster block, not appended to the file: `agents:` is
  // followed by `levels:` and `gates:`, and appending would land the entry
  // inside whichever section happens to be last.
  const rosterEntry = [
    `  - name: ${FAILING_AGENT}`,
    "    type: agent",
    "    role: Finalize the draft",
    "    tier: execution",
    "    tools: []",
    `    agent_file: ../../agents/${FAILING_AGENT}/${FAILING_AGENT}.md`,
    "    produces:",
    "      - path: final.md",
    "",
  ].join("\n");
  const rosterAnchor = "\nlevels:";
  await fs.writeFile(
    teamPath,
    replaceRequiredText({
      file: teamPath,
      pattern: rosterAnchor,
      replacement: `\n${rosterEntry}\nlevels:`,
      source: await fs.readFile(teamPath, "utf8"),
    }),
    "utf8",
  );

  // One step that really completes, then one that really fails before dispatch.
  await fs.writeFile(
    path.join(projectRoot, "workflows", "templates", "packaged-smoke.yaml"),
    `workflow:
  id: packaged-smoke
  description: Deterministic model-choice recovery journey.
  input:
    artifact: incoming-request.md
  steps:
    - id: draft
      type: team
      team: packaged-smoke-team
      input_artifact: incoming-brief.md
      result_artifact: final.md
      recovery_policy: safe_retry
    - id: finalize
      type: agent
      team: packaged-smoke-team
      agent: ${FAILING_AGENT}
      stage_type: chain
      input_artifact: incoming-brief.md
      result_artifact: final.md
      recovery_policy: manual
      handoff:
        from_step: draft
        from_artifact: final.md
        to_artifact: incoming-brief.md
  output:
    from_step: finalize
    artifact: final.md
  on_blocked: stop
  on_failed: stop
`,
    "utf8",
  );

  // Claimed by what the request carries, not by arrival order: one reply can
  // produce more than one request, so position is not a safe key.
  const provider = await startFakeChatCompletionsServer({
    script: [
      {
        content: DRAFT_ANSWER,
        match: (request) =>
          request.systemPrompt?.includes("packaged-smoke-worker") ?? false,
      },
      {
        content: RETRY_ANSWER,
        match: (request) =>
          request.model === APP_DEFAULT_MODEL.id &&
          (request.systemPrompt?.includes(FAILING_AGENT_MARKER) ?? false),
      },
      { content: "Unclaimed fixture answer." },
    ],
  });
  // The provider is owned from here: seeding and launching are both inside the
  // guard, so a failure in either cannot leave it listening.
  let primaryFailure: unknown;
  try {
    // Keyless LM Studio: the draft step's worker runs on this default, and
    // the native tool route refuses a keyless OpenAI-compatible connection,
    // which blocked the draft before the finalize step could ask anything.
    await seedProviderSettings({
      userDataPath,
      baseUrl: provider.url,
      defaultModel: APP_DEFAULT_MODEL,
      kind: "lm-studio",
    });

    const app = await electron.launch({
      args: ["."],
      cwd: repoRoot,
      // The launch recipe the other packaged-workflow journeys use, matched
      // field for field: this class of test runs a real workflow out of a copied
      // fixture project, and that is the setup proven to boot one.
      env: {
        ...fixtureDesktopEnvironment({ ...process.env, PATH: "/usr/bin:/bin" }),
        NODE_ENV: "test",
        OPENAI_API_KEY: "default-recovery-key",
        OPENAI_BASE_URL: `${provider.url}/v1`,
        PI_CODING_AGENT_DIR: piStatePath,
        PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot,
        PIPELINE_DESKTOP_REPO_ROOT: repoRoot,
        PIPELINE_DESKTOP_USER_DATA: userDataPath,
        PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      },
    });
    let apiBaseUrl: string | null = null;

    try {
      let page = await app.firstWindow();
      const baseUrl = await desktopApiBaseUrl(page);
      apiBaseUrl = baseUrl;
      const session = await createSession(baseUrl);
      const task = await launchTask(baseUrl, session.id);

      await expect
        .poll(
          async () => (await readTask(baseUrl, session.id, task.id)).status,
          { timeout: 90_000 },
        )
        .toBe("awaiting_model_choice");

      // The affected Agent's attempt never reached the application default
      // before anyone agreed to it.
      expect(agentAttemptsOnDefault(provider.requests)).toHaveLength(0);

      await openWorkflowsPane(page, "Model choice Electron E2E");
      const card = page.getByRole("note", { name: "Model choice" });
      await expect(card).toBeVisible();
      // Named as the pane displays it, which capitalises the Agent's name.
      await expect(card).toContainText(new RegExp(FAILING_AGENT, "i"));
      await expect(card).toContainText(`${ABSENT_PROVIDER} / ${ABSENT_MODEL}`);
      await expect(card).toContainText(
        `${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id}`,
      );
      await expect(card).toContainText("its provider is not ready");
      await expect(card).toContainText("saved settings will not change");

      // The decision is durable, not a message that scrolled past.
      await page.reload();
      page = await app.firstWindow();
      await openWorkflowsPane(page, "Model choice Electron E2E");
      const afterReload = page.getByRole("note", { name: "Model choice" });
      await expect(afterReload).toBeVisible();
      await expect(afterReload).toContainText(
        `${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id}`,
      );

      const approval = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response.url().includes("/model-choice"),
      );
      await afterReload
        .getByRole("button", { name: "Retry this Agent using app default" })
        .click();
      expect((await approval).status()).toBe(202);

      // Polled to a terminal status, then asserted with the reason the run
      // recorded: "expected done, got failed" alone cannot be acted on.
      await expect
        .poll(
          async () => {
            const current = await readTask(baseUrl, session.id, task.id);
            return TERMINAL_TASK_STATUSES.includes(current.status);
          },
          { timeout: 90_000 },
        )
        .toBe(true);
      const finished = await readTask(baseUrl, session.id, task.id);
      expect(
        finished.status,
        `${finished.error ?? "no error recorded"} · agent attempts on the default: ${
          agentAttemptsOnDefault(provider.requests).length
        }`,
      ).toBe("done");

      // Exactly one attempt went to the approved default, and the completed
      // predecessor was not run again.
      expect(agentAttemptsOnDefault(provider.requests)).toHaveLength(1);
      const snapshot = await new FileSystemWorkflowStateStore(
        task.assignmentPath,
      ).requireSnapshot();
      const draft = snapshot.state.steps.find(
        (step) => step.stepId === "draft",
      );
      expect(draft?.status).toBe("completed");
      expect(draft?.attemptCount).toBe(1);

      // The pending decision is gone once it has been made.
      await expect(
        page.getByRole("note", { name: "Model choice" }),
      ).toHaveCount(0);

      // What the person can actually see afterwards: both attempts, with the
      // retry named as the application default and the reason it was offered.
      // The durable record below supports this rather than standing in for it.
      // Workflows is a tab that selects this content, not a panel with its own
      // accessible name: the run's record lives in the Run activity region.
      const workflows = page.getByRole("region", { name: "Run activity" });
      await expect(workflows).toContainText(
        `${ABSENT_PROVIDER} / ${ABSENT_MODEL}`,
      );
      await expect(workflows).toContainText(
        `${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id}`,
      );
      // The retry row leads with "App default" and names the pair it replaced
      // (ui/src/lib/models/runtime-model.ts, pinned by runtime-model.test.ts).
      await expect(workflows).toContainText(
        `App default · ${FAILING_AGENT} started on ${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id} · instead of ${ABSENT_PROVIDER} / ${ABSENT_MODEL}`,
      );

      // And it survives reopening, so it is history rather than a live view.
      await page.reload();
      page = await app.firstWindow();
      await openWorkflowsPane(page, "Model choice Electron E2E");
      const reopened = page.getByRole("region", { name: "Run activity" });
      await expect(reopened).toContainText(
        `${ABSENT_PROVIDER} / ${ABSENT_MODEL}`,
      );
      await expect(reopened).toContainText(
        `${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id}`,
      );
      // The proposed pair alone proves nothing here: it is already in the
      // pre-retry offer row. Only the retry's own row says the application
      // default was the thing that ran.
      await expect(reopened).toContainText(
        `App default · ${FAILING_AGENT} started on ${FIXTURE_PROVIDER} / ${APP_DEFAULT_MODEL.id} · instead of ${ABSENT_PROVIDER} / ${ABSENT_MODEL}`,
      );
      await expect(
        page.getByRole("note", { name: "Model choice" }),
      ).toHaveCount(0);

      // The Agent's own file is untouched by agreeing.
      const finalize = snapshot.state.steps.find(
        (step) => step.stepId === "finalize",
      );
      expect(finalize?.approvedModelChoice?.failedChoice).toEqual({
        provider: ABSENT_PROVIDER,
        model: ABSENT_MODEL,
      });
      expect(finalize?.approvedModelChoice?.proposedDefault).toEqual({
        provider: FIXTURE_PROVIDER,
        model: APP_DEFAULT_MODEL.id,
      });
      expect(await fs.readFile(agentFilePath)).toEqual(agentFileBefore);
    } catch (error) {
      primaryFailure = error;
      throw error;
    } finally {
      await releaseAll(
        [
          async () => {
            if (apiBaseUrl) await deleteAllSessions(apiBaseUrl);
          },
          () => app.close(),
        ],
        primaryFailure,
      );
    }
  } catch (error) {
    primaryFailure ??= error;
    throw error;
  } finally {
    await releaseAll([() => provider.close()], primaryFailure);
  }
});

/**
 * Runs every release, then decides what to say about it.
 *
 * A cleanup that fails is a real failure and is reported when the test itself
 * had none. When the test already failed, the cleanup failure is suppressed
 * rather than allowed to replace the thing the reader actually needs to see.
 */
async function releaseAll(
  steps: readonly (() => Promise<unknown>)[],
  primaryFailure: unknown,
): Promise<void> {
  let cleanupFailure: unknown;
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      cleanupFailure ??= error;
    }
  }
  if (cleanupFailure !== undefined && primaryFailure === undefined) {
    throw cleanupFailure;
  }
}

async function createSession(baseUrl: string): Promise<{ id: string }> {
  const response = await fetch(`${baseUrl}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Model choice Electron E2E" }),
  });
  expect(response.status).toBe(201);
  return { id: requireSessionId((await response.json()) as unknown) };
}

async function launchTask(
  baseUrl: string,
  sessionId: string,
): Promise<TaskSnapshot> {
  const response = await fetch(`${baseUrl}/sessions/${sessionId}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      workflowId: "packaged-smoke",
      // Specific enough that planning launches rather than asking for detail:
      // topic, audience and outcome are all named.
      brief:
        "Prepare a one-page delivery risk report for the operations team, " +
        "quantify the schedule risk, and finalize it for sign-off.",
    }),
  });
  const payload = (await response.json()) as unknown;
  expect(response.status, JSON.stringify(payload)).toBe(202);
  return requireTaskSnapshot(payload);
}

async function openWorkflowsPane(
  page: Page,
  sessionTitle: string,
): Promise<void> {
  await page.getByRole("tab", { name: "Run", exact: true }).click();
  // The left sidebar's row: the same name also labels a panel item in a
  // collapsed column of the main area, which cannot take the click.
  await page
    .locator('[data-slot="workspace-sidebar"][data-side="left"]')
    .getByRole("button", { name: new RegExp(`^${sessionTitle}\\b`) })
    .first()
    .click();
  await page.getByRole("tab", { name: "Workflows", exact: true }).click();
}

async function readTask(
  baseUrl: string,
  sessionId: string,
  taskId: string,
): Promise<TaskSnapshot> {
  const response = await fetch(
    `${baseUrl}/sessions/${sessionId}/tasks/${taskId}`,
  );
  return requireTaskSnapshot((await response.json()) as unknown);
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get(
      "pipeline-api-base-url",
    ),
  );
  if (!baseUrl) throw new Error("Desktop API URL is unavailable");
  return baseUrl;
}

async function deleteAllSessions(baseUrl: string): Promise<void> {
  const response = await fetch(`${baseUrl}/sessions`).catch(() => null);
  if (!response?.ok) return;
  const payload = (await response.json()) as unknown;
  if (!isRecord(payload) || !Array.isArray(payload.sessions)) return;
  for (const entry of payload.sessions) {
    if (!isRecord(entry) || typeof entry.id !== "string") continue;
    await fetch(`${baseUrl}/sessions/${entry.id}`, { method: "DELETE" }).catch(
      () => undefined,
    );
  }
}
