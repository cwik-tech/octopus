import {
  DEEP_RESEARCH_SCHEMA_VERSION,
  type ClaimRecord,
  type EvidencePacket,
  type ResearchEvidenceGraph,
  type ResearchEvidenceGraphClaimNode,
  type ResearchEvidenceGraphEdge,
  type ResearchEvidenceGraphGap,
  type ResearchEvidenceGraphRequirementNode,
  type ResearchEvidenceGraphSourceNode,
  type ResearchPlan,
  type ResearchSectionDossier,
  type ResearchSectionDossierIndex,
  type ResearchSynthesisPacket,
  type SourceRecord,
} from "../../contracts/deep-research.js";
import { resolveResearchCoverageRequirements } from "./deep-research-coverage.js";
import { parseResearchPlan } from "./deep-research-validation.js";
import { hashResearchValue } from "./deep-research-worker-policy.js";
import { isUnknownArray } from "../../core/unknown-array.js";

export function buildResearchEvidenceGraph(params: {
  readonly plan: unknown;
  readonly synthesis: ResearchSynthesisPacket;
  readonly correctionWave: 0 | 1 | 2;
}): ResearchEvidenceGraph {
  const plan = parseResearchPlan(params.plan);
  assertSynthesisBelongsToPlan(plan, params.synthesis);
  const sourceById = new Map(
    params.synthesis.sources.map((source) => [source.sourceId, source]),
  );
  const coverageByTask = new Map(
    params.synthesis.coverage.map((entry) => [entry.taskId, entry]),
  );
  const policy = plan.executionPolicy;
  const requiredIndependentSources =
    policy?.evidenceTargets.minimumIndependentSourcesPerConsequentialClaim ?? 2;
  const crossVerifyConsequentialClaims =
    policy?.evidenceTargets.crossVerifyConsequentialClaims ?? false;

  const claims = params.synthesis.claims.map((claim) => {
    const supportingSourceIds = uniqueSorted(
      claim.evidenceLinks
        .filter((link) => link.relationship === "supports")
        .map((link) => link.sourceId),
    );
    const contradictingSourceIds = uniqueSorted(
      claim.evidenceLinks
        .filter((link) => link.relationship === "contradicts")
        .map((link) => link.sourceId),
    );
    const contextSourceIds = uniqueSorted(
      claim.evidenceLinks
        .filter((link) => link.relationship === "context")
        .map((link) => link.sourceId),
    );
    const independentPublisherCount = new Set(
      supportingSourceIds
        .map((sourceId) => sourceById.get(sourceId))
        .filter((source): source is SourceRecord => Boolean(source))
        .map(runtimeSourceIdentity),
    ).size;
    const crossVerificationRequired =
      claim.kind !== "uncertainty" &&
      (claim.evidenceStandard === "independent_corroboration" ||
        claim.status === "disputed") &&
      (crossVerifyConsequentialClaims ||
        claim.evidenceStandard === "independent_corroboration");
    return {
      id: claim.claimId,
      taskId: claim.taskId,
      sectionId: claim.sectionId,
      statement: claim.statement,
      status: claim.status,
      confidence: claim.confidence,
      evidenceStandard: claim.evidenceStandard,
      sourceIds: uniqueSorted(claim.sourceIds),
      supportingSourceIds,
      contradictingSourceIds,
      contextSourceIds,
      independentPublisherCount,
      crossVerificationRequired,
      crossVerified:
        !crossVerificationRequired ||
        independentPublisherCount >= requiredIndependentSources,
    };
  });
  const requirements: ResearchEvidenceGraphRequirementNode[] =
    plan.tasks.flatMap((task) => {
      const worker = plan.workerSpecs.find(
        (candidate) => candidate.id === task.workerSpecId,
      );
      if (!worker) {
        throw new Error(
          `Research task '${task.id}' references unknown worker spec '${task.workerSpecId}'.`,
        );
      }
      const coverage = coverageByTask.get(task.id)?.requirementCoverage ?? [];
      const coverageById = new Map(
        coverage.map((entry) => [entry.requirementId, entry]),
      );
      return resolveResearchCoverageRequirements(worker).map((requirement) => {
        const entry = coverageById.get(requirement.id);
        return {
          id: `${task.id}--${requirement.id}`,
          requirementId: requirement.id,
          taskId: task.id,
          sectionId: task.sectionId,
          label: requirement.label,
          required: requirement.required,
          status: entry?.status ?? "missing",
          claimIds: uniqueSorted(entry?.claimIds ?? []),
          sourceIds: uniqueSorted(entry?.sourceIds ?? []),
        };
      });
    });

  const sources = params.synthesis.sources.map((source) => ({
    id: source.sourceId,
    canonicalUrl: source.canonicalUrl,
    title: source.title,
    publisher: source.publisher,
    independenceKey: source.independenceKey,
    sourceType: source.sourceType,
    status: source.status,
    observedAt: source.observedAt,
    ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
    freshness:
      source.status === "stale"
        ? ("stale" as const)
        : source.publishedAt
          ? ("current" as const)
          : ("unknown" as const),
  }));

  const edges = [
    ...params.synthesis.claims.flatMap((claim) =>
      claim.evidenceLinks.map((link) => ({
        from: claim.claimId,
        to: link.sourceId,
        type: link.relationship,
      })),
    ),
    ...requirements.flatMap((requirement) =>
      requirement.claimIds.map((claimId) => ({
        from: requirement.id,
        to: claimId,
        type: "covers" as const,
      })),
    ),
  ].sort(edgeOrder);

  const gaps: ResearchEvidenceGraphGap[] = [];
  for (const requirement of requirements) {
    if (requirement.required && requirement.status !== "satisfied") {
      gaps.push({
        id: stableGapId("requirement_missing", requirement.id),
        type: "requirement_missing",
        taskIds: [requirement.taskId],
        sectionIds: [requirement.sectionId],
        claimIds: requirement.claimIds,
        sourceIds: requirement.sourceIds,
        message: `Required coverage '${requirement.label}' is ${requirement.status.replace("_", " ")}.`,
      });
    }
  }
  for (const claim of claims) {
    if (
      claim.status !== "removed" &&
      (claim.status === "unsupported" ||
        (claim.status === "supported" &&
          claim.supportingSourceIds.length === 0))
    ) {
      gaps.push({
        id: stableGapId("claim_unsupported", claim.id),
        type: "claim_unsupported",
        taskIds: [claim.taskId],
        sectionIds: [claim.sectionId],
        claimIds: [claim.id],
        sourceIds: claim.sourceIds,
        message: "Claim is not connected to usable supporting evidence.",
      });
    }
    if (claim.crossVerificationRequired && !claim.crossVerified) {
      gaps.push({
        id: stableGapId("cross_verification_missing", claim.id),
        type: "cross_verification_missing",
        taskIds: [claim.taskId],
        sectionIds: [claim.sectionId],
        claimIds: [claim.id],
        sourceIds: claim.supportingSourceIds,
        message:
          `Consequential claim has ${claim.independentPublisherCount} ` +
          `independent supporting source groups; ${requiredIndependentSources} are required.`,
      });
    }
  }
  params.synthesis.contradictions.forEach((contradiction, index) => {
    if (contradiction.status === "resolved") return;
    const relatedClaims = claims.filter((claim) =>
      claim.sourceIds.some((sourceId) =>
        contradiction.sourceIds.includes(sourceId),
      ),
    );
    gaps.push({
      id: stableGapId(
        "contradiction_unresolved",
        `${index}:${contradiction.description}`,
      ),
      type: "contradiction_unresolved",
      taskIds: uniqueSorted(relatedClaims.map((claim) => claim.taskId)),
      sectionIds: uniqueSorted(relatedClaims.map((claim) => claim.sectionId)),
      claimIds: uniqueSorted(relatedClaims.map((claim) => claim.id)),
      sourceIds: uniqueSorted(contradiction.sourceIds),
      message: contradiction.description,
    });
  });
  params.synthesis.unresolvedQuestions.forEach((question, index) => {
    gaps.push({
      id: stableGapId("question_unresolved", `${index}:${question}`),
      type: "question_unresolved",
      taskIds: plan.tasks.map((task) => task.id).sort(),
      sectionIds: plan.sections.map((section) => section.id).sort(),
      claimIds: [],
      sourceIds: [],
      message: question,
    });
  });

  const requiredRequirements = requirements.filter(
    (requirement) => requirement.required,
  );
  const consequentialClaims = claims.filter(
    (claim) => claim.crossVerificationRequired,
  );
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    planId: plan.planId,
    approvedPlanHash: plan.approvalHash ?? hashResearchValue(plan),
    correctionWave: params.correctionWave,
    generatedAt: stableGeneratedAt(plan, params.synthesis.sources),
    requirements,
    claims,
    sources,
    edges,
    contradictions: params.synthesis.contradictions,
    unresolvedQuestions: params.synthesis.unresolvedQuestions,
    gaps: gaps.sort((left, right) => left.id.localeCompare(right.id)),
    coverage: {
      requiredRequirements: requiredRequirements.length,
      satisfiedRequirements: requiredRequirements.filter(
        (requirement) => requirement.status === "satisfied",
      ).length,
      supportedClaims: claims.filter((claim) => claim.status === "supported")
        .length,
      totalClaims: claims.length,
      crossVerifiedConsequentialClaims: consequentialClaims.filter(
        (claim) => claim.crossVerified,
      ).length,
      consequentialClaims: consequentialClaims.length,
    },
  };
}

export function buildResearchSectionDossiers(params: {
  readonly plan: unknown;
  readonly synthesis: ResearchSynthesisPacket;
  readonly graph: ResearchEvidenceGraph;
  readonly evidencePackets: readonly EvidencePacket[];
}): ResearchSectionDossier[] {
  const plan = parseResearchPlan(params.plan);
  assertGraphBelongsToPlan(plan, params.graph);
  const sourceById = new Map(
    params.synthesis.sources.map((source) => [source.sourceId, source]),
  );
  const packetByTask = new Map(
    params.evidencePackets.map((packet) => [packet.taskId, packet]),
  );
  return plan.sections.map((section) => {
    const claims = params.synthesis.claims.filter(
      (claim) => claim.sectionId === section.id,
    );
    const sourceIds = new Set(claims.flatMap((claim) => claim.sourceIds));
    const sources = [...sourceIds]
      .map((sourceId) => sourceById.get(sourceId))
      .filter((source): source is SourceRecord => Boolean(source))
      .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
    const contradictions = params.synthesis.contradictions.filter(
      (contradiction) =>
        contradiction.sourceIds.some((sourceId) => sourceIds.has(sourceId)),
    );
    const gaps = params.graph.gaps.filter(
      (gap) =>
        gap.type !== "question_unresolved" &&
        gap.sectionIds.includes(section.id),
    );
    const unresolvedQuestions = section.taskIds.flatMap(
      (taskId) => packetByTask.get(taskId)?.unresolvedQuestions ?? [],
    );
    return {
      schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
      planId: plan.planId,
      approvedPlanHash: plan.approvalHash ?? hashResearchValue(plan),
      correctionWave: params.graph.correctionWave,
      sectionId: section.id,
      title: section.title,
      objective: section.objective,
      taskIds: [...section.taskIds],
      claims: claims.sort((left, right) =>
        left.claimId.localeCompare(right.claimId),
      ),
      sources,
      coverage: params.synthesis.coverage.filter(
        (entry) => entry.sectionId === section.id,
      ),
      contradictions,
      unresolvedQuestions: uniqueSorted(unresolvedQuestions),
      gapIds: gaps.map((gap) => gap.id).sort(),
      evidenceGraphPath: `research/evidence-graph/graph-wave-${params.graph.correctionWave}.json`,
    };
  });
}

export function buildResearchSectionDossierIndex(params: {
  readonly plan: unknown;
  readonly dossiers: readonly ResearchSectionDossier[];
}): ResearchSectionDossierIndex {
  const plan = parseResearchPlan(params.plan);
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    planId: plan.planId,
    approvedPlanHash: plan.approvalHash ?? hashResearchValue(plan),
    correctionWave: params.dossiers[0]?.correctionWave ?? 0,
    synthesisMode: plan.executionPolicy?.synthesis.mode ?? "single_pass",
    dossiers: params.dossiers.map((dossier) => ({
      sectionId: dossier.sectionId,
      title: dossier.title,
      relativePath: `research/sections/${dossier.sectionId}/dossier-wave-${dossier.correctionWave}.json`,
      ...(plan.executionPolicy?.synthesis.mode === "section_dossiers"
        ? {
            draftPath: `research/sections/${dossier.sectionId}/draft-wave-${dossier.correctionWave}.md`,
          }
        : {}),
      claimCount: dossier.claims.length,
      sourceCount: dossier.sources.length,
      gapCount: dossier.gapIds.length,
    })),
  };
}

/**
 * The run-owned drafting plan.
 *
 * Each task is addressed by its declared result file, which is the index
 * entry's `draftPath` and the identity the runtime matches to resolve that
 * section's evidence. The plan deliberately does not name the dossier file: a
 * section writer has no filesystem, so a path in its task section would be an
 * instruction it cannot follow.
 */
export function buildResearchSectionDraftPlan(params: {
  readonly plan: unknown;
  readonly index: ResearchSectionDossierIndex;
}): string | null {
  const plan = parseResearchPlan(params.plan);
  if (
    !plan.executionPolicy ||
    plan.executionPolicy.synthesis.mode !== "section_dossiers"
  ) {
    return null;
  }
  const lines = [
    "# Plan: Deep Research Section Drafting",
    "**Status:** executing",
    "",
    "### S1: Evidence-bound section drafts",
  ];
  const maximumParallelSections =
    plan.executionPolicy.synthesis.maximumParallelSections;
  params.index.dossiers.forEach((dossier, index) => {
    if (!dossier.draftPath) {
      throw new Error(
        `Section dossier '${dossier.sectionId}' has no approved draft path.`,
      );
    }
    const batchIndex = Math.floor(index / maximumParallelSections);
    const priorBatchTaskIds =
      batchIndex === 0
        ? []
        : params.index.dossiers
            .slice(
              (batchIndex - 1) * maximumParallelSections,
              batchIndex * maximumParallelSections,
            )
            .map(
              (_, priorIndex) =>
                `T${(batchIndex - 1) * maximumParallelSections + priorIndex + 1}`,
            );
    lines.push(
      `#### T${index + 1}: ${singleLine(dossier.title)}`,
      "- **Agent:** research-section-writer",
      "- **Status:** pending",
      "- **Validate:** false",
      `- **Depends on:** ${priorBatchTaskIds.join(", ") || "none"}`,
      "- **Gate:** false",
      `- **Result file:** ${dossier.draftPath}`,
      "",
    );
  });
  return `${lines.join("\n").trimEnd()}\n`;
}

export function parseResearchEvidenceGraph(
  value: unknown,
): ResearchEvidenceGraph {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Research evidence graph must be a schema-v1 object.");
  }
  for (const field of [
    "requirements",
    "claims",
    "sources",
    "edges",
    "contradictions",
    "unresolvedQuestions",
    "gaps",
  ] as const) {
    if (!Array.isArray(value[field])) {
      throw new Error(`Research evidence graph '${field}' must be an array.`);
    }
  }
  if (
    typeof value.planId !== "string" ||
    typeof value.approvedPlanHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.approvedPlanHash) ||
    (value.correctionWave !== 0 &&
      value.correctionWave !== 1 &&
      value.correctionWave !== 2) ||
    typeof value.generatedAt !== "string" ||
    !isRecord(value.coverage)
  ) {
    throw new Error("Research evidence graph identity is invalid.");
  }
  const requirements = requireUnknownArray(
    value.requirements,
    "requirements",
  ).map(parseGraphRequirement);
  const sources = requireUnknownArray(value.sources, "sources").map(
    parseGraphSource,
  );
  const claims = requireUnknownArray(value.claims, "claims").map(
    parseGraphClaim,
  );
  const edges = requireUnknownArray(value.edges, "edges").map(parseGraphEdge);
  const contradictions = requireUnknownArray(
    value.contradictions,
    "contradictions",
  ).map(parseGraphContradiction);
  const unresolvedQuestions = parseStringArray(
    value.unresolvedQuestions,
    "Research evidence graph unresolved questions",
  );
  const gaps = requireUnknownArray(value.gaps, "gaps").map(parseGraphGap);
  const graph: ResearchEvidenceGraph = {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    planId: value.planId,
    approvedPlanHash: value.approvedPlanHash,
    correctionWave: value.correctionWave,
    generatedAt: value.generatedAt,
    requirements,
    claims,
    sources,
    edges,
    contradictions,
    unresolvedQuestions,
    gaps,
    coverage: parseGraphCoverage(value.coverage),
  };
  const requirementIds = new Set(
    graph.requirements.map((requirement) => {
      if (
        !isRecord(requirement) ||
        typeof requirement.id !== "string" ||
        typeof requirement.requirementId !== "string" ||
        typeof requirement.taskId !== "string" ||
        typeof requirement.sectionId !== "string"
      ) {
        throw new Error(
          "Research evidence graph contains an invalid requirement.",
        );
      }
      return requirement.id;
    }),
  );
  if (requirementIds.size !== graph.requirements.length) {
    throw new Error(
      "Research evidence graph contains duplicate requirement identities.",
    );
  }
  const sourceIds = new Set(
    graph.sources.map((source) => {
      if (
        !isRecord(source) ||
        typeof source.id !== "string" ||
        typeof source.canonicalUrl !== "string"
      ) {
        throw new Error("Research evidence graph contains an invalid source.");
      }
      return source.id;
    }),
  );
  const claimIds = new Set(
    graph.claims.map((claim) => {
      if (
        !isRecord(claim) ||
        typeof claim.id !== "string" ||
        !Array.isArray(claim.sourceIds) ||
        claim.sourceIds.some(
          (sourceId) =>
            typeof sourceId !== "string" || !sourceIds.has(sourceId),
        )
      ) {
        throw new Error("Research evidence graph contains an invalid claim.");
      }
      return claim.id;
    }),
  );
  for (const edge of graph.edges) {
    if (
      !isRecord(edge) ||
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      !["supports", "contradicts", "context", "covers"].includes(edge.type) ||
      (edge.type === "covers"
        ? !requirementIds.has(edge.from) || !claimIds.has(edge.to)
        : !claimIds.has(edge.from) || !sourceIds.has(edge.to))
    ) {
      throw new Error("Research evidence graph contains an invalid edge.");
    }
  }
  return graph;
}

function parseGraphRequirement(
  value: unknown,
): ResearchEvidenceGraphRequirementNode {
  const record = requireGraphRecord(value, "requirement");
  return {
    id: requireGraphString(record.id, "requirement ID"),
    requirementId: requireGraphString(record.requirementId, "requirement ID"),
    taskId: requireGraphString(record.taskId, "requirement task ID"),
    sectionId: requireGraphString(record.sectionId, "requirement section ID"),
    label: requireGraphString(record.label, "requirement label"),
    required: requireGraphBoolean(record.required, "requirement required"),
    status: parseRequirementStatus(record.status),
    claimIds: parseStringArray(record.claimIds, "requirement claim IDs"),
    sourceIds: parseStringArray(record.sourceIds, "requirement source IDs"),
  };
}

function parseGraphClaim(value: unknown): ResearchEvidenceGraphClaimNode {
  const record = requireGraphRecord(value, "claim");
  return {
    id: requireGraphString(record.id, "claim ID"),
    taskId: requireGraphString(record.taskId, "claim task ID"),
    sectionId: requireGraphString(record.sectionId, "claim section ID"),
    statement: requireGraphString(record.statement, "claim statement"),
    status: parseClaimStatus(record.status),
    confidence: parseClaimConfidence(record.confidence),
    evidenceStandard: parseEvidenceStandard(record.evidenceStandard),
    sourceIds: parseStringArray(record.sourceIds, "claim source IDs"),
    supportingSourceIds: parseStringArray(
      record.supportingSourceIds,
      "claim supporting source IDs",
    ),
    contradictingSourceIds: parseStringArray(
      record.contradictingSourceIds,
      "claim contradicting source IDs",
    ),
    contextSourceIds: parseStringArray(
      record.contextSourceIds,
      "claim context source IDs",
    ),
    independentPublisherCount: requireGraphNonNegativeInteger(
      record.independentPublisherCount,
      "claim independent publisher count",
    ),
    crossVerificationRequired: requireGraphBoolean(
      record.crossVerificationRequired,
      "claim cross verification required",
    ),
    crossVerified: requireGraphBoolean(
      record.crossVerified,
      "claim cross verified",
    ),
  };
}

function parseGraphSource(value: unknown): ResearchEvidenceGraphSourceNode {
  const record = requireGraphRecord(value, "source");
  const source: ResearchEvidenceGraphSourceNode = {
    id: requireGraphString(record.id, "source ID"),
    canonicalUrl: requireGraphString(record.canonicalUrl, "source URL"),
    title: requireGraphString(record.title, "source title"),
    publisher: requireGraphString(record.publisher, "source publisher"),
    independenceKey: requireGraphString(
      record.independenceKey,
      "source independence key",
    ),
    sourceType: parseSourceType(record.sourceType),
    status: parseSourceStatus(record.status),
    observedAt: requireGraphString(record.observedAt, "source observed time"),
    freshness: parseFreshness(record.freshness),
  };
  return record.publishedAt === undefined
    ? source
    : {
        ...source,
        publishedAt: requireGraphString(
          record.publishedAt,
          "source published time",
        ),
      };
}

function parseGraphEdge(value: unknown): ResearchEvidenceGraphEdge {
  const record = requireGraphRecord(value, "edge");
  return {
    from: requireGraphString(record.from, "edge from"),
    to: requireGraphString(record.to, "edge to"),
    type: parseEdgeType(record.type),
  };
}

function parseGraphContradiction(
  value: unknown,
): ResearchEvidenceGraph["contradictions"][number] {
  const record = requireGraphRecord(value, "contradiction");
  const contradiction = {
    description: requireGraphString(
      record.description,
      "contradiction description",
    ),
    sourceIds: parseStringArray(record.sourceIds, "contradiction source IDs"),
  };
  if (record.status === undefined) return contradiction;
  if (record.status !== "resolved" && record.status !== "unresolved")
    throw new Error("Research evidence graph contradiction status is invalid.");
  if (record.resolution !== undefined && typeof record.resolution !== "string")
    throw new Error(
      "Research evidence graph contradiction resolution is invalid.",
    );
  return {
    ...contradiction,
    status: record.status,
    ...(record.resolution === undefined
      ? {}
      : { resolution: record.resolution }),
  };
}

function parseGraphGap(value: unknown): ResearchEvidenceGraphGap {
  const record = requireGraphRecord(value, "gap");
  return {
    id: requireGraphString(record.id, "gap ID"),
    type: parseGapType(record.type),
    taskIds: parseStringArray(record.taskIds, "gap task IDs"),
    sectionIds: parseStringArray(record.sectionIds, "gap section IDs"),
    claimIds: parseStringArray(record.claimIds, "gap claim IDs"),
    sourceIds: parseStringArray(record.sourceIds, "gap source IDs"),
    message: requireGraphString(record.message, "gap message"),
  };
}

function parseGraphCoverage(value: unknown): ResearchEvidenceGraph["coverage"] {
  const record = requireGraphRecord(value, "coverage");
  return {
    requiredRequirements: requireGraphNonNegativeInteger(
      record.requiredRequirements,
      "coverage required requirements",
    ),
    satisfiedRequirements: requireGraphNonNegativeInteger(
      record.satisfiedRequirements,
      "coverage satisfied requirements",
    ),
    supportedClaims: requireGraphNonNegativeInteger(
      record.supportedClaims,
      "coverage supported claims",
    ),
    totalClaims: requireGraphNonNegativeInteger(
      record.totalClaims,
      "coverage total claims",
    ),
    crossVerifiedConsequentialClaims: requireGraphNonNegativeInteger(
      record.crossVerifiedConsequentialClaims,
      "coverage cross verified claims",
    ),
    consequentialClaims: requireGraphNonNegativeInteger(
      record.consequentialClaims,
      "coverage consequential claims",
    ),
  };
}

function requireGraphRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value))
    throw new Error(`Research evidence graph ${label} is invalid.`);
  return value;
}
function requireUnknownArray(value: unknown, label: string): readonly unknown[] {
  if (!isUnknownArray(value))
    throw new Error(`Research evidence graph ${label} is invalid.`);
  return value;
}
function requireGraphString(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new Error(`Research evidence graph ${label} is invalid.`);
  return value;
}
function requireGraphBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean")
    throw new Error(`Research evidence graph ${label} is invalid.`);
  return value;
}
function requireGraphNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0)
    throw new Error(`Research evidence graph ${label} is invalid.`);
  return Number(value);
}
function parseStringArray(value: unknown, label: string): string[] {
  if (!isStringArray(value))
    throw new Error(`Research evidence graph ${label} is invalid.`);
  return [...value];
}
function parseRequirementStatus(
  value: unknown,
): ResearchEvidenceGraphRequirementNode["status"] {
  switch (value) {
    case "satisfied":
    case "unresolved":
    case "not_applicable":
    case "missing":
      return value;
    default:
      throw new Error("Research evidence graph requirement status is invalid.");
  }
}
function parseClaimStatus(
  value: unknown,
): ResearchEvidenceGraphClaimNode["status"] {
  switch (value) {
    case "supported":
    case "disputed":
    case "unsupported":
    case "removed":
      return value;
    default:
      throw new Error("Research evidence graph claim status is invalid.");
  }
}
function parseClaimConfidence(
  value: unknown,
): ResearchEvidenceGraphClaimNode["confidence"] {
  switch (value) {
    case "high":
    case "medium":
    case "low":
      return value;
    default:
      throw new Error("Research evidence graph claim confidence is invalid.");
  }
}
function parseEvidenceStandard(
  value: unknown,
): ResearchEvidenceGraphClaimNode["evidenceStandard"] {
  switch (value) {
    case "single":
    case "independent_corroboration":
      return value;
    default:
      throw new Error(
        "Research evidence graph claim evidence standard is invalid.",
      );
  }
}
function parseSourceType(
  value: unknown,
): ResearchEvidenceGraphSourceNode["sourceType"] {
  switch (value) {
    case "primary":
    case "secondary":
    case "regulatory":
    case "academic":
    case "industry":
    case "news":
    case "vendor":
    case "community":
      return value;
    default:
      throw new Error("Research evidence graph source type is invalid.");
  }
}
function parseSourceStatus(
  value: unknown,
): ResearchEvidenceGraphSourceNode["status"] {
  switch (value) {
    case "usable":
    case "blocked":
    case "stale":
    case "rejected":
      return value;
    default:
      throw new Error("Research evidence graph source status is invalid.");
  }
}
function parseFreshness(
  value: unknown,
): ResearchEvidenceGraphSourceNode["freshness"] {
  switch (value) {
    case "current":
    case "stale":
    case "unknown":
      return value;
    default:
      throw new Error("Research evidence graph source freshness is invalid.");
  }
}
function parseEdgeType(value: unknown): ResearchEvidenceGraphEdge["type"] {
  switch (value) {
    case "supports":
    case "contradicts":
    case "context":
    case "covers":
      return value;
    default:
      throw new Error("Research evidence graph edge type is invalid.");
  }
}
function parseGapType(value: unknown): ResearchEvidenceGraphGap["type"] {
  switch (value) {
    case "requirement_missing":
    case "claim_unsupported":
    case "cross_verification_missing":
    case "contradiction_unresolved":
    case "question_unresolved":
      return value;
    default:
      throw new Error("Research evidence graph gap type is invalid.");
  }
}

function assertSynthesisBelongsToPlan(
  plan: ResearchPlan,
  synthesis: ResearchSynthesisPacket,
): void {
  if (synthesis.planId !== plan.planId) {
    throw new Error("Research synthesis packet does not match its plan.");
  }
  const taskIds = new Set(plan.tasks.map((task) => task.id));
  const sectionIds = new Set(plan.sections.map((section) => section.id));
  if (
    synthesis.coverage.some(
      (entry) => !taskIds.has(entry.taskId) || !sectionIds.has(entry.sectionId),
    ) ||
    synthesis.claims.some(
      (claim) => !taskIds.has(claim.taskId) || !sectionIds.has(claim.sectionId),
    )
  ) {
    throw new Error("Research synthesis packet references unknown plan work.");
  }
}

function assertGraphBelongsToPlan(
  plan: ResearchPlan,
  graph: ResearchEvidenceGraph,
): void {
  if (
    graph.planId !== plan.planId ||
    graph.approvedPlanHash !== (plan.approvalHash ?? hashResearchValue(plan))
  ) {
    throw new Error(
      "Research evidence graph does not match its approved plan.",
    );
  }
}

function runtimeSourceIdentity(source: SourceRecord): string {
  return new URL(source.canonicalUrl).hostname
    .toLowerCase()
    .replace(/^www\./u, "");
}

function stableGeneratedAt(
  plan: ResearchPlan,
  sources: readonly SourceRecord[],
): string {
  const timestamps = [
    plan.approvedAt,
    ...sources.map((source) => source.observedAt),
  ].filter((value): value is string => Boolean(value));
  return timestamps.sort().at(-1) ?? plan.request.freshnessAsOf;
}

function stableGapId(type: string, identity: string): string {
  return `gap-${type}-${hashResearchValue(identity).slice(0, 12)}`;
}

function edgeOrder(
  left: { from: string; to: string; type: string },
  right: { from: string; to: string; type: string },
): number {
  return `${left.from}|${left.type}|${left.to}`.localeCompare(
    `${right.from}|${right.type}|${right.to}`,
  );
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}
