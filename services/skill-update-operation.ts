/**
 * Durable publication of one `update_agent_skills` operation.
 *
 * One operation writes one file per requested skill, and there is no
 * filesystem transaction spanning two of them. An attempt can therefore stop
 * with some published and the rest not, and the only thing that makes that
 * recoverable is evidence: a manifest recording, for every requested skill,
 * the state its file was in when the update was authorized and the exact bytes
 * staged to replace it. With that, a later attempt can tell its own
 * half-finished work from somebody else's edit. Without it, the two look the
 * same and the safe answer would always be "do nothing".
 *
 * The evidence belongs to the plan, the operation, and the Agent — never to
 * the job. A retry is a new build of the same stored plan and carries a new
 * job id; refusing to recover on that basis would strand the operation's own
 * output forever.
 *
 * Nothing is generated while a lock is held, and nothing is written to the
 * Agent outside one. Those are separate phases on purpose: a provider call can
 * take a long time, and a lock held across it would serialize every other
 * operation behind a network round trip.
 */

import { createHash } from "node:crypto";
import type { ResourceAgentPublisher } from "../contracts/resource-publication.js";
import * as fs from "node:fs";
import * as path from "node:path";

import { whenDefined } from "../core/optional-properties.js";
import { writeFileAtomic } from "../core/file-mutation.js";
import { withAgentNameMutationLock } from "../domains/agent-generator/agent-name-reservation.js";
import type {
  ResourceSkillUpdate,
  ResourceUpdateOperation,
} from "../contracts/resource-architect.js";
import {
  agentPackagePath,
  computeAgentRevision,
  digestAgentRevisionFiles,
  digestFileContents,
  readAgentRevisionFiles,
  type AgentRevisionFiles,
} from "../domains/agent-generator/agent-revision.js";
import type { PlannedAgentGenerationGate } from "../domains/agent-generator/planned-agent-builder.js";
import {
  assertSkillAuthoringReachable,
  generateSkillDocument,
} from "../domains/agent-generator/skill-generator.js";
import {
  assertSkillBatchConforms,
  SkillSpecViolationError,
} from "../domains/agent-generator/skill-spec-validation.js";
import { digestResourceUpdateOperation } from "../domains/resource-architect/resource-update-operation-digest.js";
import {
  findSkillUpdateStructureViolation,
  skillDocumentRelativePath,
} from "../domains/resource-architect/skill-update-rules.js";

export type SkillUpdatePersistenceBoundary =
  | "after_skill_manifest_staged"
  | "after_skills_staged"
  | "after_skill_intended_revision_recorded"
  | "after_skill_file_published"
  | "after_skill_target_published";

export type SkillUpdatePersistenceObserver = (
  boundary: SkillUpdatePersistenceBoundary,
) => void | Promise<void>;

/**
 * One skill's progress, reported only once the evidence behind it is durable.
 *
 * `staged` follows the receipt write that records the staged hash, and
 * `updated` follows the receipt write that records the live file. `failed` and
 * `cancelled` name the skill whose authoring stopped the operation.
 */
export interface SkillUpdateProgress {
  skill: { name: string; action: "create" | "update" };
  status: "generating" | "staged" | "updated" | "failed" | "cancelled";
  /** Why authoring this skill failed, on `failed` only. */
  error?: string;
}

export type SkillUpdateProgressObserver = (progress: SkillUpdateProgress) => Promise<void>;

/** Raised when the Agent changed between the proposal and its application. */
export class AgentRevisionConflictError extends Error {
  constructor(
    readonly agentId: string,
    readonly expectedRevision: string,
    readonly currentRevision: string,
  ) {
    super(
      `Agent '${agentId}' changed since the update was proposed: expected revision ${expectedRevision}, found ${currentRevision}`,
    );
    this.name = "AgentRevisionConflictError";
  }
}

/** Raised when durable evidence exists but does not describe this operation. */
export class SkillUpdateEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillUpdateEvidenceError";
  }
}

export interface SkillUpdatePublicationResult {
  /** Skills whose document this attempt wrote, in plan order. */
  publishedSkills: string[];
  /** Whether the Agent already carried exactly this update. */
  alreadyApplied: boolean;
  /** The Agent revision this operation left behind. */
  revision: string;
}

/** One requested skill, as the evidence records it. */
interface SkillManifestEntry {
  action: "create" | "update";
  name: string;
  /** Package-relative posix path of the file this skill owns. */
  filePath: string;
  /** Digest of that file before this operation, or `null` when it was absent. */
  priorHash: string | null;
  /** Digest of the staged replacement. */
  stagedHash: string;
}

interface SkillUpdateManifest {
  version: 1;
  kind: "update_agent_skills";
  planId: string;
  /**
   * The job that first staged this operation.
   *
   * Recorded so an operator can trace the work, and deliberately never
   * compared: a retry of the same stored plan is a different job and must
   * still be able to finish what this one started.
   */
  originJobId: string;
  operationIndex: number;
  target: { kind: "agent"; id: string };
  expectedRevision: string;
  /**
   * Identity of the complete operation this receipt was written for.
   *
   * Target, revision, and skill names are not enough: two proposals can agree
   * on all three and ask for different documents, and bytes authored for one
   * instruction must never satisfy the other.
   */
  operationDigest: string;
  /**
   * Digest of everything in the package this operation does not name.
   *
   * Recorded once the requested skills are known, before anything is
   * published. The expected revision covers the files being replaced too, so
   * it stops answering "has anything else changed?" the moment one of them is
   * written; this does not.
   */
  unnamedDigest: string | null;
  /** The revision the pending write will produce, recorded before the write. */
  intendedRevision: string | null;
  skills: SkillManifestEntry[];
  /** Skills whose file has reached the Agent, in publication order. */
  publishedSkills: string[];
  state: "staged" | "published";
}

type SkillUpdateParams = {
  resourcePublisher?: ResourceAgentPublisher;
  repoRoot: string;
  planId: string;
  jobId: string;
  operationIndex: number;
  operation: Extract<ResourceUpdateOperation, { kind: "update_agent_skills" }>;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  generationGate?: PlannedAgentGenerationGate;
  onPersistenceBoundary?: SkillUpdatePersistenceObserver;
  onSkillProgress?: SkillUpdateProgressObserver;
};

/** Where one operation's evidence lives, and the operation it must describe. */
type SkillUpdateLocation = Pick<
  SkillUpdateParams,
  "repoRoot" | "planId" | "operationIndex" | "operation"
>;

/**
 * Reports each skill's progress once per change of status.
 *
 * A retry can reach the same status twice: once for a reused staged file,
 * then again when publication finds its own earlier write. The job records
 * one report per status.
 */
function createProgressReporter(params: SkillUpdateParams): {
  report: (
    skill: { name: string; action: "create" | "update" },
    status: SkillUpdateProgress["status"],
    error?: string,
  ) => Promise<void>;
} {
  const last = new Map<string, SkillUpdateProgress["status"]>();
  return {
    report: async (skill, status, error) => {
      if (!params.onSkillProgress || last.get(skill.name) === status) return;
      last.set(skill.name, status);
      await params.onSkillProgress({
        skill: { name: skill.name, action: skill.action },
        status,
        ...whenDefined(error, (reason) => ({ error: reason })),
      });
    },
  };
}

type ProgressReporter = ReturnType<typeof createProgressReporter>;

export async function applyAgentSkillUpdate(
  params: SkillUpdateParams,
): Promise<SkillUpdatePublicationResult> {
  const progress = createProgressReporter(params);
  const agentId = params.operation.target.id;
  const structure = findSkillUpdateStructureViolation(params.operation.skillUpdates);
  if (structure) {
    // A plan that reached here breaking a structural rule was not produced by
    // the proposal boundary, so it authorizes nothing.
    throw new SkillUpdateEvidenceError(
      `This update of Agent '${agentId}' is not a coherent operation: ${structure}`,
    );
  }
  throwIfAborted(params.signal);

  const manifest = readManifest(params);
  const current = readAgentRevisionFiles(params.repoRoot, agentId);
  const currentRevision = digestAgentRevisionFiles(current);

  // Already exactly the result this operation set out to produce. Rewriting it
  // would be a second write of the same bytes and would make a finished
  // operation look like one that had just run.
  //
  // The revision alone is only a number that matches. A corrupted receipt can
  // name every requested skill, invent staged hashes, and set this field to
  // the Agent's untouched revision — so the claim is checked against the
  // package before it is believed.
  if (manifest?.intendedRevision === currentRevision) {
    assertPublishedResultMatchesEvidence(manifest, current);
    for (const entry of manifest.skills) await progress.report(entry, "updated");
    return { publishedSkills: [], alreadyApplied: true, revision: currentRevision };
  }
  assertRecognizedState(params, current, currentRevision, manifest);
  assertActionsMatchTheAgent(params, current, manifest);

  const receipt = manifest ?? emptyManifest(params);
  if (!manifest) {
    await writeManifest(params.repoRoot, receipt);
    await params.onPersistenceBoundary?.("after_skill_manifest_staged");
  }

  // Phase two: authoring. No lock is held here, and every provider call goes
  // through the shared budget.
  const staged = await stageSkills(params, receipt, current, progress);
  receipt.unnamedDigest = unnamedDigest(
    current,
    new Set(receipt.skills.map((entry) => entry.filePath)),
  );
  await writeManifest(params.repoRoot, receipt);
  await params.onPersistenceBoundary?.("after_skills_staged");
  throwIfAborted(params.signal);

  // Phase three: publication, under the Agent's own mutation lock.
  const publish = () => publishStagedSkills(params, receipt, staged, progress);
  return params.resourcePublisher?.publishAgent(agentId, publish) ?? publish();
}

/**
 * Each requested action still describes the Agent it is about to change.
 *
 * The proposal boundary already refused a `create` onto an occupied name and
 * an `update` of a skill that is not there, but a plan that reached the disk
 * some other way carries no such guarantee. Checked before the first provider
 * call, so a contradicting action costs nothing and changes nothing.
 */
function assertActionsMatchTheAgent(
  params: SkillUpdateParams,
  current: AgentRevisionFiles,
  manifest: SkillUpdateManifest | null,
): void {
  for (const update of params.operation.skillUpdates) {
    const filePath = skillDocumentRelativePath(update.name);
    const bytes = current.get(filePath);
    // A file this operation already published is its own work, not a state its
    // action contradicts. `assertRecognizedState` has already proved the bytes
    // are the ones this operation staged.
    const recorded = manifest?.skills.find((entry) => entry.name === update.name);
    if (bytes && recorded && digestFileContents(bytes) === recorded.stagedHash) continue;
    const present = bytes !== undefined;
    if (update.action === "create" && present) {
      throw new SkillUpdateEvidenceError(
        `This update would create skill \`${update.name}\`, which Agent '${params.operation.target.id}' already has`,
      );
    }
    if (update.action === "update" && !present) {
      throw new SkillUpdateEvidenceError(
        `This update would rewrite skill \`${update.name}\`, which Agent '${params.operation.target.id}' does not have`,
      );
    }
  }
}

/** The exact bytes staged for each requested skill, by skill name. */
type StagedSkills = ReadonlyMap<string, Buffer>;

/**
 * Authors every skill whose staged document is not already on disk.
 *
 * A retry finds its own staged files and reuses them. Regenerating would spend
 * a provider call to produce a document the operation had already decided on,
 * and — because two runs of a model do not agree — would produce a different
 * one, so the intended result would move between attempts.
 */
async function stageSkills(
  params: SkillUpdateParams,
  receipt: SkillUpdateManifest,
  current: AgentRevisionFiles,
  progress: ProgressReporter,
): Promise<StagedSkills> {
  const staged = new Map<string, Buffer>();
  let authoringReachable = false;
  for (const update of params.operation.skillUpdates) {
    throwIfAborted(params.signal);
    const filePath = skillDocumentRelativePath(update.name);
    const recorded = receipt.skills.find((entry) => entry.name === update.name);
    const reused = readStagedDocument(params, update.name, recorded?.stagedHash);
    if (reused && recorded) {
      staged.set(update.name, reused);
      // What an earlier attempt left, reported from the receipt so a new job
      // starts from the same evidence rather than from "planned".
      await progress.report(
        update,
        isRecordedAsPublished(receipt, recorded, current) ? "updated" : "staged",
      );
      continue;
    }
    if (!authoringReachable) {
      // Whether any skill can be authored is a fact about the operation. A
      // missing configuration or API key stays on the card and names no row.
      // Checked only once a skill needs authoring, so a retry that publishes
      // staged work needs no provider.
      assertSkillAuthoringReachable({
        repoRoot: params.repoRoot,
        ...whenDefined(params.provider, (provider) => ({ provider })),
        ...whenDefined(params.model, (model) => ({ model })),
      });
      authoringReachable = true;
    }
    await progress.report(update, "generating");
    let result: Awaited<ReturnType<typeof generateSkillDocument>>;
    try {
      result = await generateSkillDocument({
        repoRoot: params.repoRoot,
        request: {
          agentId: params.operation.target.id,
          action: update.action,
          name: update.name,
          instruction: update.instruction,
          ...whenDefined(
            currentDocument(current, filePath, recorded),
            (currentSource) => ({ currentSource }),
          ),
        },
        ...whenDefined(params.provider, (provider) => ({ provider })),
        ...whenDefined(params.model, (model) => ({ model })),
        ...whenDefined(params.signal, (signal) => ({ signal })),
        ...whenDefined(params.generationGate, (gate) => ({ gate })),
      });
    } catch (error) {
      // Only the author's own failure names this skill. The report is best
      // effort: a job that cannot record it has already recorded that failure
      // itself, and the authoring error is the one this operation answers for.
      const cancelled = params.signal?.aborted === true ||
        (error instanceof Error && error.name === "AbortError");
      await progress
        .report(update, cancelled ? "cancelled" : "failed", cancelled ? undefined : errorMessage(error))
        .catch(() => undefined);
      throw error;
    }
    const contents = Buffer.from(result.source, "utf8");
    await writeFileAtomic(stagedDocumentPath(params, update.name), contents);
    staged.set(update.name, contents);
    recordSkill(receipt, update, filePath, current, contents);
    // Durable before the next provider call. A later skill that fails must not
    // take this one's evidence with it, or a retry would have to author it
    // again: a staged file the receipt does not name is never reused.
    await writeManifest(params.repoRoot, receipt);
    await progress.report(update, "staged");
  }
  return staged;
}

/**
 * What the receipt of one skill update proves about each of its skills.
 *
 * Read after a restart, when the job file may be missing the last thing the
 * operation did: a receipt entry is written before the event that reports it.
 * Only a recorded entry counts. A staged file the receipt does not name proves
 * nothing, and neither does a recorded one whose bytes no longer match. A
 * receipt that cannot be read or does not describe this operation raises
 * `SkillUpdateEvidenceError`, as it does for a build.
 */
export function readRecordedSkillProgress(
  params: SkillUpdateLocation,
): SkillUpdateProgress[] {
  const receipt = readManifest(params);
  if (!receipt) return [];
  const current = readAgentRevisionFiles(params.repoRoot, params.operation.target.id);
  const progress: SkillUpdateProgress[] = [];
  for (const entry of receipt.skills) {
    const skill = { name: entry.name, action: entry.action };
    if (isRecordedAsPublished(receipt, entry, current)) {
      progress.push({ skill, status: "updated" });
      continue;
    }
    let staged: Buffer | null;
    try {
      staged = readStagedDocument(params, entry.name, entry.stagedHash);
    } catch {
      staged = null;
    }
    if (staged) progress.push({ skill, status: "staged" });
  }
  return progress;
}

/** Whether the receipt records this skill as published and the Agent still holds it. */
function isRecordedAsPublished(
  receipt: SkillUpdateManifest,
  entry: SkillManifestEntry,
  current: AgentRevisionFiles,
): boolean {
  if (!receipt.publishedSkills.includes(entry.name)) return false;
  const bytes = current.get(entry.filePath);
  return bytes !== undefined && digestFileContents(bytes) === entry.stagedHash;
}

/**
 * The document to hand the author as context for an update.
 *
 * For a file this operation has already published, the prior content is what
 * the update was written against, and it is no longer on disk. The recorded
 * evidence cannot bring those bytes back, so a skill whose own output is
 * already published is never regenerated in the first place — this only has to
 * answer for files the Agent still holds.
 */
function currentDocument(
  current: AgentRevisionFiles,
  filePath: string,
  recorded: SkillManifestEntry | undefined,
): string | undefined {
  const bytes = current.get(filePath);
  if (!bytes) return undefined;
  if (recorded && digestFileContents(bytes) === recorded.stagedHash) return undefined;
  return bytes.toString("utf8");
}

function recordSkill(
  receipt: SkillUpdateManifest,
  update: ResourceSkillUpdate,
  filePath: string,
  current: AgentRevisionFiles,
  contents: Buffer,
): void {
  const prior = current.get(filePath);
  const entry: SkillManifestEntry = {
    action: update.action,
    name: update.name,
    filePath,
    priorHash: prior ? digestFileContents(prior) : null,
    stagedHash: digestFileContents(contents),
  };
  const index = receipt.skills.findIndex((candidate) => candidate.name === update.name);
  if (index < 0) receipt.skills.push(entry);
  else receipt.skills[index] = entry;
}

/**
 * The staged bytes for one skill this operation already decided on.
 *
 * A recorded hash is a promise about a file, and a promise nothing checks is
 * not protection. Once the receipt names staged bytes, those bytes have to be
 * there and have to match: authoring a replacement would produce a different
 * document — two runs of a model do not agree — and the intended result the
 * receipt already describes would no longer be reachable.
 */
function readStagedDocument(
  params: SkillUpdateLocation,
  skillName: string,
  stagedHash: string | undefined,
): Buffer | null {
  if (!stagedHash) return null;
  const documentPath = stagedDocumentPath(params, skillName);
  // The file itself, not a link to bytes that happen to match. A hash says
  // what the content is; it does not say this operation still owns the file
  // holding it, and what a link points at can change between this check and
  // the publication that trusts it.
  let stats: fs.Stats;
  try {
    stats = fs.lstatSync(documentPath);
  } catch (error) {
    throw new SkillUpdateEvidenceError(
      `Staged document for skill \`${skillName}\` is missing: ${errorMessage(error)}`,
    );
  }
  if (!stats.isFile()) {
    throw new SkillUpdateEvidenceError(
      `Staged document for skill \`${skillName}\` is ${
        stats.isSymbolicLink() ? "a symbolic link" : "not a regular file"
      }`,
    );
  }
  let contents: Buffer;
  try {
    contents = fs.readFileSync(documentPath);
  } catch (error) {
    throw new SkillUpdateEvidenceError(
      `Staged document for skill \`${skillName}\` is missing: ${errorMessage(error)}`,
    );
  }
  if (digestFileContents(contents) !== stagedHash) {
    throw new SkillUpdateEvidenceError(
      `Staged document for skill \`${skillName}\` does not match the bytes this operation recorded`,
    );
  }
  return contents;
}

/**
 * Writes the staged documents to the Agent, under the Agent's own lock.
 *
 * The revision is checked again here because the first check happened before
 * the authoring, and everything the operation needs to be true has to be true
 * at the moment of the write rather than at some point before it.
 */
async function publishStagedSkills(
  params: SkillUpdateParams,
  receipt: SkillUpdateManifest,
  staged: StagedSkills,
  progress: ProgressReporter,
): Promise<SkillUpdatePublicationResult> {
  const agentId = params.operation.target.id;
  const packageRoot = agentPackagePath(params.repoRoot, agentId);
  // The same lock Agent creation and package publication take. A lock keyed on
  // the package path instead would be a different lock, and a concurrent Agent
  // publish could slip between the revision recheck below and the writes that
  // follow it.
  return withAgentNameMutationLock(params.repoRoot, agentId, async () => {
    const current = readAgentRevisionFiles(params.repoRoot, agentId);
    const currentRevision = digestAgentRevisionFiles(current);
    if (receipt.intendedRevision === currentRevision) {
      // The same completion claim as the unlocked branch, and checked the same
      // way. This is the recheck that decides whether anything is written, so
      // a receipt that cannot back its claim must not settle it here either.
      assertPublishedResultMatchesEvidence(receipt, current);
      for (const entry of receipt.skills) await progress.report(entry, "updated");
      return { publishedSkills: [], alreadyApplied: true, revision: currentRevision };
    }
    assertRecognizedState(params, current, currentRevision, receipt);

    // The complete intended result, decided before a single byte is written.
    // A document that does not conform stops the operation here, with the
    // Agent exactly as it was.
    const intended = new Map(current);
    for (const entry of receipt.skills) {
      const contents = staged.get(entry.name);
      if (!contents) {
        throw new SkillUpdateEvidenceError(
          `Skill \`${entry.name}\` has no staged document to publish`,
        );
      }
      intended.set(entry.filePath, contents);
    }
    const skillPathOf = (entry: SkillManifestEntry): string => `agents/${agentId}/${entry.filePath}`;
    try {
      assertSkillBatchConforms(
        receipt.skills.map((entry) => ({
          origin: "generated" as const,
          folderName: entry.name,
          source: (staged.get(entry.name) ?? Buffer.alloc(0)).toString("utf8"),
          skillPath: skillPathOf(entry),
        })),
      );
    } catch (error) {
      if (error instanceof SkillSpecViolationError) {
        // Each violation names the path it was checked under, so the skill it
        // belongs to is known, not guessed. Best effort, like any failure
        // report: the violation is what this operation answers for.
        for (const entry of receipt.skills) {
          const problems = error.violations
            .filter((violation) => violation.skillPath === skillPathOf(entry))
            .map((violation) => violation.problem);
          if (problems.length === 0) continue;
          await progress
            .report(
              entry,
              "failed",
              `its staged SKILL.md breaks the Agent Skills specification: ${problems.join("; ")}`,
            )
            .catch(() => undefined);
        }
      }
      throw error;
    }
    const intendedRevision = digestAgentRevisionFiles(intended);

    // Durable before public: a process that exits during the writes below has
    // to be able to recognize its own result, and it can only do that if the
    // revision that result produces was written down first.
    receipt.intendedRevision = intendedRevision;
    await writeManifest(params.repoRoot, receipt);
    await params.onPersistenceBoundary?.("after_skill_intended_revision_recorded");

    // Best effort from here on. The batch is one change, and a job save that
    // fails between two live writes must not leave half of it applied. The
    // event is already in the job and reaches the disk with the next save
    // that succeeds; the journal keeps the failure, and the executor fails the
    // job once the batch is published.
    const reportPublished = (entry: SkillManifestEntry): Promise<void> =>
      progress.report(entry, "updated").catch(() => undefined);
    const publishedSkills: string[] = [];
    for (const entry of receipt.skills) {
      const contents = staged.get(entry.name);
      if (!contents) continue;
      const onDisk = current.get(entry.filePath);
      if (onDisk && digestFileContents(onDisk) === entry.stagedHash) {
        // An earlier attempt of this operation already wrote this exact file.
        if (!receipt.publishedSkills.includes(entry.name)) {
          receipt.publishedSkills.push(entry.name);
          await writeManifest(params.repoRoot, receipt);
        }
        await reportPublished(entry);
        continue;
      }
      await writeFileAtomic(path.join(packageRoot, entry.filePath), contents);
      // Written the moment the file is public, before anything else can fail:
      // the record has to describe what is on disk, and the write cannot be
      // taken back.
      if (!receipt.publishedSkills.includes(entry.name)) {
        receipt.publishedSkills.push(entry.name);
      }
      await writeManifest(params.repoRoot, receipt);
      publishedSkills.push(entry.name);
      // Updated only now: the live file and the receipt entry saying so are
      // both durable.
      await reportPublished(entry);
      await params.onPersistenceBoundary?.("after_skill_file_published");
    }

    const finalRevision = computeAgentRevision(params.repoRoot, agentId);
    if (finalRevision !== intendedRevision) {
      throw new SkillUpdateEvidenceError(
        `Agent \`${agentId}\` is at revision ${finalRevision} after publication, not the intended ${intendedRevision}`,
      );
    }
    receipt.state = "published";
    await writeManifest(params.repoRoot, receipt);
    await params.onPersistenceBoundary?.("after_skill_target_published");
    return { publishedSkills, alreadyApplied: false, revision: finalRevision };
  });
}

/**
 * Every file the receipt claims to have published really holds those bytes.
 *
 * `intendedRevision` matching says the package digests to the number the
 * receipt names; it does not say the receipt describes this package. Each
 * named file is compared against its own recorded staged hash, and everything
 * the operation did not name against the digest recorded before publication,
 * so a receipt whose evidence was invented cannot report a finished update.
 */
function assertPublishedResultMatchesEvidence(
  manifest: SkillUpdateManifest,
  current: AgentRevisionFiles,
): void {
  for (const entry of manifest.skills) {
    const bytes = current.get(entry.filePath);
    if (!bytes || digestFileContents(bytes) !== entry.stagedHash) {
      throw new SkillUpdateEvidenceError(
        `Skill \`${entry.name}\` does not hold the bytes this update recorded publishing`,
      );
    }
  }
  const named = new Set(manifest.skills.map((entry) => entry.filePath));
  if (unnamedDigest(current, named) !== manifest.unnamedDigest) {
    throw new SkillUpdateEvidenceError(
      "The Agent no longer matches what this update recorded leaving alone",
    );
  }
}

/**
 * The Agent is either untouched, or holds only this operation's own writes.
 *
 * Two things have to be true, and neither implies the other. Every file this
 * operation names must hold either the bytes it staged — its own write, from
 * an attempt that stopped part-way — or exactly the content it was authorized
 * against; a file holding anything else was edited by someone, and this
 * operation has no claim on it. And substituting the staged bytes for all of
 * them must give the intended result, which is what proves the persona, the
 * other skills, and everything else under `skills/` are still byte-for-byte
 * what they were.
 *
 * The first check alone would miss an edit to an unrelated file. The second
 * alone would miss an edit to a file this operation published, because
 * substituting the staged bytes would overwrite the evidence of it.
 */
function assertRecognizedState(
  params: SkillUpdateParams,
  current: AgentRevisionFiles,
  currentRevision: string,
  manifest: SkillUpdateManifest | null,
): void {
  const expected = params.operation.expectedRevision;
  if (currentRevision === expected) return;
  const conflict = new AgentRevisionConflictError(
    params.operation.target.id,
    expected,
    currentRevision,
  );
  // Nothing was published without the intended revision being recorded first,
  // so a package that has moved without one has not moved because of this
  // operation.
  if (!manifest || manifest.intendedRevision === null || manifest.unnamedDigest === null) {
    throw conflict;
  }

  const named = new Set<string>();
  for (const entry of manifest.skills) {
    const bytes = current.get(entry.filePath);
    const digest = bytes ? digestFileContents(bytes) : null;
    if (digest !== entry.stagedHash && digest !== entry.priorHash) throw conflict;
    named.add(entry.filePath);
  }
  // Everything the evidence does not name has to be exactly what the proposal
  // was authorized against. That is what the expected revision says, so the
  // named files are removed from both sides and the remainder is compared.
  if (unnamedDigest(current, named) !== manifest.unnamedDigest) throw conflict;
}

/**
 * A digest of everything in the package the operation does not touch.
 *
 * The expected revision covers the whole package, including the files this
 * operation is about to replace, so it cannot answer "has anything else
 * changed?" once one of them has been written. This can: it is recorded
 * alongside the expected revision, before anything is published, and it moves
 * only when a file nobody named moves.
 */
function unnamedDigest(files: AgentRevisionFiles, named: ReadonlySet<string>): string {
  const remainder = new Map(files);
  for (const filePath of named) remainder.delete(filePath);
  return digestAgentRevisionFiles(remainder);
}

function emptyManifest(params: SkillUpdateParams): SkillUpdateManifest {
  return {
    version: 1,
    kind: "update_agent_skills",
    planId: params.planId,
    originJobId: params.jobId,
    operationIndex: params.operationIndex,
    target: { kind: "agent", id: params.operation.target.id },
    expectedRevision: params.operation.expectedRevision,
    operationDigest: digestResourceUpdateOperation(params.operation),
    unnamedDigest: null,
    intendedRevision: null,
    skills: [],
    publishedSkills: [],
    state: "staged",
  };
}

/**
 * Plan-scoped directory name that cannot escape the manifest root.
 *
 * Percent-encoding is not containment: `encodeURIComponent("..")` is `".."`,
 * which still resolves one directory upwards. A digest has no such characters.
 */
function planDirectoryName(planId: string): string {
  return createHash("sha256").update(planId, "utf8").digest("hex");
}

function operationRoot(params: SkillUpdateLocation): string {
  return path.join(
    params.repoRoot,
    ".create-orchestrator",
    "resource-updates",
    "skills",
    planDirectoryName(params.planId),
  );
}

function manifestPath(params: SkillUpdateLocation): string {
  return path.join(operationRoot(params), `${params.operationIndex}.json`);
}

function stagedDocumentPath(params: SkillUpdateLocation, skillName: string): string {
  // The name has already passed the containment rule, and it is re-derived
  // here from the same helper so staging cannot be reached by a path the
  // publication side would refuse.
  return path.join(
    operationRoot(params),
    `${params.operationIndex}-staged`,
    skillDocumentRelativePath(skillName),
  );
}

/**
 * Reads durable evidence for one operation.
 *
 * Absence is only a missing file. Anything present but unreadable, malformed,
 * or describing a different plan, operation, target, revision, or set of
 * skills is evidence this process does not understand, and it fails closed
 * rather than being overwritten.
 */
function readManifest(params: SkillUpdateLocation): SkillUpdateManifest | null {
  const file = manifestPath(params);
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw new SkillUpdateEvidenceError(
      `Could not read skill update evidence at ${file}: ${errorMessage(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new SkillUpdateEvidenceError(
      `Skill update evidence at ${file} is not valid JSON: ${errorMessage(error)}`,
    );
  }
  const manifest = parseManifest(parsed);
  if (
    !manifest ||
    manifest.planId !== params.planId ||
    manifest.operationIndex !== params.operationIndex ||
    manifest.target.id !== params.operation.target.id ||
    manifest.expectedRevision !== params.operation.expectedRevision ||
    manifest.operationDigest !== digestResourceUpdateOperation(params.operation) ||
    !describesSameSkills(manifest.skills, params.operation.skillUpdates)
  ) {
    throw new SkillUpdateEvidenceError(
      `Skill update evidence at ${file} does not describe this operation`,
    );
  }
  assertManifestIsCoherent(file, manifest, params.operation.skillUpdates);
  return manifest;
}

/**
 * A receipt has to mean what its fields claim.
 *
 * `intendedRevision` is the field an attempt trusts to decide that the work is
 * finished, and on its own it is only a number that happens to match. A
 * receipt naming one must also record the complete operation it produced and
 * the state of everything it did not touch — otherwise a corrupted file
 * carrying the Agent's *current* revision would report an update that never
 * happened as already applied.
 */
function assertManifestIsCoherent(
  file: string,
  manifest: SkillUpdateManifest,
  requested: readonly ResourceSkillUpdate[],
): void {
  const refuse = (problem: string): never => {
    throw new SkillUpdateEvidenceError(
      `Skill update evidence at ${file} is not coherent: ${problem}`,
    );
  };
  const names = manifest.skills.map((entry) => entry.name);
  // Publication order follows plan order, so the published names must be a
  // prefix-preserving subsequence of the recorded skills, never a set of names
  // this operation does not own.
  let cursor = 0;
  for (const published of manifest.publishedSkills) {
    const index = names.indexOf(published, cursor);
    if (index < 0) refuse(`it reports publishing \`${published}\`, which it does not describe`);
    cursor = index + 1;
  }
  if (manifest.intendedRevision !== null) {
    if (manifest.skills.length !== requested.length) {
      refuse("it names an intended result without describing every requested skill");
    }
    if (manifest.unnamedDigest === null) {
      refuse("it names an intended result without recording what it left alone");
    }
  }
  if (manifest.state === "published") {
    if (manifest.intendedRevision === null) {
      refuse("it is marked published without an intended result");
    }
    if (manifest.publishedSkills.length !== manifest.skills.length) {
      refuse("it is marked published without having published every skill it describes");
    }
  }
}

/**
 * Whether the evidence names the same actions on the same skills, in order.
 *
 * An operation that staged nothing yet has recorded no skills, which is a
 * legitimate state: the manifest is written before the first document is
 * authored. Anything else has to match the plan exactly.
 */
function describesSameSkills(
  recorded: readonly SkillManifestEntry[],
  requested: readonly ResourceSkillUpdate[],
): boolean {
  if (recorded.length === 0) return true;
  if (recorded.length > requested.length) return false;
  return recorded.every((entry, index) => {
    const update = requested[index];
    return (
      update !== undefined && entry.name === update.name && entry.action === update.action
    );
  });
}

const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function parseManifest(value: unknown): SkillUpdateManifest | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (value.kind !== "update_agent_skills") return null;
  if (typeof value.planId !== "string" || value.planId.length === 0) return null;
  if (typeof value.originJobId !== "string" || value.originJobId.length === 0) return null;
  const operationIndex = value.operationIndex;
  if (
    typeof operationIndex !== "number" ||
    !Number.isSafeInteger(operationIndex) ||
    operationIndex < 0
  ) {
    return null;
  }
  const target = value.target;
  if (!isRecord(target) || target.kind !== "agent") return null;
  if (typeof target.id !== "string" || target.id.length === 0) return null;
  if (typeof value.expectedRevision !== "string" || !DIGEST_PATTERN.test(value.expectedRevision)) {
    return null;
  }
  if (typeof value.operationDigest !== "string" || !DIGEST_PATTERN.test(value.operationDigest)) {
    return null;
  }
  const unnamedDigest = value.unnamedDigest;
  if (
    unnamedDigest !== null &&
    (typeof unnamedDigest !== "string" || !DIGEST_PATTERN.test(unnamedDigest))
  ) {
    return null;
  }
  const intendedRevision = value.intendedRevision;
  if (
    intendedRevision !== null &&
    (typeof intendedRevision !== "string" || !DIGEST_PATTERN.test(intendedRevision))
  ) {
    return null;
  }
  const skills = parseSkillEntries(value.skills);
  if (!skills) return null;
  const publishedSkills = parseStringArray(value.publishedSkills);
  if (!publishedSkills) return null;
  if (new Set(publishedSkills).size !== publishedSkills.length) return null;
  const state = value.state;
  if (state !== "staged" && state !== "published") return null;
  return {
    version: 1,
    kind: "update_agent_skills",
    planId: value.planId,
    originJobId: value.originJobId,
    operationIndex,
    target: { kind: "agent", id: target.id },
    expectedRevision: value.expectedRevision,
    operationDigest: value.operationDigest,
    unnamedDigest,
    intendedRevision,
    skills,
    publishedSkills,
    state,
  };
}

function parseSkillEntries(value: unknown): SkillManifestEntry[] | null {
  if (!Array.isArray(value)) return null;
  const entries: SkillManifestEntry[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const action = candidate.action;
    if (action !== "create" && action !== "update") return null;
    const name = candidate.name;
    if (typeof name !== "string" || name.length === 0) return null;
    const filePath = candidate.filePath;
    if (typeof filePath !== "string" || filePath !== safeDocumentPath(name)) return null;
    const priorHash = candidate.priorHash;
    if (
      priorHash !== null &&
      (typeof priorHash !== "string" || !DIGEST_PATTERN.test(priorHash))
    ) {
      return null;
    }
    const stagedHash = candidate.stagedHash;
    if (typeof stagedHash !== "string" || !DIGEST_PATTERN.test(stagedHash)) return null;
    entries.push({ action, name, filePath, priorHash, stagedHash });
  }
  return entries;
}

/** The one path a skill of this name may own, or `null` for an unusable name. */
function safeDocumentPath(skillName: string): string | null {
  try {
    return skillDocumentRelativePath(skillName);
  } catch {
    return null;
  }
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const entries: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") return null;
    entries.push(entry);
  }
  return entries;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeManifest(
  repoRoot: string,
  manifest: SkillUpdateManifest,
): Promise<void> {
  await writeFileAtomic(
    path.join(
      repoRoot,
      ".create-orchestrator",
      "resource-updates",
      "skills",
      planDirectoryName(manifest.planId),
      `${manifest.operationIndex}.json`,
    ),
    `${JSON.stringify(manifest)}\n`,
  );
}

function isMissingFileError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "ENOENT";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Skill update cancelled");
  error.name = "AbortError";
  throw error;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error === undefined || error === null) {
    return "the skill update failed without reporting a reason";
  }
  return String(error);
}
