import { isPrivateResourcePath, portableTeam } from './portable-resources.js';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { frontmatterString, parseMarkdownFrontmatter } from '../../core/markdown-frontmatter.js';
import { assertSkillBatchConforms } from '../agent-generator/skill-spec-validation.js';
import { portableIdSchema, resourcePackageManifestSchema, type ResourcePackageManifest } from '../../contracts/resource-package.js';
import type { ResourceLibraryFileManifest, ResourceLibrarySkill } from '../../contracts/resource-library.js';
import { digestResourceFile, digestResourceSkillFiles, requireSkillDocument, type ResourceSkillFiles } from './skill-files.js';

export interface ImportedResourceSkill { skill: ResourceLibrarySkill; snapshots: ReadonlyMap<string, ResourceSkillFiles> }
export interface DecodedResourcePackage { manifest: ResourcePackageManifest; skills: ImportedResourceSkill[]; files: ResourceSkillFiles }
export function packageIdentity(value: string): string { return createHash('sha256').update(value).digest('hex').slice(0, 32); }
export function resourceFileManifest(files: ResourceSkillFiles): ResourceLibraryFileManifest[] {
  return [...files].sort(([a], [b]) => a.localeCompare(b)).map(([filePath, file]) => ({ path: filePath, sha256: digestResourceFile(file.contents), sizeBytes: file.contents.length, executable: file.executable }));
}
export function decodeResourcePackage(files: ResourceSkillFiles, archiveDigest: string, filename: string): DecodedResourcePackage {
  const document = files.get('octopus-package.json');
  if (!document) return decodeStandardSkill(files, archiveDigest, filename);
  const value: unknown = JSON.parse(document.contents.toString('utf8'));
  const manifest = resourcePackageManifestSchema.parse(value);
  const expected = new Set<string>();
  for (const name of files.keys()) if (isPrivateResourcePath(name)) throw new Error(`Package contains private files: ${name}`);
  for (const record of manifest.files) {
    if (expected.has(record.path)) throw new Error(`Duplicate manifest path: ${record.path}`);
    expected.add(record.path);
    const file = files.get(record.path);
    if (!file || digestResourceFile(file.contents) !== record.sha256 || file.contents.length !== record.sizeBytes || file.executable !== record.executable) throw new Error(`Package checksum mismatch: ${record.path}`);
  }
  if (files.size !== expected.size + 1 || expected.has('octopus-package.json')) throw new Error('Package contains undeclared files');
  const identities = new Set<string>();
  const skills = manifest.skills.map((skill) => {
    portableIdSchema.parse(skill.id);
    if (identities.has(skill.id)) throw new Error(`Duplicate resource identity: ${skill.id}`);
    identities.add(skill.id);
    const snapshots = new Map<string, ResourceSkillFiles>();
    for (const revision of skill.revisions) {
      portableIdSchema.parse(revision.id);
      const prefix = `skills/${skill.id}/${revision.id}/`;
      const snapshot = new Map([...files].filter(([name]) => name.startsWith(prefix)).map(([name, file]) => [name.slice(prefix.length), file]));
      assertSkillSnapshot(skill.slug, snapshot);
      if (digestResourceSkillFiles(snapshot) !== revision.digest || JSON.stringify(resourceFileManifest(snapshot)) !== JSON.stringify(revision.files)) throw new Error(`Skill revision checksum mismatch: ${skill.id}/${revision.id}`);
      if (snapshots.has(revision.id)) throw new Error(`Duplicate skill revision: ${revision.id}`);
      snapshots.set(revision.id, snapshot);
    }
    if (!snapshots.has(skill.currentRevisionId)) throw new Error(`Missing current revision: ${skill.id}`);
    return { skill, snapshots };
  });
  if (new Set(manifest.agents.map((agent) => agent.id)).size !== manifest.agents.length || new Set(manifest.teams.map((team) => team.id)).size !== manifest.teams.length) throw new Error('Duplicate runtime resource identity');
  for (const name of expected) {
    const claimed = manifest.skills.some((skill) => skill.revisions.some((revision) => name.startsWith(`skills/${skill.id}/${revision.id}/`))) || manifest.agents.some((agent) => name.startsWith(`agents/${agent.id}/`) && !name.startsWith(`agents/${agent.id}/skills/`)) || manifest.teams.some((team) => name.startsWith(`teams/${team.id}/`));
    if (!claimed) throw new Error(`Undeclared resource asset: ${name}`);
  }
  for (const agent of manifest.agents) {
    if (!files.has(`agents/${agent.id}/${agent.id}.md`)) throw new Error(`Missing Agent persona: ${agent.id}`);
    if (new Set(agent.attachments.map((item) => item.alias)).size !== agent.attachments.length) throw new Error(`Duplicate Agent alias: ${agent.id}`);
    for (const attachment of agent.attachments) {
      portableIdSchema.parse(attachment.alias);
      if (attachment.agentId !== agent.id || !skills.find((item) => item.skill.id === attachment.skillId)?.snapshots.has(attachment.revisionId)) throw new Error(`Missing Agent skill dependency: ${agent.id}/${attachment.alias}`);
    }
  }
  for (const team of manifest.teams) {
    const config = files.get(`teams/${team.id}/team.yaml`); if (!config) throw new Error(`Missing Team configuration: ${team.id}`);
    const parsed = portableTeam(config.contents.toString('utf8'));
    for (const member of parsed.agents) {
      if (member.type === 'team') {
        const id = member.team_path?.match(/^\.\.\/([a-zA-Z0-9_-]+)(?:\/team\.yaml)?$/)?.[1];
        if (!id || !team.teamIds.includes(id)) throw new Error(`Invalid Team dependency path: ${team.id}/${member.name}`);
      } else {
        const id = member.agent_file?.match(/^\.\.\/\.\.\/agents\/([a-zA-Z0-9_-]+)\/\1\.md$/)?.[1];
        if (!id || !team.agentIds.includes(id)) throw new Error(`Invalid Agent dependency path: ${team.id}/${member.name}`);
      }
    }
    if (team.teamIds.some((id) => !manifest.teams.some((item) => item.id === id))) throw new Error(`Missing nested Team dependency: ${team.id}`);
    if (team.agentIds.some((id) => !manifest.agents.some((agent) => agent.id === id))) throw new Error(`Missing Team dependency: ${team.id}`);
  }
  return { manifest, skills, files };
}
export function assertSkillSnapshot(slug: string, files: ResourceSkillFiles): void {
  assertSkillBatchConforms([{ origin: 'generated', folderName: slug, source: requireSkillDocument(files).toString('utf8'), skillPath: `skills/${slug}/SKILL.md` }]);
}
function decodeStandardSkill(files: ResourceSkillFiles, archiveDigest: string, filename: string): DecodedResourcePackage {
  for (const name of files.keys()) if (isPrivateResourcePath(name)) throw new Error(`Skill ZIP contains private files: ${name}`);
  const candidates = [...files.keys()].filter((name) => name === 'SKILL.md' || /^[^/]+\/SKILL\.md$/.test(name));
  if (candidates.length !== 1) throw new Error('A skill ZIP needs one SKILL.md at root or inside one enclosing folder');
  const location = candidates[0];
  if (!location) throw new Error('Missing SKILL.md');
  const prefix = location === 'SKILL.md' ? '' : `${path.posix.dirname(location)}/`;
  if ([...files.keys()].some((name) => !name.startsWith(prefix))) throw new Error('Skill ZIP contains files outside its skill folder');
  const snapshot = new Map([...files].map(([name, file]) => [name.slice(prefix.length), file]));
  const metadata = parseMarkdownFrontmatter(requireSkillDocument(snapshot).toString('utf8')).metadata;
  const slug = frontmatterString(metadata.name);
  if (!slug) throw new Error('SKILL.md needs a valid name');
  assertSkillSnapshot(slug, snapshot);
  const digest = digestResourceSkillFiles(snapshot);
  const id = `skill_${packageIdentity(`standard:${slug}:${digest}`)}`;
  const revisionId = `revision_${packageIdentity(`${id}:${digest}`)}`;
  const skill: ResourceLibrarySkill = {
    id, slug, displayName: slug, description: frontmatterString(metadata.description) ?? '', origin: 'import', provenance: [filename], archived: false, currentRevisionId: revisionId,
    revisions: [{ id: revisionId, sequence: 1, parentRevisionId: null, digest, createdAt: '1980-01-01T00:00:00.000Z', changeNote: `Imported ${filename}`, files: resourceFileManifest(snapshot) }],
  };
  return { manifest: { schemaVersion: 1, id: `package_${packageIdentity(archiveDigest)}`, version: '1', origin: filename, skills: [skill], agents: [], teams: [], files: resourceFileManifest(files) }, skills: [{ skill, snapshots: new Map([[revisionId, snapshot]]) }], files };
}
