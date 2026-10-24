import { whenDefined } from "../../core/optional-properties.js"
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import type { PlanState, PlanTask } from "../../parsers/plan-parser.js";
import type { GovernedWebEvidenceMode } from "../../core/types.js";
import {
  isAcquisitionAttempt,
  isSupportedSourceObservationReceiptVersion,
  type SourceObservationReceiptVersion,
  type AcquisitionAttempt,
  type AcquisitionMethod,
} from "../acquisition/acquisition-types.js";
import type {
  EvidencePacket,
  SourceRecord,
} from "../../contracts/deep-research.js";
import { assertResearchPlanApproved } from "./deep-research-approval.js";
import {
  buildResearchPromptEnvelope,
  estimateResearchPromptTokens,
  RESEARCH_PROMPT_TOKEN_LIMITS,
} from "./deep-research-prompt-envelope.js";
import {
  authorizeResearchAssignment,
  hashResearchValue,
} from "./deep-research-worker-policy.js";
import {
  parseEvidencePacket,
  parseQualityVerdict,
} from "./deep-research-validation.js";
import {
  buildResearchQualityPacket,
  buildResearchSynthesisPacket,
  evaluateResearchQuality,
  mergeCorrectionRequests,
  mergeQualityFindings,
} from "./deep-research-quality.js";
import {
  applyAdaptiveResearchPolicy,
  buildResearchPlanAmendment,
} from "./deep-research-adaptive-policy.js";
import {
  buildResearchEvidenceGraph,
  buildResearchSectionDossierIndex,
  buildResearchSectionDossiers,
  buildResearchSectionDraftPlan,
} from "./deep-research-evidence-graph.js";
import { writeFileAtomicSync } from "../../core/file-mutation.js";
import { writeDeepResearchEvidenceSummaryIndex } from "./deep-research-worker-summary.js";
import {
  isSafePathSegment,
  resolveExistingPathInside,
  resolveRelativePathInside,
} from "../../core/path-safety.js";
import { resolveOwnedRunRelativePath } from "../../domains/runtime/runtime-paths.js";

const MAX_PLAN_BYTES = 2 * 1024 * 1024;
/**
 * The critic answers with one small verdict. Anything past this is a runaway
 * response, and the candidate scan below must not walk it.
 */
const MAX_QUALITY_RESPONSE_BYTES = 64 * 1024;
const MAX_DEPENDENCY_PACKET_BYTES = 512 * 1024;
const MAX_OBSERVATION_RECEIPT_BYTES = 64 * 1024;
const MAX_OBSERVED_CONTENT_BYTES = 20 * 1024 * 1024;
const WEB_RESEARCHER_AGENT_PATH = "agents/web-researcher";
const RECEIPT_ACQUISITION_METHODS = new Set<AcquisitionMethod>([
  "direct-http",
  "direct-http-proxied",
  "managed-browser",
  "managed-browser-proxied",
  "managed-reader",
  "cloud-browser",
  "document-parser",
]);
const EXCERPT_ANCHOR_LENGTH = 24;
const EXCERPT_REPORT_ANCHOR_LENGTH = 60;
const EXCERPT_REPORT_WINDOW_LENGTH = 80;
const DOMAIN_CARD_DIRECTORY = "research/domain-cards";
const CORRECTION_CONTEXT_PATH = "research/corrections/current.json";
const EVIDENCE_MANIFEST_PATH = "research/evidence/current-manifest.json";
const SYNTHESIS_PACKET_PATH = "research/synthesis/current.json";
const QUALITY_PACKET_PATH = "research/quality/current-packet.json";
const DETERMINISTIC_VERDICT_PATH =
  "research/quality/deterministic-verdict.json";

export interface DeepResearchTaskOverlay {
  readonly system: string;
  readonly user: string;
  readonly displayRole: string;
  readonly laneId: string;
  readonly sectionId: string;
  readonly assignmentHash: string;
  readonly workerDeadlineMs: number;
  readonly planDeadlineMs: number;
  readonly minimumDispatchMs: number;
  readonly governedWebEvidenceMode: GovernedWebEvidenceMode;
}

export interface DeepResearchExecutionLimits {
  readonly maxConcurrency: number;
  readonly maxDurationMinutes: number;
}

export interface DeepResearchDeadline {
  readonly startedAt: string;
  readonly deadlineAt: string;
  readonly remainingMs: number;
  /**
   * The approved plan budget the deadline was derived from. Carried on the
   * deadline so a stage that declares only a `deadline_artifact` — every chain
   * stage, and pipeline stages with no plan overlay — can still diagnose a
   * declared agent timeout that can never fire.
   */
  readonly maxDurationMinutes: number;
}

/**
 * Convert one approved machine plan task into a bounded prompt overlay while
 * retaining the permanent web-researcher capability identity.
 */
export function resolveDeepResearchTaskOverlay(input: {
  readonly assignmentPath: string;
  readonly planArtifact: string;
  readonly executablePlan: PlanState;
  readonly task: PlanTask;
  readonly now?: Date;
}): DeepResearchTaskOverlay {
  const approvedPlan = assertResearchPlanApproved(
    readJsonArtifact({
      assignmentPath: input.assignmentPath,
      relativePath: input.planArtifact,
      maximumBytes: MAX_PLAN_BYTES,
      label: "Deep Research plan",
    }),
  );
  const researchTask = approvedPlan.tasks.find(
    (task) => task.id === input.task.id,
  );
  if (!researchTask) {
    throw new Error(
      `Approved research plan does not contain task '${input.task.id}'.`,
    );
  }
  const workerSpec = approvedPlan.workerSpecs.find(
    (candidate) => candidate.id === researchTask.workerSpecId,
  );
  if (!workerSpec) {
    throw new Error(
      `Approved research task '${input.task.id}' has no worker specification.`,
    );
  }
  if (input.task.agent !== workerSpec.baseAgent) {
    throw new Error(
      `Research task '${input.task.id}' must dispatch through '${workerSpec.baseAgent}', not '${input.task.agent}'.`,
    );
  }

  const assignment = authorizeResearchAssignment({
    task: researchTask,
    workerSpec,
  });
  const domainCard = workerSpec.domainCardRef
    ? readJsonArtifact({
        assignmentPath: input.assignmentPath,
        relativePath: `${DOMAIN_CARD_DIRECTORY}/${workerSpec.domainCardRef}.json`,
        maximumBytes: MAX_PLAN_BYTES,
        label: "Deep Research domain card",
      })
    : undefined;
  const envelope = buildResearchPromptEnvelope({
    workerSpec: assignment.workerSpec,
    domainCard,
    dependencyDigest: buildDependencyDigest(
      input.assignmentPath,
      input.executablePlan,
      researchTask.dependsOn,
    ),
    ...whenDefined(input.now, (definedValue) => ({ now: definedValue })),
  });
  const correctionContext = readCorrectionContext(
    input.assignmentPath,
    researchTask.id,
    approvedPlan,
  );
  if (
    correctionContext &&
    input.task.resultFile !==
      `research/evidence/wave-${correctionContext.wave}/${researchTask.id}.json`
  ) {
    throw new Error(
      `Correction task '${researchTask.id}' has an unauthorized result path.`,
    );
  }

  return {
    system: envelope.system,
    user: `${envelope.user}${correctionContext ? `\n\n${correctionContext.prompt}` : ""}\n\n${buildEvidenceResponseContract(
      {
        taskId: researchTask.id,
        sectionId: researchTask.sectionId,
        assignmentId: assignment.workerSpec.laneId,
        workerSpecHash: assignment.workerSpecHash,
        maximumSources: assignment.workerSpec.stopRule.maximumSources,
      },
    )}`,
    displayRole: assignment.workerSpec.displayRole,
    laneId: assignment.workerSpec.laneId,
    sectionId: researchTask.sectionId,
    assignmentHash: assignment.workerSpecHash,
    workerDeadlineMs: assignment.workerSpec.limits.deadlineMs,
    planDeadlineMs: approvedPlan.maxDurationMinutes * 60_000,
    minimumDispatchMs: correctionContext?.minimumDispatchMs ?? 0,
    governedWebEvidenceMode:
      correctionContext?.governedWebEvidenceMode ?? "acquire",
  };
}

export function resolveDeepResearchExecutionLimits(input: {
  readonly assignmentPath: string;
  readonly planArtifact: string;
}): DeepResearchExecutionLimits {
  const plan = assertResearchPlanApproved(
    readJsonArtifact({
      assignmentPath: input.assignmentPath,
      relativePath: input.planArtifact,
      maximumBytes: MAX_PLAN_BYTES,
      label: "Deep Research plan",
    }),
  );
  return {
    maxConcurrency: Math.min(
      plan.maxResearcherAgents,
      plan.expectedPeakWorkers,
    ),
    maxDurationMinutes: plan.maxDurationMinutes,
  };
}

/**
 * The approved deadline, or `undefined` when no deadline artifact exists.
 *
 * A stage that declares only a `deadline_artifact` consumes the run budget but
 * is not defined by it: the artifact is a budget, not a contract. Its absence
 * means the stage runs unclamped — the behaviour before clamping existed — and
 * is reported rather than refused, because failing an entire drafting stage
 * over a missing budget file would be a harsher rule than the one it enforces.
 * A deadline that exists but does not match the plan still throws: that is
 * corruption, not absence.
 */
export function resolveOptionalDeepResearchDeadline(input: {
  readonly assignmentPath: string;
  readonly deadlineArtifact: string;
  readonly planArtifact?: string;
  readonly now?: Date;
}): DeepResearchDeadline | undefined {
  const candidatePath = resolveRelativePathInside(
    input.assignmentPath,
    input.deadlineArtifact,
  );
  if (!candidatePath) throw new Error("Deep Research deadline path is unsafe.");
  if (!fs.existsSync(candidatePath)) return undefined;
  return resolveDeepResearchDeadline(input);
}

export function resolveDeepResearchDeadline(input: {
  readonly assignmentPath: string;
  readonly deadlineArtifact: string;
  readonly planArtifact?: string;
  readonly now?: Date;
}): DeepResearchDeadline {
  const plan = assertResearchPlanApproved(
    readJsonArtifact({
      assignmentPath: input.assignmentPath,
      relativePath: input.planArtifact ?? "research/approved-plan.json",
      maximumBytes: MAX_PLAN_BYTES,
      label: "Deep Research plan",
    }),
  );
  const raw = readJsonArtifact({
    assignmentPath: input.assignmentPath,
    relativePath: input.deadlineArtifact,
    maximumBytes: 16 * 1024,
    label: "Deep Research deadline",
  });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Deep Research deadline must be an object.");
  }
  const deadline = raw as Record<string, unknown>;
  if (
    deadline.schemaVersion !== 1 ||
    deadline.planId !== plan.planId ||
    deadline.maxDurationMinutes !== plan.maxDurationMinutes ||
    typeof deadline.startedAt !== "string" ||
    typeof deadline.deadlineAt !== "string"
  ) {
    throw new Error("Deep Research deadline does not match the approved plan.");
  }
  const startedAtMs = Date.parse(deadline.startedAt);
  const deadlineAtMs = Date.parse(deadline.deadlineAt);
  if (
    !Number.isFinite(startedAtMs) ||
    !Number.isFinite(deadlineAtMs) ||
    deadlineAtMs - startedAtMs !== plan.maxDurationMinutes * 60_000
  ) {
    throw new Error("Deep Research deadline interval is invalid.");
  }
  return {
    startedAt: deadline.startedAt,
    deadlineAt: deadline.deadlineAt,
    remainingMs: deadlineAtMs - (input.now ?? new Date()).getTime(),
    maxDurationMinutes: plan.maxDurationMinutes,
  };
}

/**
 * Wall-clock kept back from every dispatch so a timeout can fire early enough
 * to terminate the agent, persist task status and artifacts, and evaluate the
 * outgoing gate.
 *
 * Clamping an agent timeout to the *remaining* plan budget produces a timeout
 * that expires exactly at the plan deadline, which is the same instant the run
 * is already out of time: it can never fire early enough to be useful. Sized
 * from the observed terminal path of run `c932c477`, where persisting the
 * blocker, writing the escalation artifacts, and evaluating the final gates
 * spanned roughly 13 seconds; 30 seconds keeps roughly two times that margin.
 */
export const DEEP_RESEARCH_SHUTDOWN_RESERVE_MS = 30_000 as const;

/**
 * Smallest dispatch worth starting once every clamp has been applied.
 *
 * This is both the floor on the effective agent timeout and the floor on the
 * dispatch quantum a caller may request, because the two are the same
 * question: below this, the agent cannot read its brief, call one tool, and
 * write an artifact, so the dispatch is doomed before it starts. A caller that
 * asks for less — including the default of none — is raised to it rather than
 * being allowed to dispatch a sub-second agent against a nearly spent budget.
 *
 * Sized from the smallest quantum any shipped Deep Research level asks for:
 * the packet-only correction overlay declares 30s.
 */
export const DEEP_RESEARCH_MINIMUM_DISPATCH_MS = 30_000 as const;

export interface DeepResearchDispatchBudget {
  /** Agent timeout after the declared, worker, and remaining-budget clamps. */
  readonly effectiveTimeoutMinutes: number;
  /** Minimum dispatch quantum plus the shutdown reserve. */
  readonly requiredMs: number;
  readonly remainingMs: number;
  /** Present when dispatch must not start; absent when the budget is viable. */
  readonly refusalReason?: "insufficient" | "expired";
}

/**
 * Decide whether a Deep Research dispatch can start, and with what timeout.
 *
 * The effective timeout is the smallest of the declared level timeout, the
 * approved worker deadline, and the remaining plan budget less the shutdown
 * reserve. An expired deadline and an unaffordable remainder are reported
 * separately because they need different operator-facing wording.
 */
export function planDeepResearchDispatchBudget(input: {
  readonly declaredTimeoutMinutes?: number | undefined;
  readonly remainingMs: number;
  readonly workerDeadlineMs?: number | undefined;
  readonly minimumDispatchMs?: number | undefined;
}): DeepResearchDispatchBudget {
  const minimumDispatchMs = Math.max(
    input.minimumDispatchMs ?? 0,
    DEEP_RESEARCH_MINIMUM_DISPATCH_MS,
  );
  const requiredMs = minimumDispatchMs + DEEP_RESEARCH_SHUTDOWN_RESERVE_MS;
  const dispatchableMs = input.remainingMs - DEEP_RESEARCH_SHUTDOWN_RESERVE_MS;
  const effectiveTimeoutMinutes = Math.max(
    DEEP_RESEARCH_MINIMUM_DISPATCH_MS / 60_000,
    Math.min(
      input.declaredTimeoutMinutes ?? Number.POSITIVE_INFINITY,
      (input.workerDeadlineMs ?? Number.POSITIVE_INFINITY) / 60_000,
      dispatchableMs / 60_000,
    ),
  );
  const base = { effectiveTimeoutMinutes, requiredMs, remainingMs: input.remainingMs };
  if (input.remainingMs <= 0) {
    return { ...base, refusalReason: "expired" };
  }
  if (input.remainingMs < requiredMs) {
    return { ...base, refusalReason: "insufficient" };
  }
  return base;
}

/**
 * The operator-facing refusal for a non-viable dispatch budget.
 *
 * Both refusal reasons state the same arithmetic — required, reserve, remaining
 * — because an operator reading either one is asking the same question: how far
 * short was the run, and by how much. `expired` differs only in naming the
 * deadline as the cause. Shared by the pipeline and chain engines so the two
 * cannot drift apart.
 */
export function describeDeepResearchDispatchRefusal(
  budget: DeepResearchDispatchBudget,
  options?: { readonly subject?: string },
): string {
  const subject = options?.subject ?? "this task";
  const arithmetic =
    `${Math.ceil(budget.requiredMs / 1000)} seconds are required ` +
    `(including a ${DEEP_RESEARCH_SHUTDOWN_RESERVE_MS / 1000}s shutdown reserve) and ` +
    `${Math.max(0, Math.floor(budget.remainingMs / 1000))} seconds remain.`;
  if (budget.refusalReason === "expired") {
    return (
      `Approved Deep Research deadline expired; ${subject} cannot start safely: ` +
      arithmetic
    );
  }
  return (
    `Insufficient remaining execution budget to start ${subject} safely; ` +
    arithmetic
  );
}

/**
 * Diagnose a level whose declared agent timeout can never fire.
 *
 * A timeout at or above the whole plan budget expires no earlier than the plan
 * deadline, so it reads as a safety control while providing none. Validation
 * lives here rather than in `parseConstraints` because the generic stage parser
 * has no plan context.
 *
 * This reports; it does not refuse. Level constraints are authored for
 * long-form plans and are wrong only when read as absolute, so refusing would
 * block every short plan against a correct team file. `planDeepResearchDispatchBudget`
 * is the enforcement boundary.
 *
 * Returns the operator-facing message, or `undefined` when the pair is valid.
 */
export function validateDeepResearchLevelTimeout(input: {
  readonly declaredAgentTimeoutMinutes?: number | undefined;
  readonly planMaxDurationMinutes: number;
  readonly levelId?: string | undefined;
}): string | undefined {
  const declared = input.declaredAgentTimeoutMinutes;
  if (declared === undefined || !Number.isFinite(declared)) return undefined;
  if (declared < input.planMaxDurationMinutes) return undefined;
  const where = input.levelId ? ` on level '${input.levelId}'` : "";
  return (
    `agent_timeout_minutes (${declared})${where} is at or above the approved ` +
    `plan budget of ${input.planMaxDurationMinutes} minutes, so it can never fire ` +
    `before the run deadline; dispatch is clamped to the remaining budget less ` +
    `the ${DEEP_RESEARCH_SHUTDOWN_RESERVE_MS / 1000}s shutdown reserve instead. ` +
    `Declare a timeout below the plan budget to make the intent explicit.`
  );
}

/**
 * Refresh the latest-evidence manifest and deterministic packets after one
 * acquisition/correction wave. Prior wave artifacts remain immutable.
 */
export function finalizeDeepResearchEvidenceWave(input: {
  readonly assignmentPath: string;
  readonly planArtifact: string;
  readonly executablePlan: PlanState;
}): { readonly correctionWave: 0 | 1 | 2 } {
  const approvedPlan = assertResearchPlanApproved(
    readJsonArtifact({
      assignmentPath: input.assignmentPath,
      relativePath: input.planArtifact,
      maximumBytes: MAX_PLAN_BYTES,
      label: "Deep Research plan",
    }),
  );
  const priorManifest = readOptionalJsonArtifact({
    assignmentPath: input.assignmentPath,
    relativePath: EVIDENCE_MANIFEST_PATH,
    maximumBytes: MAX_PLAN_BYTES,
    label: "Deep Research evidence manifest",
  });
  const latestByTask = parseEvidenceManifest(
    priorManifest,
    approvedPlan.tasks.map((task) => task.id),
  );
  for (const task of input.executablePlan.tasks.values()) {
    if (!approvedPlan.tasks.some((candidate) => candidate.id === task.id))
      continue;
    if (task.status !== "completed" && task.status !== "validated") {
      throw new Error(
        `Research task '${task.id}' is not complete for packet finalization.`,
      );
    }
    latestByTask.set(task.id, task.resultFile);
  }
  const evidencePackets = approvedPlan.tasks.map((task) => {
    const relativePath = latestByTask.get(task.id);
    if (!relativePath)
      throw new Error(
        `Research task '${task.id}' has no current evidence artifact.`,
      );
    return parseEvidencePacket(
      readJsonArtifact({
        assignmentPath: input.assignmentPath,
        relativePath,
        maximumBytes: MAX_DEPENDENCY_PACKET_BYTES,
        label: `Evidence packet '${task.id}'`,
      }),
    );
  });
  const correctionWave = currentCorrectionWave(input.assignmentPath);
  const synthesis = buildResearchSynthesisPacket({
    plan: approvedPlan,
    evidencePackets,
  });
  const quality = buildResearchQualityPacket({
    plan: approvedPlan,
    evidencePackets,
  });
  const evidenceGraph = buildResearchEvidenceGraph({
    plan: approvedPlan,
    synthesis,
    correctionWave,
  });
  const sectionDossiers = buildResearchSectionDossiers({
    plan: approvedPlan,
    synthesis,
    graph: evidenceGraph,
    evidencePackets,
  });
  const sectionDossierIndex = buildResearchSectionDossierIndex({
    plan: approvedPlan,
    dossiers: sectionDossiers,
  });
  const sectionDraftPlan = buildResearchSectionDraftPlan({
    plan: approvedPlan,
    index: sectionDossierIndex,
  });
  const manifest = {
    schemaVersion: 1,
    correctionWave,
    latestByTask: Object.fromEntries(
      [...latestByTask.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
  };
  const manifestVersionPath = `research/evidence/manifest-wave-${correctionWave}.json`;
  const synthesisVersionPath = `research/synthesis/packet-wave-${correctionWave}.json`;
  const qualityVersionPath = `research/quality/packet-wave-${correctionWave}.json`;
  const verdictVersionPath = `research/quality/deterministic-verdict-wave-${correctionWave}.json`;
  const evidenceGraphVersionPath = `research/evidence-graph/graph-wave-${correctionWave}.json`;
  const dossierIndexVersionPath = `research/sections/index-wave-${correctionWave}.json`;
  writeImmutableCanonicalJson(
    input.assignmentPath,
    manifestVersionPath,
    manifest,
  );
  writeImmutableCanonicalJson(
    input.assignmentPath,
    synthesisVersionPath,
    synthesis,
  );
  writeImmutableCanonicalJson(
    input.assignmentPath,
    qualityVersionPath,
    quality,
  );
  writeImmutableCanonicalJson(
    input.assignmentPath,
    evidenceGraphVersionPath,
    evidenceGraph,
  );
  writeImmutableCanonicalJson(
    input.assignmentPath,
    dossierIndexVersionPath,
    sectionDossierIndex,
  );
  for (const dossier of sectionDossiers) {
    writeImmutableCanonicalJson(
      input.assignmentPath,
      `research/sections/${dossier.sectionId}/dossier-wave-${correctionWave}.json`,
      dossier,
    );
  }
  const existingVerdict = readOptionalJsonArtifact({
    assignmentPath: input.assignmentPath,
    relativePath: verdictVersionPath,
    maximumBytes: MAX_PLAN_BYTES,
    label: "Versioned deterministic quality verdict",
  });
  const verdict =
    existingVerdict === undefined
      ? evaluateResearchQuality({
          plan: approvedPlan,
          evidencePackets,
          correctionWave,
        })
      : parseQualityVerdict(existingVerdict);
  if (verdict.correctionWave !== correctionWave) {
    throw new Error(
      "Versioned deterministic quality verdict has the wrong correction wave.",
    );
  }
  writeImmutableCanonicalJson(
    input.assignmentPath,
    verdictVersionPath,
    verdict,
  );
  writeCanonicalJson(input.assignmentPath, EVIDENCE_MANIFEST_PATH, manifest);
  writeCanonicalJson(input.assignmentPath, SYNTHESIS_PACKET_PATH, synthesis);
  writeCanonicalJson(input.assignmentPath, QUALITY_PACKET_PATH, quality);
  writeCanonicalJson(input.assignmentPath, DETERMINISTIC_VERDICT_PATH, verdict);
  writeCanonicalJson(
    input.assignmentPath,
    "research/evidence-graph/current.json",
    evidenceGraph,
  );
  writeCanonicalJson(
    input.assignmentPath,
    "research/sections/current-index.json",
    sectionDossierIndex,
  );
  for (const dossier of sectionDossiers) {
    writeCanonicalJson(
      input.assignmentPath,
      `research/sections/${dossier.sectionId}/dossier-current.json`,
      dossier,
    );
  }
  if (sectionDraftPlan) {
    const sectionPlanPath = resolveOwnedRunRelativePath({
      assignmentPath: input.assignmentPath,
      relativePath: "research/section-plan.md",
      label: "Deep Research section draft plan",
    });
    writeFileAtomicSync(sectionPlanPath, sectionDraftPlan);
  } else {
    removeOwnedRegularArtifact(
      input.assignmentPath,
      "research/section-plan.md",
    );
  }
  writeDeepResearchEvidenceSummaryIndex({
    assignmentPath: input.assignmentPath,
    entries: approvedPlan.tasks.map((task) => {
      const workerSpec = approvedPlan.workerSpecs.find(
        (candidate) => candidate.id === task.workerSpecId,
      );
      const resultFile = latestByTask.get(task.id) ?? task.id;
      return {
        taskId: task.id,
        title: task.title,
        laneId: workerSpec?.laneId ?? task.id,
        displayRole: workerSpec?.displayRole ?? task.id,
        wave: Number(resultFile.match(/wave-(\d+)/)?.[1] ?? correctionWave),
      };
    }),
  });
  if (correctionWave > 0) {
    removeOwnedRegularArtifact(input.assignmentPath, "research-package.md");
    removeOwnedRegularArtifact(
      input.assignmentPath,
      "research/quality/current-verdict.json",
    );
  }
  return { correctionWave };
}

/**
 * Parse the researcher's response as the single machine-owned evidence
 * contract. Markdown fences and explanatory prose are intentionally rejected.
 */
export function parseDeepResearchEvidenceResult(input: {
  readonly text: string;
  readonly taskId: string;
  readonly sectionId: string;
  readonly assignmentId: string;
  readonly workerSpecHash: string;
  readonly assignmentPath: string;
}): EvidencePacket {
  let raw: unknown;
  try {
    raw = JSON.parse(input.text.trim());
  } catch {
    throw new Error(
      "Researcher response must contain only one valid EvidencePacket JSON object.",
    );
  }
  const packet = parseEvidencePacket(
    canonicalizeModelEvidencePacketClericalFields(raw, {
      taskId: input.taskId,
      sectionId: input.sectionId,
    }),
  );
  if (packet.taskId !== input.taskId) {
    throw new Error(`Evidence packet taskId must be '${input.taskId}'.`);
  }
  if (packet.assignmentId !== input.assignmentId) {
    throw new Error(
      `Evidence packet assignmentId must be '${input.assignmentId}'.`,
    );
  }
  if (packet.workerSpecHash !== input.workerSpecHash) {
    throw new Error(
      "Evidence packet workerSpecHash does not match the approved assignment.",
    );
  }
  const boundPacket = validateEvidenceObservationBindings(
    packet,
    input.assignmentPath,
  );
  validateLocalCorrectionScope(boundPacket, input.assignmentPath);
  return boundPacket;
}

/**
 * Repair only redundant model-authored fields whose authoritative identity is
 * still proved by a runtime receipt. The strict packet parser and receipt
 * binding run after this function and continue to reject malformed,
 * ambiguous, cross-lane, or fabricated evidence.
 */
export function canonicalizeModelEvidencePacketClericalFields(
  value: unknown,
  owner: {
    readonly taskId: string;
    readonly sectionId: string;
  },
): unknown {
  if (!isUnknownRecord(value) || !Array.isArray(value.sources)) return value;

  const sourceIdByReceipt = new Map<string, string>();
  const ambiguousReceipts = new Set<string>();
  for (const source of value.sources) {
    if (
      !isUnknownRecord(source) ||
      typeof source.sourceId !== "string" ||
      typeof source.observationReceiptId !== "string" ||
      source.status !== "usable" ||
      source.accessMethod === "web.search"
    ) {
      continue;
    }
    const priorSourceId = sourceIdByReceipt.get(source.observationReceiptId);
    if (priorSourceId !== undefined && priorSourceId !== source.sourceId) {
      ambiguousReceipts.add(source.observationReceiptId);
      continue;
    }
    sourceIdByReceipt.set(source.observationReceiptId, source.sourceId);
  }
  for (const receiptId of ambiguousReceipts) sourceIdByReceipt.delete(receiptId);
  if (!Array.isArray(value.findings)) return value;

  return {
    ...value,
    findings: value.findings.map((finding) =>
      canonicalizeModelClaimClericalFields(finding, sourceIdByReceipt, owner),
    ),
  };
}

function canonicalizeModelClaimClericalFields(
  value: unknown,
  sourceIdByReceipt: ReadonlyMap<string, string>,
  owner: {
    readonly taskId: string;
    readonly sectionId: string;
  },
): unknown {
  if (!isUnknownRecord(value) || !Array.isArray(value.evidenceLinks)) {
    return value;
  }

  let everyLinkHasUniqueReceiptOwner = true;
  const evidenceLinks = value.evidenceLinks.map((link: unknown) => {
    if (
      !isUnknownRecord(link) ||
      typeof link.observationReceiptId !== "string"
    ) {
      everyLinkHasUniqueReceiptOwner = false;
      return link;
    }
    const sourceId = sourceIdByReceipt.get(link.observationReceiptId);
    if (sourceId === undefined) {
      everyLinkHasUniqueReceiptOwner = false;
      return link;
    }
    return { ...link, sourceId };
  });
  const hasSupportingLink = evidenceLinks.some(
    (link) => isUnknownRecord(link) && link.relationship === "supports",
  );
  const sourceIds = everyLinkHasUniqueReceiptOwner
    ? [...new Set(evidenceLinks.flatMap((link) =>
        isUnknownRecord(link) && typeof link.sourceId === "string"
          ? [link.sourceId]
          : [],
      ))]
    : value.sourceIds;
  const status =
    value.kind === "uncertainty" &&
    value.status === "supported" &&
    !hasSupportingLink
      ? "unsupported"
      : value.status;
  return {
    ...value,
    taskId: owner.taskId,
    sectionId: owner.sectionId,
    sourceIds,
    evidenceLinks,
    status,
  };
}

function isUnknownRecord(
  value: unknown,
): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateLocalCorrectionScope(
  packet: EvidencePacket,
  assignmentPath: string,
): void {
  const raw = readOptionalJsonArtifact({
    assignmentPath,
    relativePath: CORRECTION_CONTEXT_PATH,
    maximumBytes: 128 * 1024,
    label: "Deep Research correction context",
  });
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Deep Research correction context must be an object.");
  }
  const taskRequests = (raw as Record<string, unknown>).taskRequests;
  if (
    !taskRequests ||
    typeof taskRequests !== "object" ||
    Array.isArray(taskRequests)
  ) {
    throw new Error(
      "Deep Research correction context has no task request map.",
    );
  }
  const requests = (taskRequests as Record<string, unknown>)[packet.taskId];
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error(
      `Research task '${packet.taskId}' is not targeted by the active correction wave.`,
    );
  }

  const targetedClaimIds = new Set<string>();
  for (const request of requests) {
    if (!request || typeof request !== "object" || Array.isArray(request))
      return;
    const correction = request as Record<string, unknown>;
    if (
      correction.impactScope !== "local" ||
      !Array.isArray(correction.claimIds)
    )
      return;
    if (correction.claimIds.length === 0) return;
    for (const claimId of correction.claimIds) {
      if (typeof claimId !== "string") return;
      targetedClaimIds.add(claimId);
      const taskPrefix = `${packet.taskId}--`;
      if (claimId.startsWith(taskPrefix)) {
        targetedClaimIds.add(claimId.slice(taskPrefix.length));
      }
    }
  }

  const previous = readPreviousEvidencePacket(assignmentPath, packet.taskId);
  if (!previous) {
    throw new Error(
      `Local correction for task '${packet.taskId}' has no prior evidence baseline.`,
    );
  }
  const nextClaims = new Map(
    packet.findings.map((claim) => [claim.claimId, claim]),
  );
  const preservedSourceIds = new Set<string>();
  for (const previousClaim of previous.findings) {
    if (targetedClaimIds.has(previousClaim.claimId)) continue;
    const nextClaim = nextClaims.get(previousClaim.claimId);
    if (
      !nextClaim ||
      hashResearchValue(nextClaim) !== hashResearchValue(previousClaim)
    ) {
      throw new Error(
        `Local correction for task '${packet.taskId}' changed non-targeted claim ` +
          `'${previousClaim.claimId}'. Preserve every non-targeted claim exactly.`,
      );
    }
    for (const sourceId of previousClaim.sourceIds)
      preservedSourceIds.add(sourceId);
  }

  const previousSources = new Map(
    previous.sources.map((source) => [source.sourceId, source]),
  );
  const nextSources = new Map(
    packet.sources.map((source) => [source.sourceId, source]),
  );
  for (const sourceId of preservedSourceIds) {
    const previousSource = previousSources.get(sourceId);
    const nextSource = nextSources.get(sourceId);
    if (
      !previousSource ||
      !nextSource ||
      hashResearchValue(nextSource) !== hashResearchValue(previousSource)
    ) {
      throw new Error(
        `Local correction for task '${packet.taskId}' changed source '${sourceId}' used by a ` +
          "non-targeted claim. Preserve that source record exactly.",
      );
    }
  }
}

interface RuntimeObservationReceipt {
  readonly schemaVersion: SourceObservationReceiptVersion;
  readonly receiptId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly activityScopeId: string;
  readonly activityId: string;
  readonly agentPath: string;
  readonly agentDisplayName?: string;
  readonly method: AcquisitionMethod;
  readonly provider?: string;
  readonly requestedUrl: string;
  readonly finalUrl: string;
  readonly canonicalUrl: string;
  readonly title?: string;
  readonly mediaType: string;
  readonly normalizedMediaType?: "text/markdown";
  readonly observedAt: string;
  readonly contentRelativePath: string;
  readonly contentSha256: string;
  readonly contentBytes: number;
  readonly quality: "usable";
  readonly qualityReport?: unknown;
  readonly sourceMetadata?: unknown;
  readonly representations?: unknown;
  readonly rawSource?: unknown;
  readonly rawOmissionReason?: string;
  readonly attempts: readonly AcquisitionAttempt[];
}

/**
 * Compare two canonical URLs for binding equivalence.
 *
 * The worker must still supply `canonicalUrl` — it is the only field whose
 * mismatch proves a source was paired with the wrong observation receipt, and
 * runtime-filling it would turn that detected error into a silent one. What it
 * must not do is reject a source over a purely syntactic difference, so the
 * comparison ignores a single trailing path slash.
 */
function sameBoundCanonicalUrl(left: string, right: string): boolean {
  const normalizedLeft = normalizeBoundCanonicalUrl(left);
  const normalizedRight = normalizeBoundCanonicalUrl(right);
  if (normalizedLeft === undefined || normalizedRight === undefined) {
    return left === right;
  }
  return normalizedLeft === normalizedRight;
}

function normalizeBoundCanonicalUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    const pathname = url.pathname.length > 1 && url.pathname.endsWith("/")
      ? url.pathname.slice(0, -1)
      : url.pathname;
    return `${url.protocol}//${url.host}${pathname}${url.search}${url.hash}`;
  } catch {
    return undefined;
  }
}

/** Longest run of the excerpt that actually reads contiguously in the content. */
function findLongestContiguousRun(
  content: string,
  target: string,
): { readonly length: number; readonly contentIndex: number } {
  // Anchor on the excerpt's opening and walk forward from each occurrence.
  // Searching for "the longest prefix appearing anywhere" instead would report
  // an anchor from an unrelated part of the page and mislead the retry.
  let anchor = target.slice(0, Math.min(target.length, EXCERPT_ANCHOR_LENGTH));
  while (anchor.length > 0 && !content.includes(anchor)) {
    anchor = anchor.slice(0, -1);
  }
  if (anchor.length === 0) return { length: 0, contentIndex: -1 };
  let best = { length: 0, contentIndex: -1 };
  for (
    let index = content.indexOf(anchor);
    index !== -1;
    index = content.indexOf(anchor, index + 1)
  ) {
    let run = 0;
    while (
      run < target.length &&
      index + run < content.length &&
      content[index + run] === target[run]
    ) run += 1;
    if (run > best.length) best = { length: run, contentIndex: index };
  }
  return best;
}

/**
 * Describe where a claim excerpt stopped matching its observed content.
 *
 * The excerpt check is the backstop that still catches a mis-paired receipt
 * once the runtime supplies the other source fields, so contiguity stays
 * exact. It can still say precisely where the divergence began and what the
 * observation reads there, which turns an opaque rejection into an actionable
 * retry instruction.
 */
function describeExcerptDivergence(
  observedContent: string,
  excerpt: string,
): string {
  const content = compareObservedEvidence(observedContent);
  const target = compareObservedEvidence(excerpt);
  if (target.length === 0) return "The excerpt is empty.";
  // Match on the folded text but quote the original casing back, so the retry
  // instruction shows the worker its own words. Case folding is length-stable
  // for almost every script; fall back to the folded text when it is not.
  const contentDisplay = normalizeObservedEvidence(observedContent);
  const targetDisplay = normalizeObservedEvidence(excerpt);
  const readContent = contentDisplay.length === content.length
    ? contentDisplay
    : content;
  const readTarget = targetDisplay.length === target.length
    ? targetDisplay
    : target;
  const match = findLongestContiguousRun(content, target);
  if (match.length === 0) {
    return (
      "No part of the excerpt reads contiguously in this observation. Quote " +
      "one span copied from the stored observation, or bind the link to the " +
      "receipt whose content contains the quotation."
    );
  }
  const anchor = readTarget.slice(
    Math.max(0, match.length - EXCERPT_REPORT_ANCHOR_LENGTH),
    match.length,
  );
  const divergence = readTarget.slice(
    match.length,
    match.length + EXCERPT_REPORT_WINDOW_LENGTH,
  );
  const observed = readContent.slice(
    match.contentIndex + match.length,
    match.contentIndex + match.length + EXCERPT_REPORT_WINDOW_LENGTH,
  );
  return (
    `The excerpt reads contiguously up to "…${anchor}" and then diverges: the ` +
    `excerpt continues "${divergence}" where the observation reads ` +
    `"${observed}". Quote one contiguous span of the stored observation, ` +
    "including any heading markers and intervening text."
  );
}

/**
 * Report an excerpt that is verbatim in a different receipt this packet
 * already bound. The quotation is faithful and the link is simply pointed at
 * the wrong page, so naming the right receipt is far more actionable than a
 * divergence report against content that never contained the text.
 */
function findVerbatimReceipt(
  receiptContent: ReadonlyMap<string, string>,
  citedReceiptId: string,
  excerpt: string,
): string | undefined {
  const target = compareObservedEvidence(excerpt);
  if (target.length === 0) return undefined;
  for (const [receiptId, content] of receiptContent) {
    if (receiptId === citedReceiptId) continue;
    if (compareObservedEvidence(content).includes(target)) return receiptId;
  }
  return undefined;
}

function validateEvidenceObservationBindings(
  packet: EvidencePacket,
  assignmentPath: string,
): EvidencePacket {
  // Quality thresholds count every usable acquired source, so every such record
  // must be receipt-verified even when no claim currently cites it. Otherwise
  // fabricated, uncited records could pad primary/independence counts.
  const acquiredUsableSources = packet.sources.filter(
    (source) =>
      source.status === "usable" && source.accessMethod !== "web.search",
  );
  if (acquiredUsableSources.length === 0) return packet;
  // Asserted twice: here so a self-evident duplicate fails before any receipt
  // is read, and again on the runtime-derived URLs below so a normalized and an
  // un-normalized spelling of one page cannot pass as two independent sources.
  assertAcquiredSourceIndependence(acquiredUsableSources);
  const runtimeIdentity = deriveRuntimeAssignmentIdentity(assignmentPath);
  const receiptOwner = new Map<string, string>();
  const receiptContent = new Map<string, string>();
  const receiptUrl = new Map<string, string>();
  const derivedSources = new Map<string, SourceRecord>();

  for (const source of acquiredUsableSources) {
    if (!source.observationReceiptId) {
      throw new Error(
        `Usable acquired source '${source.sourceId}' is not bound to an observation receipt.`,
      );
    }
    const existingOwner = receiptOwner.get(source.observationReceiptId);
    if (existingOwner && existingOwner !== source.sourceId) {
      throw new Error(
        `Observation receipt '${source.observationReceiptId}' cannot be reused across sources.`,
      );
    }
    receiptOwner.set(source.observationReceiptId, source.sourceId);

    const receiptRelativePath = [
      "research",
      "observations",
      packet.assignmentId,
      `${source.observationReceiptId}.json`,
    ].join("/");
    const receipt = parseRuntimeObservationReceipt(
      readRuntimeOwnedJson({
        assignmentPath,
        relativePath: receiptRelativePath,
        maximumBytes: MAX_OBSERVATION_RECEIPT_BYTES,
        label: `Observation receipt '${source.observationReceiptId}'`,
      }),
    );
    if (
      receipt.receiptId !== source.observationReceiptId ||
      receipt.activityId !== source.observationReceiptId ||
      receipt.activityScopeId !== packet.assignmentId ||
      receipt.activityScopeId !== source.assignmentId ||
      receipt.sessionId !== runtimeIdentity.sessionId ||
      receipt.runId !== runtimeIdentity.runId ||
      receipt.assignmentId !== runtimeIdentity.assignmentId ||
      receipt.agentPath !== WEB_RESEARCHER_AGENT_PATH
    ) {
      throw new Error(
        `Observation receipt '${source.observationReceiptId}' identity does not match its research lane, source, agent, and runtime assignment.`,
      );
    }
    if (!sameBoundCanonicalUrl(receipt.canonicalUrl, source.canonicalUrl)) {
      throw new Error(
        `Observation receipt '${source.observationReceiptId}' was issued for ` +
          `'${receipt.canonicalUrl}' but source '${source.sourceId}' claims ` +
          `'${source.canonicalUrl}'. Bind each source to the receipt for that exact page.`,
      );
    }
    // The remaining acquisition facts are runtime-owned. Deriving them from the
    // receipt removes a transcription surface that could only ever produce a
    // mistyped value, while the URL comparison above still proves the pairing.
    derivedSources.set(source.sourceId, {
      ...source,
      canonicalUrl: receipt.canonicalUrl,
      accessMethod: receipt.method,
      observedAt: receipt.observedAt,
      contentSha256: receipt.contentSha256,
    });
    const expectedContentPath = [
      "research",
      "acquisitions",
      packet.assignmentId,
      source.observationReceiptId,
      "content.md",
    ].join("/");
    if (receipt.contentRelativePath !== expectedContentPath) {
      throw new Error(
        `Observation receipt '${source.observationReceiptId}' does not reference runtime-owned acquisition content.`,
      );
    }
    const content = readRuntimeOwnedFile({
      assignmentPath,
      relativePath: receipt.contentRelativePath,
      maximumBytes: MAX_OBSERVED_CONTENT_BYTES,
      label: `Observed content for receipt '${source.observationReceiptId}'`,
    });
    if (content.byteLength !== receipt.contentBytes) {
      throw new Error(
        `Observation receipt '${source.observationReceiptId}' content byte count does not match the runtime-owned file.`,
      );
    }
    const actualHash = crypto
      .createHash("sha256")
      .update(content)
      .digest("hex");
    if (actualHash !== receipt.contentSha256) {
      throw new Error(
        `Observation receipt '${source.observationReceiptId}' content hash does not match the runtime-owned file.`,
      );
    }
    receiptContent.set(source.observationReceiptId, content.toString("utf8"));
    receiptUrl.set(source.observationReceiptId, receipt.canonicalUrl);
  }

  const boundExcerpts = new Map<string, string>();
  for (const claim of packet.findings) {
    for (const link of claim.evidenceLinks) {
      const observedContent = receiptContent.get(link.observationReceiptId);
      if (!observedContent) {
        throw new Error(
          `Claim '${claim.claimId}' cites observation receipt '${link.observationReceiptId}', which is not bound to any usable acquired source in this packet.`,
        );
      }
      const bound = bindObservedExcerpt(observedContent, link.observedExcerpt);
      if (bound !== undefined) {
        boundExcerpts.set(
          `${claim.claimId}\u0000${link.observationReceiptId}\u0000${link.observedExcerpt}`,
          bound,
        );
        continue;
      }
      const verbatimReceiptId = findVerbatimReceipt(
        receiptContent,
        link.observationReceiptId,
        link.observedExcerpt,
      );
      if (verbatimReceiptId !== undefined) {
        throw new Error(
          `Claim '${claim.claimId}' excerpt is verbatim in observation receipt ` +
            `'${verbatimReceiptId}'${receiptUrl.get(verbatimReceiptId)
              ? ` (${receiptUrl.get(verbatimReceiptId)})`
              : ''}, not in the cited receipt ` +
            `'${link.observationReceiptId}'${receiptUrl.get(link.observationReceiptId)
              ? ` (${receiptUrl.get(link.observationReceiptId)})`
              : ''}. Bind this evidence link to the receipt whose observation ` +
            "contains the quotation.",
        );
      }
      throw new Error(
        `Claim '${claim.claimId}' excerpt was not found in observation receipt ` +
          `'${link.observationReceiptId}'. ` +
          describeExcerptDivergence(observedContent, link.observedExcerpt),
      );
    }
  }

  // Republish every bound quotation in the observation's own spelling.
  const boundFindings = packet.findings.map((claim) => ({
    ...claim,
    evidenceLinks: claim.evidenceLinks.map((link) => {
      const bound = boundExcerpts.get(
        `${claim.claimId}\u0000${link.observationReceiptId}\u0000${link.observedExcerpt}`,
      );
      return bound === undefined ? link : { ...link, observedExcerpt: bound };
    }),
  }));
  const boundSources = packet.sources.map(
    (source) => derivedSources.get(source.sourceId) ?? source,
  );
  // The parser leaves runtime-derived fields empty for receipt-backed sources
  // because the loop above always fills them. Fail loudly rather than let an
  // empty digest or observation time reach the evidence graph if that ever
  // stops being true.
  for (const source of boundSources) {
    if (source.status !== "usable" || source.accessMethod === "web.search") {
      continue;
    }
    if (!source.contentSha256 || !source.observedAt) {
      throw new Error(
        `Source '${source.sourceId}' was not bound to its runtime observation receipt.`,
      );
    }
  }
  assertAcquiredSourceIndependence(
    boundSources.filter(
      (source) =>
        source.status === "usable" && source.accessMethod !== "web.search",
    ),
  );
  return { ...packet, findings: boundFindings, sources: boundSources };
}

function normalizeObservedEvidence(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * Comparison key for a quotation and its observed content.
 *
 * Case is typography, not evidence: a worker quoting a span that begins
 * mid-sentence legitimately capitalizes its first letter, and rejecting that
 * costs a whole research lane over one character. Folding case cannot make a
 * quotation from one page match a different page, so it removes a clerical
 * failure without weakening the binding. Contiguity is deliberately *not*
 * relaxed — a paraphrase must still fail.
 */
function compareObservedEvidence(value: string): string {
  return foldObservedEvidence(value).folded;
}

/**
 * Fold one string to its comparison form, keeping a map back to the readable
 * text so a matched span can be quoted in the observation's own spelling.
 *
 * `sourceIndex[i]` is the offset in the normalized (readable) string that
 * produced `folded[i]`. The fold both drops characters (spacing the
 * page-to-Markdown conversion left before punctuation) and can expand them
 * (case folding is not always length-stable), so offsets do not survive it and
 * the map is what makes the repair in `bindObservedExcerpt` possible.
 *
 * The `**` rule is not backward compatible in one direction: an excerpt that
 * splits a `**` pair (source `aaaa**`, excerpt `aaaa*`), or that is nothing
 * but delimiters, bound under the flanking-rule pairing this replaced and does
 * not bind now, so a packet already stored with an excerpt of either shape
 * stops re-parsing. Accepted because a stored excerpt is the observation span
 * its quotation bound to, and that span begins and ends on the quotation's own
 * first and last folded characters: only a worker who quoted half a `**`, or
 * nothing but `**`, could have stored one.
 */
function foldObservedEvidence(
  value: string,
): { readonly readable: string; readonly folded: string; readonly sourceIndex: readonly number[] } {
  const readable = normalizeObservedEvidence(value);
  const markdownStrongDelimiterOffsets = findMarkdownStrongDelimiterOffsets(readable);
  const folded: string[] = [];
  const sourceIndex: number[] = [];
  for (let index = 0; index < readable.length; index += 1) {
    const character = readable.charAt(index);
    // Acquired Markdown can retain strong-emphasis delimiters around visible
    // prose. Both asterisks of every `**` pair are dropped wherever that pair
    // falls, whether or not the quotation covers the whole emphasized span.
    if (markdownStrongDelimiterOffsets.has(index)) continue;
    // Spacing around punctuation is a conversion artifact, and removing it
    // cannot make one page's quotation match another's.
    if (/\s/u.test(character) && /[,.;:!?]/u.test(readable[index + 1] ?? "")) {
      continue;
    }
    for (const lowered of character.toLowerCase()) {
      folded.push(lowered);
      sourceIndex.push(index);
    }
  }
  return { readable, folded: folded.join(""), sourceIndex };
}

/**
 * Offsets of both asterisks of every `**` pair in a readable string.
 *
 * Strong emphasis is presentation, not evidence, and a quotation may begin or
 * end anywhere inside an emphasized span. Pairing the delimiters by
 * CommonMark's flanking rules therefore only decides which orphaned `**`
 * breaks the next read of a packet the runtime itself wrote, so every pair is
 * dropped regardless of what surrounds it.
 *
 * The scan is greedy and left to right, so an odd asterisk left over by a
 * longer run survives: `***important***` folds to `*important*`, and single
 * `*` or `_` emphasis is not touched at all. A quotation of what those render
 * still fails to bind — but only on its first read, where the worker can
 * requote from the stored observation. The round-trip break this closes is the
 * one no requote survives, because the excerpt that fails to re-parse is the
 * span the runtime itself persisted.
 *
 * Dropping pairs also folds exponent syntax such as `2**10`. That trade-off is
 * accepted because folding in this direction only relaxes presentational
 * matching, and a bound link is republished as the observation's own verbatim
 * span rather than as the worker's transcription.
 */
function findMarkdownStrongDelimiterOffsets(value: string): ReadonlySet<number> {
  const offsets = new Set<number>();
  for (let index = 0; index < value.length - 1; index += 1) {
    if (value[index] !== "*" || value[index + 1] !== "*") continue;
    offsets.add(index);
    offsets.add(index + 1);
    index += 1;
  }
  return offsets;
}

/**
 * Bind one quotation to its observation and return the observation's own text.
 *
 * The worker still types the excerpt, so it may differ from the stored page in
 * capitalization or conversion spacing. Once it binds, the runtime's copy is
 * the authoritative one: publishing that instead of the transcription means
 * nothing downstream reads model-typed evidence.
 */
function bindObservedExcerpt(
  observedContent: string,
  excerpt: string,
): string | undefined {
  const content = foldObservedEvidence(observedContent);
  const target = foldObservedEvidence(excerpt);
  if (target.folded.length === 0) return undefined;
  const start = content.folded.indexOf(target.folded);
  if (start === -1) return undefined;
  const readableStart = content.sourceIndex[start];
  const readableEnd = content.sourceIndex[start + target.folded.length - 1];
  if (readableStart === undefined || readableEnd === undefined) return undefined;
  return content.readable.slice(readableStart, readableEnd + 1);
}

function assertAcquiredSourceIndependence(
  sources: readonly EvidencePacket["sources"][number][],
): void {
  const sourceByUrl = new Map<string, string>();
  const independenceByHost = new Map<string, string>();
  for (const source of sources) {
    const existingSourceId = sourceByUrl.get(source.canonicalUrl);
    if (existingSourceId && existingSourceId !== source.sourceId) {
      throw new Error(
        `Usable sources '${existingSourceId}' and '${source.sourceId}' reuse the same canonical URL and cannot count as independent evidence.`,
      );
    }
    sourceByUrl.set(source.canonicalUrl, source.sourceId);
    const hostname = new URL(source.canonicalUrl).hostname.toLowerCase();
    const existingKey = independenceByHost.get(hostname);
    if (existingKey && existingKey !== source.independenceKey) {
      throw new Error(
        `Usable sources on hostname '${hostname}' must use the same independenceKey.`,
      );
    }
    independenceByHost.set(hostname, source.independenceKey);
  }
}

function parseRuntimeObservationReceipt(
  value: unknown,
): RuntimeObservationReceipt {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Observation receipt must be an object.");
  }
  const input = value as Record<string, unknown>;
  const required = [
    "schemaVersion",
    "receiptId",
    "sessionId",
    "runId",
    "assignmentId",
    "activityScopeId",
    "activityId",
    "agentPath",
    "method",
    "requestedUrl",
    "finalUrl",
    "canonicalUrl",
    "mediaType",
    "observedAt",
    "contentRelativePath",
    "contentSha256",
    "contentBytes",
    "quality",
    "attempts",
  ] as const;
  const allowed = new Set<string>([
    ...required,
    "title",
    "provider",
    "agentDisplayName",
    "normalizedMediaType",
    "qualityReport",
    "sourceMetadata",
    "representations",
    "rawSource",
    "rawOmissionReason",
  ]);
  if (Object.keys(input).some((key) => !allowed.has(key))) {
    throw new Error("Observation receipt contains an unknown field.");
  }
  if (required.some((field) => !(field in input))) {
    throw new Error("Observation receipt is missing a required field.");
  }
  if (!isSupportedSourceObservationReceiptVersion(input.schemaVersion)) {
    throw new Error("Observation receipt uses an unsupported schema version.");
  }
  for (const field of [
    "receiptId",
    "sessionId",
    "runId",
    "assignmentId",
    "activityScopeId",
    "activityId",
  ] as const) {
    if (typeof input[field] !== "string" || !isSafePathSegment(input[field])) {
      throw new Error(
        `Observation receipt ${field} must be a safe identifier.`,
      );
    }
  }
  for (const field of [
    "agentPath",
    "method",
    "requestedUrl",
    "finalUrl",
    "canonicalUrl",
    "mediaType",
    "observedAt",
    "contentRelativePath",
    "contentSha256",
  ] as const) {
    if (
      typeof input[field] !== "string" ||
      !input[field].trim() ||
      input[field].includes("\0")
    ) {
      throw new Error(
        `Observation receipt ${field} must be a non-empty string.`,
      );
    }
  }
  if (
    input.title !== undefined &&
    (typeof input.title !== "string" || input.title.includes("\0"))
  ) {
    throw new Error("Observation receipt title must be a string.");
  }
  if (
    input.agentDisplayName !== undefined &&
    (typeof input.agentDisplayName !== "string" ||
      !input.agentDisplayName.trim() ||
      input.agentDisplayName.includes("\0"))
  ) {
    throw new Error(
      "Observation receipt agentDisplayName must be a non-empty string.",
    );
  }
  if (
    input.provider !== undefined &&
    (typeof input.provider !== "string" ||
      !input.provider.trim() ||
      input.provider.includes("\0"))
  ) {
    throw new Error("Observation receipt provider must be a non-empty string.");
  }
  if (
    !Number.isFinite(Date.parse(input.observedAt as string)) ||
    new Date(input.observedAt as string).toISOString() !== input.observedAt
  ) {
    throw new Error(
      "Observation receipt observedAt must be a canonical ISO timestamp.",
    );
  }
  if (!/^[a-f0-9]{64}$/.test(input.contentSha256 as string)) {
    throw new Error(
      "Observation receipt contentSha256 must be a lowercase SHA-256 digest.",
    );
  }
  if (!RECEIPT_ACQUISITION_METHODS.has(input.method as AcquisitionMethod)) {
    throw new Error("Observation receipt acquisition method is unsupported.");
  }
  for (const field of ["requestedUrl", "finalUrl", "canonicalUrl"] as const) {
    let parsed: URL;
    try {
      parsed = new URL(input[field] as string);
    } catch {
      throw new Error(`Observation receipt ${field} must be an HTTP URL.`);
    }
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password ||
      parsed.hash
    ) {
      throw new Error(
        `Observation receipt ${field} must be a canonical HTTP URL.`,
      );
    }
  }
  if (input.quality !== "usable") {
    throw new Error("Observation receipt must represent usable evidence.");
  }
  if (
    !Array.isArray(input.attempts) ||
    input.attempts.length < 1 ||
    input.attempts.length > 10 ||
    input.attempts.some((attempt) => !isRuntimeAcquisitionAttempt(attempt))
  ) {
    throw new Error("Observation receipt acquisition attempts are invalid.");
  }
  if (
    !Number.isSafeInteger(input.contentBytes) ||
    Number(input.contentBytes) < 1 ||
    Number(input.contentBytes) > MAX_OBSERVED_CONTENT_BYTES
  ) {
    throw new Error(
      "Observation receipt contentBytes is outside the supported range.",
    );
  }
  const relativePath = input.contentRelativePath as string;
  const expectedRelativePath = [
    "research",
    "acquisitions",
    input.activityScopeId as string,
    input.activityId as string,
    "content.md",
  ].join("/");
  if (
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..") ||
    relativePath !== expectedRelativePath
  ) {
    throw new Error("Observation receipt contentRelativePath is unsafe.");
  }
  return {
    // Kept as stored. Collapsing an unrecognised version to the legacy one
    // would relabel every receipt written at the previous current version.
    schemaVersion: requireReceiptVersion(input.schemaVersion),
    receiptId: requireReceiptString(input.receiptId),
    sessionId: requireReceiptString(input.sessionId),
    runId: requireReceiptString(input.runId),
    assignmentId: requireReceiptString(input.assignmentId),
    activityScopeId: requireReceiptString(input.activityScopeId),
    activityId: requireReceiptString(input.activityId),
    agentPath: requireReceiptString(input.agentPath),
    method: parseReceiptAcquisitionMethod(input.method),
    requestedUrl: requireReceiptString(input.requestedUrl),
    finalUrl: requireReceiptString(input.finalUrl),
    canonicalUrl: requireReceiptString(input.canonicalUrl),
    mediaType: requireReceiptString(input.mediaType),
    observedAt: requireReceiptString(input.observedAt),
    contentRelativePath: relativePath,
    contentSha256: requireReceiptString(input.contentSha256),
    contentBytes: requirePositiveSafeInteger(input.contentBytes),
    quality: "usable",
    attempts: input.attempts.filter(isRuntimeAcquisitionAttempt),
    ...(input.agentDisplayName === undefined
      ? {}
      : { agentDisplayName: requireReceiptString(input.agentDisplayName) }),
    ...(input.provider === undefined
      ? {}
      : { provider: requireReceiptString(input.provider) }),
    ...(input.title === undefined
      ? {}
      : { title: requireReceiptString(input.title) }),
    ...(input.rawOmissionReason === undefined
      ? {}
      : { rawOmissionReason: requireReceiptString(input.rawOmissionReason) }),
    ...(input.normalizedMediaType === undefined
      ? {}
      : input.normalizedMediaType === "text/markdown"
        ? { normalizedMediaType: input.normalizedMediaType }
        : invalidObservationReceiptNormalizedMediaType()),
    ...(input.qualityReport === undefined
      ? {}
      : { qualityReport: input.qualityReport }),
    ...(input.sourceMetadata === undefined
      ? {}
      : { sourceMetadata: input.sourceMetadata }),
    ...(input.representations === undefined
      ? {}
      : { representations: input.representations }),
    ...(input.rawSource === undefined ? {} : { rawSource: input.rawSource }),
  };
}

function invalidObservationReceiptNormalizedMediaType(): never {
  throw new Error("Observation receipt normalized media type is invalid.");
}

function requireReceiptString(value: unknown): string {
  if (typeof value !== "string")
    throw new Error("Observation receipt string field is invalid.");
  return value;
}

function requirePositiveSafeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new Error("Observation receipt integer field is invalid.");
  return Number(value);
}

function parseReceiptAcquisitionMethod(value: unknown): AcquisitionMethod {
  switch (value) {
    case "direct-http":
    case "direct-http-proxied":
    case "managed-browser":
    case "managed-browser-proxied":
    case "managed-reader":
    case "cloud-browser":
    case "document-parser":
      return value;
    default:
      throw new Error("Observation receipt acquisition method is unsupported.");
  }
}

function requireReceiptVersion(
  value: unknown,
): SourceObservationReceiptVersion {
  if (!isSupportedSourceObservationReceiptVersion(value)) {
    throw new Error("Observation receipt uses an unsupported schema version.");
  }
  return value;
}

function isRuntimeAcquisitionAttempt(
  value: unknown,
): value is AcquisitionAttempt {
  // The shared domain guard, so a receipt this reader accepts is exactly one the
  // capability boundary would accept too.
  return isAcquisitionAttempt(value);
}

function deriveRuntimeAssignmentIdentity(assignmentPath: string): {
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
} {
  const resolvedPath = path.resolve(assignmentPath);
  const rootStats = fs.lstatSync(resolvedPath);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) {
    throw new Error(
      "Receipt-backed research assignment must be a regular directory.",
    );
  }
  const canonicalPath = fs.realpathSync(resolvedPath);
  const resolvedLocation = parseRuntimeAssignmentPath(resolvedPath);
  const canonicalLocation = parseRuntimeAssignmentPath(canonicalPath);
  if (
    !resolvedLocation ||
    !canonicalLocation ||
    resolvedLocation.sessionId !== canonicalLocation.sessionId ||
    resolvedLocation.runId !== canonicalLocation.runId ||
    resolvedLocation.assignmentId !== canonicalLocation.assignmentId
  ) {
    throw new Error(
      "Receipt-backed research assignment path must be canonical and contain no symbolic links.",
    );
  }
  for (const directory of resolvedLocation.controlledDirectories) {
    const stats = fs.lstatSync(directory);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(
        "Receipt-backed research assignment path must be canonical and contain no symbolic links.",
      );
    }
  }
  return {
    sessionId: canonicalLocation.sessionId,
    runId: canonicalLocation.runId,
    assignmentId: canonicalLocation.assignmentId,
  };
}

function parseRuntimeAssignmentPath(candidatePath: string): {
  readonly sessionId: string;
  readonly runId: string;
  readonly assignmentId: string;
  readonly controlledDirectories: readonly string[];
} | null {
  const assignmentId = path.basename(candidatePath);
  const assignmentsDirectory = path.dirname(candidatePath);
  const runDirectory = path.dirname(assignmentsDirectory);
  const runId = path.basename(runDirectory);
  const runsDirectory = path.dirname(runDirectory);
  const sessionDirectory = path.dirname(runsDirectory);
  const sessionId = path.basename(sessionDirectory);
  const sessionsDirectory = path.dirname(sessionDirectory);
  if (
    path.basename(assignmentsDirectory) !== "assignments" ||
    path.basename(runsDirectory) !== "runs" ||
    path.basename(sessionsDirectory) !== "sessions" ||
    ![assignmentId, runId, sessionId].every(isSafePathSegment)
  ) {
    return null;
  }
  return {
    sessionId,
    runId,
    assignmentId,
    controlledDirectories: [
      sessionsDirectory,
      sessionDirectory,
      runsDirectory,
      runDirectory,
      assignmentsDirectory,
      candidatePath,
    ],
  };
}

function readRuntimeOwnedJson(input: {
  readonly assignmentPath: string;
  readonly relativePath: string;
  readonly maximumBytes: number;
  readonly label: string;
}): unknown {
  const content = readRuntimeOwnedFile(input);
  try {
    return JSON.parse(content.toString("utf8"));
  } catch (error) {
    throw new Error(
      `${input.label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readRuntimeOwnedFile(input: {
  readonly assignmentPath: string;
  readonly relativePath: string;
  readonly maximumBytes: number;
  readonly label: string;
}): Buffer {
  const candidatePath = resolveRelativePathInside(
    input.assignmentPath,
    input.relativePath,
  );
  if (!candidatePath) throw new Error(`${input.label} path is unsafe.`);
  assertNoSymlinkSegments(input.assignmentPath, candidatePath, input.label);
  const artifactPath = resolveExistingPathInside(
    input.assignmentPath,
    candidatePath,
  );
  if (!artifactPath) throw new Error(`${input.label} does not exist.`);
  const stats = fs.statSync(artifactPath);
  if (!stats.isFile())
    throw new Error(`${input.label} must be a regular file.`);
  if (stats.size > input.maximumBytes) {
    throw new Error(
      `${input.label} exceeds its ${input.maximumBytes}-byte limit.`,
    );
  }
  return fs.readFileSync(artifactPath);
}

function assertNoSymlinkSegments(
  assignmentPath: string,
  candidatePath: string,
  label: string,
): void {
  const root = path.resolve(assignmentPath);
  const relative = path.relative(root, path.resolve(candidatePath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} path is unsafe.`);
  }
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stats: fs.Stats;
    try {
      stats = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`${label} does not exist.`);
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} path must not contain symbolic links.`);
    }
  }
}

/**
 * Every JSON object a critic response could be carrying, in the order a reader
 * would try them: the whole answer, then each Markdown fenced block, then each
 * outermost balanced `{...}` span.
 *
 * The brace scan is string- and escape-aware, so a brace inside a message field
 * never splits the object around it. Scanning is linear in response length.
 */
function enumerateJsonCandidates(text: string): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (candidate: string): void => {
    const trimmed = candidate.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    candidates.push(trimmed);
  };

  add(text);
  for (const match of text.matchAll(/```[^\n]*\n([\s\S]*?)```/g)) {
    add(match[1] ?? "");
  }

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
      continue;
    }
    if (character === "}" && depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        add(text.slice(start, index + 1));
        start = -1;
      }
    }
  }
  return candidates;
}

/**
 * Accept the strict wire shape the provider schema asks for alongside the
 * canonical shape, which omits absent optional values instead of sending
 * neutral ones.
 *
 * Only two neutral values mean "absent": an empty `correctionRoute` and an
 * empty correction `question`, neither of which the contract can express as a
 * value. An empty `requirementIds` is a real answer — this finding targets no
 * deterministic requirement — so it stays the empty array it arrived as.
 * Nothing else is touched: an unknown field or an invalid enum reaches
 * `parseQualityVerdict` exactly as it was sent, for it to reject.
 */
function normalizeProviderQualityVerdict(value: unknown): unknown {
  if (!isPlainRecord(value)) return value;
  const verdict: Record<string, unknown> = { ...value };
  if (verdict.correctionRoute === "") delete verdict.correctionRoute;
  if (Array.isArray(verdict.correctionRequests)) {
    verdict.correctionRequests = verdict.correctionRequests.map((request) => {
      if (!isPlainRecord(request) || request.question !== "") return request;
      const { question: _question, ...rest } = request;
      return rest;
    });
  }
  return verdict;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Everything a critic verdict is judged against, read once per response.
 *
 * Reading it per candidate would re-read the same four artifacts for every
 * object found in the response, and these checks are properties of the
 * assignment rather than of any one candidate.
 */
interface QualityAssignmentContext {
  readonly plan: ReturnType<typeof assertResearchPlanApproved>;
  readonly expectedWave: number;
  readonly taskIds: ReadonlySet<string>;
  readonly sectionIds: ReadonlySet<string>;
  readonly claimIds: ReadonlySet<string>;
  readonly sourceIds: ReadonlySet<string>;
  readonly deterministic: ReturnType<typeof parseQualityVerdict>;
}

function readQualityAssignmentContext(input: {
  readonly assignmentPath: string;
  readonly planArtifact?: string;
}): QualityAssignmentContext {
  const planArtifact = input.planArtifact ?? "research/approved-plan.json";
  const plan = assertResearchPlanApproved(
    readJsonArtifact({
      assignmentPath: input.assignmentPath,
      relativePath: planArtifact,
      maximumBytes: MAX_PLAN_BYTES,
      label: "Deep Research plan",
    }),
  );
  const expectedWave = currentCorrectionWave(input.assignmentPath);
  const qualityPacket = readJsonArtifact({
    assignmentPath: input.assignmentPath,
    relativePath: QUALITY_PACKET_PATH,
    maximumBytes: MAX_PLAN_BYTES,
    label: "Deep Research quality packet",
  });
  if (!isPlainRecord(qualityPacket)) {
    throw new Error("Deep Research quality packet must be an object.");
  }
  const synthesis = qualityPacket.synthesis;
  if (qualityPacket.planId !== plan.planId || !isPlainRecord(synthesis)) {
    throw new Error(
      "Deep Research quality packet does not match the approved plan.",
    );
  }
  const deterministic = parseQualityVerdict(
    readJsonArtifact({
      assignmentPath: input.assignmentPath,
      relativePath: DETERMINISTIC_VERDICT_PATH,
      maximumBytes: MAX_PLAN_BYTES,
      label: "Deterministic quality verdict",
    }),
  );
  if (deterministic.correctionWave !== expectedWave) {
    throw new Error(
      "Deterministic quality verdict is stale for the current correction wave.",
    );
  }
  return {
    plan,
    expectedWave,
    taskIds: new Set(plan.tasks.map((task) => task.id)),
    sectionIds: new Set(plan.sections.map((section) => section.id)),
    claimIds: collectRecordIds(synthesis.claims, "claimId"),
    sourceIds: collectRecordIds(synthesis.sources, "sourceId"),
    deterministic,
  };
}

function collectRecordIds(value: unknown, key: string): ReadonlySet<string> {
  if (!Array.isArray(value)) return new Set();
  return new Set(
    value.flatMap((entry) =>
      isPlainRecord(entry) && typeof entry[key] === "string"
        ? [entry[key]]
        : [],
    ),
  );
}

/**
 * The assignment-specific half of the contract: a verdict must be for this
 * correction wave, may only name identities the approved plan and quality
 * packet contain, and may not soften a deterministic blocker.
 */
function assertQualityVerdictFitsAssignment(
  verdict: ReturnType<typeof parseQualityVerdict>,
  assignment: QualityAssignmentContext,
): void {
  const { expectedWave, taskIds, sectionIds, claimIds, sourceIds, deterministic } =
    assignment;
  if (verdict.correctionWave !== expectedWave) {
    throw new Error(`Quality verdict correctionWave must be ${expectedWave}.`);
  }
  for (const finding of verdict.findings) {
    if (finding.taskIds.some((taskId) => !taskIds.has(taskId))) {
      throw new Error(
        "Quality verdict finding references an unknown research task.",
      );
    }
    if (finding.sectionIds.some((sectionId) => !sectionIds.has(sectionId))) {
      throw new Error(
        "Quality verdict finding references an unknown research section.",
      );
    }
    if (finding.claimIds.some((claimId) => !claimIds.has(claimId))) {
      throw new Error(
        "Quality verdict finding references an unknown research claim.",
      );
    }
    if (finding.sourceIds.some((sourceId) => !sourceIds.has(sourceId))) {
      throw new Error(
        "Quality verdict finding references an unknown research source.",
      );
    }
  }
  for (const request of verdict.correctionRequests) {
    if (
      request.taskIds.length === 0 ||
      request.taskIds.some((taskId) => !taskIds.has(taskId))
    ) {
      throw new Error(
        "Every quality correction must target at least one approved research task.",
      );
    }
    if (request.sectionIds.some((sectionId) => !sectionIds.has(sectionId))) {
      throw new Error(
        "Quality correction references an unknown research section.",
      );
    }
    if (request.claimIds.some((claimId) => !claimIds.has(claimId))) {
      throw new Error(
        "Quality correction references an unknown research claim.",
      );
    }
  }
  if (verdict.decision === "APPROVE" && deterministic.decision !== "APPROVE") {
    throw new Error(
      "Evidence critic cannot approve while deterministic evidence blockers remain.",
    );
  }
  if (verdict.decision === "REVISE") {
    const requestedTasks = new Set(
      verdict.correctionRequests.flatMap((request) => request.taskIds),
    );
    const deterministicTasks = new Set(
      deterministic.findings
        .filter((finding) => finding.severity === "blocking")
        .flatMap((finding) => finding.taskIds),
    );
    for (const taskId of deterministicTasks) {
      if (!requestedTasks.has(taskId)) {
        throw new Error(
          `Quality correction must include deterministic blocker task '${taskId}'.`,
        );
      }
    }
  }
}

/** Validate the factual critic's machine verdict before it can control gates. */
export function parseDeepResearchQualityReviewResult(input: {
  readonly text: string;
  readonly assignmentPath: string;
  readonly planArtifact?: string;
}): ReturnType<typeof parseQualityVerdict> {
  if (Buffer.byteLength(input.text, "utf8") > MAX_QUALITY_RESPONSE_BYTES) {
    throw new Error(
      `Evidence critic response is too large; the limit is ${MAX_QUALITY_RESPONSE_BYTES} bytes.`,
    );
  }
  // Every syntactic candidate first, so a response that carries no JSON at all
  // fails before the assignment's artifacts are read.
  const parsedCandidates: unknown[] = [];
  for (const candidate of enumerateJsonCandidates(input.text)) {
    try {
      parsedCandidates.push(JSON.parse(candidate));
    } catch {
      // Prose around the object is expected; only the objects are candidates.
    }
  }
  if (parsedCandidates.length === 0) {
    throw new Error(
      "Evidence critic response must contain only one valid QualityVerdict JSON object.",
    );
  }

  const assignment = readQualityAssignmentContext({
    assignmentPath: input.assignmentPath,
    ...(input.planArtifact === undefined
      ? {}
      : { planArtifact: input.planArtifact }),
  });

  // A candidate counts as valid only once it has passed both the contract and
  // this assignment's own checks. Judging on the contract alone would let a
  // verdict that names an unknown task make a genuinely valid verdict beside it
  // look ambiguous, and would stop a good verdict from being found at all.
  const accepted: Array<ReturnType<typeof parseQualityVerdict>> = [];
  const canonical = new Set<string>();
  let firstValidationFailure: unknown;
  for (const parsed of parsedCandidates) {
    let verdict: ReturnType<typeof parseQualityVerdict>;
    try {
      verdict = parseQualityVerdict(normalizeProviderQualityVerdict(parsed));
      assertQualityVerdictFitsAssignment(verdict, assignment);
    } catch (error) {
      firstValidationFailure ??= error;
      continue;
    }
    // Two spellings of the same audit — a fence and the prose copy beside it —
    // are one answer, not a disagreement.
    const identity = JSON.stringify(verdict);
    if (canonical.has(identity)) continue;
    canonical.add(identity);
    accepted.push(verdict);
  }
  if (accepted.length > 1) {
    throw new Error(
      "Evidence critic response must contain exactly one valid QualityVerdict JSON object.",
    );
  }
  const verdict = accepted[0];
  if (!verdict) {
    if (firstValidationFailure !== undefined) throw firstValidationFailure;
    throw new Error(
      "Evidence critic response must contain only one valid QualityVerdict JSON object.",
    );
  }
  const { plan, expectedWave, deterministic } = assignment;
  const mergedFindings = mergeQualityFindings([
    ...deterministic.findings,
    ...verdict.findings,
  ]);
  const hasBlockingFindings = mergedFindings.some(
    (finding) => finding.severity === "blocking",
  );
  const decision =
    verdict.decision === "ESCALATE"
      ? "ESCALATE"
      : hasBlockingFindings || verdict.decision === "REVISE"
        ? "REVISE"
        : "APPROVE";
  const correctionRequests =
    decision === "REVISE"
      ? mergeCorrectionRequests([
          ...deterministic.correctionRequests,
          ...verdict.correctionRequests,
        ])
      : [];
  const correctionRoute =
    decision === "REVISE" &&
    correctionRequests.every((request) => request.type === "resynthesize")
      ? "synthesis"
      : decision === "REVISE"
        ? "research"
        : undefined;
  const authoritative = parseQualityVerdict({
    schemaVersion: 1,
    verdictId: `authoritative-${expectedWave}-${hashResearchValue({
      decision,
      mergedFindings,
      correctionRequests,
      reviewedAt: verdict.reviewedAt,
    }).slice(0, 12)}`,
    correctionWave: expectedWave,
    decision,
    findings: mergedFindings,
    correctionRequests,
    ...(correctionRoute === undefined ? {} : { correctionRoute }),
    reviewedAt: verdict.reviewedAt,
  });
  const adaptive = applyAdaptiveResearchPolicy({
    plan,
    verdict: authoritative,
  });
  persistAdaptiveResearchArtifacts({
    assignmentPath: input.assignmentPath,
    plan,
    sourceVerdict: authoritative,
    adaptive,
  });
  return adaptive.verdict;
}

export function persistVersionedDeepResearchQualityVerdict(input: {
  readonly assignmentPath: string;
  readonly verdict: ReturnType<typeof parseQualityVerdict>;
}): string {
  const relativePath = `research/quality/verdict-wave-${input.verdict.correctionWave}.json`;
  writeImmutableCanonicalJson(
    input.assignmentPath,
    relativePath,
    input.verdict,
  );
  const decisionPath = `research/adaptive/decision-wave-${input.verdict.correctionWave}.json`;
  if (
    readOptionalJsonArtifact({
      assignmentPath: input.assignmentPath,
      relativePath: decisionPath,
      maximumBytes: MAX_PLAN_BYTES,
      label: "Deep Research adaptive decision",
    }) === undefined
  ) {
    const plan = assertResearchPlanApproved(
      readJsonArtifact({
        assignmentPath: input.assignmentPath,
        relativePath: "research/approved-plan.json",
        maximumBytes: MAX_PLAN_BYTES,
        label: "Deep Research plan",
      }),
    );
    const adaptive = applyAdaptiveResearchPolicy({
      plan,
      verdict: input.verdict,
    });
    persistAdaptiveResearchArtifacts({
      assignmentPath: input.assignmentPath,
      plan,
      sourceVerdict: input.verdict,
      adaptive,
    });
  }
  return relativePath;
}

function persistAdaptiveResearchArtifacts(input: {
  readonly assignmentPath: string;
  readonly plan: ReturnType<typeof assertResearchPlanApproved>;
  readonly sourceVerdict: ReturnType<typeof parseQualityVerdict>;
  readonly adaptive: ReturnType<typeof applyAdaptiveResearchPolicy>;
}): void {
  const wave = input.sourceVerdict.correctionWave;
  writeImmutableCanonicalJson(
    input.assignmentPath,
    `research/adaptive/source-verdict-wave-${wave}.json`,
    input.sourceVerdict,
  );
  const decisionPath = `research/adaptive/decision-wave-${wave}.json`;
  writeImmutableCanonicalJson(
    input.assignmentPath,
    decisionPath,
    input.adaptive.decision,
  );
  writeCanonicalJson(
    input.assignmentPath,
    "research/adaptive/current-decision.json",
    input.adaptive.decision,
  );
  if (
    input.adaptive.decision.decision !== "continue" ||
    input.adaptive.verdict.decision !== "REVISE"
  ) {
    return;
  }
  const sourceVerdictPath = `research/quality/verdict-wave-${wave}.json`;
  const amendment = buildResearchPlanAmendment({
    plan: input.plan,
    verdict: input.adaptive.verdict,
    decision: input.adaptive.decision,
    sourceVerdictPath,
  });
  const amendmentPath = `research/amendments/amendment-wave-${amendment.toWave}.json`;
  writeImmutableCanonicalJson(input.assignmentPath, amendmentPath, amendment);
  writeCanonicalJson(
    input.assignmentPath,
    "research/amendments/current.json",
    amendment,
  );
}

/**
 * Fail closed when the adversarial reviewer cannot produce a valid verdict.
 * The deterministic audit remains authoritative evidence, but publication is
 * unsafe without the required qualitative review, so the only valid route is
 * user-visible escalation.
 */
export function buildDeepResearchQualityReviewFailureVerdict(input: {
  readonly assignmentPath: string;
  readonly failureReason?: string;
}): ReturnType<typeof parseQualityVerdict> {
  const plan = assertResearchPlanApproved(
    readJsonArtifact({
      assignmentPath: input.assignmentPath,
      relativePath: "research/approved-plan.json",
      maximumBytes: MAX_PLAN_BYTES,
      label: "Deep Research plan",
    }),
  );
  const deterministic = parseQualityVerdict(
    readJsonArtifact({
      assignmentPath: input.assignmentPath,
      relativePath: DETERMINISTIC_VERDICT_PATH,
      maximumBytes: MAX_PLAN_BYTES,
      label: "Deterministic quality verdict",
    }),
  );
  const expectedWave = currentCorrectionWave(input.assignmentPath);
  if (deterministic.correctionWave !== expectedWave) {
    throw new Error(
      "Deterministic quality verdict is stale for the current correction wave.",
    );
  }
  const unavailableFinding = {
    code: "decision_not_supported" as const,
    severity: "blocking" as const,
    message: [
      "The required adversarial quality review did not complete within its bounded recovery policy, so automatic publication is unsafe.",
      input.failureReason
        ? `Runtime validation detail: ${input.failureReason.replace(/\s+/gu, " ").trim().slice(0, 500)}`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
    taskIds: plan.tasks.map((task) => task.id).sort(),
    sectionIds: plan.sections.map((section) => section.id).sort(),
    claimIds: [],
    sourceIds: [],
  };
  const findings = uniqueByResearchHash([
    ...deterministic.findings,
    unavailableFinding,
  ]);
  return parseQualityVerdict({
    schemaVersion: 1,
    verdictId: `review-unavailable-${deterministic.correctionWave}-${hashResearchValue(
      {
        findings,
        reviewedAt: deterministic.reviewedAt,
      },
    ).slice(0, 12)}`,
    correctionWave: deterministic.correctionWave,
    decision: "ESCALATE",
    findings,
    correctionRequests: [],
    reviewedAt: deterministic.reviewedAt,
  });
}

function uniqueByResearchHash<T>(values: readonly T[]): T[] {
  return [
    ...new Map(
      values.map((value) => [hashResearchValue(value), value]),
    ).values(),
  ];
}

function buildEvidenceResponseContract(input: {
  readonly taskId: string;
  readonly sectionId: string;
  readonly assignmentId: string;
  readonly workerSpecHash: string;
  readonly maximumSources: number;
}): string {
  const browserCallLimit = Math.min(36, Math.max(18, input.maximumSources * 2));
  return [
    "# Required Response Contract",
    "",
    "Return exactly one EvidencePacket JSON object. Do not use Markdown fences or add prose.",
    `Set taskId exactly to "${input.taskId}".`,
    `Set every claim taskId exactly to "${input.taskId}" and every claim sectionId exactly to "${input.sectionId}".`,
    `Set assignmentId exactly to "${input.assignmentId}".`,
    `Set workerSpecHash exactly to "${input.workerSpecHash}".`,
    `The provider turn is time-bounded. Start the final JSON after at most ${browserCallLimit} total acquisition and browser calls, including failed calls, discovery calls, reads, and observations. Never make another web call after that limit.`,
    `Include no more than ${input.maximumSources} usable source records. Stop earlier when the approved coverage is decision-useful; if evidence remains incomplete, return unresolved coverage with stopReason time_limit or insufficient_evidence instead of continuing to browse.`,
    "Reserve substantial turn time for the final JSON. Keep it compact without combining factual components: reuse one atomic finding across multiple coverage entries only when every component is supported by its linked exact excerpts. Never combine capabilities, workflows, controls, modes, scopes, or qualifications merely to reduce the finding count. If a statement names multiple such items, every named capability, workflow, control, mode, scope, or qualification must appear in the linked excerpts; otherwise split the statement into atomic findings or omit unsupported items. Avoid duplicate evidence links and keep each observedExcerpt to at most 500 characters.",
    "Every source assignmentId must equal the packet assignmentId.",
    "For every usable acquired source, copy observationReceiptId exactly from the runtime source observation receipt. Never invent a receipt ID.",
    "Do not send observedAt or contentSha256 on a usable acquired source. The runtime fills both from the receipt you named; a transcribed copy is ignored.",
    "Set canonicalUrl to the page the named receipt was issued for. It is the field that proves the pairing, so a mismatch is rejected.",
    "Every claim must include evidenceLinks. Each link must contain sourceId, observationReceiptId, an exact observedExcerpt of at most 500 characters, a precise locator, and relationship supports, contradicts, or context.",
    "Each observedExcerpt must be one short contiguous passage from one acquired source. Never join separate headings or paragraphs, omit intervening words, or compose a quotation from multiple page regions.",
    "A claim whose status is supported must have at least one evidenceLink whose relationship is supports. Context-only links cannot make a claim supported.",
    "Claim sourceIds must exactly equal the unique sourceIds in its evidenceLinks, and each link receipt must equal that source record observationReceiptId.",
    "Return one coverage entry for every approved coverageRequirements item. Copy requirementId exactly; use satisfied only when the entry maps to the packet claims and sources that establish it.",
    "For every contradiction, set status to resolved or unresolved. A resolved contradiction must include a precise resolution explaining which source governs which dated or scoped fact; never call a contradiction resolved by hiding a source or choosing one without evidence.",
    "For quantitative_value coverage include value, unit, asOf as YYYY-MM-DD or a full canonical UTC timestamp such as YYYY-MM-DDTHH:mm:ss.sssZ, and scope. For unresolved or not_applicable coverage include a precise note. Use empty strings and an empty scope array for optional coverage fields that do not apply.",
    "This unattended research lane cannot approve mutating browser actions such as downloads or form submissions. Use read-only observed page content or another source; record an unresolved question if equivalent evidence is unavailable.",
    "Search-result snippets and web.search records are discovery context only. They cannot appear in claim sourceIds or evidenceLinks and cannot support a claim.",
    "The runtime rejects missing, cross-lane, reused, tampered, or unobserved receipt bindings and excerpts not present verbatim in runtime-owned content.",
  ].join("\n");
}

function readCorrectionContext(
  assignmentPath: string,
  taskId: string,
  approvedPlan: ReturnType<typeof assertResearchPlanApproved>,
):
  | {
      readonly wave: 1 | 2;
      readonly prompt: string;
      readonly minimumDispatchMs: number;
      readonly governedWebEvidenceMode: GovernedWebEvidenceMode;
    }
  | undefined {
  const raw = readOptionalJsonArtifact({
    assignmentPath,
    relativePath: CORRECTION_CONTEXT_PATH,
    maximumBytes: 128 * 1024,
    label: "Deep Research correction context",
  });
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Deep Research correction context must be an object.");
  }
  const context = raw as Record<string, unknown>;
  if (
    context.schemaVersion !== 1 ||
    (context.wave !== 1 && context.wave !== 2) ||
    context.approvedPlanHash !== approvedPlan.approvalHash ||
    typeof context.sourceVerdictPath !== "string" ||
    typeof context.sourceVerdictHash !== "string" ||
    (approvedPlan.executionPolicy !== undefined &&
      (typeof context.amendmentPath !== "string" ||
        typeof context.amendmentHash !== "string"))
  ) {
    throw new Error(
      "Deep Research correction context has an invalid version or wave.",
    );
  }
  const sourceVerdict = parseQualityVerdict(
    readJsonArtifact({
      assignmentPath,
      relativePath: context.sourceVerdictPath,
      maximumBytes: MAX_PLAN_BYTES,
      label: "Deep Research source quality verdict",
    }),
  );
  if (
    sourceVerdict.decision !== "REVISE" ||
    sourceVerdict.correctionWave !== context.wave - 1 ||
    hashResearchValue(sourceVerdict) !== context.sourceVerdictHash
  ) {
    throw new Error(
      "Deep Research correction context is not bound to its source verdict.",
    );
  }
  if (
    typeof context.amendmentPath === "string" &&
    typeof context.amendmentHash === "string"
  ) {
    const amendment = readJsonArtifact({
      assignmentPath,
      relativePath: context.amendmentPath,
      maximumBytes: 256 * 1024,
      label: "Deep Research plan amendment",
    });
    if (
      !amendment ||
      typeof amendment !== "object" ||
      Array.isArray(amendment) ||
      hashResearchValue(amendment) !== context.amendmentHash
    ) {
      throw new Error(
        "Deep Research correction context is not bound to its plan amendment.",
      );
    }
    const amendmentRecord = amendment as Record<string, unknown>;
    if (
      amendmentRecord.schemaVersion !== 1 ||
      amendmentRecord.approvedPlanHash !== approvedPlan.approvalHash ||
      amendmentRecord.sourceVerdictPath !== context.sourceVerdictPath ||
      amendmentRecord.sourceVerdictHash !== context.sourceVerdictHash ||
      amendmentRecord.fromWave !== context.wave - 1 ||
      amendmentRecord.toWave !== context.wave ||
      amendmentRecord.route !== "research" ||
      amendmentRecord.scopeChange !== "none"
    ) {
      throw new Error(
        "Deep Research plan amendment changes an unauthorized execution boundary.",
      );
    }
  }
  if (
    !context.taskRequests ||
    typeof context.taskRequests !== "object" ||
    Array.isArray(context.taskRequests)
  ) {
    throw new Error(
      "Deep Research correction context has no task request map.",
    );
  }
  const requests = (context.taskRequests as Record<string, unknown>)[taskId];
  if (requests === undefined) {
    throw new Error(
      `Research task '${taskId}' is not targeted by the active correction wave.`,
    );
  }
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error(
      `Correction requests for task '${taskId}' must be a non-empty array.`,
    );
  }
  const previousEvidence = readPreviousEvidencePacket(assignmentPath, taskId);
  const requestsArePacketOnly = requests.every(
    (request) =>
      request &&
      typeof request === "object" &&
      !Array.isArray(request) &&
      ["restructure_packet", "resynthesize"].includes(
        String((request as Record<string, unknown>).type),
      ),
  );
  const requestsAreClaimLocal = requests.every(
    (request) =>
      request &&
      typeof request === "object" &&
      !Array.isArray(request) &&
      (request as Record<string, unknown>).impactScope === "local" &&
      Array.isArray((request as Record<string, unknown>).claimIds) &&
      ((request as Record<string, unknown>).claimIds as unknown[]).length > 0,
  );
  return {
    wave: context.wave,
    minimumDispatchMs: requestsArePacketOnly ? 30_000 : 90_000,
    governedWebEvidenceMode: requestsArePacketOnly
      ? "reuse-existing"
      : "acquire",
    prompt: [
      "# Targeted Correction Wave",
      "",
      `This is correction wave ${context.wave}. Return a complete replacement EvidencePacket, not a patch.`,
      "Resolve only these runtime-validated correction requests:",
      JSON.stringify(requests),
      "Treat every acceptance criterion as mandatory. When a criterion permits removing or omitting a claim if stronger evidence cannot be obtained, remove that claim and update coverage, conclusions, contradictions, and unresolved questions consistently. Do not retain an unverifiable candidate merely with a caveat.",
      "Every factual component retained in a claim must be supported by its own exact contiguous evidence link. Remove unsupported components instead of relying on broader source content that the linked excerpt does not contain.",
      ...(requestsAreClaimLocal
        ? [
            "All requests have local claim scope. The prior EvidencePacket below is the binding baseline: copy every finding whose claimId is not named by a request exactly, including all evidence links, and copy every source record used by those findings exactly. Do not renumber, rewrite, prune, or re-observe non-targeted claims or their sources. The runtime rejects any such regression before synthesis.",
            "For each targeted claim, split the final statement into atomic factual clauses and verify that every retained clause has an exact contiguous supporting excerpt before returning the packet.",
          ]
        : []),
      ...(requestsArePacketOnly
        ? [
            "These requests concern packet structure or synthesis only. Reuse the prior runtime-validated claims, sources, receipts, and excerpts; do not browse, re-observe sources, add duplicate source records, or renumber existing sources. Remove unsupported clauses when the prior evidence cannot satisfy the approved requirement.",
          ]
        : []),
      ...(previousEvidence
        ? [
            "",
            "Prior runtime-validated EvidencePacket:",
            JSON.stringify(previousEvidence),
          ]
        : []),
    ].join("\n"),
  };
}

function readPreviousEvidencePacket(
  assignmentPath: string,
  taskId: string,
): EvidencePacket | undefined {
  const manifest = readOptionalJsonArtifact({
    assignmentPath,
    relativePath: EVIDENCE_MANIFEST_PATH,
    maximumBytes: MAX_PLAN_BYTES,
    label: "Deep Research evidence manifest",
  });
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest))
    return undefined;
  const latestByTask = (manifest as Record<string, unknown>).latestByTask;
  if (
    !latestByTask ||
    typeof latestByTask !== "object" ||
    Array.isArray(latestByTask)
  )
    return undefined;
  const relativePath = (latestByTask as Record<string, unknown>)[taskId];
  if (typeof relativePath !== "string") return undefined;
  return parseEvidencePacket(
    readJsonArtifact({
      assignmentPath,
      relativePath,
      maximumBytes: MAX_DEPENDENCY_PACKET_BYTES,
      label: `Prior evidence packet '${taskId}'`,
    }),
  );
}

function parseEvidenceManifest(
  raw: unknown,
  approvedTaskIds: readonly string[],
): Map<string, string> {
  if (raw === undefined) return new Map();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Deep Research evidence manifest must be an object.");
  }
  const manifest = raw as Record<string, unknown>;
  if (
    manifest.schemaVersion !== 1 ||
    !manifest.latestByTask ||
    typeof manifest.latestByTask !== "object" ||
    Array.isArray(manifest.latestByTask)
  ) {
    throw new Error(
      "Deep Research evidence manifest has an invalid structure.",
    );
  }
  const approved = new Set(approvedTaskIds);
  const entries = Object.entries(
    manifest.latestByTask as Record<string, unknown>,
  );
  const result = new Map<string, string>();
  for (const [taskId, relativePath] of entries) {
    if (!approved.has(taskId) || typeof relativePath !== "string") {
      throw new Error(
        "Deep Research evidence manifest contains an unknown task or path.",
      );
    }
    result.set(taskId, relativePath);
  }
  return result;
}

function currentCorrectionWave(assignmentPath: string): 0 | 1 | 2 {
  const raw = readOptionalJsonArtifact({
    assignmentPath,
    relativePath: CORRECTION_CONTEXT_PATH,
    maximumBytes: 128 * 1024,
    label: "Deep Research correction context",
  });
  if (raw === undefined) return 0;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Deep Research correction context must be an object.");
  }
  const wave = (raw as Record<string, unknown>).wave;
  if (wave !== 1 && wave !== 2)
    throw new Error("Deep Research correction wave must be 1 or 2.");
  return wave;
}

function writeCanonicalJson(
  assignmentPath: string,
  relativePath: string,
  value: unknown,
): void {
  const artifactPath = resolveOwnedRunRelativePath({
    assignmentPath,
    relativePath,
    label: "Deep Research artifact",
  });
  writeFileAtomicSync(artifactPath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeImmutableCanonicalJson(
  assignmentPath: string,
  relativePath: string,
  value: unknown,
): void {
  const existing = readOptionalJsonArtifact({
    assignmentPath,
    relativePath,
    maximumBytes: MAX_PLAN_BYTES,
    label: `Immutable Deep Research artifact '${relativePath}'`,
  });
  if (existing !== undefined) {
    if (hashResearchValue(existing) !== hashResearchValue(value)) {
      throw new Error(
        `Immutable Deep Research artifact changed: ${relativePath}`,
      );
    }
    return;
  }
  writeCanonicalJson(assignmentPath, relativePath, value);
}

function removeOwnedRegularArtifact(
  assignmentPath: string,
  relativePath: string,
): void {
  const artifactPath = resolveOwnedRunRelativePath({
    assignmentPath,
    relativePath,
    label: "Stale Deep Research artifact",
  });
  if (!fs.existsSync(artifactPath)) return;
  const stats = fs.lstatSync(artifactPath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(
      `Stale Deep Research artifact must be a regular file: ${relativePath}`,
    );
  }
  fs.rmSync(artifactPath);
}

function buildDependencyDigest(
  assignmentPath: string,
  plan: PlanState,
  approvedDependencyIds: readonly string[],
): string {
  const entries: Array<{
    taskId: string;
    stopReason: EvidencePacket["stopReason"];
    findingCount: number;
    unresolvedQuestionCount: number;
    summary: string;
  }> = [];
  const manifest = readOptionalJsonArtifact({
    assignmentPath,
    relativePath: EVIDENCE_MANIFEST_PATH,
    maximumBytes: MAX_PLAN_BYTES,
    label: "Deep Research evidence manifest",
  });
  const manifestEntries =
    manifest && typeof manifest === "object" && !Array.isArray(manifest)
      ? (manifest as Record<string, unknown>).latestByTask
      : undefined;
  for (const dependencyId of approvedDependencyIds) {
    const dependency = plan.tasks.get(dependencyId);
    const manifestPath =
      manifestEntries &&
      typeof manifestEntries === "object" &&
      !Array.isArray(manifestEntries)
        ? (manifestEntries as Record<string, unknown>)[dependencyId]
        : undefined;
    let dependencyResultFile: string | undefined;
    if (dependency) {
      if (
        dependency.status !== "completed" &&
        dependency.status !== "validated"
      ) {
        throw new Error(
          `Dependency research task '${dependencyId}' is not complete.`,
        );
      }
      dependencyResultFile = dependency.resultFile;
    } else if (typeof manifestPath === "string") {
      dependencyResultFile = manifestPath;
    }
    if (!dependencyResultFile) {
      throw new Error(
        `Dependency research task '${dependencyId}' has no current evidence artifact.`,
      );
    }
    const packet = parseEvidencePacket(
      readJsonArtifact({
        assignmentPath,
        relativePath: dependencyResultFile,
        maximumBytes: MAX_DEPENDENCY_PACKET_BYTES,
        label: `Dependency evidence packet '${dependencyId}'`,
      }),
    );
    if (packet.taskId !== dependencyId) {
      throw new Error(
        `Dependency evidence packet '${dependencyId}' has the wrong task identity.`,
      );
    }
    entries.push({
      taskId: packet.taskId,
      stopReason: packet.stopReason,
      findingCount: packet.findings.length,
      unresolvedQuestionCount: packet.unresolvedQuestions.length,
      summary: [
        packet.shortAnswer,
        ...packet.findings
          .filter((claim) => claim.status !== "removed")
          .map((claim) => claim.statement),
      ].join(" "),
    });
  }
  return serializeBoundedDependencyDigest(entries);
}

function serializeBoundedDependencyDigest(
  entries: ReadonlyArray<{
    readonly taskId: string;
    readonly stopReason: EvidencePacket["stopReason"];
    readonly findingCount: number;
    readonly unresolvedQuestionCount: number;
    readonly summary: string;
  }>,
): string {
  if (entries.length === 0) return "";

  const maximumBytes = RESEARCH_PROMPT_TOKEN_LIMITS.dependencyDigest * 4;
  const compactEntries = entries.map((entry) => ({
    id: entry.taskId,
    stop: entry.stopReason,
    findings: entry.findingCount,
    unresolved: entry.unresolvedQuestionCount,
    summary: "",
  }));
  const base = JSON.stringify({ dependencyResults: compactEntries });
  if (Buffer.byteLength(base, "utf8") > maximumBytes) {
    throw new Error(
      "Research dependency metadata exceeds its bounded prompt budget.",
    );
  }

  const availableSummaryBytes = maximumBytes - Buffer.byteLength(base, "utf8");
  const perEntryBytes = Math.floor(
    availableSummaryBytes / compactEntries.length,
  );
  compactEntries.forEach((entry, index) => {
    const source = entries[index];
    if (!source) {
      throw new Error(
        `Research dependency digest entry '${entry.id}' has no source entry.`,
      );
    }
    entry.summary = truncateJsonString(source.summary, perEntryBytes);
  });

  const digest = JSON.stringify({ dependencyResults: compactEntries });
  if (
    estimateResearchPromptTokens(digest) >
    RESEARCH_PROMPT_TOKEN_LIMITS.dependencyDigest
  ) {
    throw new Error(
      "Research dependency digest exceeded its bounded prompt budget.",
    );
  }
  return digest;
}

function truncateJsonString(
  value: string,
  maximumSerializedBytes: number,
): string {
  if (maximumSerializedBytes <= 2) return "";
  const serializedBytes = (candidate: string): number =>
    Buffer.byteLength(JSON.stringify(candidate), "utf8") - 2;
  if (serializedBytes(value) <= maximumSerializedBytes) return value;

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (serializedBytes(value.slice(0, middle)) <= maximumSerializedBytes) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return value.slice(0, low);
}

function readJsonArtifact(input: {
  readonly assignmentPath: string;
  readonly relativePath: string;
  readonly maximumBytes: number;
  readonly label: string;
}): unknown {
  const candidatePath = resolveRelativePathInside(
    input.assignmentPath,
    input.relativePath,
  );
  if (!candidatePath) throw new Error(`${input.label} path is unsafe.`);
  const artifactPath = resolveExistingPathInside(
    input.assignmentPath,
    candidatePath,
  );
  if (!artifactPath) throw new Error(`${input.label} does not exist.`);
  const linkStats = fs.lstatSync(candidatePath);
  if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
    throw new Error(`${input.label} must be a regular file.`);
  }
  const stats = fs.statSync(artifactPath);
  if (stats.size > input.maximumBytes) {
    throw new Error(
      `${input.label} exceeds its ${input.maximumBytes}-byte limit.`,
    );
  }
  try {
    return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  } catch (error) {
    throw new Error(
      `${input.label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readOptionalJsonArtifact(input: {
  readonly assignmentPath: string;
  readonly relativePath: string;
  readonly maximumBytes: number;
  readonly label: string;
}): unknown | undefined {
  const candidatePath = resolveRelativePathInside(
    input.assignmentPath,
    input.relativePath,
  );
  if (!candidatePath) throw new Error(`${input.label} path is unsafe.`);
  if (!fs.existsSync(candidatePath)) return undefined;
  return readJsonArtifact(input);
}
