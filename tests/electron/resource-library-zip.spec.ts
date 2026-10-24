import { test, expect } from '@playwright/test';
import JSZip from 'jszip';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { launchDesktop } from './support/desktop-launch.js';
import { ResourceLibraryStore } from '../../domains/resource-library/resource-library-store.js';

test('Library previews a skill ZIP, imports its supporting files and downloads its exact revision', async ({}, testInfo) => {
  const projectRoot = testInfo.outputPath('project');
  await fs.cp(path.resolve('tests/fixtures/team-chat-e2e'), projectRoot, { recursive: true });
  const archive = await new JSZip()
    .file('portable-planning/SKILL.md', '---\nname: portable-planning\ndescription: Plans portably. Use when planning.\n---\n\n# Portable instructions\n')
    .file('portable-planning/scripts/run.sh', '#!/bin/sh\necho portable\n', { unixPermissions: 0o100755 })
    .generateAsync({ type: 'nodebuffer', platform: 'UNIX' });
  const zipPath = testInfo.outputPath('planning.zip');
  await fs.writeFile(zipPath, archive);
  const app = await launchDesktop({ userDataPath: testInfo.outputPath('user-data'), workspacePath: testInfo.outputPath('workspace'), env: { PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('tab', { name: 'Library', exact: true }).click();
    const left = page.getByRole('complementary', { name: 'Primary navigation' });
    await left.getByRole('tab', { name: 'Skills', exact: true }).click();
    await page.getByRole('button', { name: 'Back up and enable Library', exact: true }).click();
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Import resources' });
    await preview.getByLabel('ZIP file').setInputFiles(zipPath);
    await expect(preview).toContainText('portable-planning');
    await preview.getByRole('button', { name: 'Import resources', exact: true }).click();
    await expect(preview).not.toBeVisible();
    await left.getByRole('button', { name: /^portable-planning/ }).click();
    const skill = page.getByRole('region', { name: 'Skill library' });
    await expect(skill).toContainText('Portable instructions');
    await expect(skill).toContainText('scripts/run.sh');
    await skill.getByRole('button', { name: 'Export', exact: true }).click();
    const exporter = page.getByRole('dialog', { name: 'Export resources' });
    await expect(exporter).toContainText('Standard skill ZIP');
    await expect(exporter.getByRole('button', { name: 'Download ZIP', exact: true })).toBeEnabled();
    const exportedPath = testInfo.outputPath('exported.zip');
    // Electron owns this native download; select its destination through the real session event.
    const downloading = app.evaluate(({ session }, outputPath) => new Promise<void>((resolve, reject) => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(outputPath);
        item.once('done', (_doneEvent, state) => state === 'completed' ? resolve() : reject(new Error(`ZIP download ${state}`)));
      });
    }), exportedPath);
    await exporter.getByRole('button', { name: 'Download ZIP', exact: true }).click();
    await downloading;
    const exported = await JSZip.loadAsync(await fs.readFile(exportedPath));
    expect(await exported.file('portable-planning/scripts/run.sh')?.async('string')).toBe('#!/bin/sh\necho portable\n');
    const store = new ResourceLibraryStore({ repoRoot: projectRoot, rootPath: path.join(testInfo.outputPath('user-data'), 'resource-library') });
    expect((await store.getSnapshot()).packages).toContainEqual(expect.objectContaining({ origin: 'planning.zip' }));
  } finally { await app.close(); }
});
