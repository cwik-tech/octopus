import type { BuiltInUpdateSource } from "../contracts/builtin-update.js";
import * as path from 'node:path';
import type { ResourceLibraryStore } from '../domains/resource-library/resource-library-store.js';
import type { ResourcePackageExport, ResourcePackagePreview, ResourcePackageResolution } from '../contracts/resource-package.js';
import { buildResourceExport } from '../domains/resource-library/package-export.js';
import { planResourceNames, type ResourceRuntimeTargets } from '../domains/resource-library/package-import.js';
import { decodeResourcePackage, packageIdentity, resourceFileManifest } from '../domains/resource-library/resource-package-format.js';
import { digestResourceFile, type ResourceSkillFile } from '../domains/resource-library/skill-files.js';
import { readResourceZip, writeResourceZip } from '../domains/resource-library/resource-zip.js';

export class ResourcePackageService {
  constructor(readonly options: { store: ResourceLibraryStore; repoRoot: string; validateBuiltinUpdate?: (source: BuiltInUpdateSource, bytes: Buffer) => Promise<void> }) {}

  async preview(input: { bytes: Buffer; filename: string; signal?: AbortSignal }): Promise<ResourcePackagePreview> {
    const digest = digestResourceFile(input.bytes);
    const files = await readResourceZip(input.bytes, input.signal ? { signal: input.signal } : {});
    const decoded = decodeResourcePackage(files, digest, input.filename);
    const current = await this.options.store.getSnapshot();
    const alreadyImported = current.packages.some((item) => item.digest === digest);
    const runtime = alreadyImported ? { agents: [], teams: [] } : await planResourceNames(this.options.repoRoot, decoded, digest);
    return {
      digest, alreadyImported, expectedGeneration: current.generation, filename: path.basename(input.filename), packageId: `package_${packageIdentity(digest)}`,
      skills: decoded.skills.map(({ skill }) => {
        const existing = current.skills.filter((item) => item.id === skill.id || item.slug === skill.slug);
        const identical = existing.find((item) => item.id === skill.id && skill.revisions.every((revision) => item.revisions.some((candidate) => candidate.id === revision.id && candidate.digest === revision.digest)));
        return { sourceId: skill.id, slug: skill.slug, revisionCount: skill.revisions.length,
          conflict: identical ? 'identical' : existing.some((item) => item.id === skill.id) ? 'identity' : existing.length ? 'name' : 'new',
          existingSkills: existing.map((item) => ({ id: item.id, label: item.displayName, revisionId: item.currentRevisionId })),
        };
      }),
      agents: runtime.agents, teams: runtime.teams,
      warnings: ['Import does not run scripts, install dependencies, enable integrations, or grant permissions.'],
    };
  }

  async commit(input: { bytes: Buffer; filename: string; digest: string; expectedGeneration: number; resolutions: ResourcePackageResolution[]; runtimeTargets?: ResourceRuntimeTargets | undefined; builtinUpdate?: BuiltInUpdateSource | undefined; signal?: AbortSignal }): Promise<{ unchanged: boolean; packageId: string }> {
    if (digestResourceFile(input.bytes) !== input.digest) throw new Error('Archive changed since preview; choose the file again');
    const files = await readResourceZip(input.bytes, input.signal ? { signal: input.signal } : {});
    const decoded = decodeResourcePackage(files, input.digest, path.basename(input.filename));
    input.signal?.throwIfAborted();
    if (input.builtinUpdate) {
      if (!this.options.validateBuiltinUpdate) throw new Error('Bundled update source is not configured');
      await this.options.validateBuiltinUpdate(input.builtinUpdate, input.bytes);
    }
    return this.options.store.installResourcePackage({ decoded, archive: input.bytes, digest: input.digest, filename: path.basename(input.filename), expectedGeneration: input.expectedGeneration, resolutions: input.resolutions, ...(input.builtinUpdate ? { builtinUpdate: input.builtinUpdate } : {}), ...(input.runtimeTargets ? { runtimeTargets: input.runtimeTargets } : {}), ...(input.signal ? { signal: input.signal } : {}) });
  }

  async export(input: ResourcePackageExport, options: { signal?: AbortSignal } = {}): Promise<{ bytes: Buffer; filename: string }> {
    return this.options.store.withPublicationLock(async () => {
      options.signal?.throwIfAborted();
      const catalog = await this.options.store.getSnapshot();
      if (input.kind === 'package') {
        if (input.format !== 'octopus') throw new Error('Collections require the Octopus package format');
        const archive = await this.options.store.readPackageArchive(input.id);
        const source = decodeResourcePackage(await readResourceZip(archive, options), digestResourceFile(archive), catalog.packages.find((item) => item.id === input.id)?.origin ?? 'collection.zip');
        const files = new Map<string, ResourceSkillFile>([...source.files].filter(([name]) => name.startsWith('agents/') || name.startsWith('teams/')));
        const skills = source.manifest.skills.map((skill) => {
          const required = new Set([skill.currentRevisionId, ...source.manifest.agents.flatMap((agent) => agent.attachments.filter((item) => item.skillId === skill.id).map((item) => item.revisionId))]);
          const revisions = skill.revisions.filter((revision) => input.includeHistory || required.has(revision.id));
          for (const revision of revisions) {
            const snapshot = source.skills.find((item) => item.skill.id === skill.id)?.snapshots.get(revision.id); if (!snapshot) throw new Error('Missing retained package revision');
            for (const [name, file] of snapshot) files.set(`skills/${skill.id}/${revision.id}/${name}`, file);
          }
          return { ...skill, revisions };
        });
        const manifest = { ...source.manifest, skills, files: resourceFileManifest(files) };
        files.set('octopus-package.json', { contents: Buffer.from(JSON.stringify(manifest, null, 2)), executable: false, mode: 0o644 });
        return { bytes: await writeResourceZip(files, options), filename: 'collection-octopus.zip' };
      }
      const exported = await buildResourceExport({ repoRoot: this.options.repoRoot, catalog, selection: input, readRevision: (skillId, revisionId) => this.options.store.readSkillRevisionSnapshot(skillId, revisionId) });
      return { bytes: await writeResourceZip(exported.files, options), filename: exported.filename };
    });
  }
}
