import { createHash } from "node:crypto";

import {
  DEEP_RESEARCH_SCHEMA_VERSION,
  type ResearchCitationCanonicalizationSummary,
  type ResearchCitationRemoval,
  type ResearchCitationRemovalKind,
  type ResearchEvidenceGraph,
  type ResearchPublicationAudit,
  type ResearchPublicationViolationCode,
} from "../../contracts/deep-research.js";
import { stripArtifactFrontmatter } from "../runtime/artifacts.js";
import { parseResearchEvidenceGraph } from "./deep-research-evidence-graph.js";

const URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
// CommonMark allows citation definitions to be indented by up to three
// spaces; four or more open a code block instead.
const FOOTNOTE_DEFINITION_LINE_PATTERN =
  /^[ ]{0,3}\[\^([^\]]+)\]:[ \t]*(.+)$/u;
const FOOTNOTE_REFERENCE_PATTERN = /\[\^([^\]]+)\]/gu;
const REFERENCE_DEFINITION_LINE_PATTERN =
  /^[ ]{0,3}\[([^^\]][^\]]*)\]:[ \t]*(\S.*)$/u;
// Full `[text][label]` and collapsed `[label][]` references first, then the
// shortcut form `[label]` when no inline-link or second-label syntax follows.
// The lookbehinds reject image syntax: `![chart][r1]` renders a figure, not
// a citation, so neither its label nor its trailing `[r1]` may count.
const REFERENCE_LINK_PATTERN =
  /(?<!!)\[([^\]]*)\]\[([^\]]*)\]|(?<!!\[[^\]]*\]|!)\[([^\]]+)\](?![\[(])/gu;

const CAVEAT_MARKERS = [
  {
    name: "contradiction",
    pattern:
      /\b(?:contradict(?:ion|ions|ory|ed|s)?|conflicting evidence|sources? disagree)\b/iu,
  },
  {
    name: "limitation",
    pattern: /\b(?:limitation|limitations|limited evidence)\b/iu,
  },
  {
    name: "uncertainty",
    pattern: /\b(?:uncertainty|uncertainties|uncertain)\b/iu,
  },
  {
    name: "unresolved",
    pattern: /\b(?:unresolved|open question|open questions)\b/iu,
  },
  {
    name: "caveat",
    pattern: /\b(?:caveat|caveats)\b/iu,
  },
  {
    name: "disputed",
    pattern: /\b(?:disputed|contested)\b/iu,
  },
  {
    name: "insufficient evidence",
    pattern:
      /\b(?:insufficient evidence|inconclusive|cannot determine|no evidence|(?:evidence|sources?)\s+(?:do|does|did|can|could|will|would)?\s*not\s+(?:establish|support|show|demonstrate))\b/iu,
  },
  {
    name: "unknown",
    pattern: /\b(?:unknown|not known)\b/iu,
  },
  {
    name: "low confidence",
    pattern: /\b(?:low confidence|weak confidence)\b/iu,
  },
] as const;

const SOURCE_SECTION_PATTERN =
  /^(?:sources?|references?|bibliography|works cited|source list)$/iu;
const CLAIM_IDENTIFIER_PATTERN =
  /\b(?:(?:claim|source|task|section|receipt|lane|wave|schema(?:version)?)[-_:# ]*\d+|version[-_:#]+\d+)\b/giu;
const NUMERAL_PATTERN =
  /(?<![\p{L}\p{N}_])(?:[$€£¥]\s*)?[+-]?(?:\d{4}-\d{2}-\d{2}|(?:\d{1,3}(?:[, ]\d{3})+|\d+)(?:\.\d+)?(?:[eE][+-]?\d+)?)(?:\s?(?:%|‰|bps?|[kmbt]|st|nd|rd|th))?(?![\p{L}\p{N}_])/giu;

export interface EditorialProvenanceSummary {
  sourceUrls: readonly string[];
  claimBearingNumerals: readonly string[];
  caveatMarkers: readonly string[];
}

/**
 * Shared citation URL normalizer. The canonicalizer must reuse this so a
 * trailing-slash or encoding difference can never surface as a URL that was
 * both removed and introduced.
 */
export function normalizeCitationUrl(value: string): string {
  return normalizeUrl(value);
}

/**
 * Shared source-heading predicate backed by the audit's own pattern. The
 * canonicalizer reuses it so both modules recognize exactly the same headings.
 */
export function isSourceSectionHeading(value: string): boolean {
  return SOURCE_SECTION_PATTERN.test(value.trim());
}

/**
 * Replaces every raw HTTP(S) URL — together with any angle-bracket or paren
 * wrapper it would otherwise leave empty — with a space. The canonicalizer
 * reuses it when preserving the readable label of a removed link so the
 * removed URL cannot leak back in through its own label text and no
 * dangling wrapper punctuation survives the scrub.
 */
export function stripCitationUrls(value: string): string {
  return value.replace(STRIPPED_URL_PATTERN, " ");
}

// URL_PATTERN's match would swallow a closing paren but stop at `>`, so the
// wrapped forms are stripped with their wrapper instead of leaving `(` / `< >`
// behind.
const STRIPPED_URL_PATTERN =
  /<[ \t]*https?:\/\/[^\s<>"'`]+[ \t]*>?|\([ \t]*https?:\/\/[^\s<>"'`]+[ \t]*\)?|https?:\/\/[^\s<>"'`]+/giu;

/**
 * Every raw HTTP(S) URL in the text, in reading order. The canonicalizer
 * reuses it to recover URLs that survive inside preserved link labels, so
 * the audit inventory sees what its legacy raw scan saw.
 */
export function extractRawCitationUrls(value: string): string[] {
  return Array.from(value.matchAll(URL_PATTERN), (match) => match[0]);
}

interface PublicationAuditViolation {
  code: ResearchPublicationViolationCode;
  message: string;
  claimIds: string[];
  sourceIds: string[];
}

export function buildResearchPublicationAudit(params: {
  sourceMarkdown: string;
  publicationMarkdown: string;
  evidenceGraph?: unknown;
  auditedAt?: string;
  canonicalization?: ResearchCitationCanonicalizationSummary;
}): ResearchPublicationAudit {
  const source = summarizeEditorialProvenance(params.sourceMarkdown);
  const publication = summarizeEditorialProvenance(params.publicationMarkdown);
  const graph =
    params.evidenceGraph === undefined
      ? undefined
      : parseResearchEvidenceGraph(params.evidenceGraph);
  const violations: PublicationAuditViolation[] = [];

  // With canonicalization active the evidence graph, not the editorial draft,
  // is the URL baseline: repairing a hallucinated URL that the draft contained
  // must not read as evidence loss, and adding a validated graph URL to the
  // generated Sources section must not read as an introduced source.
  const canonicalization = params.canonicalization;
  const expectedUrls = canonicalization
    ? uniqueSorted(canonicalization.graphUrlBaseline)
    : source.sourceUrls;
  const observedUrls = canonicalization
    ? uniqueSorted(canonicalization.publicationUrlInventory)
    : publication.sourceUrls;

  if (expectedUrls.length === 0) {
    violations.push(
      violation(
        "source_inventory_empty",
        canonicalization
          ? "the evidence graph contains no usable HTTP(S) sources"
          : "the provenance source contains no HTTP(S) source URLs",
      ),
    );
  }

  appendDifferenceViolation({
    violations,
    code: "source_removed",
    message: "removed source URLs",
    left: expectedUrls,
    right: observedUrls,
  });
  appendDifferenceViolation({
    violations,
    code: "source_introduced",
    message: "introduced source URLs",
    left: observedUrls,
    right: expectedUrls,
  });
  appendDifferenceViolation({
    violations,
    code: "claim_numeral_removed",
    message: "removed claim-bearing numerals",
    left: source.claimBearingNumerals,
    right: publication.claimBearingNumerals,
  });
  appendDifferenceViolation({
    violations,
    code: "claim_numeral_introduced",
    message: "introduced claim-bearing numerals",
    left: publication.claimBearingNumerals,
    right: source.claimBearingNumerals,
  });
  appendDifferenceViolation({
    violations,
    code: "caveat_removed",
    message: "removed caveat markers",
    left: source.caveatMarkers,
    right: publication.caveatMarkers,
  });

  const publicationUrlOccurrences = countUrlOccurrences(
    params.publicationMarkdown,
  );
  const graphSourceIdsByUrl = new Map<string, string[]>();
  if (graph) {
    for (const sourceNode of graph.sources) {
      const canonicalUrl = normalizeUrl(sourceNode.canonicalUrl);
      const sourceIds = graphSourceIdsByUrl.get(canonicalUrl) ?? [];
      sourceIds.push(sourceNode.id);
      graphSourceIdsByUrl.set(canonicalUrl, uniqueSorted(sourceIds));
    }
  }
  const citationInventory = uniqueSorted([
    ...publication.sourceUrls,
    ...graphSourceIdsByUrl.keys(),
  ]).map((url) => ({
    url,
    occurrences: publicationUrlOccurrences.get(url) ?? 0,
    sourceIds: graphSourceIdsByUrl.get(url) ?? [],
  }));

  const graphCoverage = evaluateGraphCoverage(
    graph,
    new Set(publication.sourceUrls),
  );
  if (
    graphCoverage.requiredClaimSourceLinks >
    graphCoverage.preservedClaimSourceLinks
  ) {
    violations.push({
      code: "graph_source_missing",
      message:
        `missing ${graphCoverage.requiredClaimSourceLinks - graphCoverage.preservedClaimSourceLinks} ` +
        "validated claim-to-source links from the publication",
      claimIds: [...graphCoverage.missingClaimIds],
      sourceIds: [...graphCoverage.missingSourceIds],
    });
  }

  const numericClaimParagraphs = extractNumericClaimParagraphs(
    params.publicationMarkdown,
  );
  if (graph) {
    const uncited = numericClaimParagraphs.filter(
      (paragraph) => !paragraph.cited,
    );
    if (uncited.length > 0) {
      violations.push({
        code: "numeric_claim_uncited",
        message:
          `${uncited.length} numeric claim paragraph${uncited.length === 1 ? " is" : "s are"} ` +
          "missing an inline URL or URL-backed footnote",
        claimIds: [],
        sourceIds: [],
      });
    }
  }

  const auditIdentity = JSON.stringify({
    source,
    publication,
    graphCoverage,
    numericClaimParagraphs,
    violations,
    canonicalization: canonicalization ?? null,
  });
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    auditId: `publication-audit-${createHash("sha256").update(auditIdentity).digest("hex").slice(0, 20)}`,
    decision: violations.length === 0 ? "APPROVE" : "REVISE",
    auditedAt: params.auditedAt ?? new Date().toISOString(),
    ...(canonicalization ? { canonicalization } : {}),
    sourceSummary: {
      sourceUrls: source.sourceUrls,
      publicationUrls: publication.sourceUrls,
      claimBearingNumerals: source.claimBearingNumerals,
      publicationClaimBearingNumerals: publication.claimBearingNumerals,
      caveatMarkers: source.caveatMarkers,
      publicationCaveatMarkers: publication.caveatMarkers,
    },
    citationInventory,
    graphCoverage,
    numericClaimParagraphs,
    violations,
  };
}

export function parseResearchPublicationAudit(
  value: unknown,
): ResearchPublicationAudit {
  if (
    !isRecord(value) ||
    value.schemaVersion !== DEEP_RESEARCH_SCHEMA_VERSION ||
    typeof value.auditId !== "string" ||
    !value.auditId ||
    (value.decision !== "APPROVE" && value.decision !== "REVISE") ||
    typeof value.auditedAt !== "string" ||
    !Number.isFinite(Date.parse(value.auditedAt)) ||
    !isRecord(value.sourceSummary) ||
    !Array.isArray(value.citationInventory) ||
    !isRecord(value.graphCoverage) ||
    !Array.isArray(value.numericClaimParagraphs) ||
    !Array.isArray(value.violations)
  ) {
    throw new Error("Research publication audit identity is invalid.");
  }
  for (const field of [
    "sourceUrls",
    "publicationUrls",
    "claimBearingNumerals",
    "publicationClaimBearingNumerals",
    "caveatMarkers",
    "publicationCaveatMarkers",
  ] as const) {
    if (!isStringArray(value.sourceSummary[field])) {
      throw new Error(
        `Research publication audit source summary '${field}' is invalid.`,
      );
    }
  }
  if (
    !isNonNegativeInteger(value.graphCoverage.requiredClaimSourceLinks) ||
    !isNonNegativeInteger(value.graphCoverage.preservedClaimSourceLinks) ||
    !isStringArray(value.graphCoverage.missingClaimIds) ||
    !isStringArray(value.graphCoverage.missingSourceIds)
  ) {
    throw new Error("Research publication audit graph coverage is invalid.");
  }
  for (const entry of value.citationInventory) {
    if (
      !isRecord(entry) ||
      typeof entry.url !== "string" ||
      !isNonNegativeInteger(entry.occurrences) ||
      !isStringArray(entry.sourceIds)
    ) {
      throw new Error(
        "Research publication audit citation inventory is invalid.",
      );
    }
  }
  for (const paragraph of value.numericClaimParagraphs) {
    if (
      !isRecord(paragraph) ||
      typeof paragraph.paragraph !== "string" ||
      !isStringArray(paragraph.numerals) ||
      !isStringArray(paragraph.citationUrls) ||
      typeof paragraph.cited !== "boolean"
    ) {
      throw new Error(
        "Research publication audit numeric claim inventory is invalid.",
      );
    }
  }
  const violationCodes = new Set<ResearchPublicationViolationCode>([
    "source_inventory_empty",
    "source_removed",
    "source_introduced",
    "claim_numeral_removed",
    "claim_numeral_introduced",
    "caveat_removed",
    "graph_source_missing",
    "numeric_claim_uncited",
  ]);
  for (const entry of value.violations) {
    if (
      !isRecord(entry) ||
      typeof entry.code !== "string" ||
      !violationCodes.has(entry.code as ResearchPublicationViolationCode) ||
      typeof entry.message !== "string" ||
      !isStringArray(entry.claimIds) ||
      !isStringArray(entry.sourceIds)
    ) {
      throw new Error("Research publication audit violation is invalid.");
    }
  }
  const canonicalization = parseCanonicalizationSummary(value.canonicalization);
  return {
    schemaVersion: DEEP_RESEARCH_SCHEMA_VERSION,
    auditId: value.auditId,
    decision: value.decision,
    auditedAt: value.auditedAt,
    ...(canonicalization ? { canonicalization } : {}),
    sourceSummary: {
      sourceUrls: requireStringArray(value.sourceSummary.sourceUrls),
      publicationUrls: requireStringArray(value.sourceSummary.publicationUrls),
      claimBearingNumerals: requireStringArray(
        value.sourceSummary.claimBearingNumerals,
      ),
      publicationClaimBearingNumerals: requireStringArray(
        value.sourceSummary.publicationClaimBearingNumerals,
      ),
      caveatMarkers: requireStringArray(value.sourceSummary.caveatMarkers),
      publicationCaveatMarkers: requireStringArray(
        value.sourceSummary.publicationCaveatMarkers,
      ),
    },
    citationInventory: value.citationInventory.map((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.url !== "string" ||
        !isNonNegativeInteger(entry.occurrences) ||
        !isStringArray(entry.sourceIds)
      )
        throw new Error(
          "Research publication audit citation inventory is invalid.",
        );
      return {
        url: entry.url,
        occurrences: entry.occurrences,
        sourceIds: [...entry.sourceIds],
      };
    }),
    graphCoverage: {
      requiredClaimSourceLinks: value.graphCoverage.requiredClaimSourceLinks,
      preservedClaimSourceLinks: value.graphCoverage.preservedClaimSourceLinks,
      missingClaimIds: [...value.graphCoverage.missingClaimIds],
      missingSourceIds: [...value.graphCoverage.missingSourceIds],
    },
    numericClaimParagraphs: value.numericClaimParagraphs.map((paragraph) => {
      if (
        !isRecord(paragraph) ||
        typeof paragraph.paragraph !== "string" ||
        !isStringArray(paragraph.numerals) ||
        !isStringArray(paragraph.citationUrls) ||
        typeof paragraph.cited !== "boolean"
      )
        throw new Error(
          "Research publication audit numeric claim inventory is invalid.",
        );
      return {
        paragraph: paragraph.paragraph,
        numerals: [...paragraph.numerals],
        citationUrls: [...paragraph.citationUrls],
        cited: paragraph.cited,
      };
    }),
    violations: value.violations.map((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.message !== "string" ||
        !isStringArray(entry.claimIds) ||
        !isStringArray(entry.sourceIds)
      )
        throw new Error("Research publication audit violation is invalid.");
      return {
        code: parsePublicationViolationCode(entry.code),
        message: entry.message,
        claimIds: [...entry.claimIds],
        sourceIds: [...entry.sourceIds],
      };
    }),
  };
}

function parsePublicationViolationCode(
  value: unknown,
): ResearchPublicationViolationCode {
  switch (value) {
    case "source_inventory_empty":
    case "source_removed":
    case "source_introduced":
    case "claim_numeral_removed":
    case "claim_numeral_introduced":
    case "caveat_removed":
    case "graph_source_missing":
    case "numeric_claim_uncited":
      return value;
    default:
      throw new Error("Research publication audit violation is invalid.");
  }
}

/**
 * Validates the optional canonicalization record. Audits persisted before the
 * canonicalizer existed omit the field entirely and must keep parsing.
 */
function parseCanonicalizationSummary(
  value: unknown,
): ResearchCitationCanonicalizationSummary | undefined {
  if (value === undefined) return undefined;
  if (
    !isRecord(value) ||
    typeof value.inputSha256 !== "string" ||
    typeof value.outputSha256 !== "string" ||
    !isStringArray(value.graphUrlBaseline) ||
    !isStringArray(value.publicationUrlInventory) ||
    !isNonNegativeInteger(value.normalizedLinkCount) ||
    !isNonNegativeInteger(value.generatedSourceCount) ||
    !isStringArray(value.removedSourceSectionHeadings) ||
    !Array.isArray(value.removedUnknownUrls)
  ) {
    throw new Error("Research publication audit canonicalization is invalid.");
  }
  const removedUnknownUrls: ResearchCitationRemoval[] =
    value.removedUnknownUrls.map((entry) => {
      if (
        !isRecord(entry) ||
        typeof entry.url !== "string" ||
        typeof entry.kind !== "string" ||
        !isCitationRemovalKind(entry.kind) ||
        !isNonNegativeInteger(entry.offset)
      ) {
        throw new Error(
          "Research publication audit canonicalization removal is invalid.",
        );
      }
      return { url: entry.url, kind: entry.kind, offset: entry.offset };
    });
  return {
    inputSha256: value.inputSha256,
    outputSha256: value.outputSha256,
    graphUrlBaseline: [...value.graphUrlBaseline],
    publicationUrlInventory: [...value.publicationUrlInventory],
    normalizedLinkCount: value.normalizedLinkCount,
    generatedSourceCount: value.generatedSourceCount,
    removedSourceSectionHeadings: [...value.removedSourceSectionHeadings],
    removedUnknownUrls,
  };
}

function isCitationRemovalKind(
  value: string,
): value is ResearchCitationRemovalKind {
  return (
    value === "inline_link" ||
    value === "autolink" ||
    value === "bare_url" ||
    value === "reference_definition" ||
    value === "footnote_definition"
  );
}

function requireStringArray(value: unknown): string[] {
  if (!isStringArray(value))
    throw new Error("Research publication audit string array is invalid.");
  return [...value];
}

/**
 * Enforces a deterministic floor under semantic writing review. With a graph,
 * this additionally verifies claim-source retention and numeric citations.
 */
export function assertEditorialProvenancePreserved(params: {
  sourceMarkdown: string;
  publicationMarkdown: string;
  evidenceGraph?: unknown;
  auditedAt?: string;
}): ResearchPublicationAudit {
  const audit = buildResearchPublicationAudit(params);
  if (audit.decision === "REVISE") {
    throw new Error(
      `Post-editorial provenance check failed: ${audit.violations
        .map((entry) => entry.message)
        .join("; ")}.`,
    );
  }
  return audit;
}

export function summarizeEditorialProvenance(
  markdown: string,
): EditorialProvenanceSummary {
  const body = stripArtifactFrontmatter(markdown);
  const sourceUrls = uniqueSorted(
    Array.from(body.matchAll(URL_PATTERN), (match) => normalizeUrl(match[0])),
  );
  const claimText = claimBearingText(body);
  const claimBearingNumerals = uniqueSorted(
    Array.from(claimText.matchAll(NUMERAL_PATTERN), (match) =>
      normalizeNumeral(match[0]),
    ),
  );
  const caveatMarkers = CAVEAT_MARKERS.filter(({ pattern }) =>
    pattern.test(claimText),
  ).map(({ name }) => name);

  return { sourceUrls, claimBearingNumerals, caveatMarkers };
}

function evaluateGraphCoverage(
  graph: ResearchEvidenceGraph | undefined,
  publicationUrls: ReadonlySet<string>,
): ResearchPublicationAudit["graphCoverage"] {
  if (!graph) {
    return {
      requiredClaimSourceLinks: 0,
      preservedClaimSourceLinks: 0,
      missingClaimIds: [],
      missingSourceIds: [],
    };
  }
  const sourceById = new Map(
    graph.sources.map((source) => [source.id, source]),
  );
  let requiredClaimSourceLinks = 0;
  let preservedClaimSourceLinks = 0;
  const missingClaimIds = new Set<string>();
  const missingSourceIds = new Set<string>();
  for (const claim of graph.claims) {
    if (claim.status !== "supported") continue;
    for (const sourceId of claim.supportingSourceIds) {
      const source = sourceById.get(sourceId);
      if (!source) {
        // Same invariant the canonicalizer enforces before publication: a
        // supported claim pointing at a nonexistent source is a graph defect
        // and must fail closed, not be skipped out of the coverage count.
        throw new Error(
          `Research publication audit cannot resolve source '${sourceId}' ` +
            `supporting claim '${claim.id}'.`,
        );
      }
      requiredClaimSourceLinks += 1;
      if (publicationUrls.has(normalizeUrl(source.canonicalUrl))) {
        preservedClaimSourceLinks += 1;
      } else {
        missingClaimIds.add(claim.id);
        missingSourceIds.add(sourceId);
      }
    }
  }
  return {
    requiredClaimSourceLinks,
    preservedClaimSourceLinks,
    missingClaimIds: [...missingClaimIds].sort(),
    missingSourceIds: [...missingSourceIds].sort(),
  };
}

function extractNumericClaimParagraphs(
  markdown: string,
): ResearchPublicationAudit["numericClaimParagraphs"] {
  const body = stripArtifactFrontmatter(markdown);
  const { footnoteUrls, referenceUrls } = collectDefinitionUrls(body);

  return claimParagraphs(body).flatMap((paragraph) => {
    const claimText = paragraph
      .replace(URL_PATTERN, " ")
      .replace(FOOTNOTE_REFERENCE_PATTERN, " ");
    const numerals = uniqueSorted(
      Array.from(claimText.matchAll(NUMERAL_PATTERN), (match) =>
        normalizeNumeral(match[0]),
      ),
    );
    if (numerals.length === 0) return [];
    const citationUrls = uniqueSorted([
      ...Array.from(paragraph.matchAll(URL_PATTERN), (match) =>
        normalizeUrl(match[0]),
      ),
      ...Array.from(
        paragraph.matchAll(FOOTNOTE_REFERENCE_PATTERN),
        (match) =>
          footnoteUrls.get(
            normalizeReferenceLabel(requiredCapture(match, 1)),
          ) ?? [],
      ).flat(),
      ...resolvedReferenceUrls(paragraph, referenceUrls),
    ]);
    return [
      {
        paragraph: paragraph.replace(/\s+/gu, " ").trim(),
        numerals,
        citationUrls,
        cited: citationUrls.length > 0,
      },
    ];
  });
}

/**
 * Footnote and reference definition URLs outside fenced code, resolved with
 * the same rules CommonMark and the canonicalizer apply: labels compare
 * case-insensitively and the first definition wins, so later duplicates are
 * ignored instead of shadowing it. Fenced lines toggle exactly like
 * claimParagraphs does, so a definition inside a code block can never be
 * credited as a citation.
 */
function collectDefinitionUrls(body: string): {
  footnoteUrls: Map<string, string[]>;
  referenceUrls: Map<string, string[]>;
} {
  const footnoteUrls = new Map<string, string[]>();
  const referenceUrls = new Map<string, string[]>();
  let inFence = false;
  for (const rawLine of body.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (/^(```|~~~)/u.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const footnote = FOOTNOTE_DEFINITION_LINE_PATTERN.exec(rawLine);
    if (footnote) {
      const label = normalizeReferenceLabel(requiredCapture(footnote, 1));
      if (label && !footnoteUrls.has(label)) {
        footnoteUrls.set(
          label,
          definitionCitationUrls(requiredCapture(footnote, 2)),
        );
      }
      continue;
    }
    const reference = REFERENCE_DEFINITION_LINE_PATTERN.exec(rawLine);
    if (reference) {
      const label = normalizeReferenceLabel(requiredCapture(reference, 1));
      if (label && !referenceUrls.has(label)) {
        referenceUrls.set(
          label,
          definitionCitationUrls(requiredCapture(reference, 2)),
        );
      }
    }
  }
  return { footnoteUrls, referenceUrls };
}

function definitionCitationUrls(definition: string): string[] {
  return uniqueSorted(
    Array.from(definition.matchAll(URL_PATTERN), (match) =>
      normalizeUrl(match[0]),
    ),
  );
}

function resolvedReferenceUrls(
  paragraph: string,
  definitions: ReadonlyMap<string, string[]>,
): string[] {
  const urls: string[] = [];
  for (const match of paragraph.matchAll(REFERENCE_LINK_PATTERN)) {
    const rawLabel = match[3] ?? (match[2] ? match[2] : match[1] ?? "");
    if (!rawLabel || rawLabel.startsWith("^")) continue;
    const resolved = definitions.get(normalizeReferenceLabel(rawLabel));
    if (resolved) urls.push(...resolved);
  }
  return urls;
}

function normalizeReferenceLabel(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

function requiredCapture(match: RegExpMatchArray, index: number): string {
  const capture = match[index];
  if (capture === undefined) {
    throw new Error(
      `Research publication audit pattern matched without capture ${index}.`,
    );
  }
  return capture;
}

function claimParagraphs(markdown: string): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];
  let excludedSourceHeadingLevel: number | undefined;
  let inFence = false;
  const flush = () => {
    const value = current.join(" ").trim();
    if (value) paragraphs.push(value);
    current = [];
  };

  for (const rawLine of markdown.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (/^(```|~~~)/u.test(trimmed)) {
      flush();
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const heading = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(trimmed);
    if (heading) {
      flush();
      const level = requiredCapture(heading, 1).length;
      if (
        excludedSourceHeadingLevel !== undefined &&
        level <= excludedSourceHeadingLevel
      ) {
        excludedSourceHeadingLevel = undefined;
      }
      if (SOURCE_SECTION_PATTERN.test(requiredCapture(heading, 2).trim())) {
        excludedSourceHeadingLevel = level;
      }
      continue;
    }
    if (excludedSourceHeadingLevel !== undefined) continue;
    if (
      !trimmed ||
      FOOTNOTE_DEFINITION_LINE_PATTERN.test(trimmed) ||
      REFERENCE_DEFINITION_LINE_PATTERN.test(trimmed) ||
      /^\|?(?:\s*:?-{3,}:?\s*\|)+$/u.test(trimmed)
    ) {
      flush();
      continue;
    }
    current.push(trimmed);
  }
  flush();
  return paragraphs;
}

function claimBearingText(markdown: string): string {
  const output: string[] = [];
  let excludedSourceHeadingLevel: number | undefined;
  let inFence = false;

  for (const rawLine of markdown.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (/^(```|~~~)/u.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const heading = /^(#{1,6})\s+(.+?)\s*#*$/u.exec(trimmed);
    if (heading) {
      const level = requiredCapture(heading, 1).length;
      if (
        excludedSourceHeadingLevel !== undefined &&
        level <= excludedSourceHeadingLevel
      ) {
        excludedSourceHeadingLevel = undefined;
      }
      if (SOURCE_SECTION_PATTERN.test(requiredCapture(heading, 2).trim())) {
        excludedSourceHeadingLevel = level;
        continue;
      }
    }
    if (excludedSourceHeadingLevel !== undefined) continue;
    // Reference definitions are metadata, not claim text: an unknown
    // definition removed during repair must not read as removed numerals.
    // Footnote definitions are deliberately NOT excluded: unlike reference
    // definitions, their prose is claim-bearing.
    if (
      !trimmed ||
      REFERENCE_DEFINITION_LINE_PATTERN.test(trimmed) ||
      /^\|?(?:\s*:?-{3,}:?\s*\|)+$/u.test(trimmed)
    ) {
      continue;
    }

    output.push(
      rawLine
        .replace(URL_PATTERN, " ")
        .replace(/^(\s*#{1,6}\s*)\d+(?:\.\d+)*[.)]?\s+/u, "$1")
        .replace(/^\s*(?:>\s*)*\d+[.)]\s+/u, "")
        .replace(/\[\^?\d+\]/gu, " ")
        .replace(CLAIM_IDENTIFIER_PATTERN, " "),
    );
  }

  return output.join("\n");
}

function appendDifferenceViolation(params: {
  violations: PublicationAuditViolation[];
  code: ResearchPublicationViolationCode;
  message: string;
  left: readonly string[];
  right: readonly string[];
}): void {
  const values = difference(params.left, params.right);
  if (values.length === 0) return;
  params.violations.push(
    violation(params.code, `${params.message}: ${formatValues(values)}`),
  );
}

function violation(
  code: ResearchPublicationViolationCode,
  message: string,
): PublicationAuditViolation {
  return { code, message, claimIds: [], sourceIds: [] };
}

function countUrlOccurrences(markdown: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of stripArtifactFrontmatter(markdown).matchAll(
    URL_PATTERN,
  )) {
    const url = normalizeUrl(match[0]);
    counts.set(url, (counts.get(url) ?? 0) + 1);
  }
  return counts;
}

function normalizeUrl(value: string): string {
  let withoutPunctuation = value.replace(/[.,;:!?}\]]+$/u, "");
  while (
    withoutPunctuation.endsWith(")") &&
    count(withoutPunctuation, ")") > count(withoutPunctuation, "(")
  ) {
    withoutPunctuation = withoutPunctuation.slice(0, -1);
  }
  try {
    return new URL(withoutPunctuation).toString();
  } catch {
    return withoutPunctuation;
  }
}

function count(value: string, character: string): number {
  return Array.from(value).filter((candidate) => candidate === character)
    .length;
}

function normalizeNumeral(value: string): string {
  return value
    .replace(/\s+/gu, "")
    .replace(/,(?=\d{3}(?:\D|$))/gu, "")
    .toLowerCase();
}

function uniqueSorted(values: readonly string[]): string[] {
  // Code-unit order (same as the canonicalizer) so audit summaries and the
  // auditId hash never depend on the runtime's collation locale.
  return Array.from(new Set(values.filter(Boolean))).sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
}

function difference(
  left: readonly string[],
  right: readonly string[],
): string[] {
  const accepted = new Set(right);
  return left.filter((value) => !accepted.has(value));
}

function formatValues(values: readonly string[]): string {
  const shown = values
    .slice(0, 5)
    .map((value) => `'${value}'`)
    .join(", ");
  return values.length > 5 ? `${shown}, and ${values.length - 5} more` : shown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}
