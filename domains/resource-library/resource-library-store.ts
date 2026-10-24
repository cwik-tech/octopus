import type { BuiltInUpdateSource } from "../../contracts/builtin-update.js";
import type { ResourceMigrationReport } from '../../contracts/resource-migration.js';
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { withCrossProcessFileLock } from "../../core/cross-process-file-lock.js";
import { writeFileAtomic } from "../../core/file-mutation.js";
import {
  frontmatterString,
  parseMarkdownFrontmatter,
} from "../../core/markdown-frontmatter.js";
import {
  resourceLibraryCatalogSchema,
  resourceLibraryCurrentPointerSchema,
  type ResourceLibraryAgent,
  type ResourceLibraryAttachment,
  type ResourceLibraryCatalog,
  type ResourceLibraryFileManifest,
  type ResourceLibraryMigrationReceipt,
  type ResourceLibraryMigrationResult,
  type ResourceLibrarySkill,
  type ResourceLibrarySkillRevision,
  type ResourceLibrarySnapshot,
} from "../../contracts/resource-library.js";
import {
  digestResourceFile,
  digestResourceSkillFiles,
  readResourceSkillFiles,
  requireSkillDocument,
  writeResourceSkillFiles,
  type ResourceSkillFiles,
} from "./skill-files.js";
import { assertSkillBatchConforms } from "../agent-generator/skill-spec-validation.js";
import { buildInstalledResourceExport } from "./package-export.js";
import { writeResourceZip } from "./resource-zip.js";
import { portableIdSchema } from '../../contracts/resource-package.js';
import type { ResourcePackageResolution } from '../../contracts/resource-package.js';
import { publishImportedResources, recoverImportedResources } from './package-publication.js';
import { materializeResourceImport, prepareImportedTeamRegistry, planResourceNames, type ResourceRuntimeTargets, type ResourceImportMapping } from './package-import.js';
import { packageIdentity, type DecodedResourcePackage } from './resource-package-format.js';
import { recoverAgentSkillProjections } from "./agent-projection.js";

export type ResourceLibraryPersistenceBoundary = "catalog_staged" | "current_published";

export interface ResourceLibraryAgentProjection {
  agent: ResourceLibraryAgent;
  previousAgent?: ResourceLibraryAgent;
  generationId: string;
  publish(): Promise<void>;
  isPublished(): Promise<boolean>;
  readRevisionFiles(skillId: string, revisionId: string): Promise<ResourceSkillFiles>;
}

export interface ResourceLibraryStoreOptions {
  repoRoot: string;
  rootPath: string;
  now?: () => Date;
  createId?: () => string;
  onPersistenceBoundary?: (
    boundary: ResourceLibraryPersistenceBoundary,
  ) => void | Promise<void>;
  projectAgent?: (projection: ResourceLibraryAgentProjection) => void | Promise<void>;
}

export interface ResourceLibrarySkillMutationResult {
  skill: ResourceLibrarySkill;
  revision: ResourceLibrarySkillRevision;
  unchanged: boolean;
}

export interface ResourceLibraryAgentMutationResult {
  agent: ResourceLibraryAgent;
  unchanged: boolean;
}

export interface AttachResourceSkillParams {
  agentId: string;
  skillId: string;
  revisionId: string;
  alias: string;
  expectedGeneration: number;
}

export interface DetachResourceSkillParams {
  agentId: string;
  alias: string;
  expectedGeneration: number;
}

export interface SelectAgentSkillRevisionParams {
  agentId: string;
  skillId: string;
  revisionId: string;
  expectedGeneration: number;
}

export interface CreateResourceSkillParams {
  slug: string;
  files: ResourceSkillFiles;
  changeNote: string;
  expectedGeneration: number;
}

export interface SaveResourceSkillRevisionParams {
  skillId: string;
  baseRevisionId: string;
  files: ResourceSkillFiles;
  changeNote: string;
  expectedGeneration: number;
}

export interface RestoreResourceSkillRevisionParams {
  skillId: string;
  sourceRevisionId: string;
  baseRevisionId: string;
  changeNote: string;
  expectedGeneration: number;
}

export class ResourceLibraryConflictError extends Error {
  constructor(
    readonly code: "generation_conflict" | "revision_conflict",
    message: string,
  ) {
    super(message);
    this.name = "ResourceLibraryConflictError";
  }
}

interface LegacySkillSource {
  absolutePath: string;
  relativePath: string;
  agentId?: string;
}

export class ResourceLibraryStore {
  private readonly rootPath: string;
  private readonly now: () => Date;
  private readonly createId: () => string;

  constructor(private readonly options: ResourceLibraryStoreOptions) {
    this.rootPath = path.resolve(options.rootPath);
    this.now = options.now ?? (() => new Date());
    this.createId = options.createId ?? randomUUID;
  }

  private async retainPackageArchive(packageId: string, archive: Buffer, installed = false): Promise<void> {
    const file = path.join(this.rootPath, 'packages', `${portableIdSchema.parse(packageId)}${installed ? ".installed" : ""}.zip`);
    const prior = await fs.readFile(file).catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; });
    if (prior) { if (digestResourceFile(prior) !== digestResourceFile(archive)) throw new Error('Retained package archive has external drift'); return; }
    await writeFileAtomic(file, archive);
  }

  async readPackageArchive(packageId: string): Promise<Buffer> {
    portableIdSchema.parse(packageId);
    const record = (await this.getSnapshot()).packages.find((item) => item.id === packageId);
    if (!record) throw new Error('Unknown imported collection');
    if (!record.installedDigest) throw new Error('This older collection has no accepted import snapshot; export its resources individually');
    const archive = await fs.readFile(path.join(this.rootPath, 'packages', `${packageId}.installed.zip`));
    if (digestResourceFile(archive) !== record.installedDigest) throw new Error('Retained package archive checksum mismatch');
    return archive;
  }

  async previewLegacyMigration(): Promise<ResourceMigrationReport> {
    const current = await this.getSnapshot();
    const sourceRootDigest = digestResourceFile(Buffer.from(path.resolve(this.options.repoRoot)));
    const sources: ResourceMigrationReport['sources'] = [];
    for (const source of await this.inventoryLegacySkills()) {
      const files = await readResourceSkillFiles(source.absolutePath);
      if (!files) throw new Error(`Migration source disappeared: ${source.relativePath}`);
      sources.push({ path: source.relativePath, ...(source.agentId ? { agentId: source.agentId } : {}), slug: path.basename(source.absolutePath), digest: digestResourceSkillFiles(files), files: fileManifest(files) });
    }
    const agentIds = (await this.inventoryAgents([])).map((agent) => agent.id);
    const inventoryDigest = digestResourceFile(Buffer.from(JSON.stringify({ sourceRootDigest, generation: current.generation, agentIds, sources })));
    return { schemaVersion: 1, sourceRootDigest, inventoryDigest, expectedGeneration: current.generation, alreadyMigrated: current.migrationReceipt !== undefined, agentIds, sources };
  }

  async migrateLegacyResources(options: { withLock?: boolean; expectedSources?: ReadonlyMap<string, string>; signal?: AbortSignal } = {}): Promise<ResourceLibraryMigrationResult> {
    return this.withMutationLockChoice(options.withLock, async () => {
      const current = await this.getSnapshot();
      if (current.migrationReceipt) {
        return {
          alreadyMigrated: true,
          generationId: current.generationId,
          importedSourceCount: current.migrationReceipt.importedSourceCount,
          logicalSkillCount: current.migrationReceipt.logicalSkillCount,
        };
      }

      const sources = await this.inventoryLegacySkills();
      if (options.expectedSources && sources.length !== options.expectedSources.size) throw new Error("Migration inventory changed; review it again");
      const skills = current.skills.map((skill) => ({
        ...skill,
        provenance: [...skill.provenance],
        revisions: [...skill.revisions],
      }));
      const agents = await this.inventoryAgents(current.agents);
      const receiptSources: ResourceLibraryMigrationReceipt["sources"] = [];
      const migratedAt = this.now().toISOString();

      for (const source of sources) {
        options.signal?.throwIfAborted();
        const files = await readResourceSkillFiles(source.absolutePath);
        if (!files) throw new Error(`Legacy skill disappeared: ${source.relativePath}`);
        const document = requireSkillDocument(files).toString("utf8");
        const digest = digestResourceSkillFiles(files);
        if (options.expectedSources && options.expectedSources.get(source.relativePath) !== digest) throw new Error("Migration sources changed; review them again");
        const slug = path.basename(source.absolutePath);
        const skillId = deterministicId("skill", `legacy\0${slug}\0${digest}`);
        const revisionId = deterministicId("revision", `${skillId}\0${digest}`);
        const metadata = parseMarkdownFrontmatter(document).metadata;
        const manifest = fileManifest(files);
        let skill = skills.find((candidate) => candidate.id === skillId);
        if (!skill) {
          const revision: ResourceLibrarySkillRevision = {
            id: revisionId,
            sequence: 1,
            parentRevisionId: null,
            digest,
            createdAt: migratedAt,
            changeNote: "Migrated legacy skill",
            files: manifest,
          };
          skill = {
            id: skillId,
            slug,
            displayName: frontmatterString(metadata.name) ?? slug,
            description: frontmatterString(metadata.description) ?? "",
            origin: "legacy",
            provenance: [],
            archived: false,
            currentRevisionId: revisionId,
            revisions: [revision],
          };
          skills.push(skill);
        }
        const revision = skill.revisions.find((candidate) => candidate.id === revisionId);
        if (!revision || revision.digest !== digest) {
          throw new Error(`Legacy skill identity collides with different content: ${skillId}`);
        }
        if (!skill.provenance.includes(source.relativePath)) {
          skill.provenance.push(source.relativePath);
          skill.provenance.sort();
        }
        await this.publishRevisionFiles(revisionId, files);

        if (source.agentId) {
          const agent = agents.find((candidate) => candidate.id === source.agentId);
          if (!agent) throw new Error(`Missing migrated Agent: ${source.agentId}`);
          const attachment: ResourceLibraryAttachment = {
            agentId: source.agentId,
            skillId,
            revisionId,
            alias: path.basename(source.absolutePath),
          };
          const existing = agent.attachments.find(
            (candidate) => candidate.alias === attachment.alias,
          );
          if (
            existing &&
            (existing.skillId !== skillId || existing.revisionId !== revisionId)
          ) {
            throw new Error(
              `Agent ${source.agentId} already has a different attachment for ${attachment.alias}`,
            );
          }
          if (!existing) agent.attachments.push(attachment);
          agent.attachments.sort((left, right) => left.alias.localeCompare(right.alias));
        }
        receiptSources.push({
          path: source.relativePath,
          skillId,
          revisionId,
          digest,
        });
      }

      const receipt: ResourceLibraryMigrationReceipt = {
        version: 1,
        migratedAt,
        importedSourceCount: sources.length,
        logicalSkillCount: skills.length,
        agentCount: agents.length,
        sources: receiptSources,
      };
      const next: ResourceLibraryCatalog = {
        ...current,
        generation: current.generation + 1,
        generationId: this.createId(),
        skills: sortById(skills),
        agents: sortById(agents),
        teams: sortById(current.teams),
        packages: sortById(current.packages),
        migrationReceipt: receipt,
      };
      options.signal?.throwIfAborted();
      await this.publishCatalog(next);
      return {
        alreadyMigrated: false,
        generationId: next.generationId,
        importedSourceCount: receipt.importedSourceCount,
        logicalSkillCount: receipt.logicalSkillCount,
      };
    });
  }

  async installResourcePackage(params: {
    decoded: DecodedResourcePackage; archive: Buffer; digest: string; filename: string;
    expectedGeneration: number; resolutions: readonly ResourcePackageResolution[]; runtimeTargets?: ResourceRuntimeTargets; builtinUpdate?: BuiltInUpdateSource; signal?: AbortSignal;
  }): Promise<{ unchanged: boolean; packageId: string }> {
    return this.withMutationLock(async () => {
      const current = await this.getSnapshot();
      const packageId = `package_${packageIdentity(params.digest)}`;
      if (digestResourceFile(params.archive) !== params.digest) throw new Error("Package archive digest does not match");
      if (current.packages.some((item) => item.id === packageId && item.digest === params.digest)) {
        await this.retainPackageArchive(packageId, params.archive);
        const record = current.packages.find((item) => item.id === packageId);
        if (params.builtinUpdate && (record?.builtinSource?.path !== params.builtinUpdate.path || record.builtinSource.digest !== params.builtinUpdate.digest)) {
          assertExpectedGeneration(current, params.expectedGeneration);
          await this.publishCatalog({ ...current, generation: current.generation + 1, generationId: this.createId(), packages: current.packages.map((item) => item.id === packageId ? { ...item, builtinSource: params.builtinUpdate } : item) });
        }
        return { unchanged: true, packageId };
      }
      assertExpectedGeneration(current, params.expectedGeneration);
      params.signal?.throwIfAborted();
      const targets = await planResourceNames(this.options.repoRoot, params.decoded, params.digest);
      if ((targets.agents.length || targets.teams.length) && (!params.runtimeTargets || JSON.stringify(targets) !== JSON.stringify(params.runtimeTargets))) throw new Error('Runtime resources changed since preview; rebuild the preview before importing');
      const skills = [...current.skills];
      const mapping: ResourceImportMapping[] = [];
      const resolutionIds = params.resolutions.map((item) => item.sourceId);
      if (new Set(resolutionIds).size !== resolutionIds.length || resolutionIds.some((id) => !params.decoded.skills.some((item) => item.skill.id === id))) throw new Error('Invalid or duplicate import resolution');
      for (const imported of params.decoded.skills) {
        const source = imported.skill;
        const resolution = params.resolutions.find((item) => item.sourceId === source.id);
        const identical = skills.find((item) => item.id === source.id && source.revisions.every((revision) => item.revisions.some((candidate) => candidate.id === revision.id && candidate.digest === revision.digest)));
        if (!resolution && identical) {
          mapping.push(...source.revisions.map((revision) => ({ sourceId: source.id, sourceRevisionId: revision.id, skillId: identical.id, revisionId: revision.id, substituted: false })));
          continue;
        }
        const target = skills.find((item) => item.id === resolution?.targetSkillId);
        if (resolution?.mode === 'reuse') {
          const revision = target?.revisions.find((item) => item.id === resolution.revisionId);
          if (!target || !revision) throw new Error('Choose an existing skill and revision to reuse');
          mapping.push(...source.revisions.map((item) => ({ sourceId: source.id, sourceRevisionId: item.id, skillId: target.id, revisionId: revision.id, substituted: revision.digest !== item.digest })));
          continue;
        }
        if (resolution?.mode === 'revision' && !target) throw new Error('Choose an existing skill for the new revision');
        if (target && resolution?.mode === 'revision' && target.slug !== source.slug) throw new Error('New revisions require the same skill slug; use a separate variant instead');
        const id = target && resolution?.mode === 'revision' ? target.id : skills.some((item) => item.id === source.id) ? `skill_${packageIdentity(`${params.digest}:${source.id}`)}` : source.id;
        const prior = target && resolution?.mode === 'revision' ? target : undefined;
        const revisions = prior ? [...prior.revisions] : [];
        for (const sourceRevision of [...source.revisions].sort((a, b) => a.sequence - b.sequence)) {
          const files = imported.snapshots.get(sourceRevision.id);
          if (!files) throw new Error('Missing imported revision bytes');
          const previous = revisions.at(-1);
          const localId = prior || id !== source.id ? `revision_${packageIdentity(`${id}:${sourceRevision.id}:${sourceRevision.digest}`)}` : sourceRevision.id;
          const revision: ResourceLibrarySkillRevision = prior ? {
            ...sourceRevision, id: localId, sequence: (previous?.sequence ?? 0) + 1, parentRevisionId: previous?.id ?? null,
            createdAt: this.now().toISOString(), changeNote: `Import ${params.filename}`,
          } : { ...sourceRevision, id: localId, parentRevisionId: sourceRevision.parentRevisionId ? mapping.find((item) => item.sourceId === source.id && item.sourceRevisionId === sourceRevision.parentRevisionId)?.revisionId ?? null : null };
          await this.publishRevisionFiles(revision.id, files);
          revisions.push(revision);
          mapping.push({ sourceId: source.id, sourceRevisionId: sourceRevision.id, skillId: id, revisionId: revision.id, substituted: false });
        }
        const currentRevision = mapping.find((item) => item.sourceId === source.id && item.sourceRevisionId === source.currentRevisionId);
        if (!currentRevision) throw new Error('Missing imported current revision');
        const skill: ResourceLibrarySkill = { ...(prior ?? source), id, currentRevisionId: currentRevision.revisionId, revisions, origin: prior?.origin ?? 'import', provenance: [...new Set([...(prior?.provenance ?? source.provenance), params.filename])] };
        const index = skills.findIndex((item) => item.id === id);
        if (index < 0) skills.push(skill); else skills[index] = skill;
      }
      const readImportedRevision = async (skillId: string, revisionId: string): Promise<ResourceSkillFiles> => {
        const skill = skills.find((item) => item.id === skillId); const revision = skill?.revisions.find((item) => item.id === revisionId);
        if (!revision) throw new Error("Missing imported runtime revision");
        const files = await readResourceSkillFiles(path.join(this.rootPath, "revisions", revisionId));
        if (!files || digestResourceSkillFiles(files) !== revision.digest) throw new Error("Corrupt imported runtime revision");
        return files;
      };
      const materialized = await materializeResourceImport(params.decoded, targets, mapping, readImportedRevision);
      const installedFiles = await buildInstalledResourceExport({ decoded: params.decoded, targets, mapping, skills, materialized, readRevision: readImportedRevision });
      const installedArchive = await writeResourceZip(installedFiles, params.signal ? { signal: params.signal } : {});
      await this.retainPackageArchive(packageId, installedArchive, true);
      await this.retainPackageArchive(packageId, params.archive);
      const registry = await prepareImportedTeamRegistry(this.options.repoRoot, params.decoded, targets);
      const generationId = this.createId();
      const next: ResourceLibraryCatalog = { ...current, generation: current.generation + 1, generationId, skills: sortById(skills), agents: sortById([...current.agents, ...materialized.agents]), teams: sortById([...current.teams, ...materialized.teams]), packages: sortById([...current.packages, {
        id: packageId, ...(params.builtinUpdate ? { builtinSource: params.builtinUpdate } : {}), version: params.decoded.manifest.version, schemaVersion: 1, origin: params.filename, digest: params.digest, installedDigest: digestResourceFile(installedArchive),
        resourceIds: [...new Set([...mapping.map((item) => item.skillId), ...materialized.agents.map((item) => item.id), ...materialized.teams.map((item) => item.id)])], installedAt: this.now().toISOString(), receipt: JSON.stringify({ sourcePackageId: params.decoded.manifest.id, mapping, runtimeTargets: targets }),
      }]) };
      params.signal?.throwIfAborted();
      await publishImportedResources({ repoRoot: this.options.repoRoot, libraryRoot: this.rootPath, generationId, resources: materialized.resources, ...(registry ? { registry } : {}), publish: () => this.publishCatalog(next), isPublished: async () => (await this.readCurrentPointer())?.generationId === generationId });
      return { unchanged: false, packageId };
    });
  }

  async createSkill(
    params: CreateResourceSkillParams,
  ): Promise<ResourceLibrarySkillMutationResult> {
    return this.withMutationLock(async () => {
      const current = await this.getSnapshot();
      assertExpectedGeneration(current, params.expectedGeneration);
      const document = requireSkillDocument(params.files).toString("utf8");
      assertSkillDocumentConforms(params.slug, document);
      const digest = digestResourceSkillFiles(params.files);
      const skillId = `skill_${this.createId()}`;
      const revision: ResourceLibrarySkillRevision = {
        id: deterministicId("revision", `${skillId}\0initial\0${digest}`),
        sequence: 1,
        parentRevisionId: null,
        digest,
        createdAt: this.now().toISOString(),
        changeNote: params.changeNote,
        files: fileManifest(params.files),
      };
      const metadata = parseMarkdownFrontmatter(document).metadata;
      const skill: ResourceLibrarySkill = {
        id: skillId,
        slug: params.slug,
        displayName: frontmatterString(metadata.name) ?? params.slug,
        description: frontmatterString(metadata.description) ?? "",
        origin: "library",
        provenance: [],
        archived: false,
        currentRevisionId: revision.id,
        revisions: [revision],
      };
      await this.publishRevisionFiles(revision.id, params.files);
      await this.publishCatalog({
        ...current,
        generation: current.generation + 1,
        generationId: this.createId(),
        skills: sortById([...current.skills, skill]),
      });
      return { skill, revision, unchanged: false };
    });
  }

  async saveSkillRevision(
    params: SaveResourceSkillRevisionParams,
  ): Promise<ResourceLibrarySkillMutationResult> {
    return this.withMutationLock(async () => {
      const current = await this.getSnapshot();
      assertExpectedGeneration(current, params.expectedGeneration);
      const { skill, baseRevision } = findCurrentSkillRevision(
        current,
        params.skillId,
        params.baseRevisionId,
      );
      return this.publishSkillRevision({
        current,
        skill,
        baseRevision,
        files: params.files,
        changeNote: params.changeNote,
      });
    });
  }

  async restoreSkillRevision(
    params: RestoreResourceSkillRevisionParams,
  ): Promise<ResourceLibrarySkillMutationResult> {
    return this.withMutationLock(async () => {
      const current = await this.getSnapshot();
      assertExpectedGeneration(current, params.expectedGeneration);
      const { skill, baseRevision } = findCurrentSkillRevision(
        current,
        params.skillId,
        params.baseRevisionId,
      );
      const sourceRevision = skill.revisions.find(
        (candidate) => candidate.id === params.sourceRevisionId,
      );
      if (!sourceRevision) {
        throw new Error(
          `Unknown historical revision ${params.sourceRevisionId} for ${params.skillId}`,
        );
      }
      const files = await readResourceSkillFiles(
        path.join(this.rootPath, "revisions", sourceRevision.id),
      );
      if (!files || digestResourceSkillFiles(files) !== sourceRevision.digest) {
        throw new Error(`Historical revision is missing or corrupt: ${sourceRevision.id}`);
      }
      return this.publishSkillRevision({
        current,
        skill,
        baseRevision,
        files,
        changeNote: params.changeNote,
        restoredFromRevisionId: sourceRevision.id,
      });
    });
  }

  async ingestAgentSkills(
    agentId: string,
    options: { withLock?: boolean } = {},
  ): Promise<ResourceLibraryAgentMutationResult> {
    return this.withMutationLockChoice(options.withLock, async () => {
      const current = await this.getSnapshot();
      const existingAgent = current.agents.find((candidate) => candidate.id === agentId);
      const agent = existingAgent ?? { id: agentId, attachments: [] };
      const skills = current.skills.map((skill) => ({
        ...skill,
        provenance: [...skill.provenance],
        revisions: [...skill.revisions],
      }));
      const attachments: ResourceLibraryAttachment[] = [];
      let catalogChanged = !existingAgent;
      const agentSkillsRoot = path.join(this.options.repoRoot, "agents", agentId, "skills");
      const roots = await findDirectSkillRoots(agentSkillsRoot);

      for (const root of roots) {
        const alias = path.basename(root);
        const relativePath = toRepoRelative(this.options.repoRoot, root);
        const files = await readResourceSkillFiles(root);
        if (!files) throw new Error(`Agent skill disappeared during publication: ${relativePath}`);
        const document = requireSkillDocument(files).toString("utf8");
        assertSkillDocumentConforms(alias, document);
        const digest = digestResourceSkillFiles(files);
        const previousAttachment = agent.attachments.find((attachment) => attachment.alias === alias);
        let skill = previousAttachment
          ? skills.find((candidate) => candidate.id === previousAttachment.skillId)
          : skills.find((candidate) =>
              candidate.slug === alias && candidate.revisions.some((revision) => revision.digest === digest)
            );
        if (previousAttachment && !skill) {
          throw new Error(`Agent ${agentId} refers to unknown skill ${previousAttachment.skillId}`);
        }
        let revision: ResourceLibrarySkillRevision | undefined;
        if (skill) {
          const currentSkill = skill;
          revision = currentSkill.revisions.find((candidate) => candidate.digest === digest);
          if (!revision) {
            const parent = currentSkill.revisions.find((candidate) => candidate.id === currentSkill.currentRevisionId);
            if (!parent) throw new Error(`Skill ${skill.id} has no current revision`);
            const metadata = parseMarkdownFrontmatter(document).metadata;
            revision = {
              id: deterministicId(
                "revision",
                `${skill.id}\0${parent.id}\0${parent.sequence + 1}\0${digest}`,
              ),
              sequence: parent.sequence + 1,
              parentRevisionId: parent.id,
              digest,
              createdAt: this.now().toISOString(),
              changeNote: `Ingested from Agent ${agentId}`,
              files: fileManifest(files),
            };
            skill = {
              ...skill,
              displayName: frontmatterString(metadata.name) ?? skill.slug,
              description: frontmatterString(metadata.description) ?? "",
              currentRevisionId: revision.id,
              revisions: [...skill.revisions, revision],
            };
            skills.splice(skills.findIndex((candidate) => candidate.id === skill?.id), 1, skill);
            await this.publishRevisionFiles(revision.id, files);
            catalogChanged = true;
          }
        } else {
          const metadata = parseMarkdownFrontmatter(document).metadata;
          const skillId = deterministicId("skill", `legacy\0${alias}\0${digest}`);
          revision = {
            id: deterministicId("revision", `${skillId}\0${digest}`),
            sequence: 1,
            parentRevisionId: null,
            digest,
            createdAt: this.now().toISOString(),
            changeNote: `Ingested from Agent ${agentId}`,
            files: fileManifest(files),
          };
          skill = {
            id: skillId,
            slug: alias,
            displayName: frontmatterString(metadata.name) ?? alias,
            description: frontmatterString(metadata.description) ?? "",
            origin: "library",
            provenance: [],
            archived: false,
            currentRevisionId: revision.id,
            revisions: [revision],
          };
          skills.push(skill);
          await this.publishRevisionFiles(revision.id, files);
          catalogChanged = true;
        }
        if (!skill.provenance.includes(relativePath)) {
          skill.provenance.push(relativePath);
          skill.provenance.sort();
          catalogChanged = true;
        }
        attachments.push({
          agentId,
          skillId: skill.id,
          revisionId: revision.id,
          alias,
        });
      }

      const nextAgent = { ...agent, attachments: sortByAlias(attachments) };
      if (
        !catalogChanged &&
        JSON.stringify(sortByAlias([...agent.attachments])) === JSON.stringify(nextAgent.attachments)
      ) {
        return { agent, unchanged: true };
      }
      return this.mutateAgentAttachments(
        { ...current, skills: sortById(skills) },
        nextAgent,
        true,
      );
    });
  }

  async removeAgent(
    agentId: string,
    options: { withLock?: boolean } = {},
  ): Promise<ResourceLibraryAgentMutationResult> {
    return this.withMutationLockChoice(options.withLock, async () => {
      const current = await this.getSnapshot();
      const agent = current.agents.find((candidate) => candidate.id === agentId);
      if (!agent) return { agent: { id: agentId, attachments: [] }, unchanged: true };
      await this.publishCatalog({
        ...current,
        generation: current.generation + 1,
        generationId: this.createId(),
        agents: current.agents.filter((candidate) => candidate.id !== agentId),
      });
      return { agent, unchanged: false };
    });
  }

  async setSkillArchived(params: {
    skillId: string;
    archived: boolean;
    expectedGeneration: number;
  }): Promise<{ skill: ResourceLibrarySkill; unchanged: boolean }> {
    return this.withMutationLock(async () => {
      const current = await this.getSnapshot();
      assertExpectedGeneration(current, params.expectedGeneration);
      const skill = current.skills.find((candidate) => candidate.id === params.skillId);
      if (!skill) throw new Error(`Unknown skill: ${params.skillId}`);
      if (skill.archived === params.archived) return { skill, unchanged: true };
      const updatedSkill = { ...skill, archived: params.archived };
      await this.publishCatalog({
        ...current,
        generation: current.generation + 1,
        generationId: this.createId(),
        skills: sortById(current.skills.map((candidate) =>
          candidate.id === skill.id ? updatedSkill : candidate
        )),
      });
      return { skill: updatedSkill, unchanged: false };
    });
  }

  async attachSkill(
    params: AttachResourceSkillParams,
  ): Promise<ResourceLibraryAgentMutationResult> {
    return this.withMutationLock(async () => {
      const current = await this.getSnapshot();
      assertExpectedGeneration(current, params.expectedGeneration);
      const skill = current.skills.find((candidate) => candidate.id === params.skillId);
      const revision = skill?.revisions.find((candidate) => candidate.id === params.revisionId);
      if (!skill || !revision) throw new Error(`Unknown skill revision: ${params.skillId}/${params.revisionId}`);
      if (skill.archived) throw new Error(`Archived skills cannot be attached: ${skill.slug}`);
      if (params.alias !== skill.slug) {
        throw new Error(`Runtime alias must match the standard skill slug: ${skill.slug}`);
      }
      const agent = current.agents.find((candidate) => candidate.id === params.agentId) ?? {
        id: params.agentId,
        attachments: [],
      };
      if (agent.attachments.some((attachment) => attachment.alias === params.alias)) {
        throw new Error(`Agent ${params.agentId} already uses runtime alias ${params.alias}`);
      }
      return this.mutateAgentAttachments(current, {
        ...agent,
        attachments: sortByAlias([...agent.attachments, {
          agentId: params.agentId,
          skillId: params.skillId,
          revisionId: params.revisionId,
          alias: params.alias,
        }]),
      });
    });
  }

  async detachSkill(
    params: DetachResourceSkillParams,
  ): Promise<ResourceLibraryAgentMutationResult> {
    return this.withMutationLock(async () => {
      const current = await this.getSnapshot();
      assertExpectedGeneration(current, params.expectedGeneration);
      const agent = current.agents.find((candidate) => candidate.id === params.agentId);
      if (!agent) throw new Error(`Unknown Agent: ${params.agentId}`);
      const attachments = agent.attachments.filter((attachment) => attachment.alias !== params.alias);
      if (attachments.length === agent.attachments.length) return { agent, unchanged: true };
      return this.mutateAgentAttachments(current, { ...agent, attachments });
    });
  }

  async selectAgentSkillRevision(
    params: SelectAgentSkillRevisionParams,
  ): Promise<ResourceLibraryAgentMutationResult> {
    return this.withMutationLock(async () => {
      const current = await this.getSnapshot();
      assertExpectedGeneration(current, params.expectedGeneration);
      const agent = current.agents.find((candidate) => candidate.id === params.agentId);
      const attachment = agent?.attachments.find((candidate) => candidate.skillId === params.skillId);
      const skill = current.skills.find((candidate) => candidate.id === params.skillId);
      const revision = skill?.revisions.find((candidate) => candidate.id === params.revisionId);
      if (!agent || !attachment || !skill || !revision) {
        throw new Error(`Agent ${params.agentId} has no matching attachment for ${params.skillId}`);
      }
      if (attachment.revisionId === params.revisionId) return { agent, unchanged: true };
      return this.mutateAgentAttachments(current, {
        ...agent,
        attachments: agent.attachments.map((candidate) =>
          candidate.skillId === params.skillId
            ? { ...candidate, revisionId: params.revisionId }
            : candidate
        ),
      });
    });
  }

  private async mutateAgentAttachments(
    current: ResourceLibraryCatalog,
    agent: ResourceLibraryAgent,
    ingest = false,
  ): Promise<ResourceLibraryAgentMutationResult> {
    const next = {
      ...current,
      generation: current.generation + 1,
      generationId: this.createId(),
      agents: sortById([...current.agents.filter((candidate) => candidate.id !== agent.id), agent]),
    };
    const previousAgent = ingest ? undefined : current.agents.find((candidate) => candidate.id === agent.id);
    const publish = () => this.publishCatalog(next);
    if (this.options.projectAgent) await this.options.projectAgent({
      agent,
      ...(previousAgent ? { previousAgent } : {}),
      generationId: next.generationId,
      publish,
      isPublished: async () => (await this.getSnapshot()).generationId === next.generationId,
      readRevisionFiles: async (skillId, revisionId) => {
        const skill = current.skills.find((candidate) => candidate.id === skillId);
        const revision = skill?.revisions.find((candidate) => candidate.id === revisionId);
        if (!skill || !revision) {
          throw new Error(`Unknown skill revision: ${skillId}/${revisionId}`);
        }
        const files = await readResourceSkillFiles(
          path.join(this.rootPath, "revisions", revisionId),
        );
        if (!files || digestResourceSkillFiles(files) !== revision.digest) {
          throw new Error(`Skill revision is missing or corrupt: ${skillId}/${revisionId}`);
        }
        return files;
      },
    });
    else await publish();
    return { agent, unchanged: false };
  }

  private async publishSkillRevision(params: {
    current: ResourceLibraryCatalog;
    skill: ResourceLibrarySkill;
    baseRevision: ResourceLibrarySkillRevision;
    files: ResourceSkillFiles;
    changeNote: string;
    restoredFromRevisionId?: string;
  }): Promise<ResourceLibrarySkillMutationResult> {
    const { current, skill, baseRevision, files } = params;
    const digest = digestResourceSkillFiles(files);
    if (digest === baseRevision.digest) {
      return { skill, revision: baseRevision, unchanged: true };
    }
    const document = requireSkillDocument(files).toString("utf8");
    assertSkillDocumentConforms(skill.slug, document);
    const revision: ResourceLibrarySkillRevision = {
      id: deterministicId(
        "revision",
        `${skill.id}\0${baseRevision.id}\0${baseRevision.sequence + 1}\0${digest}`,
      ),
      sequence: baseRevision.sequence + 1,
      parentRevisionId: baseRevision.id,
      digest,
      createdAt: this.now().toISOString(),
      changeNote: params.changeNote,
      ...(params.restoredFromRevisionId === undefined
        ? {}
        : { restoredFromRevisionId: params.restoredFromRevisionId }),
      files: fileManifest(files),
    };
    const metadata = parseMarkdownFrontmatter(document).metadata;
    const updatedSkill: ResourceLibrarySkill = {
      ...skill,
      displayName: frontmatterString(metadata.name) ?? skill.slug,
      description: frontmatterString(metadata.description) ?? "",
      currentRevisionId: revision.id,
      revisions: [...skill.revisions, revision],
    };
    await this.publishRevisionFiles(revision.id, files);
    await this.publishCatalog({
      ...current,
      generation: current.generation + 1,
      generationId: this.createId(),
      skills: sortById(current.skills.map((candidate) =>
        candidate.id === skill.id ? updatedSkill : candidate
      )),
    });
    return { skill: updatedSkill, revision, unchanged: false };
  }

  async getSnapshot(): Promise<ResourceLibrarySnapshot> {
    const pointer = await this.readCurrentPointer();
    if (!pointer) return emptyCatalog();
    const catalogPath = path.join(
      this.rootPath,
      "generations",
      pointer.generationId,
      "catalog.json",
    );
    return readValidatedJson(catalogPath, resourceLibraryCatalogSchema);
  }

  async readSkillRevisionSnapshot(
    skillId: string,
    revisionId: string,
  ): Promise<ResourceSkillFiles> {
    const snapshot = await this.getSnapshot();
    const skill = snapshot.skills.find((candidate) => candidate.id === skillId);
    const revision = skill?.revisions.find((candidate) => candidate.id === revisionId);
    if (!skill || !revision) {
      throw new Error(`Unknown skill revision: ${skillId}/${revisionId}`);
    }
    const root = path.join(this.rootPath, "revisions", revisionId);
    const files = await readResourceSkillFiles(root);
    if (!files || digestResourceSkillFiles(files) !== revision.digest) {
      throw new Error(`Skill revision is missing or corrupt: ${skillId}/${revisionId}`);
    }
    return files;
  }

  async readSkillRevisionFiles(
    skillId: string,
    revisionId: string,
  ): Promise<ReadonlyMap<string, Buffer>> {
    const files = await this.readSkillRevisionSnapshot(skillId, revisionId);
    return new Map(
      [...files.entries()].map(([relativePath, file]) => [relativePath, file.contents]),
    );
  }

  private async inventoryLegacySkills(): Promise<LegacySkillSource[]> {
    const sources: LegacySkillSource[] = [];
    const skillsRoot = path.join(this.options.repoRoot, "skills");
    for (const root of await findSkillRootsRecursively(skillsRoot)) {
      sources.push({
        absolutePath: root,
        relativePath: toRepoRelative(this.options.repoRoot, root),
      });
    }
    for (const agent of await this.inventoryAgents([])) {
      const agentSkillsRoot = path.join(this.options.repoRoot, "agents", agent.id, "skills");
      for (const root of await findDirectSkillRoots(agentSkillsRoot)) {
        sources.push({
          absolutePath: root,
          relativePath: toRepoRelative(this.options.repoRoot, root),
          agentId: agent.id,
        });
      }
    }
    sources.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
    return sources;
  }

  private async inventoryAgents(
    current: readonly ResourceLibraryAgent[],
  ): Promise<ResourceLibraryAgent[]> {
    const agents = current.map((agent) => ({
      ...agent,
      attachments: [...agent.attachments],
    }));
    const agentsRoot = path.join(this.options.repoRoot, "agents");
    const entries = await fs.readdir(agentsRoot, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const persona = path.join(agentsRoot, entry.name, `${entry.name}.md`);
      const stat = await fs.lstat(persona).catch(() => null);
      if (!stat?.isFile() || stat.isSymbolicLink()) continue;
      if (!agents.some((agent) => agent.id === entry.name)) {
        agents.push({ id: entry.name, attachments: [] });
      }
    }
    return sortById(agents);
  }

  private async publishRevisionFiles(
    revisionId: string,
    files: ResourceSkillFiles,
  ): Promise<void> {
    const target = path.join(this.rootPath, "revisions", revisionId);
    const existing = await readResourceSkillFiles(target);
    if (existing) {
      if (digestResourceSkillFiles(existing) !== digestResourceSkillFiles(files)) {
        throw new Error(`Immutable revision has different content: ${revisionId}`);
      }
      return;
    }
    await fs.mkdir(path.join(this.rootPath, "revisions"), { recursive: true });
    const staging = path.join(
      this.rootPath,
      "staging",
      "revisions",
      `${revisionId}-${this.createId()}`,
    );
    try {
      await fs.mkdir(path.dirname(staging), { recursive: true });
      await writeResourceSkillFiles(files, staging);
      await fs.rename(staging, target);
    } catch (error) {
      const published = await readResourceSkillFiles(target);
      if (!published || digestResourceSkillFiles(published) !== digestResourceSkillFiles(files)) {
        throw error;
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }

  private async publishCatalog(catalog: ResourceLibraryCatalog): Promise<void> {
    resourceLibraryCatalogSchema.parse(catalog);
    const catalogPath = path.join(
      this.rootPath,
      "generations",
      catalog.generationId,
      "catalog.json",
    );
    await writeFileAtomic(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`);
    await this.options.onPersistenceBoundary?.("catalog_staged");
    await writeFileAtomic(
      path.join(this.rootPath, "current.json"),
      `${JSON.stringify({ schemaVersion: 1, generationId: catalog.generationId })}\n`,
    );
    await this.options.onPersistenceBoundary?.("current_published");
  }

  private async readCurrentPointer(): Promise<{ generationId: string } | null> {
    const pointerPath = path.join(this.rootPath, "current.json");
    const source = await fs.readFile(pointerPath, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    });
    if (source === null) return null;
    const value: unknown = JSON.parse(source);
    return resourceLibraryCurrentPointerSchema.parse(value);
  }

  private async withMutationLockChoice<T>(
    withLock: boolean | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    return withLock === false ? operation() : this.withMutationLock(operation);
  }

  /** Existing authoring writers join the same recovery boundary before their Agent lock. */
  async withPublicationLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withMutationLock(operation);
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    await fs.mkdir(this.rootPath, { recursive: true });
    return withCrossProcessFileLock(
      path.join(this.rootPath, "mutation.lock"),
      async () => {
        const current = await this.getSnapshot();
        await recoverAgentSkillProjections(this.options.repoRoot, current.generationId);
        await recoverImportedResources(this.options.repoRoot, this.rootPath, current.generationId);
        await fs.rm(path.join(this.rootPath, "staging"), { recursive: true, force: true });
        return operation();
      },
    );
  }
}

function emptyCatalog(): ResourceLibraryCatalog {
  return {
    schemaVersion: 1,
    generation: 0,
    generationId: "empty",
    skills: [],
    agents: [],
    teams: [],
    packages: [],
  };
}

function fileManifest(files: ResourceSkillFiles): ResourceLibraryFileManifest[] {
  return [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relativePath, file]) => ({
      path: relativePath,
      sha256: digestResourceFile(file.contents),
      sizeBytes: file.contents.byteLength,
      executable: file.executable,
    }));
}

function deterministicId(prefix: string, value: string): string {
  return `${prefix}_${createHash("sha256").update(value, "utf8").digest("hex").slice(0, 32)}`;
}

function assertExpectedGeneration(
  catalog: ResourceLibraryCatalog,
  expectedGeneration: number,
): void {
  if (catalog.generation === expectedGeneration) return;
  throw new ResourceLibraryConflictError(
    "generation_conflict",
    `Resource Library is at generation ${catalog.generation}, not expected generation ${expectedGeneration}`,
  );
}

function assertSkillDocumentConforms(slug: string, source: string): void {
  assertSkillBatchConforms([{
    origin: "generated",
    folderName: slug,
    source,
    skillPath: `skills/${slug}/SKILL.md`,
  }]);
}

function findCurrentSkillRevision(
  catalog: ResourceLibraryCatalog,
  skillId: string,
  baseRevisionId: string,
): { skill: ResourceLibrarySkill; baseRevision: ResourceLibrarySkillRevision } {
  const skill = catalog.skills.find((candidate) => candidate.id === skillId);
  if (!skill) throw new Error(`Unknown skill: ${skillId}`);
  if (skill.currentRevisionId !== baseRevisionId) {
    throw new ResourceLibraryConflictError(
      "revision_conflict",
      `Skill ${skillId} is at revision ${skill.currentRevisionId}, not expected base ${baseRevisionId}`,
    );
  }
  const baseRevision = skill.revisions.find((candidate) => candidate.id === baseRevisionId);
  if (!baseRevision) throw new Error(`Skill ${skillId} has no current revision ${baseRevisionId}`);
  return { skill, baseRevision };
}

async function findDirectSkillRoots(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidate = path.join(root, entry.name);
    if (await isFile(path.join(candidate, "SKILL.md"))) roots.push(candidate);
  }
  return roots.sort();
}

async function findSkillRootsRecursively(root: string): Promise<string[]> {
  if (await isFile(path.join(root, "SKILL.md"))) return [root];
  const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
    roots.push(...await findSkillRootsRecursively(path.join(root, entry.name)));
  }
  return roots.sort();
}

async function isFile(filePath: string): Promise<boolean> {
  const stat = await fs.lstat(filePath).catch(() => null);
  return stat?.isFile() === true && !stat.isSymbolicLink();
}

async function readValidatedJson<T>(
  filePath: string,
  schema: { parse(value: unknown): T },
): Promise<T> {
  const source = await fs.readFile(filePath, "utf8");
  const value: unknown = JSON.parse(source);
  return schema.parse(value);
}

function toRepoRelative(repoRoot: string, absolutePath: string): string {
  return path.relative(repoRoot, absolutePath).split(path.sep).join("/");
}

function sortById<T extends { id: string }>(values: T[]): T[] {
  return values.sort((left, right) => left.id.localeCompare(right.id));
}

function sortByAlias<T extends { alias: string }>(values: T[]): T[] {
  return values.sort((left, right) => left.alias.localeCompare(right.alias));
}
