import { parseYaml } from '../../core/yaml-parser.js';
import { portableTeam } from './portable-resources.js';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ResourcePackagePreview } from '../../contracts/resource-package.js';
import type { ResourceLibraryAgent, ResourceLibraryTeam } from '../../contracts/resource-library.js';
import { packageIdentity, type DecodedResourcePackage } from './resource-package-format.js';
import { remapPortableTeam } from './portable-resources.js';
import type { ResourceSkillFile, ResourceSkillFiles } from './skill-files.js';

export interface ResourceImportMapping { sourceId: string; sourceRevisionId: string; skillId: string; revisionId: string; substituted: boolean }
export type ResourceRuntimeTargets = Pick<ResourcePackagePreview, 'agents' | 'teams'>;
export async function planResourceNames(repoRoot: string, decoded: DecodedResourcePackage, digest: string): Promise<ResourceRuntimeTargets> {
  const allocate = async (kind: 'agents' | 'teams', ids: readonly string[]) => {
    const names: string[] = await fs.readdir(path.join(repoRoot, kind)).catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error; });
    if (kind === 'teams') { const source = await fs.readFile(path.join(repoRoot, 'teams.yaml'), 'utf8').catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return ''; throw error; }); names.push(...Object.keys(parseYaml(source))); }
    const used = new Set(names.map((name) => name.normalize('NFC').toLowerCase()));
    return ids.map((id) => {
      let targetId = id; let suffix = 1;
      while (used.has(targetId.toLowerCase())) { targetId = `${id.slice(0, 90)}-import-${packageIdentity(digest).slice(0, 8)}${suffix === 1 ? '' : `-${suffix}`}`; suffix += 1; }
      used.add(targetId.toLowerCase()); return { id, targetId };
    });
  };
  return { agents: await allocate('agents', decoded.manifest.agents.map((item) => item.id)), teams: await allocate('teams', decoded.manifest.teams.map((item) => item.id)) };
}

export function materializeResourceImport(decoded: DecodedResourcePackage, targets: ResourceRuntimeTargets, mapping: readonly ResourceImportMapping[], readRevision: (skillId: string, revisionId: string) => Promise<ResourceSkillFiles>): Promise<{ resources: Map<string, ResourceSkillFiles>; agents: ResourceLibraryAgent[]; teams: ResourceLibraryTeam[] }> {
  return materialize(decoded, targets, mapping, readRevision);
}
async function materialize(decoded: DecodedResourcePackage, targets: ResourceRuntimeTargets, mapping: readonly ResourceImportMapping[], readRevision: (skillId: string, revisionId: string) => Promise<ResourceSkillFiles>) {
  const resources = new Map<string, ResourceSkillFiles>();
  const agents: ResourceLibraryAgent[] = [];
  const teams: ResourceLibraryTeam[] = [];
  const agentNames = new Map(targets.agents.map((item) => [item.id, item.targetId]));
  const teamNames = new Map(targets.teams.map((item) => [item.id, item.targetId]));
  for (const source of decoded.manifest.agents) {
    const targetId = agentNames.get(source.id); if (!targetId) throw new Error('Missing reviewed Agent mapping');
    const prefix = `agents/${source.id}/`;
    const files = new Map<string, ResourceSkillFile>();
    for (const [name, file] of decoded.files) {
      if (name.startsWith(prefix)) { const relative = name.slice(prefix.length); files.set(relative === `${source.id}.md` ? `${targetId}.md` : relative, file); }
    }
    const attachments = [];
    for (const attachment of source.attachments) {
      const pin = mapping.find((item) => item.sourceId === attachment.skillId && item.sourceRevisionId === attachment.revisionId);
      if (!pin) throw new Error(`Missing imported revision binding: ${source.id}/${attachment.alias}`);
      attachments.push({ ...attachment, agentId: targetId, skillId: pin.skillId, revisionId: pin.revisionId });
      for (const [name, file] of await readRevision(pin.skillId, pin.revisionId)) files.set(`skills/${attachment.alias}/${name}`, file);
    }
    resources.set(`agents/${targetId}`, files); agents.push({ id: targetId, attachments });
  }
  for (const source of decoded.manifest.teams) {
    const targetId = teamNames.get(source.id); if (!targetId) throw new Error('Missing reviewed Team mapping');
    const prefix = `teams/${source.id}/`;
    const files = new Map<string, ResourceSkillFile>();
    for (const [name, file] of decoded.files) {
      if (!name.startsWith(prefix)) continue;
      const relative = name.slice(prefix.length);
      files.set(relative, relative === 'team.yaml' ? { ...file, contents: Buffer.from(remapPortableTeam(file.contents.toString('utf8'), agentNames, teamNames)) } : file);
    }
    resources.set(`teams/${targetId}`, files); teams.push({ id: targetId, agentIds: source.agentIds.map((id) => { const agent = agentNames.get(id); if (!agent) throw new Error('Missing Team Agent binding'); return agent; }) });
  }
  return { resources, agents, teams };
}

export async function prepareImportedTeamRegistry(repoRoot: string, decoded: DecodedResourcePackage, targets: ResourceRuntimeTargets): Promise<{ before: Buffer | null; after: Buffer } | undefined> {
  if (!targets.teams.length) return undefined;
  const registryPath = path.join(repoRoot, 'teams.yaml');
  const stat = await fs.lstat(registryPath).catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new Error('Team registry must be a regular file');
  const before = stat ? await fs.readFile(registryPath) : null;
  let text = before?.toString('utf8') ?? '';
  const registry = parseYaml(text);
  for (const target of targets.teams) {
    if (Object.hasOwn(registry, target.targetId)) throw new Error('Team registry changed since preview; review the names again');
    const config = decoded.files.get(`teams/${target.id}/team.yaml`); if (!config) throw new Error('Missing imported Team configuration');
    const team = portableTeam(config.contents.toString('utf8')).team;
    text += `${text.endsWith('\n') || !text ? '' : '\n'}\n${target.targetId}:\n  type: team\n  team_path: ./teams/${target.targetId}\n`;
    if (typeof team.description === 'string') text += `  description: ${JSON.stringify(team.description)}\n`;
    if (decoded.manifest.teams.find((item) => item.id === target.id)?.internal) text += '  tags: [internal]\n';
  }
  return { before, after: Buffer.from(text) };
}
