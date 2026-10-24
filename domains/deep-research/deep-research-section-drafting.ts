import * as z from 'zod/v4'

import type {
  ClaimRecord,
  ResearchCoverageEntry,
  ResearchPlan,
  ResearchSectionDossier,
  ResearchSectionDossierIndex,
  SourceRecord,
} from '../../contracts/deep-research.js'
import { assertResearchPlanApproved } from './deep-research-approval.js'
import {
  parseClaimRecord,
  parseResearchRequirementCoverage,
  parseSourceRecord,
} from './deep-research-validation.js'
import {
  accountProviderRequest,
  refuseProviderRequest,
  type ProviderRequestBudget,
  type RenderedProviderRequest,
} from '../provider/provider-request-budget.js'
import { readOwnedResearchJson } from './deep-research-artifact-reader.js'
import { isUnknownArray } from '../../core/unknown-array.js'

/**
 * Deep Research — section drafting boundary.
 *
 * A section writer is given evidence, never a filesystem. The runtime resolves
 * the section's dossier inside the assignment it owns, reads it in this shell,
 * and renders a bounded payload the provider request carries in full. Nothing
 * downstream depends on the model opening a local path, which is what a
 * tool-isolated provider cannot do and what a refusal used to be mistaken for.
 */

const MAX_DOSSIER_INDEX_BYTES = 512 * 1024
const MAX_DOSSIER_BYTES = 8 * 1024 * 1024

/** Longest observed excerpt kept before compaction starts shortening them. */
const FULL_EXCERPT_LENGTH = 400
const COMPACTED_EXCERPT_LENGTH = 120

// ─── Writer response contract ────────────────────────────────────────────────

/**
 * The schema is the contract. A section writer answers with this object and
 * nothing else, so a refusal, a status report, or a plain-Markdown draft
 * cannot be mistaken for a completed section: none of them carries the
 * `section_complete` discriminator or the evidence identifiers beside it.
 */
export const sectionDraftResultSchema = z.strictObject({
  schemaVersion: z.literal(1),
  status: z.literal('section_complete'),
  sectionId: z.string().min(1),
  claimIds: z.array(z.string().min(1)),
  sourceIds: z.array(z.string().min(1)),
  markdown: z.string().min(1),
})

export type SectionDraftResult = z.infer<typeof sectionDraftResultSchema>

export class SectionDraftValidationError extends Error {
  constructor(
    readonly sectionId: string,
    readonly reason: string,
  ) {
    super(`Section '${sectionId}' draft was rejected: ${reason}`)
    this.name = 'SectionDraftValidationError'
  }
}

/**
 * The writer's answer, or a typed rejection.
 *
 * Fences are tolerated because models add them unbidden; prose around the
 * object is not, because a "here is my draft, but…" preamble is exactly the
 * procedural report this contract exists to reject.
 */
export function parseSectionDraftResult(input: {
  readonly sectionId: string
  readonly text: string
}): SectionDraftResult {
  const trimmed = stripCodeFence(input.text.trim())
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    throw new SectionDraftValidationError(
      input.sectionId,
      'the response was not the single section-draft JSON object the contract requires. ' +
      'A refusal, status report, or plain Markdown draft cannot be persisted as a section.',
    )
  }
  const parsed = sectionDraftResultSchema.safeParse(raw)
  if (!parsed.success) {
    throw new SectionDraftValidationError(
      input.sectionId,
      `the response did not satisfy the section-draft contract (${formatIssues(parsed.error)}).`,
    )
  }
  return parsed.data
}

/**
 * An absolute http(s) URL inside section prose. Deliberately not global: a
 * shared global pattern carries `lastIndex` from one draft into the next.
 */
const UNSOURCED_PROSE_URL_PATTERN = /https?:\/\/[^\s<>"'`)\]]+/iu

/**
 * Bind the answer to the dossier it was given.
 *
 * Every identifier must be one this section's evidence actually contains: a
 * draft that references another section's claim or invents a source is not a
 * section this run can publish. The remaining requirements are scoped to what
 * the dossier holds. A dossier carrying claims must be answered with claim
 * ids; one carrying sources must be answered with source ids and must put one
 * of their URLs in the prose. A section whose findings are all sourceless
 * carries claims and no sources at all, because the dossier derives its
 * sources from the union of the claim source ids, so demanding a citation
 * there would reject every draft that section can produce.
 *
 * Both sourceless shapes — claims with no sources, and a dossier holding
 * neither — are held to the opposite rule instead: the prose must carry no
 * http(s) URL, because the dossier holds none that any statement could rest
 * on, so every link such a draft contains was invented. Only that scheme is
 * checked. A bare authority like `vendor.example.com/pricing` is not reliably
 * separable from ordinary prose, and rejecting it would reject legitimate
 * drafts, so the rule the request renders claims no more than this one. The
 * evidence-empty shape is included deliberately: it observed nothing at all,
 * which makes an invented link there no more traceable than one in a section
 * whose claims carry no source. `readSectionDrafts` in the synthesis bundle
 * re-reads the persisted file without re-checking its citations, which makes
 * this the last gate before a fabricated link reaches the report. The rule is
 * satisfiable by every writer — omitting a link asks nothing of the evidence —
 * which is what separates it from the demand this relaxation removed.
 */
export function validateSectionDraftAgainstDossier(input: {
  readonly result: SectionDraftResult
  readonly dossier: ResearchSectionDossier
}): SectionDraftResult {
  const { result, dossier } = input
  if (result.sectionId !== dossier.sectionId) {
    throw new SectionDraftValidationError(
      dossier.sectionId,
      `it was written for section '${result.sectionId}'.`,
    )
  }
  const knownClaimIds = new Set(dossier.claims.map((claim) => claim.claimId))
  const unknownClaimIds = result.claimIds.filter((id) => !knownClaimIds.has(id))
  if (unknownClaimIds.length > 0) {
    throw new SectionDraftValidationError(
      dossier.sectionId,
      `it cites claim identifiers this section's evidence does not contain: ${unknownClaimIds.join(', ')}.`,
    )
  }
  const knownSources = new Map(
    dossier.sources.map((source) => [source.sourceId, source]),
  )
  const unknownSourceIds = result.sourceIds.filter((id) => !knownSources.has(id))
  if (unknownSourceIds.length > 0) {
    throw new SectionDraftValidationError(
      dossier.sectionId,
      `it cites source identifiers this section's evidence does not contain: ${unknownSourceIds.join(', ')}.`,
    )
  }
  if (
    (dossier.claims.length > 0 && result.claimIds.length === 0) ||
    (dossier.sources.length > 0 && result.sourceIds.length === 0)
  ) {
    throw new SectionDraftValidationError(
      dossier.sectionId,
      'it omits claim or source identifiers even though this section contains evidence.',
    )
  }
  if (dossier.sources.length === 0) {
    const inventedUrl = UNSOURCED_PROSE_URL_PATTERN.exec(result.markdown)?.[0]
    if (inventedUrl) {
      throw new SectionDraftValidationError(
        dossier.sectionId,
        `its prose cites ${inventedUrl} even though this section observed no ` +
        'source, so the citation was invented rather than taken from evidence.',
      )
    }
    return result
  }
  const citedUrls = result.sourceIds
    .map((id) => knownSources.get(id)?.canonicalUrl)
    .filter((url): url is string => Boolean(url))
  if (!citedUrls.some((url) => result.markdown.includes(url))) {
    throw new SectionDraftValidationError(
      dossier.sectionId,
      'its prose carries none of the source URLs it claims to rest on, so no ' +
      'material statement is traceable to observed evidence.',
    )
  }
  return result
}

// ─── Provider payload ────────────────────────────────────────────────────────

/**
 * The compaction ladder, applied in this order and no other.
 *
 * Earlier rungs remove supporting detail a writer can work without; the last
 * rung removes discussion material. The claims and sources themselves are the
 * floor: a section drafted without them would be the unsourced prose this
 * whole path exists to prevent, so when even the floor does not fit the
 * request is refused instead of quietly shrunk further.
 */
const SECTION_PAYLOAD_COMPACTION_STEPS = [
  'full',
  'short-excerpts',
  'no-excerpts',
  'claims-and-sources-only',
] as const

type SectionPayloadCompaction = typeof SECTION_PAYLOAD_COMPACTION_STEPS[number]

export interface SectionWriterMessage {
  readonly text: string
  readonly compaction: SectionPayloadCompaction
  readonly estimatedInputTokens: number
}

/**
 * The section block the provider request will carry, compacted only as far as
 * the budget forces and never past the claims and sources themselves.
 *
 * Admission measures the caller's whole rendered request, not this block: a
 * section writer also receives its task message, any attached input files, and
 * the agent's own system prompt, and a large attachment overflows the window
 * just as surely as a large dossier does.
 */
export function buildSectionWriterMessage(input: {
  readonly dossier: ResearchSectionDossier
  readonly budget: ProviderRequestBudget
  readonly renderRequest: (sectionMessage: string) => RenderedProviderRequest
}): SectionWriterMessage {
  const instructions = buildSectionDraftResponseContract(input.dossier)
  let lastText = ''
  for (const compaction of SECTION_PAYLOAD_COMPACTION_STEPS) {
    // A function replacement, not a string one: `String.replace` reads `$&`
    // and friends out of a string replacement, and this payload is source
    // titles and observed excerpts from the open web.
    const payloadText = renderPayloadText(input.dossier, compaction)
    lastText = instructions.replace(PAYLOAD_PLACEHOLDER, () => payloadText)
    const accounting = accountProviderRequest({
      budget: input.budget,
      ...input.renderRequest(lastText),
    })
    if (accounting.estimatedInputTokens <= accounting.admissibleInputTokens) {
      return {
        text: lastText,
        compaction,
        estimatedInputTokens: accounting.estimatedInputTokens,
      }
    }
  }
  refuseProviderRequest({
    stage: `Deep Research section '${input.dossier.sectionId}' drafting`,
    budget: input.budget,
    ...input.renderRequest(lastText),
    remediation:
      "Its claims and sources alone, beside this task's instructions and " +
      'attached input, exceed the window; reduce the attached input or split ' +
      'the section before drafting.',
  })
}

function renderPayloadText(
  dossier: ResearchSectionDossier,
  compaction: SectionPayloadCompaction,
): string {
  const payload = {
    sectionId: dossier.sectionId,
    title: dossier.title,
    objective: dossier.objective,
    correctionWave: dossier.correctionWave,
    claims: dossier.claims.map((claim) => renderClaim(claim, compaction)),
    sources: dossier.sources.map(renderSource),
    ...(compaction === 'claims-and-sources-only'
      ? {}
      : {
          contradictions: dossier.contradictions.map((contradiction) => ({
            description: contradiction.description,
            sourceIds: contradiction.sourceIds,
            ...(contradiction.status ? { status: contradiction.status } : {}),
          })),
          unresolvedQuestions: dossier.unresolvedQuestions,
          unresolvedGapIds: dossier.gapIds,
        }),
  }
  return JSON.stringify(payload, null, 2)
}

function renderClaim(
  claim: ClaimRecord,
  compaction: SectionPayloadCompaction,
): Record<string, unknown> {
  const base = {
    claimId: claim.claimId,
    statement: claim.statement,
    kind: claim.kind,
    status: claim.status,
    confidence: claim.confidence,
    applicableScope: claim.applicableScope,
    sourceIds: claim.sourceIds,
    supportingSourceIds: claim.evidenceLinks
      .filter((link) => link.relationship === 'supports')
      .map((link) => link.sourceId),
    contradictingSourceIds: claim.evidenceLinks
      .filter((link) => link.relationship === 'contradicts')
      .map((link) => link.sourceId),
  }
  if (compaction === 'no-excerpts' || compaction === 'claims-and-sources-only') {
    return base
  }
  const excerptLength =
    compaction === 'full' ? FULL_EXCERPT_LENGTH : COMPACTED_EXCERPT_LENGTH
  return {
    ...base,
    evidence: claim.evidenceLinks.map((link) => ({
      sourceId: link.sourceId,
      relationship: link.relationship,
      locator: link.locator,
      observedExcerpt: truncate(link.observedExcerpt, excerptLength),
    })),
  }
}

function renderSource(source: SourceRecord): Record<string, unknown> {
  return {
    sourceId: source.sourceId,
    canonicalUrl: source.canonicalUrl,
    title: source.title,
    publisher: source.publisher,
    sourceType: source.sourceType,
    status: source.status,
    observedAt: source.observedAt,
    ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
  }
}

const PAYLOAD_PLACEHOLDER = '__PAYLOAD__'

/** The instructions that travel with every materialized section payload. */
export function buildSectionDraftResponseContract(
  dossier: ResearchSectionDossier,
): string {
  return [
    '# Section Evidence Dossier',
    '',
    `Draft the report section "${dossier.title}" using only the evidence below.`,
    'This is the complete factual boundary for the task. Do not browse, do not',
    'open files, and do not add facts from anywhere else.',
    '',
    '```json',
    PAYLOAD_PLACEHOLDER,
    '```',
    '',
    '# Response contract',
    '',
    'Return one JSON object and nothing else — no Markdown fence, no preamble:',
    '',
    JSON.stringify({
      schemaVersion: 1,
      status: 'section_complete',
      sectionId: dossier.sectionId,
      claimIds:
        dossier.claims.length > 0
          ? ['<claim ids from the dossier that this section rests on>']
          : [],
      sourceIds:
        dossier.sources.length > 0
          ? ['<source ids from the dossier that this section cites>']
          : [],
      markdown: '<the complete section Markdown>',
    }),
    '',
    ...renderCitationRules(dossier),
  ].join('\n')
}

/**
 * The citation rules this particular dossier can actually satisfy.
 *
 * A dossier's sources are the union of its claims' source ids, so a section
 * whose findings are all sourceless arrives carrying claims and no URL at all.
 * Showing that writer the evidence-bearing rule asks it to cite something it
 * was never given, and its only answers are an invented source id, a refusal,
 * or a fabricated URL in the prose — each of which the runtime then rejects,
 * sending `on_failure: retry` back into the same wall.
 */
function renderCitationRules(
  dossier: ResearchSectionDossier,
): readonly string[] {
  if (dossier.sources.length > 0) {
    return [
      'Every claim id and source id must come from the dossier above. Put the',
      'canonical URL of a supporting source next to each material factual claim,',
      'in the Markdown itself. If the evidence cannot support the objective, say',
      'so inside the section Markdown and cite what the evidence does support.',
    ]
  }
  return [
    ...(dossier.claims.length > 0
      ? [
          'Every claim id must come from the dossier above. This dossier records',
          'no source at all, so return its claim ids beside an empty sourceIds',
          'array and state that evidence limitation inside the section Markdown.',
        ]
      : [
          'This dossier records no claim and no source, so return empty claimIds',
          'and sourceIds and state that unresolved evidence gap inside the',
          'section Markdown.',
        ]),
    'Do not write an http or https URL: no statement in this section is',
    'traceable to an observed source, so any link here would be invented, and',
    'a draft carrying one is rejected.',
  ]
}

// ─── Assignment resolution (shell) ───────────────────────────────────────────

export interface SectionDraftAssignment {
  readonly dossier: ResearchSectionDossier
  readonly dossierPath: string
}

const MAX_PLAN_BYTES = 2 * 1024 * 1024

/**
 * The index must be this plan's, at this plan's synthesis mode, over exactly
 * this plan's sections.
 *
 * A run keeps `current-*.json` pointers that a loopback or a reused assignment
 * directory can leave behind. Reading whichever index happens to exist would
 * hand a writer — or the synthesizer — another plan's evidence: valid JSON,
 * wrong report, and nothing downstream would notice.
 */
export function assertSectionIndexBelongsToPlan(
  plan: ResearchPlan,
  index: ResearchSectionDossierIndex,
): void {
  if (index.planId !== plan.planId) {
    throw new Error(
      `Deep Research section index belongs to plan '${index.planId}', not the ` +
      `approved plan '${plan.planId}'.`,
    )
  }
  if (plan.approvalHash && index.approvedPlanHash !== plan.approvalHash) {
    throw new Error(
      'Deep Research section index was built from a different approved plan hash.',
    )
  }
  const planMode = plan.executionPolicy?.synthesis.mode ?? 'single_pass'
  if (index.synthesisMode !== planMode) {
    throw new Error(
      `Deep Research section index declares synthesis mode ` +
      `'${index.synthesisMode}' but the approved plan requires '${planMode}'.`,
    )
  }
  const planSections = plan.sections.map((section) => section.id).join('\0')
  const indexSections = index.dossiers.map((entry) => entry.sectionId).join('\0')
  if (planSections !== indexSections) {
    throw new Error(
      'Deep Research section index sections do not match the approved plan sections.',
    )
  }
}

/** One dossier file, bound to the index entry and the approved plan it claims. */
export function assertDossierBelongsToPlan(input: {
  readonly dossier: ResearchSectionDossier
  readonly plan: ResearchPlan
  readonly index: ResearchSectionDossierIndex
  readonly entry: ResearchSectionDossierIndex['dossiers'][number]
}): void {
  const { dossier, plan, index, entry } = input
  if (
    dossier.sectionId !== entry.sectionId ||
    dossier.planId !== plan.planId ||
    dossier.correctionWave !== index.correctionWave ||
    (plan.approvalHash !== undefined &&
      dossier.approvedPlanHash !== plan.approvalHash)
  ) {
    throw new Error(
      `Deep Research section dossier '${entry.relativePath}' does not belong to ` +
      `section '${entry.sectionId}' of the approved plan at correction wave ` +
      `${index.correctionWave}.`,
    )
  }
}

/**
 * The dossier that owns one pipeline task, addressed by the durable identity
 * the runtime already wrote: the task's declared result file is the index's
 * `draftPath`. Titles and task numbering are display detail and are never used
 * to decide which evidence a writer receives.
 *
 * In a configured drafting stage every task is a section draft, so a task the
 * index does not claim is an error rather than an ordinary task. Returning
 * "no assignment" would send it down the generic persistence path, where an
 * unvalidated response becomes a completed artifact — the exact failure this
 * boundary exists to prevent.
 */
export function resolveSectionDraftAssignment(input: {
  readonly assignmentPath: string
  readonly planArtifact: string
  readonly dossierIndexArtifact: string
  readonly resultFile: string
}): SectionDraftAssignment {
  const plan = assertResearchPlanApproved(
    readOwnedResearchJson({
      assignmentPath: input.assignmentPath,
      relativePath: input.planArtifact,
      maximumBytes: MAX_PLAN_BYTES,
      label: 'Deep Research plan',
    }),
  )
  const index = parseSectionDossierIndex(
    readOwnedResearchJson({
      assignmentPath: input.assignmentPath,
      relativePath: input.dossierIndexArtifact,
      maximumBytes: MAX_DOSSIER_INDEX_BYTES,
      label: 'Deep Research section dossier index',
    }),
  )
  assertSectionIndexBelongsToPlan(plan, index)
  const owners = index.dossiers.filter(
    (candidate) => candidate.draftPath === input.resultFile,
  )
  const entry = owners[0]
  if (!entry) {
    throw new Error(
      `Deep Research drafting task result '${input.resultFile}' is owned by no ` +
      'section in the approved dossier index.',
    )
  }
  const dossier = parseSectionDossier(
    readOwnedResearchJson({
      assignmentPath: input.assignmentPath,
      relativePath: entry.relativePath,
      maximumBytes: MAX_DOSSIER_BYTES,
      label: `Deep Research section dossier '${entry.sectionId}'`,
    }),
  )
  assertDossierBelongsToPlan({ dossier, plan, index, entry })
  return { dossier, dossierPath: entry.relativePath }
}

// ─── External-file parsing ───────────────────────────────────────────────────

export function parseSectionDossierIndex(value: unknown): ResearchSectionDossierIndex {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Deep Research section dossier index must be a schema-v1 object.')
  }
  if (!Array.isArray(value.dossiers)) {
    throw new Error('Deep Research section dossier index has no dossier list.')
  }
  const dossiers = value.dossiers.map((entry) => {
    if (
      !isRecord(entry) ||
      typeof entry.sectionId !== 'string' ||
      typeof entry.title !== 'string' ||
      typeof entry.relativePath !== 'string' ||
      typeof entry.claimCount !== 'number' ||
      typeof entry.sourceCount !== 'number' ||
      typeof entry.gapCount !== 'number'
    ) {
      throw new Error('Deep Research section dossier index entry is malformed.')
    }
    if (entry.draftPath !== undefined && typeof entry.draftPath !== 'string') {
      throw new Error('Deep Research section dossier index draft path must be a string.')
    }
    return {
      sectionId: entry.sectionId,
      title: entry.title,
      relativePath: entry.relativePath,
      ...(entry.draftPath === undefined ? {} : { draftPath: entry.draftPath }),
      claimCount: entry.claimCount,
      sourceCount: entry.sourceCount,
      gapCount: entry.gapCount,
    }
  })
  if (
    typeof value.planId !== 'string' ||
    typeof value.approvedPlanHash !== 'string' ||
    (value.correctionWave !== 0 && value.correctionWave !== 1 && value.correctionWave !== 2) ||
    (value.synthesisMode !== 'single_pass' && value.synthesisMode !== 'section_dossiers')
  ) {
    throw new Error('Deep Research section dossier index header is malformed.')
  }
  // Every index entry addresses one section and, in section mode, one draft
  // file. A repeated identity makes "which evidence owns this task" ambiguous,
  // and an ambiguous answer is how a writer gets the wrong section's evidence.
  assertUniqueIndexIdentities(dossiers)
  return {
    schemaVersion: 1,
    planId: value.planId,
    approvedPlanHash: value.approvedPlanHash,
    correctionWave: value.correctionWave,
    synthesisMode: value.synthesisMode,
    dossiers,
  }
}

function assertUniqueIndexIdentities(
  dossiers: readonly {
    readonly sectionId: string
    readonly relativePath: string
    readonly draftPath?: string
  }[],
): void {
  const seenSectionIds = new Set<string>()
  const seenDraftPaths = new Set<string>()
  const seenDossierPaths = new Set<string>()
  for (const entry of dossiers) {
    if (seenSectionIds.has(entry.sectionId)) {
      throw new Error(
        `Deep Research section dossier index names section '${entry.sectionId}' more than once.`,
      )
    }
    seenSectionIds.add(entry.sectionId)
    if (seenDossierPaths.has(entry.relativePath)) {
      throw new Error(
        `Deep Research section dossier index claims dossier '${entry.relativePath}' more than once.`,
      )
    }
    seenDossierPaths.add(entry.relativePath)
    if (!entry.draftPath) continue
    if (seenDraftPaths.has(entry.draftPath)) {
      throw new Error(
        `Deep Research section dossier index claims draft path '${entry.draftPath}' more than once.`,
      )
    }
    seenDraftPaths.add(entry.draftPath)
  }
}

export function parseSectionDossier(value: unknown): ResearchSectionDossier {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error('Deep Research section dossier must be a schema-v1 object.')
  }
  const rawTaskIds = requireArray(value.taskIds, 'taskIds')
  const rawClaims = requireArray(value.claims, 'claims')
  const rawSources = requireArray(value.sources, 'sources')
  const rawContradictions = requireArray(value.contradictions, 'contradictions')
  const rawQuestions = requireArray(value.unresolvedQuestions, 'unresolvedQuestions')
  const rawGapIds = requireArray(value.gapIds, 'gapIds')
  const rawCoverage = requireArray(value.coverage, 'coverage')
  if (
    typeof value.planId !== 'string' ||
    typeof value.approvedPlanHash !== 'string' ||
    typeof value.sectionId !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.objective !== 'string' ||
    typeof value.evidenceGraphPath !== 'string' ||
    (value.correctionWave !== 0 && value.correctionWave !== 1 && value.correctionWave !== 2)
  ) {
    throw new Error('Deep Research section dossier header is malformed.')
  }
  const claims = rawClaims.map(parseClaimRecord)
  const sources = rawSources.map(parseSourceRecord)
  const contradictions = rawContradictions.map(parseDossierContradiction)
  const coverage = rawCoverage.map(parseDossierCoverageEntry)
  const unresolvedQuestions = rawQuestions.map(requireString('unresolved question'))
  const gapIds = rawGapIds.map(requireString('gap id'))
  const taskIds = rawTaskIds.map(requireString('task id'))
  return {
    schemaVersion: 1,
    planId: value.planId,
    approvedPlanHash: value.approvedPlanHash,
    correctionWave: value.correctionWave,
    sectionId: value.sectionId,
    title: value.title,
    objective: value.objective,
    taskIds,
    claims,
    sources,
    coverage,
    contradictions,
    unresolvedQuestions,
    gapIds,
    evidenceGraphPath: value.evidenceGraphPath,
  }
}

function parseDossierContradiction(
  value: unknown,
): ResearchSectionDossier['contradictions'][number] {
  if (
    !isRecord(value) ||
    typeof value.description !== 'string' ||
    !Array.isArray(value.sourceIds)
  ) {
    throw new Error('Deep Research section dossier contradiction is malformed.')
  }
  return {
    description: value.description,
    sourceIds: value.sourceIds.map(requireString('contradiction source id')),
    ...(value.status === 'resolved' || value.status === 'unresolved'
      ? { status: value.status }
      : {}),
    ...(typeof value.resolution === 'string'
      ? { resolution: value.resolution }
      : {}),
  }
}

function parseDossierCoverageEntry(value: unknown): ResearchCoverageEntry {
  if (
    !isRecord(value) ||
    typeof value.taskId !== 'string' ||
    typeof value.sectionId !== 'string' ||
    typeof value.isCovered !== 'boolean'
  ) {
    throw new Error('Deep Research section dossier coverage entry is malformed.')
  }
  return {
    taskId: value.taskId,
    sectionId: value.sectionId,
    ...(typeof value.assignmentId === 'string'
      ? { assignmentId: value.assignmentId }
      : {}),
    claimIds: requireArray(value.claimIds, 'coverage.claimIds')
      .map(requireString('coverage claim id')),
    sourceIds: requireArray(value.sourceIds, 'coverage.sourceIds')
      .map(requireString('coverage source id')),
    requirementCoverage: requireArray(
      value.requirementCoverage,
      'coverage.requirementCoverage',
    ).map(parseResearchRequirementCoverage),
    isCovered: value.isCovered,
  }
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!isUnknownArray(value)) {
    throw new Error(`Deep Research section dossier '${field}' must be an array.`)
  }
  return value
}

function requireString(label: string): (value: unknown) => string {
  return (value) => {
    if (typeof value !== 'string') {
      throw new Error(`Deep Research section dossier ${label} must be a string.`)
    }
    return value
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(value: string, maximumLength: number): string {
  return value.length <= maximumLength
    ? value
    : `${value.slice(0, maximumLength)}…`
}

function stripCodeFence(value: string): string {
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/u.exec(value)
  return fenced?.[1]?.trim() ?? value
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ')
}
