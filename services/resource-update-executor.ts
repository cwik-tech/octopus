import type { DocumentSource } from '../contracts/document-reference.js';
import { publishResourceMutation, type ResourceAgentPublication, type ResourceAgentPublisher } from '../contracts/resource-publication.js';
/**
 * Durable executor for `resource_updates` plans.
 *
 * Separate from the creation executor on purpose. `runTeamResourceBuild` owns a
 * Team shell it created: it may rename that Team, transfer draft files into it,
 * and delete it after a failed transfer. None of that is legitimate against a
 * Team the user already owns, so an update never enters that path.
 *
 * Each operation owns a transaction manifest under the plan. The manifest
 * records the target, the revision the proposal pinned, the names being added,
 * and — before a single byte reaches the target — the revision the pending
 * write will produce. That last field is what lets a process which exits
 * mid-write recognize its own result on the next attempt instead of reporting a
 * conflict against itself.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { whenDefined } from "../core/optional-properties.js";
import type {
  CreateResourceRef,
  ResourceBuildEventType,
  ResourceBuildItem,
  ResourceBuildJobSnapshot,
  ResourceSkillUpdateEventType,
} from "../contracts/resource-architect.js";
import { isPublishedResourceBuildItemStatus } from "../contracts/resource-architect.js";
import {
  addTeamBuilderAgents,
  readTeamBuilderTeam,
  TeamRevisionConflictError,
} from "../domains/agent-generator/index.js";
import {
  agentPackageMatchesHashes,
  computeAgentPackageHashes,
  type AgentPackageHashes,
} from "../domains/agent-generator/agent-package-digest.js";
import {
  buildPlannedAgents,
  type PlannedAgentBatchResult,
  type PlannedAgentGenerationGate,
} from "../domains/agent-generator/planned-agent-builder.js";
import {
  discardStagedPlannedAgent,
  publishStagedPlannedAgent,
  type StagedPlannedAgent,
} from "../domains/agent-generator/planned-agent-persistence.js";
import {
  releaseFulfilledPlannedAgentReservation,
  releasePlannedAgentReservation,
} from "../domains/agent-generator/agent-name-reservation.js";
import { computeTeamRevision } from "../domains/resource-architect/resource-revision.js";
import {
  toAuthoredTeamNewAgentPlan,
  type PersistedResourceUpdateOperation,
  type PersistedResourceUpdatePlan,
} from "../contracts/resource-architect-persisted.js";
import { digestResourceUpdateOperation } from "../domains/resource-architect/resource-update-operation-digest.js";
import { renderResourceArchitectPlannedAgentBrief } from "../domains/resource-architect/planned-agent-brief.js";
import { writeFileAtomic } from "../core/file-mutation.js";
import { createResourceUpdateGate } from "./resource-update-gate.js";
import {
  AgentRevisionConflictError,
  applyAgentSkillUpdate,
  readRecordedSkillProgress,
  SkillUpdateEvidenceError,
  type SkillUpdatePersistenceBoundary,
  type SkillUpdateProgress,
} from "./skill-update-operation.js";

/** Durable boundaries a test or operator hook can observe. */
export type ResourceUpdatePersistenceBoundary =
  | "after_update_manifest_staged"
  | "after_update_agents_staged"
  /** One Agent package has just reached `agents/`, nothing verified yet. */
  | "after_update_agent_published"
  | "after_update_intended_revision_recorded"
  /** The Team write returned and its lock is released. */
  | "after_update_team_written"
  | "after_update_target_published"
  // A skill update publishes files rather than packages, so it reports its own
  // durable points. They are part of one union because one job can carry both
  // kinds of operation and one observer watches all of it.
  | SkillUpdatePersistenceBoundary;

/**
 * How an operation ended, which decides what it gives back.
 *
 * `retryable` keeps every package a retry of the same plan could still finish;
 * `conflicted` gives everything back because that plan can never succeed; and
 * `finished` gives back the names whose work is over.
 */
type OperationDisposition = "finished" | "conflicted" | "retryable";

export type ResourceUpdatePersistenceObserver = (
  boundary: ResourceUpdatePersistenceBoundary,
) => void | Promise<void>;

interface ResourceUpdateManifest {
  version: 1;
  planId: string;
  operationIndex: number;
  target: CreateResourceRef;
  expectedRevision: string;
  /**
   * Identity of the complete operation this receipt was written for.
   *
   * The names being added are not enough: two proposals can add the same names
   * to the same Team at the same revision while describing different Agents,
   * and a package staged for one brief is not the package the other asked for.
   */
  operationDigest: string;
  /** Revision the pending write will produce, recorded before the write. */
  intendedRevision: string | null;
  agentsToAdd: string[];
  /** Agent name to the content hashes of the package staged for it. */
  stagedPackages: Record<string, AgentPackageHashes>;
  /**
   * Names whose package this operation moved into `agents/`, in publication
   * order.
   *
   * Publication is one rename per package, so an attempt can end with some
   * packages public and the rest still private. Without a per-package record a
   * retry could not tell which of its own packages already landed.
   */
  publishedPackages: string[];
  state: "staged" | "published";
}

interface ResourceUpdateJobPort {
  saveJob(job: ResourceBuildJobSnapshot): Promise<void>;
}

/**
 * Whether something failed, kept apart from what the failure was.
 *
 * A promise can reject with any value, `undefined` and `null` among them. A
 * plain `unknown` cannot say whether it is carrying such a reason or carrying
 * nothing, so the two facts are recorded separately.
 */
type JournalFailure = { failed: true; reason: unknown } | { failed: false };

/**
 * Keeps the first failure of any kind, in the order the failures arrive.
 *
 * A job can fail in two ways at once: a save the generation observers swallow,
 * which nothing else will ever report, and an operation that rejects outright.
 * Preferring either kind over the other would sometimes answer with a
 * consequence instead of its cause, so both record here when they happen and
 * the earliest one is what the job answers for.
 */
function createFailureLedger(): {
  record: (reason: unknown) => void;
  first: () => JournalFailure;
} {
  let first: JournalFailure = { failed: false };
  return {
    record: (reason: unknown): void => {
      if (!first.failed) first = { failed: true, reason };
    },
    first: () => first,
  };
}

/**
 * Serializes every job mutation and its persistence, in event order.
 *
 * Operations run concurrently against one snapshot and one store. Without a
 * queue, two saves can finish out of order and an older snapshot can land last,
 * erasing the events a newer one had already recorded.
 */
function createJobJournal(
  job: ResourceBuildJobSnapshot,
  store: ResourceUpdateJobPort,
  /** Told about every failure this journal swallows, as it happens. */
  reportFailure: (reason: unknown) => void,
): {
  record: (mutate: () => void) => Promise<void>;
  firstFailure: () => JournalFailure;
} {
  let tail: Promise<void> = Promise.resolve();
  // Generation observers deliberately swallow reporting errors so one failed
  // notification cannot abort a batch. A job that could not be persisted is a
  // different matter, so the first such failure is kept and answered for.
  let firstFailure: JournalFailure = { failed: false };
  return {
    record: (mutate: () => void): Promise<void> => {
      const next = tail.then(async () => {
        mutate();
        await store.saveJob(job);
      });
      tail = next.catch((error: unknown) => {
        // Guarded on whether anything failed before, never on the value: a
        // first rejection carrying no reason would otherwise be replaced by
        // whichever failure happened to follow it.
        if (!firstFailure.failed) firstFailure = { failed: true, reason: error };
        reportFailure(error);
      });
      return next;
    },
    firstFailure: () => firstFailure,
  };
}

export async function runResourceUpdateBuild(params: {
  resourcePublisher?: ResourceAgentPublisher;
  repoRoot: string;
  plan: PersistedResourceUpdatePlan;
  job: ResourceBuildJobSnapshot;
  store: ResourceUpdateJobPort;
  maxConcurrency: number;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  referenceContext?: string;
  referenceDocuments?: readonly DocumentSource[];
  documentReviewCacheDir?: string;
  generationGate?: PlannedAgentGenerationGate;
  onPersistenceBoundary?: ResourceUpdatePersistenceObserver;
}): Promise<void> {
  // Both waits are cancellable: a withdrawn job must not sit behind capacity
  // another operation is holding.
  const operationGate = createResourceUpdateGate(
    Math.max(1, Math.min(params.maxConcurrency, params.plan.operations.length)),
  );
  // One budget for every generation in this job. Each batch would otherwise
  // build its own semaphore and multiply the configured cap by the number of
  // operations running at once.
  const generationGate: PlannedAgentGenerationGate = params.generationGate ??
    createResourceUpdateGate(Math.max(1, params.maxConcurrency));
  const ledger = createFailureLedger();
  const journal = createJobJournal(params.job, params.store, ledger.record);
  const record = journal.record;
  // Checked as soon as generation returns, not only at the end: a swallowed
  // save failure must stop the operation before anything is published.
  const assertJournalHealthy = (): void => {
    const failure = journal.firstFailure();
    if (failure.failed) throw failure.reason;
  };
  // What earlier attempts of this plan left in the receipts, shown from the
  // job's first save rather than when each operation's turn comes: one can
  // wait behind the others or stop before it authors anything. Saved only
  // when there is something to show. A failed save stays in the journal, and
  // the job answers for it.
  const knownEvents = params.job.events.length;
  reconcileSkillUpdateEvents(params.repoRoot, params.plan, params.job);
  if (params.job.events.length > knownEvents) {
    await record(() => undefined).catch(() => undefined);
  }
  await Promise.allSettled(
    params.plan.operations.map(async (operation, planIndex) => {
      const context = {
        ...params,
        journal: record,
        assertJournalHealthy,
        generationGate,
      };
      try {
        let admitted = false;
        try {
          await operationGate.acquire(params.signal);
          admitted = true;
          await applyOperation(context, operation, planIndex);
        } catch (error) {
          // A withdrawn operation never entered `applyOperation`, so it has to
          // report itself here rather than vanish into the settled results.
          if (admitted) throw error;
          await reportWithdrawnOperation(context, operation, planIndex, error);
        } finally {
          if (admitted) operationGate.release();
        }
      } catch (error) {
        // Recorded where it is observed. A failure the journal swallowed
        // earlier stays the one the job answers for, and this one is answered
        // for when nothing preceded it.
        ledger.record(error);
        throw error;
      }
    }),
  );
  // Read from the ledger, not from the settled results: a rejection is
  // recognized by the fact that it happened, never by the value it carried, so
  // one carrying `null` or nothing is not mistaken for no rejection at all.
  const unexpected = ledger.first();
  if (unexpected.failed) {
    // An executor failure is not an operation result. Reporting the job as
    // ordinarily finished would hide it.
    failJob(params.job, errorMessage(unexpected.reason));
    await params.store.saveJob(params.job).catch(() => undefined);
    throw unexpected.reason;
  }
  await record(() => finishJob(params.job, params.signal));
}

type ResourceUpdateContext = Parameters<typeof runResourceUpdateBuild>[0] & {
  journal: (mutate: () => void) => Promise<void>;
  /** Throws the first job-persistence failure the journal swallowed. */
  assertJournalHealthy: () => void;
  generationGate: PlannedAgentGenerationGate;
};

async function reportWithdrawnOperation(
  params: ResourceUpdateContext,
  operation: PersistedResourceUpdateOperation,
  planIndex: number,
  error: unknown,
): Promise<void> {
  const cancelled = params.signal?.aborted || isAbortLike(error);
  await setItem(params, planIndex, {
    status: cancelled ? "cancelled" : "failed",
    error: errorMessage(error),
  });
  await pushEvent(
    params,
    cancelled ? "resource_update_cancelled" : "resource_update_failed",
    cancelled
      ? `Cancelled the update of \`${operation.target.id}\`.`
      : `Could not update \`${operation.target.id}\`: ${errorMessage(error)}`,
    planIndex,
  );
}

async function applyOperation(
  params: ResourceUpdateContext,
  operation: PersistedResourceUpdateOperation,
  planIndex: number,
): Promise<void> {
  const target = operation.target;
  const staged: StagedPlannedAgent[] = [];
  let disposition: OperationDisposition = "retryable";
  await setItem(params, planIndex, { status: "generating" });
  await pushEvent(
    params,
    "resource_update_started",
    `Updating ${describeTargetKind(target)} \`${target.id}\`.`,
    planIndex,
  );

  try {
    throwIfAborted(params.signal);
    if (operation.kind === "update_agent_skills") {
      await applySkillOperation(params, operation, planIndex);
      disposition = "finished";
      return;
    }

    const authorizedNames = [
      ...operation.libraryAgentsToAdd.map((agent) => agent.name),
      ...operation.newAgentsToCreate.map((agent) => agent.name),
    ];
    const operationDigest = digestResourceUpdateOperation(operation);
    const manifest = readManifest(
      params.repoRoot,
      params.plan.id,
      planIndex,
      target,
      operation.expectedRevision,
      operationDigest,
      authorizedNames,
    );
    const newAgentNames = operation.newAgentsToCreate.map((agent) => agent.name);
    // Packages an earlier attempt of this operation already moved into
    // `agents/`. Established before anything else is decided, so the retry
    // neither regenerates them nor publishes them a second time.
    const recovered = await findRecoveredPackages(
      params.repoRoot,
      manifest,
      newAgentNames,
    );
    // Recognizing the package settles the reservation that produced it: the
    // ownership marker in its final folder is now what keeps the name, so a
    // receipt an earlier job of this plan left behind has nothing left to do.
    for (const agentName of recovered) {
      await releaseFulfilledPlannedAgentReservation({
        repoRoot: params.repoRoot,
        planId: params.plan.id,
        name: agentName,
      });
    }
    const currentRevision = computeTeamRevision(params.repoRoot, target.id);
    if (manifest?.intendedRevision === currentRevision) {
      // This process, or an earlier attempt of it, already produced exactly
      // this content. Rewriting it would be a second write of the same bytes.
      // Matching Team bytes only say the roster is right; the packages those
      // entries point at have to still be the packages this operation wrote.
      await assertRecordedPackagesIntact(params.repoRoot, manifest, newAgentNames);
      await completeOperation(params, planIndex, target, manifest.agentsToAdd, true);
      disposition = "finished";
      return;
    }
    if (currentRevision !== operation.expectedRevision) {
      throw new TeamRevisionConflictError(
        target.id,
        operation.expectedRevision,
        currentRevision,
      );
    }

    const names = authorizedNames;
    // The evidence an earlier attempt recorded is carried forward, never reset.
    // Its hashes are the only thing that can identify a package this operation
    // already published, so discarding them would strand that package.
    const receipt: ResourceUpdateManifest = {
      version: 1,
      planId: params.plan.id,
      operationIndex: planIndex,
      target,
      expectedRevision: operation.expectedRevision,
      operationDigest,
      intendedRevision: manifest?.intendedRevision ?? null,
      agentsToAdd: names,
      stagedPackages: { ...(manifest?.stagedPackages ?? {}) },
      // Normalized from what is actually on disk, in plan order. A package
      // whose rename landed before the record could be written is public
      // whether or not the previous receipt names it, and the retry's own
      // receipt has to say so or it would end up naming only the packages this
      // attempt happened to publish.
      publishedPackages: [...recovered],
      state: "staged",
    };
    await writeManifest(params.repoRoot, receipt);
    await params.onPersistenceBoundary?.("after_update_manifest_staged");

    await stageNewAgents(params, operation, planIndex, staged, recovered);
    // Generation observers swallow reporting errors, so a job that could not be
    // persisted is only visible here. Nothing has been published yet.
    params.assertJournalHealthy();
    receipt.stagedPackages = await describeStagedPackages(
      params.repoRoot,
      staged,
      manifest,
      newAgentNames,
    );
    await writeManifest(params.repoRoot, receipt);
    await params.onPersistenceBoundary?.("after_update_agents_staged");
    throwIfAborted(params.signal);

    let writtenRevision: string | null = null;
    let publishedAgents: readonly string[] = [];
    const roles = new Map(
      [...operation.libraryAgentsToAdd, ...operation.newAgentsToCreate].map(
        (agent) => [agent.name, { role: agent.role }],
      ),
    );
    await publishResourceMutation(params.resourcePublisher, async (owned) => addTeamBuilderAgents({
      repoRoot: params.repoRoot,
      teamId: target.id,
      expectedRevision: operation.expectedRevision,
      agents: names.map((name) => ({
        name,
        ...whenDefined(roles.get(name)?.role, (role) => ({ role })),
        // A package this operation staged is not in `agents/` yet, so its
        // persona is read from staging while the entry still names the final
        // library path.
        ...whenDefined(stagedPersonaPathFor(staged, name), (stagedPersonaPath) => ({
          stagedPersonaPath,
        })),
      })),
      // Only now, with the revision confirmed under the write lock, may a
      // package reach `agents/`.
      onRevisionVerified: async () => {
        publishedAgents = await publishStagedPackages(params, staged, receipt, owned);
      },
      onIntendedRevision: async (intendedRevision) => {
        // The only revision this operation may claim is the one calculated
        // from the exact bytes it wrote, while the lock was still held.
        writtenRevision = intendedRevision;
        receipt.intendedRevision = intendedRevision;
        await writeManifest(params.repoRoot, receipt);
        await params.onPersistenceBoundary?.(
          "after_update_intended_revision_recorded",
        );
      },
    }));

    await params.onPersistenceBoundary?.("after_update_team_written");
    if (writtenRevision === null) {
      throw new Error(
        `Team \`${target.id}\` was written without reporting the revision it produced`,
      );
    }
    // Recomputing the revision here would read whatever another writer left
    // behind after the lock was released, and record that as this operation's
    // result.
    receipt.intendedRevision = writtenRevision;
    receipt.state = "published";
    await writeManifest(params.repoRoot, receipt);
    await params.onPersistenceBoundary?.("after_update_target_published");

    // Reported only now: the Team write these packages belong to has landed
    // and the receipt that describes it is durable. A package this operation
    // published on an earlier attempt is still its own work, so it is reported
    // as this update's creation rather than as a library Agent someone else
    // already owned.
    const publishedNow = new Set(publishedAgents);
    for (const agentName of newAgentNames) {
      if (publishedNow.has(agentName)) {
        await pushEvent(
          params,
          "agent_created",
          `Created Agent \`${agentName}\`.`,
          planIndex,
          { kind: "agent", id: agentName },
        );
        continue;
      }
      if (!recovered.includes(agentName)) continue;
      await pushEvent(
        params,
        "agent_created",
        `Created Agent \`${agentName}\` in an earlier attempt of this update.`,
        planIndex,
        { kind: "agent", id: agentName },
      );
    }
    await completeOperation(params, planIndex, target, names, false);
    disposition = "finished";
  } catch (error) {
    if (
      error instanceof ResourceUpdateEvidenceError ||
      error instanceof SkillUpdateEvidenceError
    ) {
      throw error;
    }
    const cancelled = params.signal?.aborted || isAbortLike(error);
    const conflict = error instanceof TeamRevisionConflictError ||
      error instanceof AgentRevisionConflictError;
    // Both kinds end this plan: a conflict because the revision it pinned is
    // gone, and a needs-input because the plan carries a value it cannot use.
    // Either way the operation gives everything back rather than reserving
    // names the replacement proposal will need.
    const unfixable = conflict || error instanceof ResourceUpdateNeedsFreshProposalError;
    disposition = unfixable ? "conflicted" : "retryable";
    await setItem(params, planIndex, {
      status: cancelled ? "cancelled" : "failed",
      error: errorMessage(error),
    });
    await pushEvent(
      params,
      cancelled
        ? "resource_update_cancelled"
        : conflict
          ? "resource_update_conflict"
          : "resource_update_failed",
      cancelled
        ? `Cancelled the update of \`${target.id}\`.`
        : `Could not update \`${target.id}\`: ${errorMessage(error)}`,
      planIndex,
    );
  } finally {
    // A revision conflict cannot succeed by retrying the same proposal, so
    // this operation gives back everything it owned rather than leaving it to
    // block the fresh proposal the user has to make. A recoverable
    // interruption keeps its staged work.
    await releaseOperationOwnedWork(params, staged, disposition, planIndex);
  }
}

/**
 * Publishes one Agent's skill changes.
 *
 * The durable work lives in `skill-update-operation.ts`; what happens here is
 * the reporting. The item and the events say what actually changed: which
 * skills were written, or that the Agent already carried the update, so a
 * retry of a finished operation does not claim to have done it again.
 */
async function applySkillOperation(
  params: ResourceUpdateContext,
  operation: Extract<PersistedResourceUpdateOperation, { kind: "update_agent_skills" }>,
  planIndex: number,
): Promise<void> {
  const target = operation.target;
  const result = await applyAgentSkillUpdate({
    ...whenDefined(params.resourcePublisher, (resourcePublisher) => ({ resourcePublisher })),
    repoRoot: params.repoRoot,
    planId: params.plan.id,
    jobId: params.job.jobId,
    operationIndex: planIndex,
    operation,
    generationGate: params.generationGate,
    ...whenDefined(params.provider, (provider) => ({ provider })),
    ...whenDefined(params.model, (model) => ({ model })),
    ...whenDefined(params.signal, (signal) => ({ signal })),
    ...whenDefined(
      params.onPersistenceBoundary,
      (observer) => ({ onPersistenceBoundary: observer }),
    ),
    onSkillProgress: (progress) => pushSkillEvent(params, planIndex, target, progress),
  });
  // Checked once the provider work is over and before anything is reported: a
  // job that could not be persisted must not be answered for as a success.
  params.assertJournalHealthy();
  await setItem(params, planIndex, { status: "updated", resource: target });
  await pushEvent(
    params,
    "resource_update_applied",
    result.alreadyApplied
      ? `Agent \`${target.id}\` already carries this skill update.`
      : `Updated ${describeSkillCount(result.publishedSkills.length)} on Agent \`${target.id}\`: ${
        result.publishedSkills.join(", ")
      }.`,
    planIndex,
    target,
  );
}

function describeSkillCount(count: number): string {
  return count === 1 ? "1 skill" : `${count} skills`;
}

const SKILL_PROGRESS_EVENT_TYPES = {
  generating: "skill_generating",
  staged: "skill_staged",
  updated: "skill_updated",
  failed: "skill_failed",
  cancelled: "skill_cancelled",
} as const satisfies Record<SkillUpdateProgress["status"], ResourceSkillUpdateEventType>;

/**
 * Records one skill's progress against this operation's card.
 *
 * The event names the skill and its proposed action, so the card can resolve
 * each row by plan index and skill name without reading prose.
 */
async function pushSkillEvent(
  params: ResourceUpdateContext,
  planIndex: number,
  target: CreateResourceRef,
  progress: SkillUpdateProgress,
): Promise<void> {
  const type = SKILL_PROGRESS_EVENT_TYPES[progress.status];
  await params.journal(() => {
    // The job may already say so: its first save reports what the receipt
    // proves, and the operation reports the same when it reaches that skill.
    if (latestSkillEventType(params.job, planIndex, progress.skill.name) === type) return;
    params.job.events.push({
      id: params.job.events.length + 1,
      type,
      plannedResource: params.job.items[planIndex]?.plannedResource ?? target,
      planIndex,
      skill: progress.skill,
      message: describeSkillProgress(progress, target),
    });
  });
}

/**
 * Adds the skill progress a job file is missing but the receipts prove.
 *
 * A receipt entry is written before the event that reports it, so a process
 * that exits between the two leaves a staged or published skill the job never
 * heard about. The receipt is the evidence, and only its hash-checked entries
 * count; a receipt this process cannot read leaves that operation's events as
 * they are.
 */
export function reconcileSkillUpdateEvents(
  repoRoot: string,
  plan: PersistedResourceUpdatePlan,
  job: ResourceBuildJobSnapshot,
): void {
  plan.operations.forEach((operation, planIndex) => {
    if (operation.kind !== "update_agent_skills") return;
    let recorded: SkillUpdateProgress[];
    try {
      recorded = readRecordedSkillProgress({
        repoRoot,
        planId: plan.id,
        operationIndex: planIndex,
        operation,
      });
    } catch {
      return;
    }
    for (const progress of recorded) {
      const latest = latestSkillEventType(job, planIndex, progress.skill.name);
      const alreadyKnown = latest === "skill_updated" ||
        (progress.status === "staged" && latest === "skill_staged");
      if (alreadyKnown) continue;
      job.events.push({
        id: job.events.length + 1,
        type: SKILL_PROGRESS_EVENT_TYPES[progress.status],
        plannedResource: job.items[planIndex]?.plannedResource ?? operation.target,
        planIndex,
        skill: progress.skill,
        message: describeSkillProgress(progress, operation.target),
      });
    }
  });
}

/** The type of the latest event about one skill of one operation, if any. */
function latestSkillEventType(
  job: ResourceBuildJobSnapshot,
  planIndex: number,
  skillName: string,
): ResourceBuildEventType | undefined {
  return [...job.events].reverse().find((event) =>
    event.planIndex === planIndex && event.skill?.name === skillName
  )?.type;
}

function describeSkillProgress(
  progress: SkillUpdateProgress,
  target: CreateResourceRef,
): string {
  const name = progress.skill.name;
  switch (progress.status) {
    case "generating":
      return `Authoring skill \`${name}\`.`;
    case "staged":
      return `Staged skill \`${name}\`; Agent \`${target.id}\` is unchanged until the update is published.`;
    case "updated":
      return `Updated skill \`${name}\` on Agent \`${target.id}\`.`;
    case "failed":
      return `Could not author skill \`${name}\`: ${progress.error ?? "the skill author failed without a reason"}`;
    case "cancelled":
      return `Cancelled skill \`${name}\`.`;
  }
}

/**
 * Every package this operation recorded is still exactly what it recorded.
 *
 * Team YAML matching the intended revision proves the roster entries are
 * there, not that the Agent packages they name still hold the bytes this
 * operation published.
 */
async function assertRecordedPackagesIntact(
  repoRoot: string,
  manifest: ResourceUpdateManifest,
  expectedNames: readonly string[],
): Promise<void> {
  // An empty or partial hash map would otherwise pass vacuously, letting a
  // matching Team revision confirm an Agent whose package is gone.
  const recorded = Object.keys(manifest.stagedPackages).sort();
  const expected = [...expectedNames].sort();
  if (
    recorded.length !== expected.length ||
    recorded.some((name, index) => name !== expected[index])
  ) {
    throw new Error(
      `Update evidence describes packages [${recorded.join(", ")}] but this operation created [${expected.join(", ")}]`,
    );
  }
  for (const [agentName, hashes] of Object.entries(manifest.stagedPackages)) {
    const packagePath = path.join(repoRoot, "agents", agentName);
    if (!(await agentPackageMatchesHashes(packagePath, hashes))) {
      throw new Error(
        `Agent \`${agentName}\` no longer matches the package this update published`,
      );
    }
  }
}

/**
 * Content evidence for every package this operation owns.
 *
 * A retry restages only what is still private, so the packages it recovered
 * are not in `staged`. Their evidence is carried from the previous receipt and
 * re-verified against what is on disk, because dropping it would leave the
 * operation unable to recognize its own published output on the next attempt.
 */
async function describeStagedPackages(
  repoRoot: string,
  staged: readonly StagedPlannedAgent[],
  previous: ResourceUpdateManifest | null,
  requiredNames: readonly string[],
): Promise<Record<string, AgentPackageHashes>> {
  const packages: Record<string, AgentPackageHashes> = {};
  for (const entry of staged) {
    if (entry.stagedAgentPath) {
      packages[entry.agentName] = await computeAgentPackageHashes(entry.stagedAgentPath);
      continue;
    }
    packages[entry.agentName] = await carryPublishedEvidence(
      repoRoot,
      previous,
      entry.agentName,
    );
  }
  for (const agentName of requiredNames) {
    if (packages[agentName]) continue;
    packages[agentName] = await carryPublishedEvidence(repoRoot, previous, agentName);
  }
  return packages;
}

/** Evidence a previous attempt recorded, confirmed against the published package. */
async function carryPublishedEvidence(
  repoRoot: string,
  previous: ResourceUpdateManifest | null,
  agentName: string,
): Promise<AgentPackageHashes> {
  const recorded = previous?.stagedPackages?.[agentName];
  if (!recorded) {
    throw new Error(
      `Agent \`${agentName}\` is already published but this operation recorded no package evidence for it`,
    );
  }
  const publishedPath = path.join(repoRoot, "agents", agentName);
  if (!(await agentPackageMatchesHashes(publishedPath, recorded))) {
    throw new Error(
      `Published Agent \`${agentName}\` does not match the package this operation staged`,
    );
  }
  return recorded;
}

/**
 * Packages an earlier attempt of this operation already moved into `agents/`.
 *
 * The rename and the record that follows it cannot be one step, so a package
 * can be public before the receipt names it. Content decides: a package whose
 * bytes match the hashes this operation recorded — the ownership marker among
 * them — is the package this operation published, whether or not the receipt
 * got as far as saying so. A name the receipt does name must still be there and
 * still match, or the evidence and the filesystem disagree and nothing may
 * proceed on a guess.
 */
async function findRecoveredPackages(
  repoRoot: string,
  manifest: ResourceUpdateManifest | null,
  newAgentNames: readonly string[],
): Promise<string[]> {
  if (!manifest) return [];
  const recovered: string[] = [];
  for (const agentName of newAgentNames) {
    const claimed = manifest.publishedPackages.includes(agentName);
    const recorded = manifest.stagedPackages[agentName];
    if (!recorded) {
      if (claimed) {
        throw new Error(
          `Update evidence names \`${agentName}\` as published but records no package for it`,
        );
      }
      continue;
    }
    const publishedPath = path.join(repoRoot, "agents", agentName);
    if (!fs.existsSync(publishedPath)) {
      if (claimed) {
        throw new Error(
          `Agent \`${agentName}\` was published by this update but is no longer in agents/`,
        );
      }
      continue;
    }
    if (!(await agentPackageMatchesHashes(publishedPath, recorded))) {
      throw new Error(
        `Agent \`${agentName}\` no longer matches the package this update published`,
      );
    }
    recovered.push(agentName);
  }
  return recovered;
}

/**
 * Moves each staged package into `agents/`, verifying its bytes first.
 *
 * One rename per package, recorded one package at a time. There is no
 * filesystem transaction spanning two renames, so an attempt that stops here
 * leaves some packages public and the rest private, and the receipt has to say
 * which is which.
 */
async function publishStagedPackages(
  params: ResourceUpdateContext,
  staged: readonly StagedPlannedAgent[],
  receipt: ResourceUpdateManifest,
  publisher: ResourceAgentPublication | undefined,
): Promise<string[]> {
  // Publication reports nothing to the job. A success event persisted here
  // would be durable before the Team write that authorizes it, so a store
  // failure in between would leave a visible Agent and an unchanged Team.
  const published: string[] = [];
  for (const entry of staged) {
    if (entry.stagedAgentPath) {
      const expected = receipt.stagedPackages[entry.agentName];
      if (
        !expected ||
        !(await agentPackageMatchesHashes(entry.stagedAgentPath, expected))
      ) {
        throw new Error(
          `Staged Agent \`${entry.agentName}\` no longer matches its recorded package`,
        );
      }
    }
    const publish = () => publishStagedPlannedAgent(params.repoRoot, entry);
    const agentName = await (publisher?.publishAgent(entry.agentName, publish) ?? publish());
    // Written the moment the package is public, before it is verified: the
    // record must describe what is on disk even if the verification below
    // fails, because the rename cannot be taken back.
    if (!receipt.publishedPackages.includes(agentName)) {
      receipt.publishedPackages.push(agentName);
      await writeManifest(params.repoRoot, receipt);
    }
    await params.onPersistenceBoundary?.("after_update_agent_published");
    // Publication can resolve by accepting a final folder that already exists
    // with a matching marker and persona, and the bytes can change after the
    // rename. A marker says who owns the package, not that its content is what
    // this operation staged, so the final path is checked before the Team is
    // written against it. Missing evidence is a failure, never a pass.
    const publishedEvidence = receipt.stagedPackages[agentName];
    if (!publishedEvidence) {
      throw new Error(
        `Published Agent \`${agentName}\` has no recorded package evidence in this operation`,
      );
    }
    if (
      !(await agentPackageMatchesHashes(
        path.join(params.repoRoot, "agents", agentName),
        publishedEvidence,
      ))
    ) {
      throw new Error(
        `Published Agent \`${agentName}\` does not match the package this operation staged`,
      );
    }
    published.push(agentName);
  }
  return published;
}

/** The staged persona for `name`, when this operation staged one. */
function stagedPersonaPathFor(
  staged: readonly StagedPlannedAgent[],
  name: string,
): string | undefined {
  const entry = staged.find((candidate) => candidate.agentName === name)
  if (!entry?.stagedAgentPath) return undefined
  return path.join(entry.stagedAgentPath, `${name}.md`)
}

/**
 * Gives back what this operation owned, reporting any part it could not.
 *
 * Cleanup never masks the failure that caused it: the original outcome has
 * already been recorded on the item, and a cleanup problem is reported as its
 * own event so a leaked name is visible rather than silent.
 */
async function releaseOperationOwnedWork(
  params: ResourceUpdateContext,
  staged: readonly StagedPlannedAgent[],
  disposition: OperationDisposition,
  planIndex: number,
): Promise<void> {
  const discardStagedWork = disposition === "conflicted";
  const issues: string[] = [];
  for (const entry of staged) {
    // A package that is still private and still publishable is work a retry of
    // this same plan has to be able to take over. Handing its name back while
    // it sits in staging would let a different plan claim that exact name and
    // open a second transaction for it. A package that already reached
    // `agents/` needs no receipt: its ownership marker is what makes the name
    // unavailable to anyone else.
    if (
      disposition === "retryable" &&
      entry.transactionRoot &&
      fs.existsSync(entry.transactionRoot)
    ) {
      continue;
    }
    // The staged evidence is settled first. Releasing the name while unknown
    // ready evidence is still on disk would hand that exact Agent name to a
    // fresh plan while the old package remains, so a name is only given back
    // once nothing this operation owns is left behind.
    let mayReleaseName = true;
    if (discardStagedWork && entry.transactionRoot) {
      try {
        const discarded = await discardStagedPlannedAgent({
          repoRoot: params.repoRoot,
          orchestratorKey: params.plan.id,
          requestedName: entry.agentName,
          transactionRoot: entry.transactionRoot,
        });
        if (!discarded) {
          // Preserved because its evidence did not match. The name stays
          // reserved with it, so nothing new can claim it until someone looks.
          mayReleaseName = false;
          issues.push(
            `staged package \`${entry.agentName}\` was preserved because its evidence did not match this operation, and its name stays reserved`,
          );
        }
      } catch (error) {
        mayReleaseName = false;
        issues.push(`staged package \`${entry.agentName}\`: ${errorMessage(error)}`);
      }
    }
    if (!mayReleaseName) continue;
    try {
      await releasePlannedAgentReservation({
        repoRoot: params.repoRoot,
        planId: params.plan.id,
        jobId: params.job.jobId,
        name: entry.agentName,
      });
    } catch (error) {
      issues.push(`name \`${entry.agentName}\`: ${errorMessage(error)}`);
    }
  }
  if (issues.length === 0) return;
  // Reported as its own event against this operation's own card. The item's
  // error still names the failure that caused the cleanup, which a leaked name
  // must not overwrite.
  await pushEvent(
    params,
    "resource_update_failed",
    `Could not release everything this update reserved: ${issues.join("; ")}`,
    planIndex,
  );
}

/**
 * Publishes the plan's new Agent packages.
 *
 * Reuses the planned-Agent staging and name reservations rather than inventing
 * a second ownership marker: a retry of the same plan republishes nothing and
 * reports the Agent as reused.
 */
async function stageNewAgents(
  params: ResourceUpdateContext,
  operation: Extract<PersistedResourceUpdateOperation, { kind: "add_team_agents" }>,
  planIndex: number,
  /** Filled before any failure is raised, so cleanup can still reach them. */
  staged: StagedPlannedAgent[],
  /** Packages an earlier attempt published; regenerating them is not staging. */
  recovered: readonly string[],
): Promise<PlannedAgentBatchResult> {
  for (const existing of operation.libraryAgentsToAdd) {
    await pushEvent(
      params,
      "agent_reused",
      `Reused Agent \`${existing.name}\`.`,
      planIndex,
      { kind: "agent", id: existing.name },
    );
  }
  // A package this operation already published is not a library Agent it is
  // reusing. Leaving it in the batch would report it that way and lose the
  // provenance the receipt is keeping.
  const outstanding = operation.newAgentsToCreate.filter(
    (agent) => !recovered.includes(agent.name),
  );
  if (outstanding.length === 0) {
    return { items: [], staged: [], cleanupIssues: [] };
  }


  const result = await buildPlannedAgents({
    repoRoot: params.repoRoot,
    planId: params.plan.id,
    jobId: params.job.jobId,
    // The digest above hashed the operation exactly as stored, legacy field
    // and all. Generation is the other side of that boundary: it writes new
    // files, so it is handed the authored view and never sees an old grade.
    agents: outstanding.map(toAuthoredTeamNewAgentPlan),
    maxConcurrency: Math.max(1, outstanding.length),
    generationGate: params.generationGate,
    publication: "stage",
    ...whenDefined(params.provider, (provider) => ({ provider })),
    ...whenDefined(params.model, (model) => ({ model })),
    ...whenDefined(params.signal, (signal) => ({ signal })),
    renderBrief: (agent) => renderResourceArchitectPlannedAgentBrief(undefined, agent),
    ...whenDefined(params.referenceContext, (referenceContext) => ({ referenceContext })),
    ...whenDefined(params.referenceDocuments, (referenceDocuments) => ({ referenceDocuments })),
    ...whenDefined(params.documentReviewCacheDir, (documentReviewCacheDir) => ({ documentReviewCacheDir })),
    onUpdate: (update) =>
      params.journal(() => {
        params.job.events.push({
          id: params.job.events.length + 1,
          type: update.eventType,
          plannedResource: update.item.plannedResource,
          ...whenDefined(update.item.resource, (resource) => ({ resource })),
          planIndex,
          message: update.message,
        });
      }),
  });

  // Recorded before any failure is raised: a package this operation staged is
  // its responsibility to give back even when the batch as a whole fails.
  staged.push(...result.staged);
  if (result.cleanupIssues.length > 0) {
    // A leaked name blocks a later proposal, so it cannot be swallowed. It is
    // raised separately from the resource outcomes it does not describe.
    throw new Error(
      `Agent name cleanup did not complete: ${result.cleanupIssues.join("; ")}`,
    );
  }

  // In staging mode a produced package leaves its item `generating`; anything
  // else is a failure.
  const unfinished = result.items.filter(
    (item) =>
      item.status !== "generating" && !isPublishedResourceBuildItemStatus(item.status),
  );
  if (unfinished.length > 0) {
    const description = unfinished
      .map((item) => `${item.plannedResource.id} (${item.status})`)
      .join(", ");
    // A name this plan cannot have, or a brief it has to change, is not
    // something a retry of this plan can fix — the plan is what carries the
    // value that does not work. Reported separately so the operation gives its
    // names back instead of holding them against the fresh proposal that has
    // to replace it.
    if (unfinished.some((item) => item.status === "needs_input")) {
      throw new ResourceUpdateNeedsFreshProposalError(
        `Ask for a fresh proposal: ${description} cannot be created from this plan.`,
      );
    }
    // One operation is one authorized write. Adding only the Agents that
    // happened to succeed would apply an update the user never reviewed.
    throw new Error(`Could not create every requested Agent: ${description}`);
  }
  return result;
}

async function completeOperation(
  params: ResourceUpdateContext,
  planIndex: number,
  target: CreateResourceRef,
  names: readonly string[],
  alreadyPublished: boolean,
): Promise<void> {
  const roster = new Set(
    readTeamBuilderTeam(params.repoRoot, target.id).agents.map((agent) => agent.name),
  );
  // Success means the Team carries every requested addition. Skipping the
  // names that are missing and reporting `updated` anyway would claim a
  // membership change that did not happen.
  const missing = names.filter((name) => !roster.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Team \`${target.id}\` is missing requested member(s): ${missing.join(", ")}`,
    );
  }
  for (const name of names) {
    await pushEvent(
      params,
      "agent_added",
      `Added \`${name}\` to \`${target.id}\`.`,
      planIndex,
      { kind: "agent", id: name },
    );
  }
  await setItem(params, planIndex, { status: "updated", resource: target });
  await pushEvent(
    params,
    "resource_update_applied",
    alreadyPublished
      ? `${describeTargetKind(target)} \`${target.id}\` already carries this update.`
      : `Updated ${describeTargetKind(target)} \`${target.id}\`.`,
    planIndex,
  );
  // The receipt is deliberately kept. A batch where one operation succeeded and
  // another failed is retried whole, and without the published receipt the
  // successful operation would run again and conflict against its own Team
  // write. Its `intendedRevision` and `stagedPackages` are the exact evidence
  // that recovery needs, so nothing about it is rewritten here.
}

function finishJob(
  job: ResourceBuildJobSnapshot,
  signal: AbortSignal | undefined,
): void {
  const published = job.items
    .filter((item) => isPublishedResourceBuildItemStatus(item.status))
    .sort((left, right) => left.planIndex - right.planIndex);
  job.selectedResource = published[0]?.resource ?? null;
  if (published.length === job.items.length) {
    job.status = "completed";
    pushJobEvent(job, "build_completed", "Applied every requested update.");
    return;
  }
  if (published.length > 0) {
    job.status = "partially_completed";
    pushJobEvent(job, "build_partially_completed", "Applied part of the update batch.");
    return;
  }
  if (signal?.aborted || job.items.every((item) => item.status === "cancelled")) {
    job.status = "cancelled";
    pushJobEvent(job, "build_cancelled", "Cancelled the update batch.");
    return;
  }
  failJob(job, job.items.find((item) => item.error)?.error ?? "No update was applied.");
}

function failJob(job: ResourceBuildJobSnapshot, message: string): void {
  job.status = "failed";
  job.error = message;
  pushJobEvent(job, "build_failed", message);
}

async function setItem(
  params: ResourceUpdateContext,
  planIndex: number,
  patch: Partial<ResourceBuildItem>,
): Promise<void> {
  await params.journal(() => {
    const item = params.job.items[planIndex];
    if (!item) return;
    const next: ResourceBuildItem = { ...item, ...patch };
    if (patch.error === undefined) delete next.error;
    params.job.items[planIndex] = next;
  });
}

async function pushEvent(
  params: ResourceUpdateContext,
  type: ResourceBuildEventType,
  message: string,
  planIndex: number,
  resource?: CreateResourceRef,
): Promise<void> {
  await params.journal(() => {
    const item = params.job.items[planIndex];
    params.job.events.push({
      id: params.job.events.length + 1,
      type,
      message,
      planIndex,
      ...(item ? { plannedResource: item.plannedResource } : {}),
      ...whenDefined(resource ?? item?.resource, (value) => ({ resource: value })),
    });
  });
}

function pushJobEvent(
  job: ResourceBuildJobSnapshot,
  type: ResourceBuildEventType,
  message: string,
): void {
  job.events.push({ id: job.events.length + 1, type, message });
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

function manifestPath(repoRoot: string, planId: string, index: number): string {
  return path.join(
    repoRoot,
    ".create-orchestrator",
    "resource-updates",
    planDirectoryName(planId),
    `${index}.json`,
  );
}

/**
 * Raised when this stored plan can never succeed, whatever it retries.
 *
 * A name the plan asks to create is already held by somebody else, or a brief
 * the model has to revise: either way the plan carries the value that cannot
 * work, so the operation gives everything back rather than holding names a
 * fresh proposal will need.
 */
export class ResourceUpdateNeedsFreshProposalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceUpdateNeedsFreshProposalError";
  }
}

/** Raised when durable evidence exists but does not describe this operation. */
export class ResourceUpdateEvidenceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceUpdateEvidenceError";
  }
}

/**
 * Reads durable evidence for one operation.
 *
 * Absence is only a missing file. Anything present but unreadable, malformed,
 * or describing a different plan, operation, or target is evidence this process
 * does not understand, and it fails closed rather than being overwritten.
 */
const REVISION_PATTERN = /^sha256:[0-9a-f]{64}$/u;

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function readManifest(
  repoRoot: string,
  planId: string,
  index: number,
  target: CreateResourceRef,
  expectedRevision: string,
  operationDigest: string,
  authorizedNames: readonly string[],
): ResourceUpdateManifest | null {
  const file = manifestPath(repoRoot, planId, index);
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) return null;
    throw new ResourceUpdateEvidenceError(
      `Could not read update evidence at ${file}: ${errorMessage(error)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ResourceUpdateEvidenceError(
      `Update evidence at ${file} is not valid JSON: ${errorMessage(error)}`,
    );
  }
  const manifest = parseManifest(parsed);
  // A receipt is only evidence for the operation it was written for. A
  // valid-looking receipt for the same target but a different revision or a
  // different set of names would otherwise authorize content nobody approved.
  if (
    !manifest ||
    manifest.planId !== planId ||
    manifest.operationIndex !== index ||
    manifest.target.kind !== target.kind ||
    manifest.target.id !== target.id ||
    manifest.expectedRevision !== expectedRevision ||
    manifest.operationDigest !== operationDigest ||
    !sameNames(manifest.agentsToAdd, authorizedNames)
  ) {
    throw new ResourceUpdateEvidenceError(
      `Update evidence at ${file} does not describe this operation`,
    );
  }
  return manifest;
}

function parseManifest(value: unknown): ResourceUpdateManifest | null {
  if (!isRecord(value)) return null;
  if (value.version !== 1) return null;
  if (typeof value.planId !== "string" || value.planId.length === 0) return null;
  const operationIndex = value.operationIndex;
  if (typeof operationIndex !== "number" || !Number.isSafeInteger(operationIndex)) {
    return null;
  }
  if (operationIndex < 0) return null;
  const target = parseResourceRef(value.target);
  if (!target) return null;
  if (
    typeof value.expectedRevision !== "string" ||
    !REVISION_PATTERN.test(value.expectedRevision)
  ) {
    return null;
  }
  if (
    typeof value.operationDigest !== "string" ||
    !REVISION_PATTERN.test(value.operationDigest)
  ) {
    return null;
  }
  const intendedRevision = value.intendedRevision;
  if (
    intendedRevision !== null &&
    (typeof intendedRevision !== "string" || !REVISION_PATTERN.test(intendedRevision))
  ) {
    return null;
  }
  const agentsToAdd = parseStringArray(value.agentsToAdd);
  if (!agentsToAdd) return null;
  const stagedPackages = parseStagedPackages(value.stagedPackages);
  if (!stagedPackages) return null;
  // Required, not defaulted, for the same reason as the hashes above: a
  // receipt that never recorded which packages went public cannot be read as
  // one that recorded none.
  const publishedPackages = parseStringArray(value.publishedPackages);
  if (!publishedPackages) return null;
  if (new Set(publishedPackages).size !== publishedPackages.length) return null;
  const state = value.state;
  if (state !== "staged" && state !== "published") return null;
  return {
    version: 1,
    planId: value.planId,
    operationIndex,
    target,
    expectedRevision: value.expectedRevision,
    operationDigest: value.operationDigest,
    intendedRevision,
    agentsToAdd,
    stagedPackages,
    publishedPackages,
    state,
  };
}

function parseResourceRef(value: unknown): CreateResourceRef | null {
  if (!isRecord(value)) return null;
  if (value.kind !== "agent" && value.kind !== "team") return null;
  if (typeof value.id !== "string" || value.id.length === 0) return null;
  return { kind: value.kind, id: value.id };
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

function parseStagedPackages(
  value: unknown,
): Record<string, AgentPackageHashes> | null {
  // Required, not defaulted: a receipt with no package evidence cannot be
  // read as a receipt that recorded none.
  if (!isRecord(value)) return null;
  const packages = createNullPrototypeRecord<AgentPackageHashes>();
  for (const [agentName, hashes] of Object.entries(value)) {
    if (!isRecord(hashes)) return null;
    // Prototype-safe for the same reason the producer is: a recorded
    // `__proto__` entry assigned onto an ordinary object is dropped, and
    // recovery would then compare against evidence missing a real file.
    const parsed = createNullPrototypeRecord<string>();
    for (const [filePath, digest] of Object.entries(hashes)) {
      if (typeof digest !== "string" || !REVISION_PATTERN.test(digest)) return null;
      parsed[filePath] = digest;
    }
    packages[agentName] = parsed;
  }
  return packages;
}

// Same object as Object.create(null), without its `any` result.
function createNullPrototypeRecord<T>(): Record<string, T> {
  const record: Record<string, T> = {};
  Object.setPrototypeOf(record, null);
  return record;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length && left.every((name, index) => name === right[index])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function writeManifest(
  repoRoot: string,
  manifest: ResourceUpdateManifest,
): Promise<void> {
  await writeFileAtomic(
    manifestPath(repoRoot, manifest.planId, manifest.operationIndex),
    `${JSON.stringify(manifest)}\n`,
  );
}


function describeTargetKind(target: CreateResourceRef): string {
  return target.kind === "team" ? "Team" : "Agent";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Resource update cancelled");
  error.name = "AbortError";
  throw error;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  // A rejection can carry nothing at all. `String(undefined)` would put the
  // word "undefined" in front of the user as the reason their update failed.
  if (error === undefined || error === null) {
    return "The resource update failed without reporting a reason";
  }
  return String(error);
}
