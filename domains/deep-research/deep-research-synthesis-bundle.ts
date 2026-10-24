import * as fs from 'node:fs'

import type {
  ClaimRecord,
  ResearchPlan,
  ResearchSectionDossierIndex,
  SourceRecord,
} from '../../contracts/deep-research.js'
import { assertResearchPlanApproved } from './deep-research-approval.js'
import { hashResearchValue } from './deep-research-worker-policy.js'
import { readOwnedResearchJson } from './deep-research-artifact-reader.js'
import {
  assertDossierBelongsToPlan,
  assertSectionIndexBelongsToPlan,
  parseSectionDossier,
  parseSectionDossierIndex,
} from './deep-research-section-drafting.js'
import {
  parseClaimRecord,
  parseQualityVerdict,
  parseSourceRecord,
} from './deep-research-validation.js'
import {
  accountProviderRequest,
  refuseProviderRequest,
  type ProviderRequestBudget,
  type RenderedProviderRequest,
} from '../provider/provider-request-budget.js'
import {
  resolveExistingPathInside,
  resolveRelativePathInside,
} from '../../core/path-safety.js'
import { isUnknownArray } from '../../core/unknown-array.js'

/**
 * Deep Research — report synthesis bundle.
 *
 * The synthesizer used to be handed whatever the level declared first among its
 * input artifacts: in practice the whole synthesis packet, every claim and
 * every source verbatim, which on a large run exceeded the model's window
 * before the process started. This builds the one bundle it actually needs —
 * approved plan context, a citation-grade evidence index, and the validated
 * section drafts — binds every part of it to the approved plan, and admits the
 * request the caller will really send before any process starts.
 */

const MAX_PLAN_BYTES = 2 * 1024 * 1024
const MAX_INDEX_BYTES = 512 * 1024
const MAX_DOSSIER_BYTES = 8 * 1024 * 1024
const MAX_SYNTHESIS_PACKET_BYTES = 32 * 1024 * 1024
const MAX_DRAFT_BYTES = 8 * 1024 * 1024
const MAX_CORRECTION_CONTEXT_BYTES = 128 * 1024
const MAX_VERDICT_BYTES = 1024 * 1024
const MAX_PRIOR_REPORT_BYTES = 8 * 1024 * 1024

export interface ResearchSynthesisBundleRequest {
  readonly assignmentPath: string
  readonly planArtifact: string
  readonly dossierIndexArtifact: string
  readonly synthesisArtifact: string
  /**
   * The active correction context, when the stage declares one. A synthesis
   * correction wave archives the prior report and deletes the live one, so
   * without this the synthesizer would be asked to revise a report it cannot
   * see against blockers it never learns.
   */
  readonly correctionsArtifact?: string
  readonly budget: ProviderRequestBudget
  /**
   * Extra instructions the caller was given for this dispatch. They are kept
   * inside the bundle — never in place of it — so a coordinator note cannot
   * silently replace the validated evidence, and so its cost is counted.
   */
  readonly additionalInstructions?: string
  /**
   * Build the exact request the caller will send from a candidate bundle.
   *
   * Admission has to measure the real thing. A chain step, for instance, puts
   * its input in both the system prompt and the user message, so counting the
   * bundle once would understate the request by half.
   */
  readonly renderRequest: (bundleText: string) => RenderedProviderRequest
}

/**
 * The compaction ladder, applied in this order and no other.
 *
 * Detail that helps a writer but is not required for citation goes first; the
 * claim index's prose goes next. The claim-to-source map, validated section
 * drafts, and source register are the floor — together they preserve the
 * report and its traceability — so when even those do not fit, the request is
 * refused rather than silently truncated into an untraceable report.
 */
const SYNTHESIS_COMPACTION_STEPS = [
  'full',
  'no-claim-scope',
  'no-claim-statements',
] as const

export type SynthesisBundleCompaction = typeof SYNTHESIS_COMPACTION_STEPS[number]

export interface ResearchSynthesisBundle {
  readonly text: string
  readonly compaction: SynthesisBundleCompaction
  readonly estimatedInputTokens: number
  readonly sectionIds: readonly string[]
}

export function buildDeepResearchSynthesisBundle(
  request: ResearchSynthesisBundleRequest,
): ResearchSynthesisBundle {
  const plan = assertResearchPlanApproved(
    readOwnedResearchJson({
      assignmentPath: request.assignmentPath,
      relativePath: request.planArtifact,
      maximumBytes: MAX_PLAN_BYTES,
      label: 'Deep Research plan',
    }),
  )
  const index = parseSectionDossierIndex(
    readOwnedResearchJson({
      assignmentPath: request.assignmentPath,
      relativePath: request.dossierIndexArtifact,
      maximumBytes: MAX_INDEX_BYTES,
      label: 'Deep Research section dossier index',
    }),
  )
  assertSectionIndexBelongsToPlan(plan, index)
  const evidence = readEvidenceIndex({
    assignmentPath: request.assignmentPath,
    relativePath: request.synthesisArtifact,
    plan,
  })
  const drafts = readSectionDrafts(request.assignmentPath, plan, index)
  const correction = request.correctionsArtifact
    ? readCorrectionWave({
        assignmentPath: request.assignmentPath,
        relativePath: request.correctionsArtifact,
        plan,
      })
    : undefined

  let lastText = ''
  for (const compaction of SYNTHESIS_COMPACTION_STEPS) {
    lastText = renderBundle({
      plan,
      evidence,
      drafts,
      compaction,
      ...(correction ? { correction } : {}),
      ...(request.additionalInstructions
        ? { additionalInstructions: request.additionalInstructions }
        : {}),
    })
    const accounting = accountProviderRequest({
      budget: request.budget,
      ...request.renderRequest(lastText),
    })
    if (accounting.estimatedInputTokens <= accounting.admissibleInputTokens) {
      return {
        text: lastText,
        compaction,
        estimatedInputTokens: accounting.estimatedInputTokens,
        sectionIds: drafts.map((draft) => draft.sectionId),
      }
    }
  }
  refuseProviderRequest({
    stage: 'Deep Research report synthesis',
    budget: request.budget,
    ...request.renderRequest(lastText),
    remediation:
      'Its claim-to-source map, validated section drafts, and source register ' +
      'exceed the window; shorten the section drafts or reduce the approved ' +
      'section count before synthesis.',
  })
}

// ─── Rendering ───────────────────────────────────────────────────────────────

interface SectionDraft {
  readonly sectionId: string
  readonly title: string
  readonly markdown: string
}

interface CorrectionWave {
  readonly wave: number
  readonly acceptanceCriteria: readonly string[]
  readonly priorReport: string
}

interface EvidenceIndex {
  readonly claims: readonly ClaimRecord[]
  readonly sources: readonly SourceRecord[]
  readonly contradictions: ReadonlyArray<{
    readonly description: string
    readonly sourceIds: readonly string[]
  }>
  readonly unresolvedQuestions: readonly string[]
}

function renderBundle(input: {
  readonly plan: ResearchPlan
  readonly evidence: EvidenceIndex
  readonly drafts: readonly SectionDraft[]
  readonly compaction: SynthesisBundleCompaction
  readonly correction?: CorrectionWave
  readonly additionalInstructions?: string
}): string {
  const { plan, evidence, drafts, compaction } = input
  const lines: string[] = [
    '# Deep Research synthesis bundle',
    '',
    'This is the complete, runtime-validated input for the report. Everything',
    'you may cite is below. Do not open files and do not add outside facts.',
    '',
    '## Approved request',
    '',
    '```json',
    JSON.stringify(
      {
        planId: plan.planId,
        question: plan.request.question,
        objective: plan.request.objective,
        audience: plan.request.audience,
        includedScope: plan.request.includedScope,
        excludedScope: plan.request.excludedScope,
        jurisdictions: plan.request.jurisdictions,
        freshnessAsOf: plan.request.freshnessAsOf,
        sourceRequirements: plan.request.sourceRequirements,
        sections: plan.sections.map((section) => ({
          sectionId: section.id,
          title: section.title,
          objective: section.objective,
        })),
      },
      null,
      2,
    ),
    '```',
    '',
    '## Evidence index',
    '',
    '```json',
    JSON.stringify(
      {
        claims: evidence.claims.map((claim) => renderClaim(claim, compaction)),
        sources: evidence.sources.map((source) => ({
          sourceId: source.sourceId,
          canonicalUrl: source.canonicalUrl,
          title: source.title,
          publisher: source.publisher,
          sourceType: source.sourceType,
          observedAt: source.observedAt,
          ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
        })),
        contradictions: evidence.contradictions,
        unresolvedQuestions: evidence.unresolvedQuestions,
      },
      null,
      2,
    ),
    '```',
    '',
  ]
  for (const draft of drafts) {
    lines.push(
      `## Evidence-bound section draft: ${draft.title} (${draft.sectionId})`,
      '',
      draft.markdown.trimEnd(),
      '',
    )
  }
  if (input.correction) {
    lines.push(
      `## Requested corrections (wave ${input.correction.wave})`,
      '',
      'Make the smallest changes that resolve these blockers. Do not introduce',
      'new claims unless the evidence index above already supports them.',
      '',
      ...input.correction.acceptanceCriteria.map((criterion) => `- ${criterion}`),
      '',
      '## Prior report under revision',
      '',
      input.correction.priorReport.trimEnd(),
      '',
    )
  }
  if (input.additionalInstructions?.trim()) {
    lines.push(
      '## Additional instructions for this dispatch',
      '',
      'These do not add evidence and cannot relax the rules above.',
      '',
      input.additionalInstructions.trim(),
      '',
    )
  }
  lines.push(
    '## Your task',
    '',
    'Perform one report-level coherence pass over the validated material above:',
    'reconcile terminology, remove repetition, add transitions, and write the',
    'executive summary and conclusion. Keep every material statement attached',
    'to a source in the evidence index. Return the complete research package',
    'Markdown and nothing else.',
  )
  return lines.join('\n')
}

function renderClaim(
  claim: ClaimRecord,
  compaction: SynthesisBundleCompaction,
): Record<string, unknown> {
  const base = {
    claimId: claim.claimId,
    sectionId: claim.sectionId,
    status: claim.status,
    confidence: claim.confidence,
    supportingSourceIds: claim.evidenceLinks
      .filter((link) => link.relationship === 'supports')
      .map((link) => link.sourceId),
  }
  if (compaction === 'no-claim-statements') return base
  if (compaction === 'no-claim-scope') {
    return { ...base, statement: claim.statement }
  }
  return {
    ...base,
    statement: claim.statement,
    kind: claim.kind,
    applicableScope: claim.applicableScope,
  }
}

// ─── Artifact reading ────────────────────────────────────────────────────────

/**
 * The synthesis packet's claims and sources, validated through the same
 * contract parsers that accepted them in the first place.
 *
 * A malformed record fails the bundle rather than being skipped: dropping one
 * quietly would remove evidence from a report that still claims to be complete.
 */
function readEvidenceIndex(input: {
  readonly assignmentPath: string
  readonly relativePath: string
  readonly plan: ResearchPlan
}): EvidenceIndex {
  const raw = readOwnedResearchJson({
    assignmentPath: input.assignmentPath,
    relativePath: input.relativePath,
    maximumBytes: MAX_SYNTHESIS_PACKET_BYTES,
    label: 'Deep Research synthesis packet',
  })
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw new Error('Deep Research synthesis packet must be a schema-v1 object.')
  }
  if (raw.planId !== input.plan.planId) {
    throw new Error(
      `Deep Research synthesis packet belongs to plan '${String(raw.planId)}', ` +
      `not the approved plan '${input.plan.planId}'.`,
    )
  }
  return {
    claims: requireArray(raw.claims, 'claims').map(parseClaimRecord),
    sources: requireArray(raw.sources, 'sources').map(parseSourceRecord),
    contradictions: requireArray(raw.contradictions, 'contradictions').map(
      (entry) => {
        if (!isRecord(entry) || typeof entry.description !== 'string') {
          throw new Error(
            'Deep Research synthesis packet contradiction is malformed.',
          )
        }
        return {
          description: entry.description,
          sourceIds: requireArray(entry.sourceIds, 'contradiction.sourceIds').map(
            requireString('contradiction source id'),
          ),
        }
      },
    ),
    unresolvedQuestions: requireArray(
      raw.unresolvedQuestions,
      'unresolvedQuestions',
    ).map(requireString('unresolved question')),
  }
}

/**
 * Every drafted section, or a refusal.
 *
 * Fails closed on purpose. A section-dossier run whose drafts are missing is an
 * incomplete run, and synthesizing the remainder would produce a report that
 * silently omits an approved section while still reaching the quality audit as
 * a finished package. In single-pass mode the index declares no drafts and this
 * returns nothing, which is the correct complete state for that plan.
 */
function readSectionDrafts(
  assignmentPath: string,
  plan: ResearchPlan,
  index: ResearchSectionDossierIndex,
): readonly SectionDraft[] {
  const sectionMode = index.synthesisMode === 'section_dossiers'
  const drafts: SectionDraft[] = []
  for (const entry of index.dossiers) {
    if (!sectionMode) {
      if (entry.draftPath) {
        throw new Error(
          `Deep Research section '${entry.sectionId}' declares a draft path in a ` +
          'single-pass plan.',
        )
      }
      continue
    }
    if (!entry.draftPath) {
      throw new Error(
        `Deep Research section '${entry.sectionId}' has no approved draft path.`,
      )
    }
    assertDossierBelongsToIndex(assignmentPath, plan, index, entry)
    const markdown = readOwnedDraft(assignmentPath, entry.draftPath, entry.sectionId)
    drafts.push({
      sectionId: entry.sectionId,
      title: entry.title,
      markdown,
    })
  }
  return drafts
}

function assertDossierBelongsToIndex(
  assignmentPath: string,
  plan: ResearchPlan,
  index: ResearchSectionDossierIndex,
  entry: ResearchSectionDossierIndex['dossiers'][number],
): void {
  const dossier = parseSectionDossier(
    readOwnedResearchJson({
      assignmentPath,
      relativePath: entry.relativePath,
      maximumBytes: MAX_DOSSIER_BYTES,
      label: `Deep Research section dossier '${entry.sectionId}'`,
    }),
  )
  assertDossierBelongsToPlan({ dossier, plan, index, entry })
}

function readOwnedDraft(
  assignmentPath: string,
  relativePath: string,
  sectionId: string,
): string {
  const candidatePath = resolveRelativePathInside(assignmentPath, relativePath)
  if (!candidatePath) {
    throw new Error(`Deep Research section draft path is unsafe: ${relativePath}`)
  }
  const draftPath = resolveExistingPathInside(assignmentPath, candidatePath)
  if (!draftPath) {
    throw new Error(
      `Deep Research section '${sectionId}' has no persisted draft at ` +
      `${relativePath}; the drafting stage did not complete.`,
    )
  }
  const linkStats = fs.lstatSync(candidatePath)
  if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
    throw new Error(
      `Deep Research section draft must be a regular file: ${relativePath}`,
    )
  }
  if (fs.statSync(draftPath).size > MAX_DRAFT_BYTES) {
    throw new Error(
      `Deep Research section draft '${relativePath}' exceeds its ` +
      `${MAX_DRAFT_BYTES}-byte limit.`,
    )
  }
  const markdown = fs.readFileSync(draftPath, 'utf8')
  if (!markdown.trim()) {
    throw new Error(
      `Deep Research section '${sectionId}' persisted an empty draft at ${relativePath}.`,
    )
  }
  return markdown
}

/**
 * The report revision this wave asks for, or undefined when there is none to
 * carry.
 *
 * `research/corrections/current.json` is written by both wave scripts, so its
 * presence says a correction is in flight, not what kind. The source verdict's
 * route decides: a **synthesis**-routed wave revises the existing report
 * against the critic's blockers, so the bundle must carry those blockers and
 * the archived prior report. A **research**-routed wave has already re-run its
 * evidence lanes and re-drafted its sections, so there is nothing to revise —
 * the refreshed evidence in the bundle is the whole instruction, and treating
 * that context as a revision would block every research correction loop.
 *
 * The context is bound to the approved plan and to the exact verdict it names
 * before any of it is believed: a stale `current.json` left by an earlier run
 * would otherwise put another wave's blockers in front of this report.
 */
function readCorrectionWave(input: {
  readonly assignmentPath: string
  readonly relativePath: string
  readonly plan: ResearchPlan
}): CorrectionWave | undefined {
  const candidatePath = resolveRelativePathInside(
    input.assignmentPath,
    input.relativePath,
  )
  if (!candidatePath) {
    throw new Error(
      `Deep Research correction context path is unsafe: ${input.relativePath}`,
    )
  }
  if (!resolveExistingPathInside(input.assignmentPath, candidatePath)) return undefined
  const raw = readOwnedResearchJson({
    assignmentPath: input.assignmentPath,
    relativePath: input.relativePath,
    maximumBytes: MAX_CORRECTION_CONTEXT_BYTES,
    label: 'Deep Research correction context',
  })
  if (!isRecord(raw) || raw.schemaVersion !== 1) {
    throw new Error('Deep Research correction context must be a schema-v1 object.')
  }
  if (
    typeof raw.sourceVerdictPath !== 'string' ||
    typeof raw.sourceVerdictHash !== 'string' ||
    typeof raw.wave !== 'number'
  ) {
    throw new Error('Deep Research correction context is malformed.')
  }
  if (
    input.plan.approvalHash !== undefined &&
    raw.approvedPlanHash !== input.plan.approvalHash
  ) {
    throw new Error(
      'Deep Research correction context was built from a different approved plan hash.',
    )
  }
  const verdict = parseQualityVerdict(
    readOwnedResearchJson({
      assignmentPath: input.assignmentPath,
      relativePath: raw.sourceVerdictPath,
      maximumBytes: MAX_VERDICT_BYTES,
      label: 'Deep Research source quality verdict',
    }),
  )
  if (hashResearchValue(verdict) !== raw.sourceVerdictHash) {
    throw new Error(
      `Deep Research correction context does not match the source quality verdict ` +
      `it names at '${raw.sourceVerdictPath}'.`,
    )
  }
  if (raw.wave !== verdict.correctionWave + 1) {
    throw new Error(
      `Deep Research correction context declares wave ${raw.wave} for a verdict ` +
      `at wave ${verdict.correctionWave}.`,
    )
  }
  if (verdict.correctionRoute !== 'synthesis') return undefined
  const acceptanceCriteria = verdict.correctionRequests
    .filter((correctionRequest) => correctionRequest.type === 'resynthesize')
    .flatMap((correctionRequest) => correctionRequest.acceptanceCriteria)
  if (acceptanceCriteria.length === 0) {
    throw new Error(
      'Deep Research synthesis correction wave carries no resynthesis acceptance criteria.',
    )
  }
  return {
    wave: raw.wave,
    acceptanceCriteria,
    priorReport: readOwnedText({
      assignmentPath: input.assignmentPath,
      relativePath: `research/reports/report-wave-${verdict.correctionWave}.md`,
      maximumBytes: MAX_PRIOR_REPORT_BYTES,
      label: 'Deep Research prior report',
    }),
  }
}

function readOwnedText(input: {
  readonly assignmentPath: string
  readonly relativePath: string
  readonly maximumBytes: number
  readonly label: string
}): string {
  const candidatePath = resolveRelativePathInside(
    input.assignmentPath,
    input.relativePath,
  )
  if (!candidatePath) throw new Error(`${input.label} path is unsafe.`)
  const filePath = resolveExistingPathInside(input.assignmentPath, candidatePath)
  if (!filePath) throw new Error(`${input.label} does not exist.`)
  const linkStats = fs.lstatSync(candidatePath)
  if (linkStats.isSymbolicLink() || !linkStats.isFile()) {
    throw new Error(`${input.label} must be a regular file.`)
  }
  if (fs.statSync(filePath).size > input.maximumBytes) {
    throw new Error(`${input.label} exceeds its ${input.maximumBytes}-byte limit.`)
  }
  return fs.readFileSync(filePath, 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function requireArray(value: unknown, field: string): readonly unknown[] {
  if (!isUnknownArray(value)) {
    throw new Error(`Deep Research synthesis packet '${field}' must be an array.`)
  }
  return value
}

function requireString(label: string): (value: unknown) => string {
  return (value) => {
    if (typeof value !== 'string') {
      throw new Error(`Deep Research synthesis packet ${label} must be a string.`)
    }
    return value
  }
}
