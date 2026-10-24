import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { resourceMigrationReportSchema } from '../../contracts/resource-migration.js';

test('migration CLI reviews and enables isolated sources then preserves data on an unused rollback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'migration-cli-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repo = path.join(root, 'project'); const library = path.join(root, 'library'); const reportPath = path.join(root, 'review.json');
  await fs.mkdir(path.join(repo, 'skills/planning'), { recursive: true });
  await fs.mkdir(path.join(repo, 'agents'), { recursive: true });
  const document = '---\nname: planning\ndescription: Plans work. Use when planning.\n---\n\n# Original\n';
  await fs.writeFile(path.join(repo, 'skills/planning/SKILL.md'), document);
  const run = (command: string, args: string[]) => spawnSync(process.execPath, ['--import', 'tsx', path.resolve('scripts/resource-library-migration.ts'), command, '--repo-root', repo, '--library-root', library, ...args], { encoding: 'utf8', timeout: 10_000 });
  const dryRun = run('dry-run', ['--report', reportPath]); assert.equal(dryRun.status, 0, dryRun.stderr);
  await assert.rejects(fs.stat(path.join(library, 'current.json')), { code: 'ENOENT' });
  const value: unknown = JSON.parse(await fs.readFile(reportPath, 'utf8')); const report = resourceMigrationReportSchema.parse(value);
  assert.equal(report.sources.length, 1);
  const applied = run('apply', ['--report', reportPath]); assert.equal(applied.status, 0, applied.stderr);
  const backupDirs = await fs.readdir(path.join(library, 'backups')); const backup = backupDirs[0]; assert.ok(backup);
  assert.equal(await fs.readFile(path.join(library, 'backups', backup, 'sources/skills/planning/SKILL.md'), 'utf8'), document);
  const rollback = run('rollback', ['--backup', path.join(library, 'backups', backup)]); assert.equal(rollback.status, 0, rollback.stderr);
  assert.equal(await fs.readFile(path.join(repo, 'skills/planning/SKILL.md'), 'utf8'), document);
  await assert.rejects(fs.stat(path.join(library, 'current.json')), { code: 'ENOENT' });
});
