/**
 * Persists a generated agent package to disk.
 *
 * Creates `agents/<approvedName>/`, writes `<approvedName>.md`, scaffolds
 * `experience/scratch-pad.md` (with the same template seen across existing
 * agents), and copies each source skill folder into `skills/<name>/`.
 *
 * `overwrite: true` removes any pre-existing folder at the target before
 * writing. Without it, this function refuses to proceed if the folder
 * already exists.
 */

import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import type { CommitAgentRequest, CommitAgentResult } from "./types.js";
import {
  assertAgentNameIsNotReserved,
  withAgentNameMutationLock,
} from "./agent-name-reservation.js";
import {
  assertSkillBatchConforms,
  type SkillPublicationSource,
} from "./skill-spec-validation.js";

const SCRATCH_PAD_TEMPLATE = `<!--
After each session, append an entry below using this format:

### Session: [date] — [brief topic]
- **What worked:** [approaches/methods that produced good results]
- **What didn't:** [approaches that failed or produced weak results]
- **Pattern noticed:** [any recurring pattern worth remembering]
- **For next time:** [specific adjustment to try in future sessions]
-->
`;

/**
 * Durable points a publication passes, for tests that need to observe one.
 *
 * Internal to this module and never part of the HTTP contract: it exists so a
 * concurrency test can watch the lock from the inside without depending on
 * timing.
 */
export type CommitAgentBoundary = "after_agent_folder_created";

export async function commitAgent(
  request: CommitAgentRequest & {
    repoRoot: string;
    onPersistenceBoundary?: (boundary: CommitAgentBoundary) => void | Promise<void>;
  },
): Promise<CommitAgentResult> {
  const name = sanitizeAgentName(request.approvedName);
  if (!name) {
    throw new Error("approvedName must be a non-empty kebab-case identifier");
  }

  // Everything this publication would write is read and checked first: the
  // imported folders from their own bytes, the generated skills from theirs,
  // and the folder names both would claim. Nothing below this line can be
  // reached by a batch the specification rejects, so a bad skill leaves no
  // package behind — and, with `overwrite`, leaves the Agent that was already
  // there exactly as it was.
  const imported = await readImportedSkillSources(request.skillPaths);
  const generated = describeGeneratedSkills(request.generatedSkills ?? []);
  assertSkillBatchConforms([...imported, ...generated]);
  // Every import carries bytes from here on: one with none is a violation the
  // check above raised, so this narrowing removes nothing.
  const publishableImports = imported.flatMap((skill) =>
    skill.source === null ? [] : [{ ...skill, source: skill.source }],
  );

  const agentsDir = path.join(request.repoRoot, "agents");
  const agentFolder = path.join(agentsDir, name);
  await fs.mkdir(agentsDir, { recursive: true });
  const personaPath = path.join(agentFolder, `${name}.md`);
  const importedSkills: string[] = [];
  const generatedSkills: string[] = [];
  // One lock for the whole target mutation, not just the folder it starts
  // with. Releasing after the mkdir left the persona and every skill written
  // outside it, so a concurrent writer of this same Agent — a skill update
  // that had just rechecked its revision, or another publication — could
  // interleave with these writes. Provider work and the imported-source
  // preflight stay outside, where they belong.
  await withAgentNameMutationLock(request.repoRoot, name, async () => {
    assertAgentNameIsNotReserved(request.repoRoot, name);
    if (fsSync.existsSync(agentFolder)) {
      if (!request.overwrite) {
        throw new Error(`Agent folder already exists: ${agentFolder}`);
      }
      await fs.rm(agentFolder, { recursive: true, force: true });
    }
    await fs.mkdir(agentFolder);
    await request.onPersistenceBoundary?.("after_agent_folder_created");

    await fs.mkdir(path.join(agentFolder, "experience"));
    await fs.mkdir(path.join(agentFolder, "skills"), { recursive: true });

    await fs.writeFile(personaPath, request.personaMarkdown, "utf8");

    await fs.writeFile(
      path.join(agentFolder, "experience", "scratch-pad.md"),
      SCRATCH_PAD_TEMPLATE,
      "utf8",
    );

    // Both kinds are published from the snapshot the check ran against, under
    // the exact folder name it approved. Renaming here would publish a folder
    // whose `name` no longer matches it; re-reading the source here would
    // publish bytes nothing validated, and a copy that skipped the file would
    // publish a folder with no SKILL.md while reporting the skill as imported.
    for (const skill of publishableImports) {
      const skillDir = path.join(agentFolder, "skills", skill.folderName);
      await copyDir(skill.sourcePath, skillDir, SKILL_FILE_PUBLISHED_FROM_SNAPSHOT);
      await fs.writeFile(path.join(skillDir, SKILL_FILE), skill.source, "utf8");
      importedSkills.push(skill.folderName);
    }

    for (const skill of generated) {
      const skillDir = path.join(agentFolder, "skills", skill.folderName);
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(path.join(skillDir, SKILL_FILE), skill.source, "utf8");
      generatedSkills.push(skill.folderName);
    }
  });

  return {
    agentName: name,
    agentFolderPath: agentFolder,
    personaPath,
    importedSkills,
    generatedSkills,
  };
}

export async function savePersona(params: {
  repoRoot: string;
  agentName: string;
  personaMarkdown: string;
}): Promise<{ personaPath: string }> {
  const name = sanitizeAgentName(params.agentName);
  if (!name) {
    throw new Error("agentName must be a non-empty kebab-case identifier");
  }
  const personaPath = path.join(params.repoRoot, "agents", name, `${name}.md`);
  // The same lock every other writer of this Agent takes. A save that skipped
  // it could land between a skill update's revision recheck and its writes,
  // and that update would then publish over a persona it never checked.
  return withAgentNameMutationLock(params.repoRoot, name, async () => {
    if (!fsSync.existsSync(personaPath)) {
      throw new Error(`Persona file does not exist: ${personaPath}`);
    }
    await fs.writeFile(personaPath, params.personaMarkdown, "utf8");
    return { personaPath };
  });
}

export async function readPersona(params: {
  repoRoot: string;
  agentName: string;
}): Promise<string> {
  const name = sanitizeAgentName(params.agentName);
  if (!name)
    throw new Error("agentName must be a non-empty kebab-case identifier");
  const personaPath = path.join(params.repoRoot, "agents", name, `${name}.md`);
  return fs.readFile(personaPath, "utf8");
}

const SKILL_FILE = "SKILL.md";
/** The one entry `copyDir` leaves out: it is written from the validated bytes. */
const SKILL_FILE_PUBLISHED_FROM_SNAPSHOT: ReadonlySet<string> = new Set([SKILL_FILE]);

/** One selected skill folder, read before anything is created. */
interface ImportedSkillSource extends SkillPublicationSource {
  sourcePath: string;
}

/**
 * Reads each selected folder's own `SKILL.md`.
 *
 * A folder with no `SKILL.md` is carried through as a source with no bytes
 * rather than dropped: the user asked for that folder, and publishing the Agent
 * without it and saying nothing would hand back a package missing a skill it
 * was told to carry.
 */
async function readImportedSkillSources(
  skillPaths: readonly string[],
): Promise<ImportedSkillSource[]> {
  const sources: ImportedSkillSource[] = [];
  for (const skillPath of skillPaths) {
    const sourcePath = path.resolve(skillPath);
    const folderName = path.basename(sourcePath);
    const skillFile = path.join(sourcePath, SKILL_FILE);
    sources.push({
      origin: "imported",
      folderName,
      sourcePath,
      skillPath: skillFile,
      source: await readSkillFile(skillFile),
    });
  }
  return sources;
}

/**
 * The bytes of one `SKILL.md`, or `null` when there is no file there.
 *
 * Only a missing file is absence. Anything else — a permission fault, an I/O
 * error, or an entry that is not a regular file — is a question this read could
 * not answer, and reporting it as absence would name the wrong problem and lose
 * the reason with it. A symbolic link matters in particular: reading follows it
 * and copying does not, so accepting one would validate bytes that never reach
 * the published folder.
 */
async function readSkillFile(skillFile: string): Promise<string | null> {
  const stats = await fs.lstat(skillFile).catch((error: unknown) => {
    if (isMissingFileError(error)) return null;
    throw readFailure(skillFile, error);
  });
  if (stats === null) return null;
  if (!stats.isFile()) {
    throw new Error(
      `Cannot publish ${skillFile}: a skill's SKILL.md must be a regular file`,
    );
  }
  return fs.readFile(skillFile, "utf8").catch((error: unknown) => {
    throw readFailure(skillFile, error);
  });
}

function readFailure(skillFile: string, error: unknown): Error {
  return new Error(
    `Could not read ${skillFile}: ${error instanceof Error ? error.message : String(error)}`,
    { cause: error },
  );
}

/** Whether a read failed because the file simply is not there. */
function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

/** The generated skills as the batch check sees them: name plus exact bytes. */
function describeGeneratedSkills(
  skills: readonly { name: string; body: string }[],
): (SkillPublicationSource & { source: string })[] {
  return skills.map((skill) => {
    const folderName = skill.name ?? "";
    return {
      origin: "generated",
      folderName,
      source: skill.body,
      skillPath: `skills/${folderName || "(unnamed)"}/${SKILL_FILE}`,
    };
  });
}

async function copyDir(
  source: string,
  target: string,
  skipRootEntries: ReadonlySet<string> = new Set(),
): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  const entries = await fs.readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (skipRootEntries.has(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDir(sourcePath, targetPath);
    } else if (entry.isFile()) {
      await fs.copyFile(sourcePath, targetPath);
    }
  }
}

function sanitizeAgentName(input: string): string {
  const trimmed = (input || "").trim().toLowerCase();
  const safe = trimmed.replace(/[^a-z0-9_-]/g, "-").replace(/^-+|-+$/g, "");
  if (safe.length === 0) return "";
  if (safe.length > 40) return safe.slice(0, 40).replace(/-+$/g, "");
  return safe;
}

export function nextAvailableAgentName(
  repoRoot: string,
  baseName: string,
): string {
  const base = sanitizeAgentName(baseName) || `agent-${Date.now()}`;
  const agentsDir = path.join(repoRoot, "agents");
  if (!fsSync.existsSync(path.join(agentsDir, base))) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!fsSync.existsSync(path.join(agentsDir, candidate))) return candidate;
  }
  return `${base}-${Date.now()}`;
}
