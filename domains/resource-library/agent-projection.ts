import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as z from "zod/v4";

import { writeFileAtomic } from "../../core/file-mutation.js";
import type { ResourceLibraryAgentProjection } from "./resource-library-store.js";
import { digestResourceSkillFiles, readResourceSkillFiles, writeResourceSkillFiles, type ResourceSkillFile } from "./skill-files.js";

const journalName = ".skills-publication.json";
const journalSchema = z.object({
  generationId: z.string().min(1),
  staging: z.string().regex(/^\.skills-staging-[a-zA-Z0-9-]+$/),
  backup: z.string().regex(/^\.skills-backup-[a-zA-Z0-9-]+$/),
  hadLive: z.boolean(),
});

export async function projectAgentSkills(params: {
  repoRoot: string;
  projection: ResourceLibraryAgentProjection;
}): Promise<void> {
  const { repoRoot, projection } = params;
  const agentDir = path.join(repoRoot, "agents", projection.agent.id);
  const persona = await optionalStat(path.join(agentDir, `${projection.agent.id}.md`));
  if (!persona?.isFile() || persona.isSymbolicLink()) {
    throw new Error(`Cannot project skills for missing Agent ${projection.agent.id}`);
  }
  const live = path.join(agentDir, "skills");
  const liveStat = await optionalStat(live);
  if (liveStat?.isSymbolicLink() || (liveStat && !liveStat.isDirectory())) {
    throw new Error(`Agent skills path is not a real directory: ${live}`);
  }
  await assertNoProjectionDrift(live, projection);
  const suffix = `${process.pid}-${randomUUID()}`;
  const journal = {
    generationId: projection.generationId,
    staging: `.skills-staging-${suffix}`,
    backup: `.skills-backup-${suffix}`,
    hadLive: liveStat !== null,
  };
  const staging = path.join(agentDir, journal.staging);
  await fs.mkdir(staging);
  try {
    for (const attachment of projection.agent.attachments) {
      const files = await projection.readRevisionFiles(attachment.skillId, attachment.revisionId);
      const target = path.join(staging, attachment.alias);
      await writeResourceSkillFiles(files, target);
      const staged = await readResourceSkillFiles(target);
      if (!staged || digestResourceSkillFiles(staged) !== digestResourceSkillFiles(files)) {
        throw new Error(`Projected skill failed verification: ${attachment.alias}`);
      }
    }
    // The journal precedes either rename so restart can undo an unpublished swap.
    await writeFileAtomic(path.join(agentDir, journalName), JSON.stringify(journal));
    if (journal.hadLive) await fs.rename(live, path.join(agentDir, journal.backup));
    await fs.rename(staging, live);
    await projection.publish();
    await recoverAgentProjection(agentDir, projection.generationId);
  } catch (error) {
    const committed = await projection.isPublished();
    await recoverAgentProjection(agentDir, committed ? projection.generationId : undefined);
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

async function assertNoProjectionDrift(live: string, projection: ResourceLibraryAgentProjection): Promise<void> {
  if (!projection.previousAgent) return; // Explicit ingest accepts authored files.
  const actual = await readResourceSkillFiles(live);
  const expected = new Map<string, ResourceSkillFile>();
  for (const attachment of projection.previousAgent.attachments) {
    const files = await projection.readRevisionFiles(attachment.skillId, attachment.revisionId);
    for (const [relativePath, file] of files) expected.set(`${attachment.alias}/${relativePath}`, file);
  }
  if ((!actual && expected.size > 0) || (actual && digestResourceSkillFiles(actual) !== digestResourceSkillFiles(expected))) {
    throw new Error(`Agent skill projection drift: ${projection.agent.id}. Explicitly ingest or restore the changed files before editing attachments.`);
  }
}

export async function recoverAgentSkillProjections(repoRoot: string, generationId: string): Promise<void> {
  const agentsRoot = path.join(repoRoot, "agents");
  const stat = await optionalStat(agentsRoot);
  if (!stat) return;
  for (const entry of await fs.readdir(agentsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      await recoverAgentProjection(path.join(agentsRoot, entry.name), generationId);
    }
  }
}

async function recoverAgentProjection(agentDir: string, generationId: string | undefined): Promise<void> {
  const journalPath = path.join(agentDir, journalName);
  if (!await optionalStat(journalPath)) return;
  const raw: unknown = JSON.parse(await fs.readFile(journalPath, "utf8"));
  const journal = journalSchema.parse(raw);
  const live = path.join(agentDir, "skills");
  const staging = path.join(agentDir, journal.staging);
  const backup = path.join(agentDir, journal.backup);
  if (journal.generationId !== generationId) {
    if (await optionalStat(backup)) {
      await fs.rm(live, { recursive: true, force: true });
      await fs.rename(backup, live);
    } else if (!journal.hadLive && !await optionalStat(staging)) {
      await fs.rm(live, { recursive: true, force: true });
    }
  }
  await fs.rm(staging, { recursive: true, force: true });
  await fs.rm(backup, { recursive: true, force: true });
  await fs.rm(journalPath);
}

async function optionalStat(target: string) {
  try { return await fs.lstat(target); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
