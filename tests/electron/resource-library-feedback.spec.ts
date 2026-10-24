import { expect, test, type TestInfo } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { launchDesktop } from './support/desktop-launch.js';

async function openSkill(testInfo: TestInfo) {
  const projectRoot = testInfo.outputPath('project');
  await fs.cp(path.resolve('tests/fixtures/team-chat-e2e'), projectRoot, { recursive: true });
  const skillPath = path.join(projectRoot, 'agents/spec-alpha/skills/planning');
  await fs.mkdir(skillPath, { recursive: true });
  await fs.writeFile(path.join(skillPath, 'SKILL.md'), '---\nname: planning\ndescription: Plans the work. Use when planning work.\n---\n\n# Original instructions\n');
  const app = await launchDesktop({ userDataPath: testInfo.outputPath('user-data'), workspacePath: testInfo.outputPath('workspace'), env: { PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot } });
  const page = await app.firstWindow();
  await page.getByRole('tab', { name: 'Library', exact: true }).click();
  const left = page.getByRole('complementary', { name: 'Primary navigation' });
  await left.getByRole('tab', { name: 'Skills', exact: true }).click();
  await page.getByRole('button', { name: 'Back up and enable Library', exact: true }).click();
  await left.getByRole('button', { name: /^planning/ }).click();
  const skill = page.getByRole('region', { name: 'Skill library' });
  await expect(skill.getByRole('button', { name: 'Edit', exact: true })).toBeEnabled();
  return { app, page, skill };
}

test('Library confirms saved and unchanged edits and keeps a rejected draft visible', async ({}, testInfo) => {
  const { app, page, skill } = await openSkill(testInfo);
  try {
    await skill.getByRole('button', { name: 'Edit', exact: true }).click();
    const editor = page.getByRole('dialog');
    await editor.getByRole('button', { name: 'About executable files for file 1' }).hover();
    await page.screenshot({ path: testInfo.outputPath('skill-editor-help.png') });
    const document = editor.getByLabel('Contents for file 1');
    const original = await document.inputValue();
    await document.fill(original.replace('Original instructions', 'Updated instructions'));
    await editor.getByRole('button', { name: 'Save revision', exact: true }).click();
    await expect(editor).not.toBeVisible();
    await expect(page.getByText('Revision 2 saved', { exact: true })).toBeVisible();
    await expect(skill.getByLabel('Revision 2 actions')).toBeVisible();

    await skill.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.getByRole('button', { name: 'Save revision', exact: true }).click();
    await expect(editor).not.toBeVisible();
    await expect(page.getByText('No changes to save', { exact: true })).toBeVisible();

    await skill.getByRole('button', { name: 'Edit', exact: true }).click();
    await document.fill(original.replace('name: planning', 'name: invalid-name'));
    await editor.getByRole('button', { name: 'Save revision', exact: true }).click();
    await expect(page.getByText('Could not save revision', { exact: true })).toBeVisible();
    await expect(editor.getByRole('alert')).toBeInViewport();
    await expect(document).toHaveValue(original.replace('name: planning', 'name: invalid-name'));
  } finally { await app.close(); }
});

test('Library explains archive availability and confirms restoring new attachments', async ({}, testInfo) => {
  const { app, page, skill } = await openSkill(testInfo);
  try {
    await skill.getByRole('button', { name: 'Attach', exact: true }).click();
    await expect(page.getByRole('menu')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('skill-attach-menu.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await skill.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.getByText('Skill archived', { exact: true })).toBeVisible();
    await expect(skill.getByRole('button', { name: 'Attach', exact: true })).toBeDisabled();
    await page.screenshot({ path: testInfo.outputPath('skill-archived.png') });
    await expect(skill).toContainText('Spec Alpha');
    await skill.getByRole('button', { name: 'Unarchive', exact: true }).click();
    await expect(page.getByText('Skill available again', { exact: true })).toBeVisible();
    await expect(skill.getByRole('button', { name: 'Attach', exact: true })).toBeEnabled();
  } finally { await app.close(); }
});
