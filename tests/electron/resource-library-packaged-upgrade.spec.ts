import { test, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { launchDesktop } from './support/desktop-launch.js';
import { stageCuratedBuiltIns } from '../../electron/builtin-resources.js';
import { builtInBundleSchema, builtInSelectionSchema } from '../../contracts/builtin-resources.js';
import { ResourceLibraryService } from '../../services/resource-library-service.js';
import { ResourceLibraryStore } from '../../domains/resource-library/resource-library-store.js';

test('a packaged resource upgrade preserves personal history pins archives edits and removed defaults', async ({}, testInfo) => {
  const executable = process.env.PIPELINE_DESKTOP_EXECUTABLE ?? '';
  test.skip(!executable, 'Requires the packaged executable; run through run-packaged-electron-smoke.mjs.');
  const appRoot = path.resolve(path.dirname(executable), '../Resources/app');
  const originalManifest = await fs.readFile(path.join(appRoot, 'builtin-resources.json'));
  const manifest = builtInBundleSchema.parse(JSON.parse(originalManifest.toString('utf8')));
  const baseline = new Map<string, Buffer>();
  for (const resource of manifest.resources) for (const file of resource.files) baseline.set(file.path, await fs.readFile(path.join(appRoot, file.path)));
  const userDataPath = testInfo.outputPath('user-data'); const workspacePath = testInfo.outputPath('workspace');
  const projectRoot = path.join(userDataPath, 'project');
  const store = new ResourceLibraryStore({ repoRoot: projectRoot, rootPath: path.join(userDataPath, 'resource-library') });
  let app = await launchDesktop({ userDataPath, workspacePath });
  try {
    let page = await app.firstWindow();
    await page.getByRole('tab', { name: 'Library', exact: true }).click();
    let left = page.getByRole('complementary', { name: 'Primary navigation' });
    await left.getByRole('tab', { name: 'Skills', exact: true }).click();
    await page.getByRole('button', { name: 'Back up and enable Library', exact: true }).click();
    await page.getByRole('button', { name: 'New skill', exact: true }).click();
    const editor = page.getByRole('dialog');
    await editor.getByLabel('Skill slug').fill('personal-planning');
    await editor.getByRole('button', { name: 'Save revision', exact: true }).click();
    await expect(editor).not.toBeVisible();
    let skill = page.getByRole('region', { name: 'Skill library' });
    await skill.getByRole('button', { name: 'Attach', exact: true }).click();
    await page.getByRole('menuitem', { name: 'General Agent', exact: true }).click();
    await expect(skill).toContainText('General Agent');
    await skill.getByRole('button', { name: 'Edit', exact: true }).click();
    await editor.getByLabel('Contents for file 1').fill('---\nname: personal-planning\ndescription: Plans personal work. Use when planning personal tasks.\n---\n\n# Personal revision two\n');
    await editor.getByRole('button', { name: 'Save revision', exact: true }).click();
    await expect(skill.getByLabel('Revision 2 actions')).toBeVisible();
    await skill.getByRole('button', { name: 'Archive', exact: true }).click();
    await expect(page.getByText('Skill archived', { exact: true })).toBeVisible();
    const before = await store.getSnapshot(); const personal = before.skills.find((item) => item.slug === 'personal-planning'); assert.ok(personal);
    const pin = before.agents.find((item) => item.id === 'general-agent')?.attachments.find((item) => item.skillId === personal.id); assert.ok(pin);
    await app.close();
    const personaPath = path.join(projectRoot, 'agents/general-agent/general-agent.md'); await fs.appendFile(personaPath, '\n# Personal edit survives upgrade\n');
    await fs.rm(path.join(projectRoot, 'agents/evidence-critic'), { recursive: true });
    // Change only this test-owned package's resource bundle; keep its real packaged engine.
    await fs.appendFile(path.join(appRoot, 'agents/general-agent/general-agent.md'), '\n# New bundled default\n');
    const selection = builtInSelectionSchema.parse(JSON.parse(await fs.readFile('resources/builtins.json', 'utf8')));
    const upgraded = testInfo.outputPath('upgraded-resources');
    await stageCuratedBuiltIns({ sourceRoot: appRoot, outputRoot: upgraded, appVersion: '0.1.37-fixture', selection });
    await fs.cp(upgraded, appRoot, { recursive: true });
    app = await launchDesktop({ userDataPath, workspacePath }); page = await app.firstWindow();
    await page.getByRole('tab', { name: 'Library', exact: true }).click(); left = page.getByRole('complementary', { name: 'Primary navigation' });
    await left.getByRole('tab', { name: 'Skills', exact: true }).click(); await left.getByRole('button', { name: /^personal-planning/ }).click();
    skill = page.getByRole('region', { name: 'Skill library' }); await expect(skill.getByLabel('Revision 2 actions')).toBeVisible();
    await expect(skill.getByRole('button', { name: 'Unarchive', exact: true })).toBeVisible();
    const after = await store.getSnapshot(); expect(after.skills.find((item) => item.id === personal.id)).toEqual(personal);
    expect(after.agents.find((item) => item.id === 'general-agent')?.attachments.find((item) => item.skillId === personal.id)).toEqual(pin);
    expect(await fs.readFile(personaPath, 'utf8')).toContain('Personal edit survives upgrade');
    await expect(fs.stat(path.join(projectRoot, 'agents/evidence-critic'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(left.getByRole('tab', { name: 'Packages', exact: true })).toHaveCount(0);
    const library = new ResourceLibraryService({ repoRootPath: projectRoot, rootPath: path.join(userDataPath, 'resource-library'), builtinResourceRootPath: appRoot });
    expect((await library.getBrowserSnapshot()).builtInUpdates).toContainEqual(expect.objectContaining({ path: 'agents/general-agent' }));
    await page.screenshot({ path: testInfo.outputPath('packaged-upgrade.png') });
  } finally {
    try { await app.close(); }
    finally {
      for (const [name, contents] of baseline) await fs.writeFile(path.join(appRoot, name), contents);
      await fs.writeFile(path.join(appRoot, 'builtin-resources.json'), originalManifest);
    }
  }
});
