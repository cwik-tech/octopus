import type { ResourceAgentPublication } from "../contracts/resource-publication.js";
import { builtInBundleSchema, builtInInstallReceiptSchema } from "../contracts/builtin-resources.js";
import type { BuiltInUpdateSource } from "../contracts/builtin-update.js";
import { verifyBuiltinFiles } from "../domains/resource-library/builtin-bundle-files.js";
import { digestResourceFile } from "../domains/resource-library/skill-files.js";
import { createResourceMigrationBackup } from "./resource-migration-backup.js";
import { preserveSkillSnapshot } from "../domains/agent-generator/skill-preservation.js";
import { portableIdSchema } from "../contracts/resource-package.js";
import { ResourcePackageService } from './resource-package-service.js';
import * as path from "node:path";
import * as fs from "node:fs/promises";

import type {
  ResourceLibraryBrowserSnapshot,
  ResourceLibraryMigrationResult,
  ResourceLibraryRevisionFiles,
} from "../contracts/resource-library.js";
import {
  listAgentTeamOptions,
  listAgents,
  readTeamBuilderTeam,
} from "../domains/agent-generator/index.js";
import { projectAgentSkills } from "../domains/resource-library/agent-projection.js";
import {
  createRuntimeProjection,
  type ResourceRuntimeProjection,
} from "../domains/resource-library/runtime-projection.js";
import {
  ResourceLibraryStore,
  type CreateResourceSkillParams,
  type ResourceLibrarySkillMutationResult,
  type RestoreResourceSkillRevisionParams,
  type SaveResourceSkillRevisionParams,
} from "../domains/resource-library/resource-library-store.js";

export interface ResourceLibraryServiceOptions {
  repoRootPath: string;
  rootPath: string;
  now?: () => Date;
  createId?: () => string;
  requireMigrationApproval?: boolean;
  builtinResourceRootPath?: string;
}

export class ResourceLibraryService {
  readonly store: ResourceLibraryStore;
  readonly packages: ResourcePackageService;
  private initialization: Promise<ResourceLibraryMigrationResult> | undefined;

  constructor(private readonly options: ResourceLibraryServiceOptions) {
    this.store = new ResourceLibraryStore({
      repoRoot: options.repoRootPath,
      rootPath: options.rootPath,
      ...(options.now ? { now: options.now } : {}),
      ...(options.createId ? { createId: options.createId } : {}),
      projectAgent: async (projection) => {
        await projectAgentSkills({ repoRoot: options.repoRootPath, projection });
      },
    });
    this.packages = new ResourcePackageService({ store: this.store, repoRoot: options.repoRootPath, validateBuiltinUpdate: (source, bytes) => this.validateBuiltinUpdate(source, bytes) });
  }

  async initialize(): Promise<ResourceLibraryMigrationResult | undefined> {
    if (this.options.requireMigrationApproval !== false && !(await this.store.getSnapshot()).migrationReceipt) return undefined;
    this.initialization ??= this.store.migrateLegacyResources().catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  private async getBuiltinOffers() {
    if (!this.options.builtinResourceRootPath) return [];
    const text = await fs.readFile(path.join(this.options.repoRootPath, '.builtin-install-receipt.json'), 'utf8').catch((error: unknown) => { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error; });
    if (text === null) return [];
    const value: unknown = JSON.parse(text); const receipt = builtInInstallReceiptSchema.parse(value);
    const catalog = await this.store.getSnapshot();
    return receipt.offeredUpdates.filter((offer) => !catalog.packages.some((item) => item.builtinSource?.path === offer.path && item.builtinSource.digest === offer.digest));
  }

  async exportBuiltinUpdate(source: BuiltInUpdateSource): Promise<{ bytes: Buffer; filename: string }> {
    const offer = (await this.getBuiltinOffers()).find((item) => item.path === source.path && item.digest === source.digest);
    const root = this.options.builtinResourceRootPath;
    if (!offer || !root) throw new Error('Bundled update changed or is no longer offered. Refresh Library.');
    if (offer.kind !== 'directory') throw new Error('Bundled configuration updates require manual review; existing configuration is preserved.');
    const value: unknown = JSON.parse(await fs.readFile(path.join(root, 'builtin-resources.json'), 'utf8'));
    const manifest = builtInBundleSchema.parse(value);
    if (!manifest.resources.some((item) => item.path === offer.path && item.digest === offer.digest)) throw new Error('Bundled update manifest changed');
    await verifyBuiltinFiles(root, manifest);
    const cache = new ResourceLibraryStore({ repoRoot: root, rootPath: path.join(this.options.rootPath, 'builtin-cache', manifest.buildId) });
    await cache.migrateLegacyResources();
    const [kind, id] = offer.path.split('/');
    if (!id) throw new Error('Invalid bundled resource path');
    const packages = new ResourcePackageService({ store: cache, repoRoot: root });
    if (kind === 'agents') return packages.export({ kind: 'agent', id, format: 'octopus', includeHistory: false });
    if (kind === 'teams') return packages.export({ kind: 'team', id, format: 'octopus', includeHistory: false });
    if (kind === 'skills') {
      const skill = (await cache.getSnapshot()).skills.find((item) => item.slug === id); if (!skill) throw new Error('Missing bundled skill');
      return packages.export({ kind: 'skill', id: skill.id, format: 'octopus', includeHistory: false });
    }
    throw new Error('Unsupported bundled resource');
  }

  private async validateBuiltinUpdate(source: BuiltInUpdateSource, bytes: Buffer): Promise<void> {
    const expected = await this.exportBuiltinUpdate(source);
    if (digestResourceFile(expected.bytes) !== digestResourceFile(bytes)) throw new Error('Reviewed bundled update archive changed');
  }

  async withResourceRead<T>(read: () => T | Promise<T>): Promise<T> {
    if (!(await this.initialize())) return read();
    return this.store.withPublicationLock(async () => read());
  }

  async getBrowserSnapshot(): Promise<ResourceLibraryBrowserSnapshot> {
    const initialized = await this.initialize();
    const read = async (): Promise<ResourceLibraryBrowserSnapshot> => ({
      ...(await this.store.getSnapshot()),
      builtInUpdates: await this.getBuiltinOffers(),
      ...(!initialized ? { migrationPending: await this.store.previewLegacyMigration() } : {}),
      agentDetails: listAgents(this.options.repoRootPath),
      teamDetails: listAgentTeamOptions(this.options.repoRootPath).map((team) => readTeamBuilderTeam(this.options.repoRootPath, team.id)),
    });
    return initialized ? this.store.withPublicationLock(read) : read();
  }

  async publishResources<T>(writer: (owned: ResourceAgentPublication) => Promise<T>): Promise<T> {
    await this.initialize();
    return this.store.withPublicationLock(async () => {
      let active = true;
      let tail = Promise.resolve();
      const owned: ResourceAgentPublication = {
        publishAgent: <TResult>(agentId: string, write: () => Promise<TResult>): Promise<TResult> => {
          if (!active) return Promise.reject(new Error('Resource publication scope has ended'));
          const result = tail.then(() => this.publishAgentUnderLock(agentId, write));
          tail = result.then(() => undefined, () => undefined);
          return result;
        },
      };
      try { return await writer(owned); }
      finally { active = false; await tail; }
    });
  }

  async publishAgent<T>(agentId: string, writer: () => Promise<T>): Promise<T> {
    return this.publishResources((owned) => owned.publishAgent(agentId, writer));
  }

  private async publishAgentUnderLock<T>(agentId: string, writer: () => Promise<T>): Promise<T> {
    if (!(await this.store.getSnapshot()).migrationReceipt) {
      await this.retainLegacyAgentSkills(agentId);
      return writer();
    }
    await this.retainAgentSkills(agentId);
    const result = await writer();
    await this.store.ingestAgentSkills(agentId, { withLock: false });
    return result;
  }

  async deleteAgentPublication<T>(
    agentId: string,
    writer: () => Promise<T>,
  ): Promise<T> {
    if (!(await this.initialize())) {
      return this.store.withPublicationLock(async () => { await this.retainLegacyAgentSkills(agentId); return writer(); });
    }
    return this.store.withPublicationLock(
      async () => {
        await this.retainAgentSkills(agentId);
        const result = await writer();
        await this.store.removeAgent(agentId, { withLock: false });
        return result;
      },
    );
  }

  async ingestAgentSkills(agentId: string): Promise<void> {
    await this.ensureReady();
    await this.store.ingestAgentSkills(agentId);
  }

  async ensureReady(): Promise<void> {
    if (!(await this.initialize())) throw new Error('Review and approve the Library migration before changing Library resources.');
  }

  async approveMigration(input: { inventoryDigest: string; expectedGeneration: number }, options: { signal?: AbortSignal } = {}): Promise<{ backupPath: string }> {
    return this.store.withPublicationLock(async () => {
      options.signal?.throwIfAborted();
      const report = await this.store.previewLegacyMigration();
      if (report.alreadyMigrated) throw new Error('Library is already enabled. Refresh the Library view.');
      if (report.inventoryDigest !== input.inventoryDigest || report.expectedGeneration !== input.expectedGeneration) throw new Error('Migration inventory changed since review. Refresh and review it again.');
      const backupPath = await createResourceMigrationBackup({ repoRoot: this.options.repoRootPath, libraryRoot: this.options.rootPath, report, ...options });
      const result = await this.store.migrateLegacyResources({ withLock: false, expectedSources: new Map(report.sources.map((source) => [source.path, source.digest])), ...options });
      this.initialization = Promise.resolve(result);
      return { backupPath };
    });
  }

  private async retainLegacyAgentSkills(agentId: string): Promise<void> {
    portableIdSchema.parse(agentId);
    const root = path.join(this.options.repoRootPath, 'agents', agentId, 'skills');
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error;
    });
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith('.')) await preserveSkillSnapshot({ repoRoot: this.options.repoRootPath, source: path.join(root, entry.name), skillName: entry.name });
    }
  }

  private async retainAgentSkills(agentId: string): Promise<void> {
    const persona = path.join(this.options.repoRootPath, "agents", agentId, `${agentId}.md`);
    try {
      const stat = await fs.lstat(persona);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        await this.store.ingestAgentSkills(agentId, { withLock: false });
      }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
  }

  async removeAgent(agentId: string): Promise<void> {
    await this.ensureReady();
    await this.store.removeAgent(agentId);
  }

  async createTaskProjection(params: {
    scopeId: string;
  }): Promise<ResourceRuntimeProjection> {
    return this.createProjection({ ...params, includeTeams: true });
  }

  async createAgentProjection(params: {
    scopeId: string;
    agentIds: readonly string[];
  }): Promise<ResourceRuntimeProjection> {
    return this.createProjection({ ...params, includeTeams: false });
  }

  private async createProjection(params: {
    scopeId: string;
    agentIds?: readonly string[];
    includeTeams: boolean;
  }): Promise<ResourceRuntimeProjection> {
    if (!(await this.initialize())) return { rootPath: this.options.repoRootPath, agentPaths: Object.fromEntries(listAgents(this.options.repoRootPath).map((agent) => [agent.name, `agents/${agent.name}`])) };
    return this.store.withPublicationLock(
      async () => {
        const catalog = await this.store.getSnapshot();
        return createRuntimeProjection({
          repoRoot: this.options.repoRootPath,
          catalog,
          scopeId: params.scopeId,
          ...(params.agentIds ? { agentIds: params.agentIds } : {}),
          includeTeams: params.includeTeams,
          readRevisionFiles: (skillId, revisionId) =>
            this.store.readSkillRevisionSnapshot(skillId, revisionId),
        });
      },
    );
  }

  async createSkill(
    params: CreateResourceSkillParams,
  ): Promise<ResourceLibrarySkillMutationResult> {
    await this.ensureReady();
    return this.store.createSkill(params);
  }

  async saveSkillRevision(
    params: SaveResourceSkillRevisionParams,
  ): Promise<ResourceLibrarySkillMutationResult> {
    await this.ensureReady();
    return this.store.saveSkillRevision(params);
  }

  async restoreSkillRevision(
    params: RestoreResourceSkillRevisionParams,
  ): Promise<ResourceLibrarySkillMutationResult> {
    await this.ensureReady();
    return this.store.restoreSkillRevision(params);
  }

  async setSkillArchived(params: {
    skillId: string;
    archived: boolean;
    expectedGeneration: number;
  }): Promise<{ skill: import("../contracts/resource-library.js").ResourceLibrarySkill; unchanged: boolean }> {
    await this.ensureReady();
    return this.store.setSkillArchived(params);
  }

  async attachSkill(params: {
    agentId: string;
    skillId: string;
    revisionId: string;
    alias: string;
    expectedGeneration: number;
  }): Promise<ResourceLibraryBrowserSnapshot> {
    await this.ensureReady();
    await this.store.attachSkill(params);
    return this.getBrowserSnapshot();
  }

  async detachSkill(params: {
    agentId: string;
    alias: string;
    expectedGeneration: number;
  }): Promise<ResourceLibraryBrowserSnapshot> {
    await this.ensureReady();
    await this.store.detachSkill(params);
    return this.getBrowserSnapshot();
  }

  async selectAgentSkillRevision(params: {
    agentId: string;
    skillId: string;
    revisionId: string;
    expectedGeneration: number;
  }): Promise<ResourceLibraryBrowserSnapshot> {
    await this.ensureReady();
    await this.store.selectAgentSkillRevision(params);
    return this.getBrowserSnapshot();
  }

  async readRevisionFiles(
    skillId: string,
    revisionId: string,
  ): Promise<ResourceLibraryRevisionFiles> {
    await this.ensureReady();
    const [snapshot, files] = await Promise.all([
      this.store.getSnapshot(),
      this.store.readSkillRevisionFiles(skillId, revisionId),
    ]);
    const revision = snapshot.skills
      .find((skill) => skill.id === skillId)
      ?.revisions.find((candidate) => candidate.id === revisionId);
    if (!revision) throw new Error(`Unknown skill revision: ${skillId}/${revisionId}`);
    return {
      files: revision.files.map((manifest) => ({
        path: manifest.path,
        contentBase64: (files.get(manifest.path) ?? Buffer.alloc(0)).toString("base64"),
        executable: manifest.executable,
      })),
    };
  }
}
