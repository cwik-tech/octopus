import { test, expect } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { launchDesktop } from './support/desktop-launch.js';

test('Library requires reviewed migration approval without blocking existing Create and Run navigation', async ({}, testInfo) => {
  const projectRoot = testInfo.outputPath('project'); const userDataPath = testInfo.outputPath('user-data');
  await fs.cp(path.resolve('tests/fixtures/team-chat-e2e'), projectRoot, { recursive: true });
  const app = await launchDesktop({ userDataPath, workspacePath: testInfo.outputPath('workspace'), env: { PIPELINE_DESKTOP_PROJECT_ROOT: projectRoot } });
  try {
    const page = await app.firstWindow(); const left = page.getByRole('complementary', { name: 'Primary navigation' });
    await page.getByRole('tab', { name: 'Create', exact: true }).click(); await left.getByRole('tab', { name: 'Agents', exact: true }).click();
    await expect(left.getByRole('button', { name: /^Spec Alpha/ })).toBeVisible();
    await page.getByRole('tab', { name: 'Run', exact: true }).click(); await expect(left.getByRole('tab', { name: 'Sessions', exact: true })).toHaveAttribute('aria-selected', 'true');
    await assertNoCatalog();
    await page.getByRole('tab', { name: 'Library', exact: true }).click(); await left.getByRole('tab', { name: 'Skills', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Review existing resources', exact: true })).toBeVisible(); await assertNoCatalog();
    await page.getByRole('button', { name: 'Back up and enable Library', exact: true }).click();
    await expect(page.getByRole('button', { name: 'New skill', exact: true })).toBeVisible();
    expect((await fs.readdir(path.join(userDataPath, 'resource-library/backups'))).length).toBe(1);
    expect(await fs.readFile(path.join(projectRoot, 'agents/spec-alpha/spec-alpha.md'), 'utf8')).toContain('spec-alpha');
    await page.screenshot({ path: testInfo.outputPath('enabled-library.png') });
  } finally { await app.close(); }
  async function assertNoCatalog() { await expect(fs.stat(path.join(userDataPath, 'resource-library/current.json'))).rejects.toMatchObject({ code: 'ENOENT' }); }
});
