import { createHash } from "node:crypto";

import {
  DEEP_RESEARCH_SCHEMA_VERSION,
  RESEARCH_EVALUATION_ARTIFACT_KINDS,
  RESEARCH_EVALUATION_METRIC_IDS,
  type ResearchEvaluationArtifactKind,
  type ResearchEvaluationCase,
  type ResearchEvaluationCorpus,
  type ResearchEvaluationMetric,
  type ResearchEvaluationMetricId,
  type ResearchEvaluationReport,
} from "../../contracts/deep-research.js";
import { parseResearchEvidenceGraph } from "./deep-research-evidence-graph.js";
import { parseResearchPublicationAudit } from "./deep-research-publication-audit.js";

const AUTHORITATIVE_SOURCE_TYPES = new Set([
  "primary",
  "regulatory",
  "academic",
  "vendor",
]);

const COMPOSITE_METRIC_IDS = new Set<ResearchEvaluationMetricId>([
  "requirement_coverage",
  "claim_support",
  "authoritative_sources",
  "independent_claim_verification",
  "contradiction_resolution",
  "semantic_coherence",
  "citation_correctness",
  "artifact_validity",
  "acquisition_yield",
]);

export interface DeepResearchEvaluationObservation {
  readonly semanticReviewApproved: boolean;
  readonly approvedTaskCount: number;
  readonly usableObservedSources: number;
  readonly elapsedMs: number;
  readonly costUsd: number;
  readonly artifactChecks: Readonly<
    Partial<Record<ResearchEvaluationArtifactKind, boolean>>
  >;
  readonly finalMarkdown: string;
  readonly finalDocx: Uint8Array;
  readonly retainedArtifacts: readonly string[];
}

export function buildDeepResearchEvaluationReport(params: {
  readonly evaluationCase: ResearchEvaluationCase;
  readonly evidenceGraph: unknown;
  readonly publicationAudit: unknown;
  readonly observation: DeepResearchEvaluationObservation;
  readonly baseline?: unknown;
  readonly evaluatedAt?: string;
}): ResearchEvaluationReport {
  const evaluationCase = parseResearchEvaluationCase(params.evaluationCase);
  const graph = parseResearchEvidenceGraph(params.evidenceGraph);
  const audit = parseResearchPublicationAudit(params.publicationAudit);
  const baseline =
    params.baseline === undefined
      ? undefined
      : parseResearchEvaluationReport(params.baseline);
  if (baseline && baseline.caseId !== evaluationCase.id) {
    throw new Error(
      `Deep Research evaluation baseline case '${baseline.caseId}' does not match '${evaluationCase.id}'.`,
    );
  }
  validateObservation(params.observation);

  const requiredRequirements = graph.coverage.requiredRequirements;
  const requirementCoverage = ratio(
    graph.coverage.satisfiedRequirements,
    requiredRequirements,
  );
  const activeClaims = graph.claims.filter(
    (claim) => claim.status !== "removed",
  );
  const supportedClaims = activeClaims.filter(
    (claim) =>
      claim.status === "supported" && claim.supportingSourceIds.length > 0,
  );
  const usableSources = graph.sources.filter(
    (source) => source.status === "usable",
  );
  const authoritativeSources = usableSources.filter((source) =>
    AUTHORITATIVE_SOURCE_TYPES.has(source.sourceType),
  );
  const consequentialClaims = graph.claims.filter(
    (claim) => claim.status !== "removed" && claim.crossVerificationRequired,
  );
  const crossVerifiedClaims = consequentialClaims.filter(
    (claim) => claim.crossVerified,
  );
  const contradictions = graph.contradictions;
  const resolvedContradictions = contradictions.filter(
    (contradiction) => contradiction.status === "resolved",
  );
  const normalizedMarkdown = semanticText(params.observation.finalMarkdown);
  const expectedTermsFound = evaluationCase.expectedTerms.filter((term) =>
    normalizedMarkdown.includes(semanticText(term)),
  );
  const semanticCoherence = params.observation.semanticReviewApproved
    ? ratio(expectedTermsFound.length, evaluationCase.expectedTerms.length)
    : 0;
  const graphCitationCoverage = ratio(
    audit.graphCoverage.preservedClaimSourceLinks,
    audit.graphCoverage.requiredClaimSourceLinks,
  );
  const citedNumericParagraphs = audit.numericClaimParagraphs.filter(
    (paragraph) => paragraph.cited,
  );
  const numericCitationCoverage = ratio(
    citedNumericParagraphs.length,
    audit.numericClaimParagraphs.length,
  );
  const requiredArtifactChecks = evaluationCase.requiredArtifacts.map(
    (kind) => params.observation.artifactChecks[kind] === true,
  );
  const thresholds = evaluationCase.thresholds;
  const metrics: ResearchEvaluationMetric[] = [
    minimumMetric({
      id: "requirement_coverage",
      label: "Required evidence coverage",
      value: requirementCoverage,
      threshold: thresholds.minimumRequirementCoverage,
      numerator: graph.coverage.satisfiedRequirements,
      denominator: requiredRequirements,
    }),
    minimumMetric({
      id: "claim_support",
      label: "Supported active claims",
      value: ratio(supportedClaims.length, activeClaims.length),
      threshold: thresholds.minimumClaimSupport,
      numerator: supportedClaims.length,
      denominator: activeClaims.length,
    }),
    minimumMetric({
      id: "authoritative_sources",
      label: "Authoritative usable sources",
      value: ratio(authoritativeSources.length, usableSources.length),
      threshold: thresholds.minimumAuthoritativeSourceRatio,
      numerator: authoritativeSources.length,
      denominator: usableSources.length,
    }),
    minimumMetric({
      id: "independent_claim_verification",
      label: "Independently verified consequential claims",
      value: ratio(crossVerifiedClaims.length, consequentialClaims.length),
      threshold: thresholds.minimumIndependentClaimRatio,
      numerator: crossVerifiedClaims.length,
      denominator: consequentialClaims.length,
    }),
    minimumMetric({
      id: "contradiction_resolution",
      label: "Resolved contradictions",
      value: ratio(resolvedContradictions.length, contradictions.length),
      threshold: thresholds.minimumContradictionResolution,
      numerator: resolvedContradictions.length,
      denominator: contradictions.length,
    }),
    minimumMetric({
      id: "semantic_coherence",
      label: "Semantic approval and expected brief coverage",
      value: semanticCoherence,
      threshold: thresholds.minimumSemanticCoherence,
      numerator: expectedTermsFound.length,
      denominator: evaluationCase.expectedTerms.length,
    }),
    minimumMetric({
      id: "citation_correctness",
      label: "Graph and numeric citation coverage",
      value: Math.min(graphCitationCoverage, numericCitationCoverage),
      threshold: thresholds.minimumCitationCorrectness,
    }),
    minimumMetric({
      id: "artifact_validity",
      label: "Required artifact validity",
      value: ratio(
        requiredArtifactChecks.filter(Boolean).length,
        requiredArtifactChecks.length,
      ),
      threshold: thresholds.minimumArtifactValidity,
      numerator: requiredArtifactChecks.filter(Boolean).length,
      denominator: requiredArtifactChecks.length,
    }),
    minimumMetric({
      id: "acquisition_yield",
      label: "Usable observed sources per approved task",
      value:
        params.observation.usableObservedSources /
        params.observation.approvedTaskCount,
      threshold: thresholds.minimumAcquisitionYield,
      unit: "sources_per_task",
      numerator: params.observation.usableObservedSources,
      denominator: params.observation.approvedTaskCount,
    }),
    maximumMetric({
      id: "elapsed_time",
      label: "End-to-end elapsed time",
      value: params.observation.elapsedMs,
      threshold: thresholds.maximumElapsedMs,
      unit: "milliseconds",
    }),
    maximumMetric({
      id: "cost",
      label: "End-to-end provider cost",
      value: params.observation.costUsd,
      threshold: thresholds.maximumCostUsd,
      unit: "usd",
    }),
  ];
  const compositeScore = round(
    average(
      metrics
        .filter((metric) => COMPOSITE_METRIC_IDS.has(metric.id))
        .map((metric) =>
          metric.id === "acquisition_yield"
            ? Math.min(1, metric.value / metric.threshold)
            : clampRatio(metric.value),
        ),
    ),
  );
  const comparison = baseline
    ? buildComparison({
        metrics,
        compositeScore,
        baseline,
        maximumCompositeRegression: thresholds.maximumCompositeRegression,
      })
    : undefined;
  const blockingReasons = [
    ...metrics
      .filter((metric) => !metric.passed)
      .map(
        (metric) =>
          `${metric.label} was ${formatMetric(metric.value, metric.unit)}; ` +
          `required ${metric.comparison === "at_least" ? "at least" : "at most"} ` +
          `${formatMetric(metric.threshold, metric.unit)}.`,
      ),
    ...(compositeScore < thresholds.minimumCompositeScore
      ? [
          `Composite quality score was ${formatMetric(compositeScore, "ratio")}; ` +
            `required at least ${formatMetric(thresholds.minimumCompositeScore, "ratio")}.`,
        ]
      : []),
    ...(comparison && !comparison.passed
      ? [
          `Composite quality regressed by ${formatMetric(
            Math.abs(comparison.compositeScoreDelta),
            "ratio",
          )}; maximum allowed regression is ${formatMetric(
            comparison.maximumCompositeRegression,
            "ratio",
          )}.`,
        ]
      : []),
  ];
  if (audit.decision !== "APPROVE") {
    blockingReasons.push(
      `Publication audit requires revision: ${
        audit.violations.map((violation) => violation.code).join(", ") ||
        "unspecified violation"
      }.`,
    );
  }

  const identity = {
    caseId: evaluationCase.id,
    graph,
    audit,
    observation: {
      ...params.observation,
      finalDocx: hashBytes(params.observation.finalDocx),
    },
    baselineEvaluationId: baseline?.evaluationId,
  };
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    evaluationId: `deep-research-evaluation-${hashValue(identity).slice(0, 20)}`,
    caseId: evaluationCase.id,
    caseTitle: evaluationCase.title,
    scenarioClass: evaluationCase.scenarioClass,
    planId: graph.planId,
    approvedPlanHash: graph.approvedPlanHash,
    correctionWave: graph.correctionWave,
    decision:
      blockingReasons.length === 0 && audit.decision === "APPROVE"
        ? "PASS"
        : "FAIL",
    evaluatedAt: params.evaluatedAt ?? new Date().toISOString(),
    compositeScore,
    metrics,
    blockingReasons,
    artifactHashes: {
      evidenceGraph: hashValue(graph),
      publicationAudit: hashValue(audit),
      finalMarkdown: hashValue(params.observation.finalMarkdown),
      finalDocx: hashBytes(params.observation.finalDocx),
    },
    retainedArtifacts: uniqueSorted(params.observation.retainedArtifacts),
    ...(comparison ? { comparison } : {}),
  };
}

export function parseResearchEvaluationCorpus(
  value: unknown,
): ResearchEvaluationCorpus {
  if (
    !isRecord(value) ||
    value.schemaVersion !== DEEP_RESEARCH_SCHEMA_VERSION ||
    typeof value.frozenAt !== "string" ||
    !Number.isFinite(Date.parse(value.frozenAt)) ||
    !Array.isArray(value.cases) ||
    value.cases.length === 0
  ) {
    throw new Error("Deep Research evaluation corpus is invalid.");
  }
  const cases = value.cases.map(parseResearchEvaluationCase);
  if (new Set(cases.map((entry) => entry.id)).size !== cases.length) {
    throw new Error(
      "Deep Research evaluation corpus contains duplicate case IDs.",
    );
  }
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    frozenAt: value.frozenAt,
    cases,
  };
}

function parseResearchEvaluationCase(value: unknown): ResearchEvaluationCase {
  if (
    !isRecord(value) ||
    value.schemaVersion !== DEEP_RESEARCH_SCHEMA_VERSION ||
    typeof value.id !== "string" ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.id) ||
    typeof value.title !== "string" ||
    !value.title.trim() ||
    (value.scenarioClass !== "simple" && value.scenarioClass !== "complex") ||
    typeof value.brief !== "string" ||
    !value.brief.trim() ||
    !isNonEmptyStringArray(value.expectedTerms) ||
    !Array.isArray(value.requiredArtifacts) ||
    value.requiredArtifacts.length === 0 ||
    !isRecord(value.thresholds)
  ) {
    throw new Error("Deep Research evaluation case is invalid.");
  }
  const artifactKinds = new Set(RESEARCH_EVALUATION_ARTIFACT_KINDS);
  if (
    value.requiredArtifacts.some(
      (kind) =>
        typeof kind !== "string" ||
        !artifactKinds.has(kind as ResearchEvaluationArtifactKind),
    )
  ) {
    throw new Error(
      `Deep Research evaluation case '${value.id}' has an invalid artifact kind.`,
    );
  }
  const thresholdNames = [
    "minimumRequirementCoverage",
    "minimumClaimSupport",
    "minimumAuthoritativeSourceRatio",
    "minimumIndependentClaimRatio",
    "minimumContradictionResolution",
    "minimumSemanticCoherence",
    "minimumCitationCorrectness",
    "minimumArtifactValidity",
    "minimumCompositeScore",
  ] as const;
  for (const name of thresholdNames) {
    if (!isRatio(value.thresholds[name])) {
      throw new Error(
        `Deep Research evaluation case '${value.id}' threshold '${name}' must be between 0 and 1.`,
      );
    }
  }
  if (
    !isPositiveNumber(value.thresholds.minimumAcquisitionYield) ||
    !isPositiveNumber(value.thresholds.maximumElapsedMs) ||
    !isPositiveNumber(value.thresholds.maximumCostUsd) ||
    !isRatio(value.thresholds.maximumCompositeRegression)
  ) {
    throw new Error(
      `Deep Research evaluation case '${value.id}' has invalid yield, time, cost, or regression thresholds.`,
    );
  }
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    id: value.id,
    title: value.title,
    scenarioClass: value.scenarioClass,
    brief: value.brief,
    expectedTerms: [...value.expectedTerms],
    requiredArtifacts: value.requiredArtifacts.map(parseArtifactKind),
    thresholds: {
      minimumRequirementCoverage: requireFiniteNumber(
        value.thresholds.minimumRequirementCoverage,
      ),
      minimumClaimSupport: requireFiniteNumber(
        value.thresholds.minimumClaimSupport,
      ),
      minimumAuthoritativeSourceRatio: requireFiniteNumber(
        value.thresholds.minimumAuthoritativeSourceRatio,
      ),
      minimumIndependentClaimRatio: requireFiniteNumber(
        value.thresholds.minimumIndependentClaimRatio,
      ),
      minimumContradictionResolution: requireFiniteNumber(
        value.thresholds.minimumContradictionResolution,
      ),
      minimumSemanticCoherence: requireFiniteNumber(
        value.thresholds.minimumSemanticCoherence,
      ),
      minimumCitationCorrectness: requireFiniteNumber(
        value.thresholds.minimumCitationCorrectness,
      ),
      minimumArtifactValidity: requireFiniteNumber(
        value.thresholds.minimumArtifactValidity,
      ),
      minimumAcquisitionYield: requireFiniteNumber(
        value.thresholds.minimumAcquisitionYield,
      ),
      minimumCompositeScore: requireFiniteNumber(
        value.thresholds.minimumCompositeScore,
      ),
      maximumElapsedMs: requireFiniteNumber(value.thresholds.maximumElapsedMs),
      maximumCostUsd: requireFiniteNumber(value.thresholds.maximumCostUsd),
      maximumCompositeRegression: requireFiniteNumber(
        value.thresholds.maximumCompositeRegression,
      ),
    },
  };
}

export function parseResearchEvaluationReport(
  value: unknown,
): ResearchEvaluationReport {
  if (
    !isRecord(value) ||
    value.schemaVersion !== DEEP_RESEARCH_SCHEMA_VERSION ||
    typeof value.evaluationId !== "string" ||
    !value.evaluationId ||
    typeof value.caseId !== "string" ||
    typeof value.caseTitle !== "string" ||
    (value.scenarioClass !== "simple" && value.scenarioClass !== "complex") ||
    typeof value.planId !== "string" ||
    typeof value.approvedPlanHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(value.approvedPlanHash) ||
    (value.correctionWave !== 0 &&
      value.correctionWave !== 1 &&
      value.correctionWave !== 2) ||
    (value.decision !== "PASS" && value.decision !== "FAIL") ||
    typeof value.evaluatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.evaluatedAt)) ||
    !isRatio(value.compositeScore) ||
    !Array.isArray(value.metrics) ||
    !isNonEmptyStringArrayOrEmpty(value.blockingReasons) ||
    !isRecord(value.artifactHashes) ||
    !isNonEmptyStringArrayOrEmpty(value.retainedArtifacts)
  ) {
    throw new Error("Deep Research evaluation report is invalid.");
  }
  const metricIds = new Set(RESEARCH_EVALUATION_METRIC_IDS);
  const seenMetricIds = new Set<string>();
  for (const metric of value.metrics) {
    if (
      !isRecord(metric) ||
      typeof metric.id !== "string" ||
      !metricIds.has(metric.id as ResearchEvaluationMetricId) ||
      seenMetricIds.has(metric.id) ||
      typeof metric.label !== "string" ||
      typeof metric.value !== "number" ||
      !Number.isFinite(metric.value) ||
      !["ratio", "sources_per_task", "milliseconds", "usd"].includes(
        String(metric.unit),
      ) ||
      (metric.comparison !== "at_least" && metric.comparison !== "at_most") ||
      typeof metric.threshold !== "number" ||
      !Number.isFinite(metric.threshold) ||
      typeof metric.passed !== "boolean"
    ) {
      throw new Error(
        "Deep Research evaluation report contains an invalid metric.",
      );
    }
    seenMetricIds.add(metric.id);
  }
  if (seenMetricIds.size !== RESEARCH_EVALUATION_METRIC_IDS.length) {
    throw new Error(
      "Deep Research evaluation report does not contain every required metric.",
    );
  }
  for (const hashName of [
    "evidenceGraph",
    "publicationAudit",
    "finalMarkdown",
    "finalDocx",
  ] as const) {
    if (
      typeof value.artifactHashes[hashName] !== "string" ||
      !/^[a-f0-9]{64}$/u.test(value.artifactHashes[hashName])
    ) {
      throw new Error(
        `Deep Research evaluation report hash '${hashName}' is invalid.`,
      );
    }
  }
  const report: ResearchEvaluationReport = {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    evaluationId: value.evaluationId,
    caseId: value.caseId,
    caseTitle: value.caseTitle,
    scenarioClass: value.scenarioClass,
    planId: value.planId,
    approvedPlanHash: value.approvedPlanHash,
    correctionWave: value.correctionWave,
    decision: value.decision,
    evaluatedAt: value.evaluatedAt,
    compositeScore: value.compositeScore,
    metrics: value.metrics.map(parseEvaluationMetric),
    blockingReasons: [...value.blockingReasons],
    artifactHashes: {
      evidenceGraph: requireString(value.artifactHashes.evidenceGraph),
      publicationAudit: requireString(value.artifactHashes.publicationAudit),
      finalMarkdown: requireString(value.artifactHashes.finalMarkdown),
      finalDocx: requireString(value.artifactHashes.finalDocx),
    },
    retainedArtifacts: [...value.retainedArtifacts],
  };
  return value.comparison === undefined
    ? report
    : { ...report, comparison: parseReportComparison(value.comparison) };
}

function parseArtifactKind(value: unknown): ResearchEvaluationArtifactKind {
  switch (value) {
    case "evidence_graph":
    case "section_dossiers":
    case "section_drafts":
    case "research_package":
    case "publication_audit":
    case "final_markdown":
    case "final_docx":
      return value;
    default:
      break;
  }
  throw new Error(
    "Deep Research evaluation case has an invalid artifact kind.",
  );
}

function parseMetricId(value: unknown): ResearchEvaluationMetricId {
  switch (value) {
    case "requirement_coverage":
    case "claim_support":
    case "authoritative_sources":
    case "independent_claim_verification":
    case "contradiction_resolution":
    case "semantic_coherence":
    case "citation_correctness":
    case "artifact_validity":
    case "acquisition_yield":
    case "elapsed_time":
    case "cost":
      return value;
    default:
      break;
  }
  throw new Error(
    "Deep Research evaluation report contains an invalid metric ID.",
  );
}

function parseEvaluationMetric(value: unknown): ResearchEvaluationMetric {
  if (
    !isRecord(value) ||
    typeof value.label !== "string" ||
    typeof value.value !== "number" ||
    !Number.isFinite(value.value) ||
    typeof value.threshold !== "number" ||
    !Number.isFinite(value.threshold) ||
    typeof value.passed !== "boolean" ||
    (value.unit !== "ratio" &&
      value.unit !== "sources_per_task" &&
      value.unit !== "milliseconds" &&
      value.unit !== "usd") ||
    (value.comparison !== "at_least" && value.comparison !== "at_most")
  ) {
    throw new Error(
      "Deep Research evaluation report contains an invalid metric.",
    );
  }
  const metric: ResearchEvaluationMetric = {
    id: parseMetricId(value.id),
    label: value.label,
    value: value.value,
    unit: value.unit,
    comparison: value.comparison,
    threshold: value.threshold,
    passed: value.passed,
  };
  const numerator =
    value.numerator === undefined
      ? undefined
      : requireFiniteNumber(value.numerator);
  const denominator =
    value.denominator === undefined
      ? undefined
      : requireFiniteNumber(value.denominator);
  return {
    ...metric,
    ...(numerator === undefined ? {} : { numerator }),
    ...(denominator === undefined ? {} : { denominator }),
  };
}

function requireString(value: unknown): string {
  if (typeof value !== "string") throw new Error("Expected a string.");
  return value;
}

function requireFiniteNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Expected a finite number.");
  return value;
}

function parseReportComparison(
  value: unknown,
): NonNullable<ResearchEvaluationReport["comparison"]> {
  if (
    !isRecord(value) ||
    typeof value.baselineEvaluationId !== "string" ||
    typeof value.baselineCompositeScore !== "number" ||
    !Number.isFinite(value.baselineCompositeScore) ||
    typeof value.compositeScoreDelta !== "number" ||
    !Number.isFinite(value.compositeScoreDelta) ||
    typeof value.maximumCompositeRegression !== "number" ||
    !Number.isFinite(value.maximumCompositeRegression) ||
    typeof value.passed !== "boolean" ||
    !Array.isArray(value.metricDeltas)
  ) {
    throw new Error("Deep Research evaluation report comparison is invalid.");
  }
  return {
    baselineEvaluationId: value.baselineEvaluationId,
    baselineCompositeScore: value.baselineCompositeScore,
    compositeScoreDelta: value.compositeScoreDelta,
    maximumCompositeRegression: value.maximumCompositeRegression,
    passed: value.passed,
    metricDeltas: value.metricDeltas.map((delta) => {
      if (
        !isRecord(delta) ||
        typeof delta.delta !== "number" ||
        !Number.isFinite(delta.delta)
      )
        throw new Error(
          "Deep Research evaluation report metric delta is invalid.",
        );
      return { id: parseMetricId(delta.id), delta: delta.delta };
    }),
  };
}

function buildComparison(params: {
  metrics: readonly ResearchEvaluationMetric[];
  compositeScore: number;
  baseline: ResearchEvaluationReport;
  maximumCompositeRegression: number;
}): NonNullable<ResearchEvaluationReport["comparison"]> {
  const baselineById = new Map(
    params.baseline.metrics.map((metric) => [metric.id, metric]),
  );
  const compositeScoreDelta = round(
    params.compositeScore - params.baseline.compositeScore,
  );
  return {
    baselineEvaluationId: params.baseline.evaluationId,
    baselineCompositeScore: params.baseline.compositeScore,
    compositeScoreDelta,
    maximumCompositeRegression: params.maximumCompositeRegression,
    passed: compositeScoreDelta >= -params.maximumCompositeRegression,
    metricDeltas: params.metrics.map((metric) => ({
      id: metric.id,
      delta: round(
        metric.value - (baselineById.get(metric.id)?.value ?? metric.value),
      ),
    })),
  };
}

function minimumMetric(params: {
  id: ResearchEvaluationMetricId;
  label: string;
  value: number;
  threshold: number;
  unit?: ResearchEvaluationMetric["unit"];
  numerator?: number;
  denominator?: number;
}): ResearchEvaluationMetric {
  return {
    id: params.id,
    label: params.label,
    value: round(params.value),
    unit: params.unit ?? "ratio",
    comparison: "at_least",
    threshold: params.threshold,
    passed: params.value >= params.threshold,
    ...(params.numerator === undefined ? {} : { numerator: params.numerator }),
    ...(params.denominator === undefined
      ? {}
      : { denominator: params.denominator }),
  };
}

function maximumMetric(params: {
  id: ResearchEvaluationMetricId;
  label: string;
  value: number;
  threshold: number;
  unit: ResearchEvaluationMetric["unit"];
}): ResearchEvaluationMetric {
  return {
    id: params.id,
    label: params.label,
    value: round(params.value),
    unit: params.unit,
    comparison: "at_most",
    threshold: params.threshold,
    passed: params.value <= params.threshold,
  };
}

function validateObservation(
  observation: DeepResearchEvaluationObservation,
): void {
  if (
    !Number.isInteger(observation.approvedTaskCount) ||
    observation.approvedTaskCount < 1 ||
    !Number.isInteger(observation.usableObservedSources) ||
    observation.usableObservedSources < 0 ||
    !Number.isFinite(observation.elapsedMs) ||
    observation.elapsedMs < 0 ||
    !Number.isFinite(observation.costUsd) ||
    observation.costUsd < 0 ||
    typeof observation.semanticReviewApproved !== "boolean" ||
    !isRecord(observation.artifactChecks) ||
    typeof observation.finalMarkdown !== "string" ||
    observation.finalMarkdown.trim().length === 0 ||
    observation.finalDocx.byteLength === 0 ||
    !Array.isArray(observation.retainedArtifacts) ||
    observation.retainedArtifacts.some(
      (artifact) => typeof artifact !== "string" || !artifact.trim(),
    )
  ) {
    throw new Error("Deep Research evaluation observation is invalid.");
  }
}

function ratio(numerator: number, denominator: number): number {
  return denominator === 0 ? 1 : clampRatio(numerator / denominator);
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function average(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function formatMetric(
  value: number,
  unit: ResearchEvaluationMetric["unit"],
): string {
  if (unit === "ratio") return `${(value * 100).toFixed(1)}%`;
  if (unit === "usd") return `$${value.toFixed(2)}`;
  if (unit === "milliseconds") return `${(value / 60_000).toFixed(1)} minutes`;
  return `${value.toFixed(2)} sources per task`;
}

function semanticText(value: string): string {
  return value
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function hashValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function hashBytes(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRatio(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function isNonEmptyStringArrayOrEmpty(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}
