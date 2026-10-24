import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ResourceLibraryService } from '../../services/resource-library-service.js';
import { writeFileAtomic } from '../../core/file-mutation.js';

async function fixture(t: import('node:test').TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'resource-concurrency-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'project'); await fs.mkdir(path.join(repoRoot, 'agents/alpha'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'agents/alpha/alpha.md'), 'alpha persona');
  await fs.writeFile(path.join(repoRoot, 'teams.yaml'), '');
  const service = new ResourceLibraryService({ repoRootPath: repoRoot, rootPath: path.join(root, 'library'), requireMigrationApproval: false });
  await service.initialize();
  return { repoRoot, service };
}

test('concurrent resource publications retain both accepted Team registry entries', async (t) => {
  const { repoRoot, service } = await fixture(t); const registry = path.join(repoRoot, 'teams.yaml');
  const append = (id: string) => service.publishResources(async () => {
    const previous = fsSync.readFileSync(registry, 'utf8');
    await Promise.resolve();
    await writeFileAtomic(registry, `${previous}${id}:\n  type: team\n`);
  });
  await Promise.all([append('imported'), append('legacy')]);
  const final = await fs.readFile(registry, 'utf8');
  assert.ok(final.includes('imported:\n'), 'The accepted imported Team must remain registered');
  assert.ok(final.includes('legacy:\n'), 'The accepted existing Team write must remain registered');
});

test('a Team publication can publish its staged Agent without reacquiring Library ownership', { timeout: 2000 }, async (t) => {
  const { repoRoot, service } = await fixture(t);
  await service.publishResources(async (owned) => {
    await owned.publishAgent('beta', async () => {
      await fs.mkdir(path.join(repoRoot, 'agents/beta/skills/planning'), { recursive: true });
      await fs.writeFile(path.join(repoRoot, 'agents/beta/beta.md'), 'beta persona');
      await fs.writeFile(path.join(repoRoot, 'agents/beta/skills/planning/SKILL.md'), '---\nname: planning\ndescription: Plans work. Use when planning.\n---\n\n# Planning\n');
    });
  });
  const snapshot = await service.store.getSnapshot();
  assert.ok(snapshot.agents.find((agent) => agent.id === 'beta')?.attachments.some((pin) => pin.alias === 'planning'));
});

test('the Team API refuses publication while an interrupted Library import has external drift', async (t) => {
  const { repoRoot, service } = await fixture(t);
  const { startApiServer } = await import('../../server/api-server.js');
  const { FileSystemRunStore } = await import('../../domains/run/run-store.js');
  const { publishImportedResources } = await import('../../domains/resource-library/package-publication.js');
  const { filesFromBuffers } = await import('../../domains/resource-library/skill-files.js');
  const workspacePath = path.join(repoRoot, 'workspace'); const libraryRoot = path.join(repoRoot, '../library');
  await fs.mkdir(workspacePath, { recursive: true });
  const server = await startApiServer({ repoRootPath: repoRoot, resourceLibraryRootPath: libraryRoot, workspacePath, requireResourceLibraryMigrationApproval: false, store: new FileSystemRunStore(workspacePath), launcher: { async startRun() { return { launched: true, pid: 0, cwd: repoRoot }; } } });
  t.after(() => server.close());
  await service.initialize();
  await assert.rejects(publishImportedResources({ repoRoot, libraryRoot, generationId: 'uncommitted', resources: new Map([['agents/imported', filesFromBuffers(new Map([['imported.md', Buffer.from('imported persona')]]))]]), publish: async () => { await fs.writeFile(path.join(repoRoot, 'agents/imported/imported.md'), 'external edit'); throw new Error('publication rejected'); }, isPublished: async () => false }), /external drift/);
  const before = await fs.readFile(path.join(repoRoot, 'teams.yaml'), 'utf8');
  const response = await fetch(`${server.url}/create/team-builder/teams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'legacy-team', description: 'Legacy team', tags: [] }), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 500, 'Team publication must refuse the shared recovery conflict');
  assert.equal(await fs.readFile(path.join(repoRoot, 'teams.yaml'), 'utf8'), before);
  await assert.rejects(fs.stat(path.join(repoRoot, 'teams/legacy-team')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(repoRoot, 'agents/imported/imported.md'), 'utf8'), 'external edit');
});

test('a real Team API write and package import preserve their reviewed registry entries', async (t) => {
  const { repoRoot, service } = await fixture(t);
  const { createTeamBuilderTeam } = await import('../../domains/agent-generator/team-manager.js');
  const { startApiServer } = await import('../../server/api-server.js');
  const { FileSystemRunStore } = await import('../../domains/run/run-store.js');
  const { parseYaml } = await import('../../core/yaml-parser.js');
  await createTeamBuilderTeam(repoRoot, { id: 'portable-team', description: 'Portable team', tags: [] });
  const archive = await service.packages.export({ kind: 'team', id: 'portable-team', format: 'octopus', includeHistory: false });
  const preview = await service.packages.preview({ bytes: archive.bytes, filename: 'portable.zip' });
  const target = preview.teams[0]; assert.ok(target);
  const workspacePath = path.join(repoRoot, 'workspace'); await fs.mkdir(workspacePath);
  const server = await startApiServer({ repoRootPath: repoRoot, resourceLibraryRootPath: path.join(repoRoot, '../library'), workspacePath, requireResourceLibraryMigrationApproval: false, store: new FileSystemRunStore(workspacePath), launcher: { async startRun() { return { launched: true, pid: 0, cwd: repoRoot }; } } });
  t.after(() => server.close());
  const [response, imported] = await Promise.all([
    fetch(`${server.url}/create/team-builder/teams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'concurrent-team', description: 'Concurrent team', tags: [] }), signal: AbortSignal.timeout(5000) }),
    service.packages.commit({ bytes: archive.bytes, filename: 'portable.zip', digest: preview.digest, expectedGeneration: preview.expectedGeneration, resolutions: [], runtimeTargets: { agents: preview.agents, teams: preview.teams } }),
  ]);
  assert.equal(response.status, 201, await response.text()); assert.equal(imported.unchanged, false);
  const registry = parseYaml(await fs.readFile(path.join(repoRoot, 'teams.yaml'), 'utf8'));
  assert.ok(registry['portable-team']); assert.ok(registry['concurrent-team']); assert.ok(registry[target.targetId]);
});

test('a Team API write recovers an unpublished import before accepting new registry changes', async (t) => {
  const { repoRoot } = await fixture(t);
  const { startApiServer } = await import('../../server/api-server.js');
  const { FileSystemRunStore } = await import('../../domains/run/run-store.js');
  const { spawnSync } = await import('node:child_process');
  const libraryRoot = path.join(repoRoot, '../library'); const workspacePath = path.join(repoRoot, 'workspace'); await fs.mkdir(workspacePath);
  const server = await startApiServer({ repoRootPath: repoRoot, resourceLibraryRootPath: libraryRoot, workspacePath, requireResourceLibraryMigrationApproval: false, store: new FileSystemRunStore(workspacePath), launcher: { async startRun() { return { launched: true, pid: 0, cwd: repoRoot }; } } });
  t.after(() => server.close());
  assert.equal((await fetch(`${server.url}/resource-library`, { signal: AbortSignal.timeout(5000) })).status, 200);
  const publication = new URL('../../domains/resource-library/package-publication.js', import.meta.url).href;
  const files = new URL('../../domains/resource-library/skill-files.js', import.meta.url).href;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { publishImportedResources } from ${JSON.stringify(publication)}; import { filesFromBuffers } from ${JSON.stringify(files)}; await publishImportedResources({repoRoot:${JSON.stringify(repoRoot)},libraryRoot:${JSON.stringify(libraryRoot)},generationId:'interrupted-team-import',resources:new Map([['agents/imported',filesFromBuffers(new Map([['imported.md',Buffer.from('imported persona')]]))]]),registry:{before:Buffer.from(''),after:Buffer.from('imported:\\n  type: team\\n')},publish:async()=>{process.exit(23)},isPublished:async()=>false});`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(child.status, 23, child.stderr);
  const response = await fetch(`${server.url}/create/team-builder/teams`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'after-recovery', description: 'Recovered team', tags: [] }), signal: AbortSignal.timeout(5000) });
  assert.equal(response.status, 201, await response.text());
  await assert.rejects(fs.stat(path.join(repoRoot, 'agents/imported')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(libraryRoot, 'package-publication.json')), { code: 'ENOENT' });
  const registry = await fs.readFile(path.join(repoRoot, 'teams.yaml'), 'utf8');
  assert.ok(registry.includes('after-recovery:')); assert.ok(!registry.includes('imported:'));
});
