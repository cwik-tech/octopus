import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { stageCuratedBuiltIns } from '../../electron/builtin-resources.js';
import { seedDesktopProjectRoot } from '../../electron/project-root.js';

test('packaged defaults seed successfully when Finder metadata is excluded from the app', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-finder-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source');
  const outputRoot = path.join(root, 'bundle');
  const projectRootPath = path.join(root, 'project');
  const localSkill = 'agents/core/skills/example';
  const sharedSkill = 'skills/example';
  const document = '---\nname: example\ndescription: Demonstrate packaged startup. Use when testing bundled skill installation.\n---\nUse this example.\n';
  await fs.mkdir(path.join(sourceRoot, localSkill, 'references'), { recursive: true });
  await fs.mkdir(path.join(sourceRoot, sharedSkill), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'agents/core/core.md'), 'core persona');
  await fs.writeFile(path.join(sourceRoot, localSkill, 'SKILL.md'), document);
  await fs.writeFile(path.join(sourceRoot, sharedSkill, 'SKILL.md'), document);
  await fs.writeFile(path.join(sourceRoot, localSkill, 'references/.DS_Store'), 'Finder metadata');
  await fs.writeFile(path.join(sourceRoot, sharedSkill, '.DS_Store'), 'Finder metadata');

  await stageCuratedBuiltIns({ sourceRoot, outputRoot, appVersion: '1.0.0', selection: { schemaVersion: 1, agents: ['core'], teams: [], skills: ['example'], workflowTemplates: [], entryTeam: null } });
  // Electron Builder excludes these files from the final app by default.
  await fs.rm(path.join(outputRoot, localSkill, 'references/.DS_Store'), { force: true });
  await fs.rm(path.join(outputRoot, sharedSkill, '.DS_Store'), { force: true });
  await seedDesktopProjectRoot({ appRootPath: outputRoot, projectRootPath });

  assert.equal(await fs.readFile(path.join(projectRootPath, localSkill, 'SKILL.md'), 'utf8'), document);
  assert.equal(await fs.readFile(path.join(projectRootPath, sharedSkill, 'SKILL.md'), 'utf8'), document);
  assert.equal((await fs.readFile(path.join(outputRoot, 'builtin-resources.json'), 'utf8')).includes('.DS_Store'), false);
});

test('curated distribution stages selected dependencies without personal resources or memory', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-stage-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'); const outputRoot = path.join(root, 'output');
  await fs.mkdir(path.join(sourceRoot, 'agents/core/experience'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'agents/core/core.md'), 'core persona');
  await fs.writeFile(path.join(sourceRoot, 'agents/core/experience/private.md'), 'private memory');
  await fs.mkdir(path.join(sourceRoot, 'agents/personal'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'agents/personal/personal.md'), 'personal persona');
  await stageCuratedBuiltIns({ sourceRoot, outputRoot, appVersion: '1.0.0', selection: { schemaVersion: 1, agents: ['core'], teams: [], skills: [], workflowTemplates: [], entryTeam: null } });
  assert.equal(await fs.readFile(path.join(outputRoot, 'agents/core/core.md'), 'utf8'), 'core persona');
  await assert.rejects(fs.stat(path.join(outputRoot, 'agents/core/experience')), { code: 'ENOENT' });
  await assert.rejects(fs.stat(path.join(outputRoot, 'agents/personal')), { code: 'ENOENT' });
  assert.equal(await fs.readFile(path.join(sourceRoot, 'agents/personal/personal.md'), 'utf8'), 'personal persona');
  assert.equal(await fs.readFile(path.join(sourceRoot, 'agents/core/experience/private.md'), 'utf8'), 'private memory');
});

test('built-in install receipts preserve edits and removed defaults across bundled upgrades', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-upgrade-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'); const firstBundle = path.join(root, 'bundle-one'); const secondBundle = path.join(root, 'bundle-two'); const projectRootPath = path.join(root, 'personal-project');
  await fs.mkdir(path.join(sourceRoot, 'agents/core'), { recursive: true }); await fs.writeFile(path.join(sourceRoot, 'agents/core/core.md'), 'original bundled persona');
  const selection = { schemaVersion: 1 as const, agents: ['core'], teams: [], skills: [], workflowTemplates: [], entryTeam: null };
  await stageCuratedBuiltIns({ sourceRoot, outputRoot: firstBundle, appVersion: '1.0.0', selection });
  await seedDesktopProjectRoot({ appRootPath: firstBundle, projectRootPath });
  await fs.writeFile(path.join(projectRootPath, 'agents/core/core.md'), 'personal edit');
  await fs.writeFile(path.join(sourceRoot, 'agents/core/core.md'), 'new bundled persona');
  await stageCuratedBuiltIns({ sourceRoot, outputRoot: secondBundle, appVersion: '1.0.1', selection });
  await seedDesktopProjectRoot({ appRootPath: secondBundle, projectRootPath });
  assert.equal(await fs.readFile(path.join(projectRootPath, 'agents/core/core.md'), 'utf8'), 'personal edit');
  const receipt = JSON.parse(await fs.readFile(path.join(projectRootPath, '.builtin-install-receipt.json'), 'utf8'));
  assert.equal(receipt.offeredUpdates[0]?.path, 'agents/core');
  await fs.rm(path.join(projectRootPath, 'agents/core'), { recursive: true });
  await seedDesktopProjectRoot({ appRootPath: secondBundle, projectRootPath });
  await assert.rejects(fs.stat(path.join(projectRootPath, 'agents/core')), { code: 'ENOENT' });
});

test('a corrupt bundled resource cannot leave a partially installed default', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-corrupt-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'); const outputRoot = path.join(root, 'bundle'); const projectRootPath = path.join(root, 'project');
  await fs.mkdir(path.join(sourceRoot, 'agents/core'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'agents/core/core.md'), 'valid persona');
  await fs.writeFile(path.join(sourceRoot, 'agents/core/z-support.md'), 'valid support');
  await stageCuratedBuiltIns({ sourceRoot, outputRoot, appVersion: '1.0.0', selection: { schemaVersion: 1, agents: ['core'], teams: [], skills: [], workflowTemplates: [], entryTeam: null } });
  await fs.writeFile(path.join(outputRoot, 'agents/core/z-support.md'), 'corrupted support');
  await assert.rejects(seedDesktopProjectRoot({ appRootPath: outputRoot, projectRootPath }), /checksum/);
  await assert.rejects(fs.stat(path.join(projectRootPath, 'agents/core')), { code: 'ENOENT' });
});

test('the first curated upgrade preserves legacy edits and absent defaults without an old receipt', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'builtin-legacy-upgrade-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sourceRoot = path.join(root, 'source'); const outputRoot = path.join(root, 'bundle'); const projectRootPath = path.join(root, 'legacy-project');
  await fs.mkdir(path.join(sourceRoot, 'agents/core'), { recursive: true }); await fs.writeFile(path.join(sourceRoot, 'agents/core/core.md'), 'bundled core');
  await fs.mkdir(path.join(sourceRoot, 'agents/removed'), { recursive: true }); await fs.writeFile(path.join(sourceRoot, 'agents/removed/removed.md'), 'bundled default');
  await fs.mkdir(path.join(projectRootPath, 'agents/core'), { recursive: true }); await fs.writeFile(path.join(projectRootPath, 'agents/core/core.md'), 'legacy personal edit');
  await stageCuratedBuiltIns({ sourceRoot, outputRoot, appVersion: '1.0.0', selection: { schemaVersion: 1, agents: ['core', 'removed'], teams: [], skills: [], workflowTemplates: [], entryTeam: null } });
  const result = await seedDesktopProjectRoot({ appRootPath: outputRoot, projectRootPath });
  assert.equal(result.copiedFiles, 0);
  assert.equal(await fs.readFile(path.join(projectRootPath, 'agents/core/core.md'), 'utf8'), 'legacy personal edit');
  await assert.rejects(fs.stat(path.join(projectRootPath, 'agents/removed')), { code: 'ENOENT' });
  const receipt = JSON.parse(await fs.readFile(path.join(projectRootPath, '.builtin-install-receipt.json'), 'utf8'));
  assert.deepEqual(receipt.offeredUpdates.map((item: { path: string }) => item.path), ['agents/core', 'agents/removed']);
  await seedDesktopProjectRoot({ appRootPath: outputRoot, projectRootPath });
  await assert.rejects(fs.stat(path.join(projectRootPath, 'agents/removed')), { code: 'ENOENT' });
});
