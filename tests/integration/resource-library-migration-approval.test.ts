import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { ResourceLibraryService } from '../../services/resource-library-service.js';

async function fixture(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'library-approval-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repoRootPath = path.join(root, 'project'); const rootPath = path.join(root, 'library');
  const source = path.join(repoRootPath, 'agents/alpha/skills/planning'); await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(repoRootPath, 'agents/alpha/alpha.md'), 'alpha persona');
  const document = '---\nname: planning\ndescription: Plans work. Use when planning.\n---\n\n# Original\n';
  await fs.writeFile(path.join(source, 'SKILL.md'), document);
  const service = new ResourceLibraryService({ repoRootPath, rootPath, requireMigrationApproval: true });
  return { root, rootPath, repoRootPath, source, service, document };
}

test('desktop migration waits for approval while legacy publication and execution remain available', async (t) => {
  const { service, rootPath, repoRootPath, source, document } = await fixture(t);
  assert.equal(await service.initialize(), undefined);
  await assert.rejects(fs.stat(path.join(rootPath, 'current.json')), { code: 'ENOENT' });
  const snapshot = await service.getBrowserSnapshot(); assert.ok(snapshot.migrationPending);
  assert.equal(snapshot.migrationPending.sources.length, 1);
  assert.equal((await service.createAgentProjection({ scopeId: 'legacy-turn', agentIds: ['alpha'] })).rootPath, repoRootPath);
  await service.publishAgent('alpha', async () => fs.writeFile(path.join(source, 'SKILL.md'), document.replace('Original', 'Edited')));
  assert.equal(await fs.readFile(path.join(repoRootPath, 'skills/planning/SKILL.md'), 'utf8'), document);
  await assert.rejects(fs.stat(path.join(rootPath, 'current.json')), { code: 'ENOENT' });
});

test('approved migration creates a verified backup and retains its receipt after restart', async (t) => {
  const { service, rootPath, repoRootPath, source, document } = await fixture(t);
  const preview = (await service.getBrowserSnapshot()).migrationPending; assert.ok(preview);
  const result = await service.approveMigration({ inventoryDigest: preview.inventoryDigest, expectedGeneration: preview.expectedGeneration });
  assert.equal(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), document);
  assert.equal(await fs.readFile(path.join(result.backupPath, 'sources/agents/alpha/skills/planning/SKILL.md'), 'utf8'), document);
  const restarted = new ResourceLibraryService({ repoRootPath, rootPath, requireMigrationApproval: true });
  assert.ok(await restarted.initialize());
  assert.equal((await restarted.getBrowserSnapshot()).migrationPending, undefined);
  assert.equal((await restarted.getBrowserSnapshot()).skills.length, 1);
});

test('changed migration sources reject a stale approval without publishing a catalog', async (t) => {
  const { service, rootPath, source } = await fixture(t);
  const preview = (await service.getBrowserSnapshot()).migrationPending; assert.ok(preview);
  await fs.writeFile(path.join(source, 'SKILL.md'), 'changed after review');
  await assert.rejects(service.approveMigration({ inventoryDigest: preview.inventoryDigest, expectedGeneration: preview.expectedGeneration }), /changed|stale/i);
  await assert.rejects(fs.stat(path.join(rootPath, 'current.json')), { code: 'ENOENT' });
});

test('cancelled migration approval leaves the canonical catalog unpublished', async (t) => {
  const { service, rootPath } = await fixture(t);
  const preview = (await service.getBrowserSnapshot()).migrationPending; assert.ok(preview);
  await assert.rejects(service.approveMigration({ inventoryDigest: preview.inventoryDigest, expectedGeneration: preview.expectedGeneration }, { signal: AbortSignal.abort() }), /abort/i);
  await assert.rejects(fs.stat(path.join(rootPath, 'current.json')), { code: 'ENOENT' });
});

test('rollback before Library use preserves its data and returns to approval-required mode', async (t) => {
  const { service, rootPath, repoRootPath } = await fixture(t);
  const preview = (await service.getBrowserSnapshot()).migrationPending; assert.ok(preview);
  const result = await service.approveMigration({ inventoryDigest: preview.inventoryDigest, expectedGeneration: preview.expectedGeneration });
  const { rollbackResourceMigration } = await import('../../services/resource-migration-rollback.js');
  await rollbackResourceMigration({ store: service.store, repoRoot: repoRootPath, libraryRoot: rootPath, backupPath: result.backupPath });
  await assert.rejects(fs.stat(path.join(rootPath, 'current.json')), { code: 'ENOENT' });
  assert.ok((await service.getBrowserSnapshot()).migrationPending);
  assert.equal((await fs.readdir(path.join(rootPath, 'revisions'))).length, 1);
});

test('rollback refuses to discard revisions created after migration', async (t) => {
  const { service, rootPath, repoRootPath, document } = await fixture(t);
  const preview = (await service.getBrowserSnapshot()).migrationPending; assert.ok(preview);
  const result = await service.approveMigration({ inventoryDigest: preview.inventoryDigest, expectedGeneration: preview.expectedGeneration });
  const skill = (await service.getBrowserSnapshot()).skills[0]; assert.ok(skill);
  const { filesFromBuffers } = await import('../../domains/resource-library/skill-files.js');
  await service.saveSkillRevision({ skillId: skill.id, baseRevisionId: skill.currentRevisionId, expectedGeneration: 1, changeNote: 'After migration', files: filesFromBuffers(new Map([['SKILL.md', Buffer.from(document.replace('Original', 'After migration'))]])) });
  const { rollbackResourceMigration } = await import('../../services/resource-migration-rollback.js');
  await assert.rejects(rollbackResourceMigration({ store: service.store, repoRoot: repoRootPath, libraryRoot: rootPath, backupPath: result.backupPath }), /used|changed|generation/i);
  assert.equal((await service.getBrowserSnapshot()).skills[0]?.revisions.length, 2);
});
