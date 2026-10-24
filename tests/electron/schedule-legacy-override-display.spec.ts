/**
 * What a person actually sees for a schedule saved before model overrides were
 * retired.
 *
 * The component test beside this one proves the row's markup. It cannot prove
 * that the stored file reaches the row: the schedule is loaded from
 * `schedules.json`, served by the desktop API, and decoded by the client before
 * anything renders, and a break anywhere along that path would leave the
 * component test passing while the desktop showed the old, misleading line.
 *
 * Deliberately small: one seeded legacy schedule, one rendered row. It is not a
 * second matrix of schedule behaviour.
 */
import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
} from "@playwright/test";
import { fixtureDesktopEnvironment } from "../support/desktop-journey-environment.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

const LEGACY_AGENT = "legacy-override-agent";

/**
 * A record of the shape written before the field was refused.
 *
 * Disabled on purpose. This fixture is about what the row displays, and an
 * enabled schedule would be eligible to fire on wall-clock time — turning a
 * display check into something that launches work in CI.
 */
const LEGACY_SCHEDULE = {
  version: 1,
  schedules: [
    {
      id: "sch_legacy_override",
      name: "Legacy nightly review",
      kind: "agent",
      target: LEGACY_AGENT,
      modelOverride: { provider: "anthropic", model: "claude-sonnet-4-6" },
      prompt: "Review the latest brief.",
      cron: "0 9 * * *",
      timezone: "America/Detroit",
      scheduleLabel: "Every day at 09:00",
      overlap: "skip",
      notifyOnFailure: false,
      enabled: false,
      createdAt: "2026-07-19T00:00:00.000Z",
      updatedAt: "2026-07-19T00:00:00.000Z",
    },
  ],
};

test("a schedule saved with a model override says the setting is ignored", async ({}, testInfo) => {
  test.setTimeout(90_000);
  const userDataPath = testInfo.outputPath("legacy-override-user-data");
  const workspacePath = testInfo.outputPath("legacy-override-workspace");
  const projectRoot = testInfo.outputPath("legacy-override-project");
  await Promise.all([
    fs.mkdir(userDataPath, { recursive: true }),
    fs.mkdir(path.join(workspacePath, "task-queue"), { recursive: true }),
    fs.mkdir(path.join(projectRoot, "agents", LEGACY_AGENT), { recursive: true }),
  ]);
  // A target the scheduler can actually resolve. `ScheduleService.initialize`
  // repairs targets and records failures on load, so an unresolvable one would
  // put this fixture's setup, rather than the display, on trial.
  await fs.writeFile(
    path.join(projectRoot, "agents", LEGACY_AGENT, `${LEGACY_AGENT}.md`),
    [
      "---",
      `name: ${LEGACY_AGENT}`,
      "description: Agent targeted by a legacy schedule.",
      "---",
      "",
      "Produce the requested review.",
      "",
    ].join("\n"),
  );
  await fs.writeFile(
    path.join(workspacePath, "task-queue", "schedules.json"),
    `${JSON.stringify(LEGACY_SCHEDULE, null, 2)}\n`,
  );

  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ userDataPath, workspacePath, projectRoot });
    const page = await app.firstWindow({ timeout: 45_000 });

    await page.getByRole("button", { name: /^Schedule & Batches/ }).click();
    const row = page.getByText("Legacy Nightly Review", { exact: true });
    await expect(row).toBeVisible({ timeout: 30_000 });

    // The stored pair is still on screen — it is in the file, and a person who
    // opens that file deserves to see the same thing here.
    const ignored = page.getByText(/anthropic\/claude-sonnet-4-6/);
    await expect(ignored).toBeVisible();
    // But named as retired, not as the pair this schedule runs on.
    await expect(ignored).toContainText(/ignored/i);
    // The operative parts of the row are unchanged beside it.
    await expect(page.getByText(/America\/Detroit/)).toBeVisible();

    // Attached so the rendered result can be inspected rather than inferred:
    // this line sits in a `truncate` row, and DOM visibility alone would not
    // show the `(ignored)` suffix being clipped.
    const screenshot = testInfo.outputPath("legacy-override-row.png");
    await ignored.locator("xpath=ancestor::div[1]").screenshot({ path: screenshot });
    await testInfo.attach("legacy-override-row", {
      path: screenshot,
      contentType: "image/png",
    });
    // And the suffix is really laid out, not clipped away: the row reports no
    // horizontal overflow past what it displays.
    const clipped = await ignored.evaluate((element) => {
      const row = element.parentElement;
      return row ? row.scrollWidth > row.clientWidth + 1 : true;
    });
    expect(clipped).toBe(false);

    // Reading a schedule does not repair it. Asserted on the schedule's own
    // authored definition rather than on the whole file: loading legitimately
    // computes and persists runtime bookkeeping such as the next fire time.
    const stored = JSON.parse(
      await fs.readFile(path.join(workspacePath, "task-queue", "schedules.json"), "utf8"),
    ) as { schedules?: Array<Record<string, unknown>> };
    const seeded = LEGACY_SCHEDULE.schedules[0]!;
    const reloaded = stored.schedules?.find((entry) => entry.id === seeded.id);
    expect(reloaded).toBeDefined();
    for (const field of [
      "name",
      "kind",
      "target",
      "prompt",
      "cron",
      "timezone",
      "scheduleLabel",
      "overlap",
      "enabled",
      "createdAt",
    ] as const) {
      expect(reloaded?.[field]).toEqual(seeded[field]);
    }
    expect(reloaded?.modelOverride).toEqual(seeded.modelOverride);
  } finally {
    if (app) await app.close();
  }
});

async function launchDesktop(params: {
  userDataPath: string;
  workspacePath: string;
  projectRoot: string;
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
      PIPELINE_DESKTOP_USER_DATA: params.userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: params.workspacePath,
      PIPELINE_DESKTOP_PROJECT_ROOT: params.projectRoot,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  });
}
