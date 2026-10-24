import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import JSZip from 'jszip';
import { ResourceLibraryStore } from '../../domains/resource-library/resource-library-store.js';
import { ResourcePackageService } from '../../services/resource-package-service.js';

async function fixture(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-conflict-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'project'); await fs.mkdir(path.join(repoRoot, 'agents/alpha'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'agents/alpha/alpha.md'), 'local alpha');
  const store = new ResourceLibraryStore({ repoRoot, rootPath: path.join(root, 'library') }); await store.migrateLegacyResources();
  return { root, repoRoot, store, service: new ResourcePackageService({ store, repoRoot }) };
}
async function archive(body: string) { return new JSZip().file('planning/SKILL.md', `---\nname: planning\ndescription: Plans the work. Use when planning.\n---\n\n# ${body}\n`).generateAsync({ type: 'nodebuffer' }); }
async function install(service: ResourcePackageService, bytes: Buffer) { const preview = await service.preview({ bytes, filename: 'planning.zip' }); return service.commit({ bytes, filename: 'planning.zip', digest: preview.digest, expectedGeneration: preview.expectedGeneration, resolutions: [] }); }

test('same-name skill imports retain both variants and reject changed or stale previews', async (t) => {
  const { service, store } = await fixture(t);
  const first = await archive('first'); const second = await archive('second');
  await install(service, first);
  const original = (await store.getSnapshot()).skills[0]; assert.ok(original);
  const preview = await service.preview({ bytes: second, filename: 'planning.zip' });
  assert.equal(preview.skills[0]?.conflict, 'name');
  await assert.rejects(service.commit({ bytes: first, filename: 'planning.zip', digest: preview.digest, expectedGeneration: preview.expectedGeneration, resolutions: [] }), /changed since preview/);
  await store.setSkillArchived({ skillId: original.id, archived: true, expectedGeneration: preview.expectedGeneration });
  await assert.rejects(service.commit({ bytes: second, filename: 'planning.zip', digest: preview.digest, expectedGeneration: preview.expectedGeneration, resolutions: [] }), /generation/);
  await install(service, second);
  const snapshot = await store.getSnapshot(); assert.equal(snapshot.skills.length, 2); assert.equal(snapshot.packages.length, 2);
  assert.equal((await store.readSkillRevisionSnapshot(original.id, original.currentRevisionId)).get('SKILL.md')?.contents.toString().endsWith('# first\n'), true);
});

test('an explicit imported revision preserves the existing Agent pin and old skill bytes', async (t) => {
  const { service, store } = await fixture(t);
  await install(service, await archive('first'));
  const initial = await store.getSnapshot(); const skill = initial.skills[0]; assert.ok(skill);
  await store.attachSkill({ agentId: 'alpha', skillId: skill.id, revisionId: skill.currentRevisionId, alias: 'planning', expectedGeneration: initial.generation });
  const bytes = await archive('second'); const preview = await service.preview({ bytes, filename: 'update.zip' }); const sourceId = preview.skills[0]?.sourceId; assert.ok(sourceId);
  await service.commit({ bytes, filename: 'update.zip', digest: preview.digest, expectedGeneration: preview.expectedGeneration, resolutions: [{ sourceId, mode: 'revision', targetSkillId: skill.id }] });
  const current = await store.getSnapshot(); assert.equal(current.skills.length, 1); assert.equal(current.skills[0]?.revisions.length, 2);
  assert.equal(current.agents.find((item) => item.id === 'alpha')?.attachments[0]?.revisionId, skill.currentRevisionId);
  assert.equal((await store.readSkillRevisionSnapshot(skill.id, skill.currentRevisionId)).get('SKILL.md')?.contents.toString().endsWith('# first\n'), true);
});

test('Team import previews reviewed renames and never overwrites existing Agent or Team content', async (t) => {
  const { root } = await fixture(t);
  const sourceRoot = path.join(root, 'source'); await fs.cp(path.resolve('tests/fixtures/team-chat-e2e'), sourceRoot, { recursive: true });
  const sourceStore = new ResourceLibraryStore({ repoRoot: sourceRoot, rootPath: path.join(root, 'source-library') }); await sourceStore.migrateLegacyResources();
  const source = new ResourcePackageService({ store: sourceStore, repoRoot: sourceRoot });
  const exported = await source.export({ kind: 'team', id: 'board-team', format: 'octopus', includeHistory: false });
  const preview = await source.preview({ bytes: exported.bytes, filename: 'board.zip' });
  const renamed = preview.agents.find((item) => item.id === 'spec-alpha'); assert.ok(renamed); assert.notEqual(renamed.targetId, 'spec-alpha');
  const renamedTeam = preview.teams.find((item) => item.id === 'board-team'); assert.ok(renamedTeam); assert.notEqual(renamedTeam.targetId, 'board-team');
  const original = await fs.readFile(path.join(sourceRoot, 'agents/spec-alpha/spec-alpha.md'), 'utf8');
  await source.commit({ bytes: exported.bytes, filename: 'board.zip', digest: preview.digest, expectedGeneration: preview.expectedGeneration, resolutions: [], runtimeTargets: { agents: preview.agents, teams: preview.teams } });
  assert.equal(await fs.readFile(path.join(sourceRoot, 'agents/spec-alpha/spec-alpha.md'), 'utf8'), original);
  assert.equal(await fs.readFile(path.join(sourceRoot, 'agents', renamed.targetId, `${renamed.targetId}.md`), 'utf8'), original);
  const team = await fs.readFile(path.join(sourceRoot, 'teams', renamedTeam.targetId, 'team.yaml'), 'utf8');
  assert.ok(team.includes(`../../agents/${renamed.targetId}/${renamed.targetId}.md`));
});

test('package checksum failures and rejected catalog publication leave no visible installation', async (t) => {
  const { root, repoRoot, service, store } = await fixture(t);
  await install(service, await archive('original'));
  const skill = (await store.getSnapshot()).skills[0]; assert.ok(skill);
  const exported = await service.export({ kind: 'skill', id: skill.id, format: 'octopus', includeHistory: true });
  const changed = await JSZip.loadAsync(exported.bytes);
  const filename = Object.keys(changed.files).find((name) => name.endsWith('/SKILL.md')); assert.ok(filename);
  changed.file(filename, 'changed without manifest');
  const before = await store.getSnapshot();
  await assert.rejects(service.preview({ bytes: await changed.generateAsync({ type: 'nodebuffer' }), filename: 'corrupt.zip' }), /checksum/);
  assert.deepEqual(await store.getSnapshot(), before);
  let rejectPublication = false;
  const guarded = new ResourceLibraryStore({ repoRoot, rootPath: path.join(root, 'guarded-library'), onPersistenceBoundary: (boundary) => { if (rejectPublication && boundary === 'catalog_staged') throw new Error('Catalog rejected'); } });
  await guarded.migrateLegacyResources(); const guardedBefore = await guarded.getSnapshot(); rejectPublication = true;
  const guardedService = new ResourcePackageService({ store: guarded, repoRoot });
  await assert.rejects(install(guardedService, await archive('rejected')), /Catalog rejected/);
  assert.deepEqual(await guarded.getSnapshot(), guardedBefore);
});

test('export refuses a nonconforming legacy revision before offering a non-importable ZIP', async (t) => {
  const { root, repoRoot } = await fixture(t);
  await fs.mkdir(path.join(repoRoot, 'skills/legacy'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'skills/legacy/SKILL.md'), '---\nname: legacy\ndescription: Legacy instructions without activation context.\n---\n\n# Original\n');
  const store = new ResourceLibraryStore({ repoRoot, rootPath: path.join(root, 'legacy-library') }); await store.migrateLegacyResources();
  const skill = (await store.getSnapshot()).skills[0]; assert.ok(skill);
  const service = new ResourcePackageService({ store, repoRoot });
  await assert.rejects(service.export({ kind: 'skill', id: skill.id, format: 'skill', includeHistory: false }), /description|activation|specification/i);
});

test('a local substitution with private files is rejected before collection publication', async (t) => {
  const { root, repoRoot } = await fixture(t);
  await fs.mkdir(path.join(repoRoot, 'skills/planning'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'skills/planning/SKILL.md'), '---\nname: planning\ndescription: Plans work. Use when planning.\n---\n\n# Local\n');
  await fs.writeFile(path.join(repoRoot, 'skills/planning/.env'), 'FIXTURE_SECRET=private');
  const store = new ResourceLibraryStore({ repoRoot, rootPath: path.join(root, 'local-library') }); await store.migrateLegacyResources();
  const before = await store.getSnapshot(); const local = before.skills[0]; assert.ok(local);
  const service = new ResourcePackageService({ store, repoRoot }); const bytes = await archive('incoming');
  const preview = await service.preview({ bytes, filename: 'planning.zip' }); const incoming = preview.skills[0]; assert.ok(incoming);
  await assert.rejects(service.commit({ bytes, filename: 'planning.zip', digest: preview.digest, expectedGeneration: preview.expectedGeneration, resolutions: [{ sourceId: incoming.sourceId, mode: 'reuse', targetSkillId: local.id, revisionId: local.currentRevisionId }] }), /private files/i);
  assert.deepEqual(await store.getSnapshot(), before);
});
