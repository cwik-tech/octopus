import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as z from "zod/v4";

import { writeFileAtomic } from "../../core/file-mutation.js";
import {
  resourceLibraryAttachmentSchema,
  type ResourceLibraryCatalog,
} from "../../contracts/resource-library.js";
import {
  digestResourceSkillFiles,
  readResourceSkillFiles,
  writeResourceSkillFiles,
  type ResourceSkillFiles,
} from "./skill-files.js";

export interface ResourceRuntimeProjection {
  rootPath: string;
  agentPaths: Record<string, string>;
}

const segment = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/);
const projectionManifestSchema = z.object({
  schemaVersion: z.literal(1), scopeId: z.string(), agentIds: z.array(segment),
  generationId: z.string(), includeTeams: z.boolean(),
  attachments: z.array(resourceLibraryAttachmentSchema.extend({
    agentId: segment, alias: segment, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })),
});
type ProjectionManifest = z.infer<typeof projectionManifestSchema>;

export async function createRuntimeProjection(params: {
  repoRoot: string;
  catalog: ResourceLibraryCatalog;
  scopeId: string;
  agentIds?: readonly string[];
  includeTeams: boolean;
  readRevisionFiles(skillId: string, revisionId: string): Promise<ResourceSkillFiles>;
}): Promise<ResourceRuntimeProjection> {
  const { repoRoot, catalog } = params;
  const requestedIds = params.agentIds ? [...new Set(params.agentIds)].sort() : undefined;
  const projectionId = createHash("sha256")
    .update(JSON.stringify([params.scopeId, params.includeTeams, requestedIds ?? "*"]))
    .digest("hex").slice(0, 32);
  const projectionsRoot = path.join(repoRoot, "agents", ".resource-library-tasks");
  const rootPath = path.join(projectionsRoot, projectionId);
  const retained = await readRetainedProjection(rootPath, params.scopeId, params.includeTeams);
  if (retained) return projectionResult(repoRoot, rootPath, retained.agentIds);
  const agentIds = [...new Set(params.agentIds ?? catalog.agents.map((agent) => agent.id))].sort();
  const agents = agentIds.map((agentId) => {
    const agent = catalog.agents.find((candidate) => candidate.id === agentId);
    if (!agent) throw new Error(`No Library attachment record for Agent ${agentId}`);
    return agent;
  });
  const attachments = agents.flatMap((agent) => agent.attachments).sort((left, right) =>
    `${left.agentId}/${left.alias}`.localeCompare(`${right.agentId}/${right.alias}`)
  );
  const manifest: ProjectionManifest = {
    schemaVersion: 1,
    scopeId: params.scopeId,
    agentIds,
    generationId: catalog.generationId,
    includeTeams: params.includeTeams,
    attachments: attachments.map((attachment) => {
      const skill = catalog.skills.find((candidate) => candidate.id === attachment.skillId);
      const revision = skill?.revisions.find((candidate) => candidate.id === attachment.revisionId);
      if (!skill || !revision) {
        throw new Error(`Unknown pinned revision ${attachment.skillId}/${attachment.revisionId}`);
      }
      return { ...attachment, digest: revision.digest };
    }),
  };

  const staging = path.join(
    projectionsRoot,
    `.staging-${projectionId}-${process.pid}-${randomUUID()}`,
  );
  await fs.mkdir(staging, { recursive: true });
  try {
    for (const agent of agents) {
      await materializeAgent({
        repoRoot,
        targetRoot: staging,
        agent,
        readRevisionFiles: params.readRevisionFiles,
      });
    }
    if (params.includeTeams) await materializeTeams(repoRoot, staging);
    await writeFileAtomic(
      path.join(staging, "projection.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await fs.mkdir(projectionsRoot, { recursive: true });
    await fs.rename(staging, rootPath);
  } catch (error) {
    if (await readRetainedProjection(rootPath, params.scopeId, params.includeTeams)) {
      return projectionResult(repoRoot, rootPath, agentIds);
    }
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
  return projectionResult(repoRoot, rootPath, agentIds);
}

async function materializeAgent(params: {
  repoRoot: string;
  targetRoot: string;
  agent: ResourceLibraryCatalog["agents"][number];
  readRevisionFiles(skillId: string, revisionId: string): Promise<ResourceSkillFiles>;
}): Promise<void> {
  const { agent, repoRoot, targetRoot } = params;
  const source = path.join(repoRoot, "agents", agent.id);
  const target = path.join(targetRoot, "agents", agent.id);
  // Runtime snapshots keep existing memory context; portable exports exclude it separately.
  await copyPortableTree(source, target, new Set(["skills"]));
  await fs.mkdir(path.join(target, "skills"), { recursive: true });
  for (const attachment of agent.attachments) {
    const files = await params.readRevisionFiles(
      attachment.skillId,
      attachment.revisionId,
    );
    const digest = digestResourceSkillFiles(files);
    const destination = path.join(target, "skills", attachment.alias);
    await writeResourceSkillFiles(files, destination);
    const projected = await readResourceSkillFiles(destination);
    if (!projected || digestResourceSkillFiles(projected) !== digest) {
      throw new Error(`Runtime projection failed for ${agent.id}/${attachment.alias}`);
    }
  }
}

async function materializeTeams(repoRoot: string, targetRoot: string): Promise<void> {
  for (const filename of ["teams.yaml", "start.yaml"]) {
    const source = path.join(repoRoot, filename);
    const stat = await fs.lstat(source).catch(() => null);
    if (!stat) continue;
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Runtime team registry is not a regular file: ${source}`);
    }
    await fs.mkdir(targetRoot, { recursive: true });
    await fs.copyFile(source, path.join(targetRoot, filename));
  }
  const teamsRoot = path.join(repoRoot, "teams");
  const stat = await fs.lstat(teamsRoot).catch(() => null);
  if (stat) await copyPortableTree(teamsRoot, path.join(targetRoot, "teams"));
}

async function copyPortableTree(
  source: string,
  target: string,
  skipRootNames: ReadonlySet<string> = new Set(),
): Promise<void> {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw new Error(`Portable resources cannot be symbolic links: ${source}`);
  if (stat.isFile()) {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(source, target);
    await fs.chmod(target, stat.mode & 0o777);
    return;
  }
  if (!stat.isDirectory()) throw new Error(`Portable resource has an unsupported type: ${source}`);
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || skipRootNames.has(entry.name)) continue;
    await copyPortableTree(path.join(source, entry.name), path.join(target, entry.name), new Set());
  }
}

async function readRetainedProjection(
  rootPath: string, scopeId: string, includeTeams: boolean,
): Promise<ProjectionManifest | null> {
  const source = await fs.readFile(path.join(rootPath, "projection.json"), "utf8").catch((error: unknown) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return null;
  const value: unknown = JSON.parse(source);
  const manifest = projectionManifestSchema.parse(value);
  if (manifest.scopeId !== scopeId || manifest.includeTeams !== includeTeams) {
    throw new Error("Retained projection scope does not match admission");
  }
  for (const attachment of manifest.attachments) {
    const files = await readResourceSkillFiles(path.join(rootPath, "agents", attachment.agentId, "skills", attachment.alias));
    if (!files || digestResourceSkillFiles(files) !== attachment.digest) {
      throw new Error(`Retained projection is corrupt: ${attachment.agentId}/${attachment.alias}`);
    }
  }
  return manifest;
}

function projectionResult(
  repoRoot: string,
  rootPath: string,
  agentIds: readonly string[],
): ResourceRuntimeProjection {
  const relativeRoot = path.relative(repoRoot, rootPath).split(path.sep).join("/");
  return {
    rootPath,
    agentPaths: Object.fromEntries(
      agentIds.map((agentId) => [agentId, `${relativeRoot}/agents/${agentId}`]),
    ),
  };
}
