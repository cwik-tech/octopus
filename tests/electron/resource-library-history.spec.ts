import { expect, test } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { launchDesktop } from './support/desktop-launch.js';

test('Library creates a named skill, edits support files, restores history and detaches one Agent', async ({}, testInfo) => {
  const projectRoot = testInfo.outputPath('project');
  await fs.cp(path.resolve('tests/fixtures/team-chat-e2e'), projectRoot, { recursive: true });
  const app = await launchDesktop({ userDataPath: testInfo.outputPath('user-data'), workspacePath: testInfo.outputPath('workspace'), env: { PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot } });
  try {
    const page = await app.firstWindow();
    const left = page.getByRole('complementary', { name: 'Primary navigation' });
    await page.getByRole('tab', { name: 'Library', exact: true }).click();
    const sections = left.getByRole('tablist', { name: 'Library sections' });
    await sections.getByRole('tab', { name: 'Skills', exact: true }).click();
    await page.getByRole('button', { name: 'Back up and enable Library', exact: true }).click();
    await page.getByRole('group', { name: 'Left window actions' }).getByRole('button', { name: 'New skill', exact: true }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Skill slug').fill('planning');
    await editor.getByRole('button', { name: 'Add supporting file' }).click();
    await editor.getByLabel('Path for file 2').fill('scripts/run.mjs');
    await editor.getByLabel('Contents for file 2').fill('original script');
    await editor.getByRole('button', { name: 'Save revision' }).click();
    await expect(editor).not.toBeVisible();
    const skill = page.getByRole('region', { name: 'Skill library' });
    await expect(skill.getByRole('heading', { name: 'planning', exact: true })).toBeVisible();
    await skill.getByRole('button', { name: 'Attach', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Spec Alpha', exact: true }).click();
    await expect(skill).toContainText('Spec Alpha');
    await skill.getByRole('button', { name: 'Edit', exact: true }).click();
    const scriptEditor = editor.locator('div').filter({
      has: page.locator('input[value="scripts/run.mjs"]'),
    }).filter({ has: page.getByRole('textbox', { name: /^Contents for file/ }) }).last();
    await scriptEditor.getByRole('textbox', { name: /^Contents for file/ }).fill('updated script');
    await editor.getByRole('button', { name: 'Save revision' }).click();
    await expect(editor).not.toBeVisible();
    await expect(skill.getByLabel('Revision 2 actions')).toBeVisible();
    expect(await fs.readFile(path.join(projectRoot, 'agents/spec-alpha/skills/planning/scripts/run.mjs'), 'utf8')).toBe('original script');
    await skill.getByLabel('Revision 1 actions').getByRole('button', { name: 'Compare' }).click();
    await expect(skill.getByRole('region', { name: 'Revision comparison' })).toContainText('updated script');
    await skill.getByLabel('Revision 1 actions').getByRole('button', { name: 'Restore' }).click();
    await expect(skill.getByLabel('Revision 3 actions')).toBeVisible();
    await sections.getByRole('tab', { name: 'Agents', exact: true }).click();
    await left.getByRole('button', { name: /^Spec Alpha/ }).click();
    const agent = page.getByRole('region', { name: 'Agent library' });
    await agent.getByRole('button', { name: 'Select revision' }).click();
    await page.getByRole('menuitem', { name: 'Revision 2', exact: true }).click();
    await expect(agent).toContainText('Revision 2');
    expect(await fs.readFile(path.join(projectRoot, 'agents/spec-alpha/skills/planning/scripts/run.mjs'), 'utf8')).toBe('updated script');
    await agent.getByRole('button', { name: 'Detach', exact: true }).click();
    await expect(agent).toContainText('No skills attached.');
    await sections.getByRole('tab', { name: 'Skills', exact: true }).click();
    await left.getByRole('button', { name: /^planning/ }).click();
    await expect(skill.getByLabel('Revision 3 actions')).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('library-history.png') });
  } finally { await app.close(); }
});
