import { expect, test, type TestInfo } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import JSZip from 'jszip';
import { ResourceLibraryStore } from '../../domains/resource-library/resource-library-store.js';
import { resourcePackageManifestSchema } from '../../contracts/resource-package.js';
import { launchDesktop } from './support/desktop-launch.js';

async function prepareAppRoot(testInfo: TestInfo) {
  const root = testInfo.outputPath('app');
  await fs.mkdir(root, { recursive: true });
  // A test-owned file renderer avoids replacing assets beneath the user's open app.
  for (const entry of await fs.readdir(process.cwd())) {
    if (['ui', '.git', 'test-results'].includes(entry)) continue;
    if (['agents', 'skills', 'teams', 'workflows'].includes(entry)) await fs.cp(path.resolve(entry), path.join(root, entry), { recursive: true });
    else await fs.symlink(path.resolve(entry), path.join(root, entry));
  }
  await fs.cp(process.env.PIPELINE_LIBRARY_TEST_RENDERER ?? path.resolve('ui/dist'), path.join(root, 'ui/dist'), { recursive: true });
  return root;
}

test('Library exports the selected format and history with Packages hidden from navigation', async ({}, testInfo) => {
  const appRoot = await prepareAppRoot(testInfo);
  const project = testInfo.outputPath('project');
  const userData = testInfo.outputPath('user-data');
  await fs.cp(path.resolve('tests/fixtures/team-chat-e2e'), project, { recursive: true });
  const store = new ResourceLibraryStore({ repoRoot: project, rootPath: path.join(userData, 'resource-library') });
  await store.migrateLegacyResources();
  const document = '---\nname: portable-planning\ndescription: Plans portably. Use when planning work.\n---\n\n# Original\n';
  const first = await store.createSkill({ slug: 'portable-planning', files: new Map([['SKILL.md', { contents: Buffer.from(document), mode: 0o644, executable: false }]]), changeNote: 'Original', expectedGeneration: (await store.getSnapshot()).generation });
  await store.saveSkillRevision({ skillId: first.skill.id, baseRevisionId: first.revision.id, files: new Map([['SKILL.md', { contents: Buffer.from(document.replace('# Original', '# Updated')), mode: 0o644, executable: false }]]), changeNote: 'Updated', expectedGeneration: (await store.getSnapshot()).generation });
  const app = await launchDesktop({ userDataPath: userData, workspacePath: testInfo.outputPath('workspace'), env: { PIPELINE_DESKTOP_REPO_ROOT: appRoot, PIPELINE_DESKTOP_PROJECT_ROOT: project } });
  const page = await app.firstWindow();
  try {
    await page.getByRole('tab', { name: 'Library', exact: true }).click();
    const left = page.getByRole('complementary', { name: 'Primary navigation' });
    await expect(left.getByRole('tab', { name: 'Packages', exact: true })).toHaveCount(0);
    await left.getByRole('tab', { name: 'Skills', exact: true }).click();
    await left.getByRole('button', { name: 'portable-planning', exact: true }).click();
    const skill = page.getByRole('region', { name: 'Skill library' });
    await expect(skill.getByRole('heading', { name: 'portable-planning', exact: true })).toBeVisible();
    await skill.getByRole('button', { name: 'Export', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Export resources' });
    const format = dialog.getByLabel('ZIP format');
    await expect(format).toContainText('Standard skill ZIP');
    const history = dialog.getByRole('switch', { name: 'Include history', exact: true });
    await expect(history).toBeDisabled();
    await expect(history).not.toBeChecked();
    await format.click();
    await page.getByRole('option', { name: 'Octopus package', exact: true }).click();
    await expect(format).toContainText('Octopus package');
    await history.check();
    await expect(history).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath('export-controls.png'), animations: 'disabled' });
    await format.click();
    await expect(page.getByRole('option', { name: 'Octopus package', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.screenshot({ path: testInfo.outputPath('export-format-menu.png'), animations: 'disabled' });
    await page.getByRole('option', { name: 'Octopus package', exact: true }).click();
    const archivePath = testInfo.outputPath('history.zip');
    const downloading = app.evaluate(({ session }, destination) => new Promise<void>((resolve, reject) => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(destination);
        item.once('done', (_event, state) => state === 'completed' ? resolve() : reject(new Error(`Download ${state}`)));
      });
    }), archivePath);
    await dialog.getByRole('button', { name: 'Download ZIP', exact: true }).click();
    await downloading;
    const archive = await JSZip.loadAsync(await fs.readFile(archivePath));
    const manifestText = await archive.file('octopus-package.json')?.async('string');
    expect(manifestText).toBeDefined();
    const payload: unknown = JSON.parse(manifestText ?? 'null');
    const manifest = resourcePackageManifestSchema.parse(payload);
    expect(manifest.skills[0]?.revisions).toHaveLength(2);
    await skill.getByRole('button', { name: 'Export', exact: true }).click();
    await expect(format).toContainText('Standard skill ZIP');
    await expect(history).toBeDisabled();
    await expect(history).not.toBeChecked();
  } finally { await app.close(); }
});
