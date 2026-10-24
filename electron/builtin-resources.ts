import { verifyBuiltinFiles, assertNoSymlinkParents } from '../domains/resource-library/builtin-bundle-files.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { builtInBundleSchema, builtInInstallReceiptSchema, builtInSelectionSchema, type BuiltInBundle, type BuiltInInstallReceipt, type BuiltInSelection } from '../contracts/builtin-resources.js';
import { readPortableResourceTree, portableTeam, renderYaml, isPrivateResourcePath } from '../domains/resource-library/portable-resources.js';
import { digestResourceFile, digestResourceSkillFiles, normalizeResourcePath, readResourceSkillFiles, type ResourceSkillFile, type ResourceSkillFiles } from '../domains/resource-library/skill-files.js';
import { assertSkillSnapshot, resourceFileManifest, packageIdentity } from '../domains/resource-library/resource-package-format.js';
import { parseYaml, type YamlObject } from '../core/yaml-parser.js';
import { writeFileAtomic } from '../core/file-mutation.js';
import { withCrossProcessFileLock } from '../core/cross-process-file-lock.js';

export async function stageCuratedBuiltIns(input: { sourceRoot: string; outputRoot: string; appVersion: string; selection: BuiltInSelection }): Promise<void> {
  const selection = builtInSelectionSchema.parse(input.selection);
  if (path.resolve(input.outputRoot) === path.resolve(input.sourceRoot) || path.relative(input.outputRoot, input.sourceRoot).split(path.sep)[0] !== '..') throw new Error('Distribution output must not contain the source root');
  const files = new Map<string, ResourceSkillFile>();
  const resources: BuiltInBundle['resources'] = [];
  const agents = new Set(selection.agents); const teams = new Set<string>(); const visiting = new Set<string>();
  const add = (resourcePath: string, contents: ResourceSkillFiles, kind: 'directory' | 'file') => {
    // Electron Builder excludes Finder metadata; hash only files shipped in the app.
    const bundledContents = new Map([...contents].filter(([name]) => !name.split('/').includes('.DS_Store')));
    const entries = new Map([...bundledContents].map(([name, file]) => [kind === 'file' ? resourcePath : `${resourcePath}/${name}`, file]));
    for (const [name, file] of entries) { if (files.has(name)) throw new Error(`Duplicate built-in path: ${name}`); files.set(name, file); }
    resources.push({ path: resourcePath, kind, digest: digestResourceSkillFiles(bundledContents), files: resourceFileManifest(entries) });
  };
  const addTeam = async (id: string): Promise<void> => {
    if (visiting.has(id)) throw new Error(`Cyclic built-in Team: ${id}`); if (teams.has(id)) return; visiting.add(id);
    const contents = await readPortableResourceTree(path.join(input.sourceRoot, 'teams', id));
    const config = contents.get('team.yaml'); if (!config) throw new Error(`Missing built-in Team: ${id}`);
    for (const member of portableTeam(config.contents.toString('utf8')).agents) {
      if (member.type === 'agent') {
        const agent = member.agent_file?.match(/^\.\.\/\.\.\/agents\/([a-zA-Z0-9_-]+)\/\1\.md$/)?.[1];
        if (!agent) throw new Error(`Unsupported built-in Agent dependency: ${id}/${member.name}`); agents.add(agent);
      } else {
        const child = member.team_path?.match(/^\.\.\/([a-zA-Z0-9_-]+)(?:\/team\.yaml)?$/)?.[1];
        if (!child) throw new Error(`Unsupported built-in Team dependency: ${id}/${member.name}`); await addTeam(child);
      }
    }
    add(`teams/${id}`, contents, 'directory'); teams.add(id); visiting.delete(id);
  };
  for (const id of selection.teams) await addTeam(id);
  for (const id of agents) {
    const contents = new Map(await readPortableResourceTree(path.join(input.sourceRoot, 'agents', id)));
    if (!contents.has(`${id}.md`)) throw new Error(`Missing built-in persona: ${id}`);
    const skillRoot = path.join(input.sourceRoot, 'agents', id, 'skills');
    const entries = await fs.readdir(skillRoot, { withFileTypes: true }).catch((error: unknown) => { if (isMissing(error)) return []; throw error; });
    for (const entry of entries) {
      if (entry.name.startsWith('.')) continue;
      const skill = await readResourceSkillFiles(path.join(skillRoot, entry.name)); if (!skill) throw new Error('Missing built-in skill');
      assertSkillSnapshot(entry.name, skill);
      for (const [name, file] of skill) { if (isPrivateResourcePath(name)) throw new Error(`Private file in built-in skill: ${id}/${entry.name}/${name}`); contents.set(`skills/${entry.name}/${name}`, file); }
    }
    add(`agents/${id}`, contents, 'directory');
  }
  for (const id of selection.skills) {
    const contents = await readResourceSkillFiles(path.join(input.sourceRoot, 'skills', id)); if (!contents) throw new Error(`Missing built-in skill: ${id}`);
    assertSkillSnapshot(id, contents); if ([...contents.keys()].some(isPrivateResourcePath)) throw new Error(`Private file in built-in skill: ${id}`);
    add(`skills/${id}`, contents, 'directory');
  }
  const addFile = (name: string, contents: Buffer) => add(name, new Map([[path.posix.basename(name), { contents, mode: 0o644, executable: false }]]), 'file');
  if (selection.entryTeam !== null) {
    if (!teams.has(selection.entryTeam)) throw new Error('The default entry Team must be curated');
    addFile('start.yaml', Buffer.from(`entry: ${selection.entryTeam}\nregistry: ./teams.yaml\n`));
  }
  if (teams.size) {
    const registry = parseYaml(await fs.readFile(path.join(input.sourceRoot, 'teams.yaml'), 'utf8'));
    const filtered: YamlObject = {};
    for (const id of teams) {
      const entry = registry[id];
      filtered[id] = entry ?? { type: 'team', team_path: `./teams/${id}` };
    }
    addFile('teams.yaml', Buffer.from(`${renderYaml(filtered, 0)}\n`));
  }
  if (selection.workflowTemplates.length) {
    for (const name of selection.workflowTemplates) addFile(`workflows/templates/${name}`, await fs.readFile(path.join(input.sourceRoot, 'workflows/templates', name)));
    const registry = parseYaml(await fs.readFile(path.join(input.sourceRoot, 'workflows/registry.yaml'), 'utf8'));
    const filtered: YamlObject = {};
    for (const [id, entry] of Object.entries(registry)) {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || typeof entry.template_path !== 'string') continue;
      if (selection.workflowTemplates.some((name) => entry.template_path === `./templates/${name}` || entry.template_path === `templates/${name}`)) filtered[id] = entry;
    }
    addFile('workflows/registry.yaml', Buffer.from(`${renderYaml(filtered, 0)}\n`));
  }
  resources.sort((a, b) => a.path.localeCompare(b.path));
  const manifest: BuiltInBundle = { schemaVersion: 1, appVersion: input.appVersion, buildId: packageIdentity(`${input.appVersion}:${JSON.stringify(resources)}`), resources };
  await fs.mkdir(input.outputRoot, { recursive: true });
  if ((await fs.readdir(input.outputRoot)).length) throw new Error('Curated output must be an empty staging directory');
  for (const [name, file] of files) { const target = path.join(input.outputRoot, normalizeResourcePath(name)); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, file.contents, { mode: file.mode }); await fs.chmod(target, file.mode); }
  await fs.writeFile(path.join(input.outputRoot, 'builtin-resources.json'), JSON.stringify(manifest, null, 2));
}

export async function seedCuratedBuiltIns(appRootPath: string, projectRootPath: string): Promise<{ copiedFiles: number; skippedFiles: number } | null> {
  const source = await fs.readFile(path.join(appRootPath, 'builtin-resources.json'), 'utf8').catch((error: unknown) => { if (isMissing(error)) return null; throw error; });
  if (source === null) return null;
  const value: unknown = JSON.parse(source); const manifest = builtInBundleSchema.parse(value);
  const verified = await verifyBuiltinFiles(appRootPath, manifest);
  await fs.mkdir(projectRootPath, { recursive: true });
  return withCrossProcessFileLock(path.join(projectRootPath, '.builtin-install.lock'), async () => {
    const receiptPath = path.join(projectRootPath, '.builtin-install-receipt.json');
    const saved = await fs.readFile(receiptPath, 'utf8').catch((error: unknown) => { if (isMissing(error)) return null; throw error; });
    const parsed: unknown = saved === null ? null : JSON.parse(saved);
    const previous = parsed === null ? null : builtInInstallReceiptSchema.parse(parsed);
    const requiresLegacyReview = previous === null && (await fs.readdir(projectRootPath)).some((name) => ['agents', 'teams', 'skills', 'workflows', 'start.yaml', 'teams.yaml'].includes(name));
    const receipt: BuiltInInstallReceipt = { schemaVersion: 1, buildId: manifest.buildId, resources: previous ? [...previous.resources] : [], offeredUpdates: [] };
    let copiedFiles = 0; let skippedFiles = 0;
    const seen = new Set<string>();
    for (const resource of manifest.resources) {
      normalizeResourcePath(resource.path);
      if (seen.has(resource.path)) throw new Error('Duplicate built-in resource'); seen.add(resource.path);
      const destination = path.join(projectRootPath, resource.path);
      await assertNoSymlinkParents(projectRootPath, resource.path);
      const existing = await fs.lstat(destination).catch((error: unknown) => { if (isMissing(error)) return null; throw error; });
      let installed = receipt.resources.find((item) => item.path === resource.path);
      if (installed) {
        if (!existing) installed.removed = true;
        if (!installed.removed && installed.sourceDigest !== resource.digest) receipt.offeredUpdates.push({ path: resource.path, digest: resource.digest, appVersion: manifest.appVersion, kind: resource.kind });
        skippedFiles += resource.files.length; continue;
      }
      // Without a receipt, missing legacy defaults cannot be distinguished from deliberate removals.
      if (previous || requiresLegacyReview) { receipt.offeredUpdates.push({ path: resource.path, digest: resource.digest, appVersion: manifest.appVersion, kind: resource.kind }); continue; }
      installed = { path: resource.path, sourceDigest: resource.digest, removed: false }; receipt.resources.push(installed);
      if (existing) { skippedFiles += resource.files.length; continue; }
      const staging = path.join(projectRootPath, '.builtin-staging', packageIdentity(`${manifest.buildId}:${resource.path}`));
      await fs.mkdir(path.dirname(staging), { recursive: true });
      await fs.rm(staging, { recursive: true, force: true });
      try {
        if (resource.kind === 'directory') await fs.mkdir(staging);
        for (const file of resource.files) {
          const contents = verified.get(file.path); if (!contents) throw new Error('Missing verified bundled bytes');
          const relative = resource.kind === 'directory' ? file.path.slice(resource.path.length + 1) : '';
          const target = resource.kind === 'directory' ? path.join(staging, relative) : staging;
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.writeFile(target, contents, { flag: 'wx', mode: file.executable ? 0o755 : 0o644 });
          await fs.chmod(target, file.executable ? 0o755 : 0o644);
        }
        await fs.mkdir(path.dirname(destination), { recursive: true });
        if (resource.kind === 'directory') await fs.rename(staging, destination);
        else { await fs.link(staging, destination); await fs.unlink(staging); }
        copiedFiles += resource.files.length;
      } finally { await fs.rm(staging, { recursive: true, force: true }); }

    }
    await writeFileAtomic(receiptPath, JSON.stringify(receipt, null, 2)); return { copiedFiles, skippedFiles };
  });
}

function isMissing(error: unknown): boolean { return error instanceof Error && 'code' in error && error.code === 'ENOENT'; }
