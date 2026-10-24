import * as fs from 'node:fs/promises';
import { parseYaml } from '../../core/yaml-parser.js';
import * as path from 'node:path';
import type { ResourcePackageExport, ResourcePackageManifest } from '../../contracts/resource-package.js';
import { portableIdSchema } from '../../contracts/resource-package.js';
import type { ResourceLibraryCatalog } from '../../contracts/resource-library.js';
import { readPortableResourceTree, portableTeam, isPrivateResourcePath } from './portable-resources.js';
import type { ResourceImportMapping, ResourceRuntimeTargets, materializeResourceImport } from './package-import.js';
import { assertSkillSnapshot, resourceFileManifest, packageIdentity, type DecodedResourcePackage } from './resource-package-format.js';
import { digestResourceSkillFiles, type ResourceSkillFile, type ResourceSkillFiles } from './skill-files.js';

export async function buildResourceExport(input: {
  repoRoot: string; catalog: ResourceLibraryCatalog; selection: ResourcePackageExport;
  readRevision(skillId: string, revisionId: string): Promise<ResourceSkillFiles>;
}): Promise<{ manifest: ResourcePackageManifest; files: Map<string, ResourceSkillFile>; filename: string }> {
  const { selection, catalog, repoRoot } = input;
  const files = new Map<string, ResourceSkillFile>();
  const agents: ResourcePackageManifest['agents'] = [];
  const teams: ResourcePackageManifest['teams'] = [];
  const pins = new Map<string, Set<string>>();
  const pin = (skillId: string, revisionId: string) => { const ids = pins.get(skillId) ?? new Set<string>(); ids.add(revisionId); pins.set(skillId, ids); };
  const addAgent = async (id: string): Promise<void> => {
    portableIdSchema.parse(id);
    if (agents.some((agent) => agent.id === id)) return;
    const agent = catalog.agents.find((item) => item.id === id);
    if (!agent) throw new Error(`Missing Agent dependency: ${id}`);
    const contents = await readPortableResourceTree(path.join(repoRoot, 'agents', id));
    if (!contents.has(`${id}.md`)) throw new Error(`Missing Agent persona: ${id}`);
    for (const [name, file] of contents) files.set(`agents/${id}/${name}`, file);
    agents.push(agent);
    for (const attachment of agent.attachments) pin(attachment.skillId, attachment.revisionId);
  };
  const visiting = new Set<string>();
  const addTeam = async (id: string): Promise<void> => {
    portableIdSchema.parse(id);
    if (visiting.has(id)) throw new Error(`Cyclic Team dependency: ${id}`);
    if (teams.some((team) => team.id === id)) return;
    visiting.add(id);
    const contents = await readPortableResourceTree(path.join(repoRoot, 'teams', id));
    const config = contents.get('team.yaml'); if (!config) throw new Error(`Missing Team configuration: ${id}`);
    const parsed = portableTeam(config.contents.toString('utf8'));
    const agentIds: string[] = []; const teamIds: string[] = [];
    for (const member of parsed.agents) {
      if (member.type === 'team') {
        const match = member.team_path?.match(/^\.\.\/([a-zA-Z0-9_-]+)(?:\/team\.yaml)?$/);
        const child = match?.[1]; if (!child) throw new Error(`Team ${id} has a machine-local or unsupported Team dependency: ${member.name}`);
        await addTeam(child); teamIds.push(child);
      } else {
        const match = member.agent_file?.match(/^\.\.\/\.\.\/agents\/([a-zA-Z0-9_-]+)\/\1\.md$/);
        const agentId = match?.[1]; if (!agentId) throw new Error(`Team ${id} has a machine-local or unsupported Agent dependency: ${member.name}`);
        await addAgent(agentId); agentIds.push(agentId);
      }
    }
    for (const [name, file] of contents) files.set(`teams/${id}/${name}`, file);
    const registrySource = await fs.readFile(path.join(repoRoot, 'teams.yaml'), 'utf8').catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''; throw error; });
    const entry = parseYaml(registrySource)[id];
    const internal = typeof entry === 'object' && entry !== null && !Array.isArray(entry) && Array.isArray(entry.tags) && entry.tags.includes('internal');
    teams.push({ id, agentIds: [...new Set(agentIds)], teamIds: [...new Set(teamIds)], internal }); visiting.delete(id);
  };
  const addSkill = (id: string) => { const skill = catalog.skills.find((item) => item.id === id); if (!skill) throw new Error(`Unknown skill: ${id}`); pin(id, skill.currentRevisionId); };
  if (selection.kind === 'skill') addSkill(selection.id);
  else if (selection.kind === 'agent') await addAgent(selection.id);
  else if (selection.kind === 'team') await addTeam(selection.id);
  else {
    const item = catalog.packages.find((pkg) => pkg.id === selection.id); if (!item) throw new Error('Unknown package');
    for (const id of item.resourceIds) {
      if (catalog.skills.some((skill) => skill.id === id)) addSkill(id);
      else if (catalog.agents.some((agent) => agent.id === id)) await addAgent(id);
      else if (catalog.teams.some((team) => team.id === id)) await addTeam(id);
      else throw new Error(`Package dependency was removed: ${id}`);
    }
  }
  if (selection.format === 'skill' && (selection.kind !== 'skill' || selection.includeHistory)) throw new Error('Standard skill ZIPs contain one revision and no Octopus history');
  const skills: ResourcePackageManifest['skills'] = [];
  for (const [id, required] of pins) {
    const skill = catalog.skills.find((item) => item.id === id); if (!skill) throw new Error(`Missing skill: ${id}`);
    const revisions = skill.revisions.filter((revision) => selection.includeHistory || required.has(revision.id));
    if ([...required].some((revisionId) => !revisions.some((revision) => revision.id === revisionId))) throw new Error(`Missing required revision: ${id}`);
    for (const revision of revisions) {
      const contents = await input.readRevision(id, revision.id);
      assertSkillSnapshot(skill.slug, contents);
      if (digestResourceSkillFiles(contents) !== revision.digest) throw new Error(`Corrupt revision: ${revision.id}`);
      for (const [name, file] of contents) {
        if (isPrivateResourcePath(name)) throw new Error(`Skill ${skill.slug} contains private files (${name}); remove them in a new revision before export`);
        files.set(`${selection.format === 'skill' ? skill.slug : `skills/${id}/${revision.id}`}/${name}`, file);
      }
    }
    skills.push({ ...skill, currentRevisionId: revisions.some((revision) => revision.id === skill.currentRevisionId) ? skill.currentRevisionId : revisions[0]?.id ?? skill.currentRevisionId, revisions });
  }
  const manifest: ResourcePackageManifest = { schemaVersion: 1, id: `package_${packageIdentity(JSON.stringify(resourceFileManifest(files)))}`, version: '1', origin: 'Octopus Library', skills, agents, teams, files: resourceFileManifest(files) };
  if (selection.format === 'octopus') files.set('octopus-package.json', { contents: Buffer.from(JSON.stringify(manifest, null, 2)), mode: 0o644, executable: false });
  return { manifest, files, filename: `${selection.kind === 'skill' ? skills[0]?.slug ?? 'skill' : selection.id}${selection.format === 'octopus' ? '-octopus' : ''}.zip` };
}

/** Freeze the accepted import, including local substitutions and reviewed runtime names. */
export async function buildInstalledResourceExport(input: {
  decoded: DecodedResourcePackage;
  targets: ResourceRuntimeTargets;
  mapping: readonly ResourceImportMapping[];
  skills: ResourceLibraryCatalog['skills'];
  materialized: Awaited<ReturnType<typeof materializeResourceImport>>;
  readRevision(skillId: string, revisionId: string): Promise<ResourceSkillFiles>;
}): Promise<Map<string, ResourceSkillFile>> {
  const files = new Map<string, ResourceSkillFile>();
  for (const [directory, contents] of input.materialized.resources) {
    for (const [name, file] of contents) {
      if (directory.startsWith('agents/') && name.startsWith('skills/')) continue;
      files.set(`${directory}/${name}`, file);
    }
  }
  const skills: ResourcePackageManifest['skills'] = [];
  for (const skill of input.skills) {
    const mapped = input.mapping.filter((item) => item.skillId === skill.id);
    if (!mapped.length) continue;
    const revisions = skill.revisions.filter((revision) => mapped.some((item) => item.revisionId === revision.id));
    const sourceCurrent = input.decoded.skills.find((source) => mapped.some((item) => item.sourceId === source.skill.id));
    const current = mapped.find((item) => item.sourceId === sourceCurrent?.skill.id && item.sourceRevisionId === sourceCurrent.skill.currentRevisionId);
    if (!current || !revisions.length) throw new Error('Missing accepted collection revision');
    skills.push({ ...skill, currentRevisionId: current.revisionId, revisions });
    for (const revision of revisions) {
      const snapshot = await input.readRevision(skill.id, revision.id);
      assertSkillSnapshot(skill.slug, snapshot);
      for (const [name, file] of snapshot) {
        if (isPrivateResourcePath(name)) throw new Error(`Selected local revision contains private files: ${name}`);
        files.set(`skills/${skill.id}/${revision.id}/${name}`, file);
      }
    }
  }
  const remap = (kind: 'agents' | 'teams', id: string) => {
    const target = input.targets[kind].find((item) => item.id === id);
    if (!target) throw new Error(`Missing accepted ${kind} mapping`);
    return target.targetId;
  };
  const manifest: ResourcePackageManifest = {
    ...input.decoded.manifest, skills, agents: input.materialized.agents,
    teams: input.decoded.manifest.teams.map((team) => ({ ...team, id: remap('teams', team.id), agentIds: team.agentIds.map((id) => remap('agents', id)), teamIds: team.teamIds.map((id) => remap('teams', id)) })),
    files: resourceFileManifest(files),
  };
  files.set('octopus-package.json', { contents: Buffer.from(JSON.stringify(manifest, null, 2)), mode: 0o644, executable: false });
  return files;
}
