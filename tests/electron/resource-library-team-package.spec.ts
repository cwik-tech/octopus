import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { launchDesktop } from './support/desktop-launch.js';

test('Library imports a Team package as reviewed variants without overwriting its original Team', async ({}, testInfo) => {
  const projectRoot = testInfo.outputPath('project');
  await fs.cp(path.resolve('tests/fixtures/team-chat-e2e'), projectRoot, { recursive: true });
  const original = await fs.readFile(path.join(projectRoot, 'teams/board-team/team.yaml'), 'utf8');
  const app = await launchDesktop({ userDataPath: testInfo.outputPath('user-data'), workspacePath: testInfo.outputPath('workspace'), env: { PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot } });
  try {
    const page = await app.firstWindow(); const left = page.getByRole('complementary', { name: 'Primary navigation' });
    await page.getByRole('tab', { name: 'Library', exact: true }).click();
    await left.getByRole('tab', { name: 'Teams', exact: true }).click();
    await page.getByRole('button', { name: 'Back up and enable Library', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Import', exact: true })).toBeVisible();
    await left.getByRole('button', { name: /^Board Team/ }).click();
    await expect(page.getByRole('heading', { name: 'Board Team', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    const zipPath = testInfo.outputPath('board-team.zip');
    const downloading = app.evaluate(({ session }, outputPath) => new Promise<void>((resolve, reject) => {
      session.defaultSession.once('will-download', (_event, item) => { item.setSavePath(outputPath); item.once('done', (_done, state) => state === 'completed' ? resolve() : reject(new Error(`Download ${state}`))); });
    }), zipPath);
    await page.getByRole('dialog', { name: 'Export resources' }).getByRole('button', { name: 'Download ZIP', exact: true }).click(); await downloading;
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    const preview = page.getByRole('dialog', { name: 'Import resources' }); await preview.getByLabel('ZIP file').setInputFiles(zipPath);
    await expect(preview).toContainText('board-team → board-team-import-');
    await preview.getByRole('button', { name: 'Import resources', exact: true }).click();
    await expect(preview).not.toBeVisible();
    await left.getByRole('button', { name: /^Board Team Import/ }).click();
    await expect(page.getByRole('region', { name: 'Team library' })).toContainText('board-lead-import-');
    expect(await fs.readFile(path.join(projectRoot, 'teams/board-team/team.yaml'), 'utf8')).toBe(original);
    await page.screenshot({ path: testInfo.outputPath('imported-team.png') });
  } finally { await app.close(); }
});
