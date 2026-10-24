import { expect, test } from "@playwright/test";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { launchDesktop } from "./support/desktop-launch.js";

test("Library browses Projects Skills Agents and Teams without changing Create or Run", async ({}, testInfo) => {
  const userDataPath = testInfo.outputPath("user-data");
  const workspacePath = testInfo.outputPath("workspace");
  const projectRoot = testInfo.outputPath("project");
  await fs.mkdir(userDataPath, { recursive: true });
  await fs.cp(path.resolve("tests/fixtures/team-chat-e2e"), projectRoot, { recursive: true });
  const skillDir = path.join(projectRoot, "agents", "spec-alpha", "skills", "research");
  await fs.mkdir(path.join(skillDir, "scripts"), { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: research\ndescription: Researches exactly. Use when exact research is needed.\n---\n\n# Shared instructions\n",
  );
  await fs.writeFile(path.join(skillDir, "scripts", "run.mjs"), "console.log('shared');\n");

  const app = await launchDesktop({
    userDataPath,
    workspacePath,
    env: { PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot },
  });
  try {
    const page = await app.firstWindow();
    const left = page.getByRole("complementary", { name: "Primary navigation" });
    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await left.getByRole("tab", { name: "Agents", exact: true }).click();
    await expect(left.getByRole("tab", { name: "Agents", exact: true })).toHaveAttribute("aria-selected", "true");

    await page.getByRole("tab", { name: "Library", exact: true }).click();
    const sections = left.getByRole("tablist", { name: "Library sections" });
    await expect(sections.getByRole("tab", { name: "Projects", exact: true })).toHaveAttribute("aria-selected", "true");
    await expect(left.getByRole("button", { name: /^All projects/ })).toBeVisible();
    await page.getByRole("group", { name: "Left window actions" }).getByRole("button", { name: "New project", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "New project", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");

    await sections.getByRole("tab", { name: "Skills", exact: true }).click();
    await page.getByRole('button', { name: 'Back up and enable Library', exact: true }).click();
    await left.getByRole("button", { name: /^research/ }).click();
    await expect(page.getByRole("region", { name: "Skill library" })).toContainText("Shared instructions");
    await expect(page.getByRole("region", { name: "Skill library" })).toContainText("scripts/run.mjs");

    await sections.getByRole("tab", { name: "Agents", exact: true }).click();
    await page.getByRole("group", { name: "Left window actions" }).getByRole("button", { name: "Import resources", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Import resources", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await left.getByRole("button", { name: /^Spec Alpha/ }).click();
    await expect(page.getByRole("region", { name: "Agent library" })).toContainText("spec-alpha");
    await expect(page.getByRole("region", { name: "Agent library" })).toContainText("research");

    await sections.getByRole("tab", { name: "Teams", exact: true }).click();
    await left.getByRole("button", { name: /^Board Team/ }).click();
    await expect(page.getByRole("region", { name: "Team library" }).getByRole("heading", { name: "Board Team", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Team library" })).toContainText("board-lead");

    await page.getByRole("tab", { name: "Create", exact: true }).click();
    await expect(left.getByRole("tab", { name: "Agents", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "Run", exact: true }).click();
    await expect(left.getByRole("tab", { name: "Sessions", exact: true })).toHaveAttribute("aria-selected", "true");
  } finally {
    await app.close();
  }
});
