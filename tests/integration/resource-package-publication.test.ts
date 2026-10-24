import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { publishImportedResources, recoverImportedResources } from '../../domains/resource-library/package-publication.js';
import { filesFromBuffers } from '../../domains/resource-library/skill-files.js';

test('rejected package publication removes only its newly published resource directories', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-publication-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'project'); const libraryRoot = path.join(root, 'library');
  await fs.mkdir(path.join(repoRoot, 'agents/local'), { recursive: true });
  await fs.writeFile(path.join(repoRoot, 'agents/local/local.md'), 'local original');
  const resources = new Map([['agents/imported', filesFromBuffers(new Map([['imported.md', Buffer.from('imported persona')]]))]]);
  await assert.rejects(publishImportedResources({ repoRoot, libraryRoot, generationId: 'next-generation', resources,
    registry: { before: null, after: Buffer.from('imported:\n  type: team\n  team_path: ./teams/imported\n') },
    publish: async () => { assert.equal((await fs.readFile(path.join(repoRoot, 'teams.yaml'), 'utf8')).startsWith('imported:'), true); throw new Error('Catalog publication rejected'); }, isPublished: async () => false,
  }), /rejected/);
  await assert.rejects(fs.stat(path.join(repoRoot, 'agents/imported')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(repoRoot, 'agents/local/local.md'), 'utf8'), 'local original');
  await assert.rejects(fs.stat(path.join(repoRoot, 'teams.yaml')), { code: 'ENOENT' });
});

test('package restart recovery retains committed resources and refuses to erase external drift', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'project'); const libraryRoot = path.join(root, 'library');
  const resources = new Map([['agents/imported', filesFromBuffers(new Map([['imported.md', Buffer.from('imported persona')]]))]]);
  await publishImportedResources({ repoRoot, libraryRoot, generationId: 'committed', resources, publish: async () => undefined, isPublished: async () => true });
  await recoverImportedResources(repoRoot, libraryRoot, 'committed');
  assert.equal(await fs.readFile(path.join(repoRoot, 'agents/imported/imported.md'), 'utf8'), 'imported persona');
  await assert.rejects(publishImportedResources({ repoRoot, libraryRoot, generationId: 'another', resources, publish: async () => undefined, isPublished: async () => false }), /exist|collision/i);
  assert.equal(await fs.readFile(path.join(repoRoot, 'agents/imported/imported.md'), 'utf8'), 'imported persona');
});

async function interruptedPublication(t: import('node:test').TestContext, committed: boolean, beforeCrash?: (paths: { repoRoot: string; libraryRoot: string }) => Promise<void>) {
  const { spawnSync } = await import('node:child_process');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'package-crash-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const repoRoot = path.join(root, 'project'); const libraryRoot = path.join(root, 'library');
  await beforeCrash?.({ repoRoot, libraryRoot });
  const publicationModule = new URL('../../domains/resource-library/package-publication.js', import.meta.url).href;
  const filesModule = new URL('../../domains/resource-library/skill-files.js', import.meta.url).href;
  const beforeRegistry = 'local:\n  type: team\n  team_path: ./teams/local\n';
  const afterRegistry = `${beforeRegistry}imported:\n  type: team\n  team_path: ./teams/imported\n`;
  const code = `import { publishImportedResources } from ${JSON.stringify(publicationModule)};
    import { filesFromBuffers } from ${JSON.stringify(filesModule)};
    import * as fs from 'node:fs/promises';
    await fs.mkdir(${JSON.stringify(repoRoot)}, { recursive: true });
    await fs.writeFile(${JSON.stringify(path.join(repoRoot, 'teams.yaml'))}, ${JSON.stringify(beforeRegistry)});
    await publishImportedResources({ repoRoot: ${JSON.stringify(repoRoot)}, libraryRoot: ${JSON.stringify(libraryRoot)}, generationId: 'crashed',
      resources: new Map([['agents/imported', filesFromBuffers(new Map([['imported.md', Buffer.from('original imported persona')]]))]]),
      registry: { before: Buffer.from(${JSON.stringify(beforeRegistry)}), after: Buffer.from(${JSON.stringify(afterRegistry)}) },
      publish: async () => { ${committed ? `await fs.writeFile(${JSON.stringify(path.join(libraryRoot, 'committed'))}, 'yes');` : ''} process.exit(23); }, isPublished: async () => false });`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { encoding: 'utf8' });
  assert.equal(result.status, 23, result.stderr);
  return { repoRoot, libraryRoot };
}

test('a process exit before catalog publication is recovered without leaving imported Agents', async (t) => {
  const { repoRoot, libraryRoot } = await interruptedPublication(t, false);
  await recoverImportedResources(repoRoot, libraryRoot, 'previous');
  await assert.rejects(fs.stat(path.join(repoRoot, 'agents/imported')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(repoRoot, 'teams.yaml'), 'utf8'), 'local:\n  type: team\n  team_path: ./teams/local\n');
});

test('a process exit after catalog publication retains the complete imported Agent', async (t) => {
  const { repoRoot, libraryRoot } = await interruptedPublication(t, true);
  await recoverImportedResources(repoRoot, libraryRoot, 'crashed');
  assert.equal(await fs.readFile(path.join(repoRoot, 'agents/imported/imported.md'), 'utf8'), 'original imported persona');
  await assert.rejects(fs.stat(path.join(repoRoot, 'agents/imported/.octopus-import-owner')), { code: 'ENOENT' });
  assert.equal((await fs.readFile(path.join(repoRoot, 'teams.yaml'), 'utf8')).includes('imported:'), true);
});

test('recovery refuses to delete an interrupted import that was edited externally', async (t) => {
  const { repoRoot, libraryRoot } = await interruptedPublication(t, false);
  await fs.writeFile(path.join(repoRoot, 'agents/imported/imported.md'), 'external edit');
  await assert.rejects(recoverImportedResources(repoRoot, libraryRoot, 'previous'), /external drift/);
  assert.equal(await fs.readFile(path.join(repoRoot, 'agents/imported/imported.md'), 'utf8'), 'external edit');
});

test('an initialized Library read recovers another process interrupted package publication', async (t) => {
  const { ResourceLibraryService } = await import('../../services/resource-library-service.js');
  let service: InstanceType<typeof ResourceLibraryService> | undefined;
  await interruptedPublication(t, false, async ({ repoRoot, libraryRoot }) => {
    await fs.mkdir(path.join(repoRoot, 'agents'), { recursive: true });
    service = new ResourceLibraryService({ repoRootPath: repoRoot, rootPath: libraryRoot, requireMigrationApproval: false });
    await service.initialize();
  });
  assert.ok(service);
  assert.equal((await service.getBrowserSnapshot()).agentDetails.some((agent) => agent.name === 'imported'), false);
});
