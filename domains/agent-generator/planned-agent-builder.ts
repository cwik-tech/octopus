import { applyPlannedWebResearch } from "./planned-agent-web-research.js";
import type { ResourceAgentPublisher } from "../../contracts/resource-publication.js";
import type { DocumentSource } from '../../contracts/document-reference.js';
import { whenDefined } from "../../core/optional-properties.js"
import type {
  GeneratedSkill,
  PlannedAgentGenerationInput,
} from "../../contracts/agent-generator.js";
import type {
  ResourceBuildEventType,
  ResourceBuildItem,
} from "../../contracts/resource-architect.js";
import { ConcurrencySemaphore } from "../../core/rate-limiter.js";
import {
  persistPlannedAgentDraft,
  stagePlannedAgentDraft,
  type PlannedAgentPersistenceObserver,
  type StagedPlannedAgent,
} from "./planned-agent-persistence.js";
import { runCreateAgent } from "./create-agent.js";
import {
  describeGeneratedSkillSources,
  repairGeneratedSkills,
} from "./skill-spec-repair.js";
import { findSkillBatchViolations } from "./skill-spec-validation.js";
import {
  releasePlannedAgentReservation,
  reservePlannedAgentName,
  validateExactAgentName,
  verifyPlannedAgentReservation,
} from "./agent-name-reservation.js";

export interface PlannedAgentBuildUpdate {
  item: ResourceBuildItem;
  eventType: ResourceBuildEventType;
  message: string;
}

export interface PlannedAgentBatchResult {
  items: ResourceBuildItem[];
  /**
   * Names this batch reserved and could not give back, in plan order.
   *
   * A leaked reservation makes the name unavailable to a later proposal, but
   * it says nothing about the resource itself, so it is reported beside the
   * items rather than written into one. Only the update executor acts on this
   * today; creation surfaces its own outcomes unchanged.
   */
  cleanupIssues: string[];
  /**
   * Packages produced but deliberately not published, in `stage` mode. The
   * caller publishes them once its own preconditions still hold.
   */
  staged: StagedPlannedAgent[];
}

/**
 * Whether a finished package reaches `agents/` immediately.
 *
 * `publish` is Agent and Team creation, which owns the name outright. `stage`
 * is an update, which must re-check the target it is joining before an Agent
 * folder exists at all.
 */
export type PlannedAgentPublication = "publish" | "stage";

/**
 * A concurrency budget shared across every provider generation in one job.
 *
 * Without it, a job that runs several batches gives each batch its own
 * semaphore, so the configured cap is multiplied by the number of batches.
 */
export interface PlannedAgentGenerationGate {
  /**
   * Waits for capacity. A gate that accepts a signal must reject a cancelled
   * waiter rather than leave it queued behind capacity someone else holds.
   */
  acquire(signal?: AbortSignal): Promise<void>;
  release(): void;
}


export async function buildPlannedAgents(params: {
  resourcePublisher?: ResourceAgentPublisher;
  repoRoot: string;
  planId: string;
  jobId: string;
  /**
   * The Agents to generate, as generation sees them: identity and the detailed
   * build brief. The card summary is not part of this view, so neither a
   * renderer nor the fallback skill can put it where the brief belongs.
   */
  agents: PlannedAgentGenerationInput[];
  maxConcurrency: number;
  provider?: string;
  model?: string;
  signal?: AbortSignal;
  renderBrief?: (agent: PlannedAgentGenerationInput) => string;
  referenceContext?: string;
  referenceDocuments?: readonly DocumentSource[];
  documentReviewCacheDir?: string;
  onPersistenceBoundary?: PlannedAgentPersistenceObserver;
  allowFallback?: boolean;
  publication?: PlannedAgentPublication;
  /**
   * Replaces this batch's own semaphore when several batches share one
   * provider budget, so nested batches cannot multiply the configured cap.
   */
  generationGate?: PlannedAgentGenerationGate;
  onUpdate?: (update: PlannedAgentBuildUpdate) => void | Promise<void>;
}): Promise<PlannedAgentBatchResult> {
  validateBatch(params.agents, params.maxConcurrency);
  const items = params.agents.map<ResourceBuildItem>((agent, planIndex) => ({
    plannedResource: { kind: "agent", id: agent.name },
    planIndex,
    status: "planned",
  }));
  const reserved = new Set<number>();

  // Names are reserved one at a time, and a withdrawal between two of them
  // must not leave the earlier ones held: nothing downstream has seen them
  // yet, and a terminal cancelled job is never reconciled, so a leaked name
  // would be unavailable to every later proposal.
  try {
    await reserveEveryName(params, items, reserved);
  } catch (error) {
    await releaseReservedNames(params, reserved);
    throw error;
  }

  const gate: PlannedAgentGenerationGate = params.generationGate ??
    new ConcurrencySemaphore(
      Math.min(params.maxConcurrency, Math.max(1, params.agents.length)),
    );
  // Keyed by plan index so publication evidence follows the plan's own order
  // rather than whichever provider happened to answer first.
  const staged = new Map<number, StagedPlannedAgent>();
  const cleanupIssues = new Map<number, string>();
  return continueBatch(params, items, reserved, gate, staged, cleanupIssues);
}

/** Reserves every planned name, in plan order. */
async function reserveEveryName(
  params: Parameters<typeof buildPlannedAgents>[0],
  items: ResourceBuildItem[],
  reserved: Set<number>,
): Promise<void> {
  for (const [planIndex, agent] of params.agents.entries()) {
    throwIfAborted(params.signal);
    try {
      const result = await reservePlannedAgentName({
        repoRoot: params.repoRoot,
        planId: params.planId,
        jobId: params.jobId,
        name: agent.name,
      });
      if (result.status === "reused") {
        items[planIndex] = {
          ...requirePlanItem(items, planIndex),
          resource: { kind: "agent", id: agent.name },
          status: "reused",
        };
        await emit(params, items[planIndex], "agent_reused", `Reused Agent \`${agent.name}\`.`);
        continue;
      }
      reserved.add(planIndex);
      await emit(params, requirePlanItem(items, planIndex), "name_reserved", `Reserved Agent name \`${agent.name}\`.`);
    } catch (error) {
      items[planIndex] = {
        ...requirePlanItem(items, planIndex),
        status: "needs_input",
        error: errorMessage(error),
      };
      await emit(
        params,
        items[planIndex],
        "agent_needs_input",
        `Agent \`${agent.name}\` needs a revised name: ${errorMessage(error)}`,
      );
    }
  }
}

/**
 * Gives back every name the reservation phase acquired.
 *
 * A failure here is not hidden: the caller is already unwinding, and a name it
 * could not release has to reach the operator rather than disappear behind the
 * error that caused the unwind.
 */
async function releaseReservedNames(
  params: Parameters<typeof buildPlannedAgents>[0],
  reserved: Set<number>,
): Promise<void> {
  const issues: string[] = [];
  for (const planIndex of reserved) {
    const agent = params.agents[planIndex];
    if (!agent) continue;
    try {
      await releasePlannedAgentReservation({
        repoRoot: params.repoRoot,
        planId: params.planId,
        jobId: params.jobId,
        name: agent.name,
      });
    } catch (error) {
      issues.push(`${agent.name}: ${errorMessage(error)}`);
    }
  }
  reserved.clear();
  if (issues.length > 0) {
    throw new Error(`Could not release every reserved Agent name: ${issues.join("; ")}`);
  }
}

async function continueBatch(
  params: Parameters<typeof buildPlannedAgents>[0],
  items: ResourceBuildItem[],
  reserved: Set<number>,
  gate: PlannedAgentGenerationGate,
  staged: Map<number, StagedPlannedAgent>,
  cleanupIssues: Map<number, string>,
): Promise<PlannedAgentBatchResult> {
  const generationTasks = params.agents.map(async (agent, planIndex) => {
    if (!reserved.has(planIndex)) return;
    let admitted = false;
    try {
      // Release only what was actually acquired: a cancelled waiter holds
      // nothing, and freeing a permit it never took would hand away someone
      // else's capacity.
      await gate.acquire(params.signal);
      admitted = true;
      const result = await generateOne(params, agent, items, planIndex, (issue) => {
        cleanupIssues.set(planIndex, issue);
      });
      if (result) staged.set(planIndex, result);
    } catch (error) {
      // A waiter cancelled before it was admitted never entered `generateOne`,
      // so it has to report itself and give its name back here.
      await reportUnadmittedAgent(params, agent, items, planIndex, error, (issue) => {
        cleanupIssues.set(planIndex, issue);
      });
    } finally {
      if (admitted) gate.release();
    }
  });
  await Promise.allSettled(generationTasks);
  return {
    items,
    cleanupIssues: [...cleanupIssues.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, issue]) => issue),
    staged: [...staged.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, entry]) => entry),
  };
}

async function generateOne(
  params: Parameters<typeof buildPlannedAgents>[0],
  agent: PlannedAgentGenerationInput,
  items: ResourceBuildItem[],
  planIndex: number,
  reportCleanupIssue: (issue: string) => void,
): Promise<StagedPlannedAgent | null> {
  const stageOnly = params.publication === "stage";
  let stagedResult: StagedPlannedAgent | null = null;
  try {
    throwIfAborted(params.signal);
    items[planIndex] = { ...requirePlanItem(items, planIndex), status: "generating" };
    await emit(
      params,
      items[planIndex],
      "agent_generating",
      `Generating Agent \`${agent.name}\`.`,
    );
    const draft = await runCreateAgent({
      ...whenDefined(params.referenceDocuments, (referenceDocuments) => ({ referenceDocuments })),
      ...whenDefined(params.documentReviewCacheDir, (documentReviewCacheDir) => ({ documentReviewCacheDir })),
      repoRoot: params.repoRoot,
      skillPaths: [],
      chatHistory: [{
        role: "user",
        text: [
          params.renderBrief?.(agent) ?? renderPlannedAgentBrief(agent),
          `Internet access approved for this Agent: ${agent.webResearchEnabled === true ? "enabled; use research_web for current sources" : "disabled; do not claim to browse or search the web"}.`,
          params.referenceContext?.trim(),
        ].filter(Boolean).join("\n\n"),
      }],
      duplicatePolicy: "duplicate",
      ...whenDefined(params.provider, (definedValue) => ({ provider: definedValue })),
      ...whenDefined(params.model, (definedValue) => ({ model: definedValue })),
      ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
    });
    throwIfAborted(params.signal);

    if ("duplicate" in draft && draft.duplicate) {
      throw new Error(
        `Planned Agent unexpectedly resolved to existing Agent ${draft.duplicate.existingAgentName}`,
      );
    }
    if ("needsInput" in draft && draft.needsInput) {
      items[planIndex] = {
        ...requirePlanItem(items, planIndex),
        status: "needs_input",
        error: draft.message,
      };
      await emit(params, items[planIndex], "agent_needs_input", draft.message);
      return null;
    }

    if (draft.meta.fallback && !params.allowFallback) {
      throw new Error(
        `Agent provider did not return a publishable draft: ${draft.meta.reason ?? "fallback draft"}`,
      );
    }

    const personaMarkdown = applyPlannedWebResearch(
      draft.meta.fallback
        ? forcePlannedFallbackIdentity(draft.personaMarkdown, agent.name)
        : draft.personaMarkdown,
      agent.webResearchEnabled,
    );
    const suggestedName = draft.meta.fallback ? agent.name : draft.suggestedName;
    assertGeneratedIdentity(agent.name, suggestedName, personaMarkdown);
    await verifyPlannedAgentReservation({
      repoRoot: params.repoRoot,
      planId: params.planId,
      jobId: params.jobId,
      name: agent.name,
    });
    const generatedSkills = await repairSkillSpecViolations(
      params,
      items,
      planIndex,
      draft.generatedSkills?.length
        ? draft.generatedSkills
        : [createFallbackSkill(agent)],
    );
    const persistence = {
      repoRoot: params.repoRoot,
      orchestratorKey: params.planId,
      requestedName: agent.name,
      personaMarkdown,
      generatedSkills,
      ...whenDefined(params.onPersistenceBoundary, (definedValue) => ({ onPersistenceBoundary: definedValue })),
    };
    if (stageOnly) {
      // The package exists privately. No `agent_created` is reported and the
      // item stays `generating`, because nothing has reached `agents/` yet.
      stagedResult = await stagePlannedAgentDraft(persistence);
      return stagedResult;
    }
    const persist = () => persistPlannedAgentDraft(persistence);
    const agentName = await (params.resourcePublisher?.publishAgent(agent.name, persist) ?? persist());
    items[planIndex] = {
      ...requirePlanItem(items, planIndex),
      resource: { kind: "agent", id: agentName },
      status: "created",
    };
    await emit(
      params,
      items[planIndex],
      "agent_created",
      `Created Agent \`${agentName}\`.`,
    );
  } catch (error) {
    const cancelled = params.signal?.aborted || isAbortLike(error);
    items[planIndex] = {
      ...requirePlanItem(items, planIndex),
      status: cancelled ? "cancelled" : "failed",
      error: errorMessage(error),
    };
    await emit(
      params,
      items[planIndex],
      cancelled ? "agent_cancelled" : "agent_failed",
      cancelled
        ? `Cancelled Agent \`${agent.name}\`.`
        : `Failed Agent \`${agent.name}\`: ${errorMessage(error)}`,
    );
  } finally {
    // A package that is staged and still publishable keeps its name reserved
    // until the caller publishes it or gives it up. Anything else — a failure,
    // a cancellation, or an ordinary publish — hands the name back now, so a
    // name cannot be owned by an operation that will never use it.
    if (!stageOnly || !stagedResult) {
      await releaseReservation(params, agent, reportCleanupIssue);
    }
  }
  return stagedResult;
}

/**
 * Corrects any generated skill this package could not publish, before staging.
 *
 * The check duplicates the one `commitAgent` runs, deliberately and earlier. A
 * violation discovered inside the staging transaction leaves a shell on disk
 * and gives the reserved name back, and the model reproduces the same
 * violation on every regeneration, so the retry that follows fails the same
 * way. Repairing here is the only place where every planned-Agent path — Team
 * creation, Retry, and the update executor — is covered at once.
 *
 * Nothing else about the draft is touched: the persona, the skills that
 * conform, and every folder name go through exactly as the architect wrote
 * them.
 */
async function repairSkillSpecViolations(
  params: Parameters<typeof buildPlannedAgents>[0],
  items: ResourceBuildItem[],
  planIndex: number,
  generatedSkills: GeneratedSkill[],
): Promise<GeneratedSkill[]> {
  const violations = findSkillBatchViolations(
    describeGeneratedSkillSources(generatedSkills),
  );
  if (violations.length === 0) return generatedSkills;
  const repaired = await repairGeneratedSkills({
    repoRoot: params.repoRoot,
    skills: generatedSkills,
    violations,
    ...whenDefined(params.provider, (definedValue) => ({ provider: definedValue })),
    ...whenDefined(params.model, (definedValue) => ({ model: definedValue })),
    ...whenDefined(params.signal, (definedValue) => ({ signal: definedValue })),
  });
  for (const skillName of repaired.repairedSkillNames) {
    await emit(
      params,
      requirePlanItem(items, planIndex),
      "skill_repaired",
      `Repaired skill \`${skillName}\` to satisfy the Agent Skills specification.`,
    );
  }
  return repaired.skills;
}

/**
 * Gives a reserved name back, recording a failure to do so separately.
 *
 * A cleanup failure means the name stays owned by a build that is over, which
 * a later proposal will hit as an unavailable name. It says nothing about the
 * resource, so it must not be written onto the resource's own outcome.
 */
async function releaseReservation(
  params: Parameters<typeof buildPlannedAgents>[0],
  agent: PlannedAgentGenerationInput,
  reportCleanupIssue: (issue: string) => void,
): Promise<void> {
  try {
    await releasePlannedAgentReservation({
      repoRoot: params.repoRoot,
      planId: params.planId,
      jobId: params.jobId,
      name: agent.name,
    });
  } catch (error) {
    reportCleanupIssue(
      `Agent name \`${agent.name}\` could not be released: ${errorMessage(error)}`,
    );
  }
}

/** Reads the build item `buildPlannedAgents` created for every plan index. */
function requirePlanItem(
  items: ResourceBuildItem[],
  planIndex: number,
): ResourceBuildItem {
  const item = items[planIndex];
  if (!item) {
    throw new Error(`No build item exists for plan index ${planIndex}`);
  }
  return item;
}

/** Reports an Agent that never reached generation, and frees its name. */
async function reportUnadmittedAgent(
  params: Parameters<typeof buildPlannedAgents>[0],
  agent: PlannedAgentGenerationInput,
  items: ResourceBuildItem[],
  planIndex: number,
  error: unknown,
  reportCleanupIssue: (issue: string) => void,
): Promise<void> {
  const item = items[planIndex];
  if (!item) return;
  const cancelled = params.signal?.aborted || isAbortLike(error);
  items[planIndex] = {
    ...item,
    status: cancelled ? "cancelled" : "failed",
    error: errorMessage(error),
  };
  await emit(
    params,
    items[planIndex],
    cancelled ? "agent_cancelled" : "agent_failed",
    cancelled
      ? `Cancelled Agent \`${agent.name}\`.`
      : `Failed Agent \`${agent.name}\`: ${errorMessage(error)}`,
  );
  await releaseReservation(params, agent, reportCleanupIssue);
}

function validateBatch(agents: PlannedAgentGenerationInput[], maxConcurrency: number): void {
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new Error("maxConcurrency must be a positive integer");
  }
  if (agents.length === 0) throw new Error("At least one planned Agent is required");
  const names = new Set<string>();
  for (const agent of agents) {
    validateExactAgentName(agent.name);
    if (names.has(agent.name)) {
      throw new Error(`Duplicate planned Agent name: ${agent.name}`);
    }
    names.add(agent.name);
  }
}

function assertGeneratedIdentity(
  plannedName: string,
  suggestedName: string,
  personaMarkdown: string,
): void {
  if (suggestedName !== plannedName) {
    throw new Error(
      `Generated Agent suggested \`${suggestedName}\` instead of planned name \`${plannedName}\``,
    );
  }
  const frontmatterName = personaMarkdown.match(/^name:\s*([^\r\n]+)$/m)?.[1]?.trim();
  if (frontmatterName !== plannedName) {
    throw new Error(
      `Generated persona name \`${frontmatterName ?? "missing"}\` does not match planned name \`${plannedName}\``,
    );
  }
}

function forcePlannedFallbackIdentity(
  personaMarkdown: string,
  plannedName: string,
): string {
  if (/^name:\s*[^\r\n]+$/m.test(personaMarkdown)) {
    return personaMarkdown.replace(/^name:\s*[^\r\n]+$/m, `name: ${plannedName}`);
  }
  return personaMarkdown;
}

function renderPlannedAgentBrief(agent: PlannedAgentGenerationInput): string {
  return [
    "Create this planned Agent package.",
    "",
    `Planned Agent name: \`${agent.name}\``,
    `Role: ${agent.role}`,
    `Description: ${agent.description}`,
    `Rationale: ${agent.rationale}`,
    "",
    `The JSON suggestedName and persona frontmatter name must both be exactly \`${agent.name}\`.`,
  ].join("\n");
}

export function createFallbackSkill(agent: PlannedAgentGenerationInput): GeneratedSkill {
  const suffix = "-method";
  const baseName = agent.name
    .slice(0, 40 - suffix.length)
    .replace(/-+$/g, "");
  const skillName = `${baseName}${suffix}`;
  // The description is the only text an agent reads when deciding whether to
  // activate a skill, so it has to say when to use this one and not only what
  // it is for. It is built from the Agent's name alone: a role or description
  // the model wrote could carry a colon, which the frontmatter rules refuse in
  // an inline value.
  const subject = agent.name.replace(/-/g, " ");
  return {
    name: skillName,
    body: [
      "---",
      `name: ${skillName}`,
      `description: Working method for ${agent.name}. Use when a ${subject} task needs its steps, checks, and output shape made explicit before the work starts.`,
      "---",
      "",
      `# ${agent.role}`,
      "",
      agent.description,
      "",
    ].join("\n"),
  };
}

async function emit(
  params: Parameters<typeof buildPlannedAgents>[0],
  item: ResourceBuildItem,
  eventType: ResourceBuildEventType,
  message: string,
): Promise<void> {
  try {
    await params.onUpdate?.({
      item: cloneItem(item),
      eventType,
      message,
    });
  } catch (error) {
    // Item state is committed before observers run; failed notifications must
    // not alter a resource outcome or abort the rest of the batch.
    console.warn(
      `Could not report planned Agent ${eventType} for ${item.plannedResource.id}:`,
      error,
    );
  }
}

function cloneItem(item: ResourceBuildItem): ResourceBuildItem {
  return JSON.parse(JSON.stringify(item)) as ResourceBuildItem;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  const error = new Error("Agent generation cancelled");
  error.name = "AbortError";
  throw error;
}

function isAbortLike(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
