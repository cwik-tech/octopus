import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { stageCuratedBuiltIns } from '../../electron/builtin-resources.js';
import { seedDesktopProjectRoot } from '../../electron/project-root.js';
import { ResourceLibraryService } from '../../services/resource-library-service.js';

test('bundled updates are offered for review and acknowledged only by an explicit Library import', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-offer-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'); const first = path.join(root, 'first'); const second = path.join(root, 'second'); const repoRootPath = path.join(root, 'project'); const rootPath = path.join(root, 'library');
  await fs.mkdir(path.join(sourceRoot, 'agents/core'), { recursive: true }); await fs.writeFile(path.join(sourceRoot, 'agents/core/core.md'), 'initial core persona');
  const selection = { schemaVersion: 1 as const, agents: ['core'], teams: [], skills: [], workflowTemplates: [], entryTeam: null };
  await stageCuratedBuiltIns({ sourceRoot, outputRoot: first, appVersion: '1.0.0', selection }); await seedDesktopProjectRoot({ appRootPath: first, projectRootPath: repoRootPath });
  const service = new ResourceLibraryService({ repoRootPath, rootPath, requireMigrationApproval: false, builtinResourceRootPath: second }); await service.initialize();
  await fs.writeFile(path.join(repoRootPath, 'agents/core/core.md'), 'personal edit');
  await fs.writeFile(path.join(sourceRoot, 'agents/core/core.md'), 'updated bundled persona');
  await stageCuratedBuiltIns({ sourceRoot, outputRoot: second, appVersion: '1.0.1', selection }); await seedDesktopProjectRoot({ appRootPath: second, projectRootPath: repoRootPath });
  const offer = (await service.getBrowserSnapshot()).builtInUpdates?.[0]; assert.ok(offer); assert.equal(offer.path, 'agents/core');
  const exported = await service.exportBuiltinUpdate({ path: offer.path, digest: offer.digest });
  const preview = await service.packages.preview({ bytes: exported.bytes, filename: exported.filename });
  await service.packages.commit({ bytes: exported.bytes, filename: exported.filename, digest: preview.digest, expectedGeneration: preview.expectedGeneration, resolutions: [], runtimeTargets: { agents: preview.agents, teams: preview.teams }, builtinUpdate: { path: offer.path, digest: offer.digest } });
  assert.equal(await fs.readFile(path.join(repoRootPath, 'agents/core/core.md'), 'utf8'), 'personal edit');
  assert.equal((await service.getBrowserSnapshot()).builtInUpdates?.length, 0);
  const targetId = preview.agents[0]?.targetId; assert.ok(targetId);
  assert.equal(await fs.readFile(path.join(repoRootPath, 'agents', targetId, `${targetId}.md`), 'utf8'), 'updated bundled persona');
});
