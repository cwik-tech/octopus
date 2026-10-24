/**
 * Team Runtime — Review Engine
 *
 * Produce-review-revise loop: A producer creates an artifact, a reviewer
 * evaluates it, and the loop continues until approved or max iterations.
 *
 * Tool registered: `submit_for_review`
 */

import { AgentQuestionInterruptionError } from '../core/agent-question-interruption.js'
import { nextReviewTurn } from '../core/review-question-continuation.js'
import { whenDefined } from '../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { Type } from 'typebox'
import { Text } from '@earendil-works/pi-tui'
import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  ReviewStageConfig,
  ReviewState,
  BaseEngineContext,
  TeamConfig,
} from '../core/types.js'
import {
  adoptBudgetDispatchAdmission,
  type BudgetDispatchAdmission,
} from '../core/budget-ledger.js'
import { STAGE_TYPE, STAGE_LIFECYCLE_STATUS } from '../core/constants.js'
import { dispatchWithFailurePolicy, resolveFailurePolicy, HaltError } from '../domains/agent-execution/failure-policy.js'
import { resolveChildWorkspacePath } from '../parsers/team-config.js'
import { checkConstraints, formatCost, formatElapsed } from '../core/constraints.js'
import { combineAbortSignals } from '../core/timeout-manager.js'
import { substituteTemplateVars } from '../domains/runtime/template.js'
import { canonicalizeReviewFeedback, parseTaggedVerdict, parseVerdict } from '../core/verdict-parser.js'
import {
  buildArtifactMetadata,
  resolveRuntimeOwnedArtifactContent,
  writeMarkdownArtifact,
} from '../domains/runtime/artifacts.js'
import { logReviewEvent } from '../domains/runtime/logger.js'
import { publishAcceptedTeamChatMessage } from '../domains/runtime/team-chat-messages.js'
import { buildStageDispatchInvocationId } from '../core/stage-dispatch-identity.js'
import { canTransitionStageStatus, transitionStageStatus } from '../domains/stage/stage-lifecycle.js'
import { deriveEffectiveStageContractsForTeam } from '../domains/stage/stage-contracts.js'
import { buildResearchPublicationAudit } from '../domains/deep-research/deep-research-publication-audit.js'
import { canonicalizeResearchCitations } from '../domains/deep-research/deep-research-citation-canonicalization.js'
import { resolveOwnedRunRelativePath } from '../domains/runtime/runtime-paths.js'
import { writeFileAtomicSync } from '../core/file-mutation.js'

interface ReviewContext extends BaseEngineContext<ReviewStageConfig> {
  onStateCheckpoint?: () => void
}

interface TemplateStructureValidation {
  templatePath: string
  templateLabel: string
  requiredSections: string[]
  draftHeadings: string[]
  missingSections: string[]
  orderIssue: {
    expectedOrder: string[]
    actualMatchedOrder: string[]
  } | null
}

interface StyleProfileValidation {
  profilePath: string
  profileLabel: string
  bannedPhrases: string[]
}

interface ResearchPublicationValidation {
  audit: ReturnType<typeof buildResearchPublicationAudit>
  feedback: string
}

function normalizeReviewParams(input: unknown): { action?: 'produce' | 'status'; content?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    if (typeof input === 'string' && input.trim()) {
      return { content: input }
    }
    return {}
  }

  const raw = input as Record<string, unknown>
  const action: 'status' | 'produce' | undefined = raw.action === 'status' ? 'status' : raw.action === 'produce' ? 'produce' : undefined
  const content = typeof raw.content === 'string'
    ? raw.content
    : typeof raw.message === 'string'
      ? raw.message
      : undefined

  return {
    ...whenDefined(action, (presentAction) => ({ action: presentAction })),
    ...whenDefined(content, (presentContent) => ({ content: presentContent })),
  }
}

function traceReview(
  ctx: ReviewContext,
  step: string,
  extra: Record<string, unknown> = {},
): void {
  logReviewEvent(ctx.outputPath, {
    timestamp: new Date().toISOString(),
    session_id: ctx.state.sessionId,
    root_session_id: ctx.state.rootSessionId,
    assignment_path: ctx.outputPath,
    team: ctx.teamName,
    level_id: ctx.levelId,
    stage_type: STAGE_TYPE.REVIEW,
    producer: ctx.config.producer,
    reviewer: ctx.config.reviewer,
    step,
    ...extra,
  })
}

function updateReviewStageStatus(
  ctx: ReviewContext,
  next: typeof STAGE_LIFECYCLE_STATUS[keyof typeof STAGE_LIFECYCLE_STATUS],
): void {
  const levelState = ctx.state.levelStates.get(ctx.levelId)
  if (!levelState || !levelState.stageStatus || levelState.stageStatus === next) return
  if (!canTransitionStageStatus(levelState.stageStatus, next)) return
  transitionStageStatus(levelState, next)
}

// ─── State Helpers ───────────────────────────────────────────────────────────

/** Get existing review state or null — does NOT mutate. */
function getReviewState(ctx: ReviewContext): ReviewState | null {
  const es = ctx.state.levelStates.get(ctx.levelId)?.engineState
  if (es?.type === STAGE_TYPE.REVIEW) return es
  return null
}

/** Initialize a fresh review state and store it in level state. */
function initReviewState(ctx: ReviewContext): ReviewState {
  const reviewState: ReviewState = {
    type: STAGE_TYPE.REVIEW,
    iteration: 0,
    maxIterations: ctx.config.config.max_iterations,
    lastVerdict: null,
    lastFeedback: '',
    lastDraft: '',
  }
  const ls = ctx.state.levelStates.get(ctx.levelId)
  if (ls) ls.engineState = reviewState
  return reviewState
}

// ─── Internal Helpers ────────────────────────────────────────────────────────

/** Build the substituted system prompt for a review agent. */
function buildAgentPrompt(
  teamRootPath: string,
  agent: { systemPrompt: string; agentDir: string; experienceEnabled: boolean },
  state: ReviewContext['state'],
  workspacePath: string,
  outputPath: string,
  finalOutputPath: string,
  taskContent: string,
): string {
  return substituteTemplateVars(agent.systemPrompt, {
    SESSION_ID: state.sessionId,
    WORKSPACE_PATH: workspacePath,
    ASSIGNMENT_PATH: outputPath,
    OUTPUT_PATH: finalOutputPath,
    EXPERIENCE_PATH: agent.experienceEnabled ? path.join(agent.agentDir, 'experience') : '',
    TEAM_ROOT_PATH: teamRootPath,
    TEMPLATES_PATH: path.join(teamRootPath, 'templates'),
    PROFILES_PATH: path.join(teamRootPath, 'profiles'),
    STYLE_GUIDE_PATH: path.join(teamRootPath, 'style-guide.md'),
    CLIENT_NAME: '',
    PROJECT_NAME: '',
    TASK_CONTENT: taskContent,
  })
}

/** Build the producer's task message. */
function buildProducerMessage(
  reviewState: ReviewState,
  initialContent: string,
  inputFilesContent: string,
): string {
  const inputFilesSection = reviewState.iteration === 1 && inputFilesContent
    ? `\n**Input Files:**\n${inputFilesContent}\n\n`
    : ''

  return reviewState.iteration === 1
    ? `# Production Request\n\n${inputFilesSection}${initialContent || 'Create the initial content.'}\n\nProduce your output.`
    : `# Revision Request (Iteration ${reviewState.iteration})\n\n` +
      `## Current Draft\n\n${reviewState.lastDraft}\n\n` +
      `**Previous feedback from reviewer:**\n${reviewState.lastFeedback}\n\n` +
      `Revise the CURRENT DRAFT above based on the feedback above.\n` +
      `If you remove or rewrite away a metric-dependent claim, also remove any matching placeholder-log entry tied to that claim.\n` +
      `Do not keep obsolete items in a ## Placeholders section once the draft no longer depends on them.\n` +
      `Return the full revised document, not a summary of edits and not a fresh restart from the original brief.`
}

/** Build the reviewer's evaluation message. */
function buildReviewerMessage(
  producerName: string,
  producerOutput: string,
  iteration: number,
  previousFeedback: string,
): string {
  const priorFeedbackSection = iteration > 1 && previousFeedback.trim()
    ? `## Previous Blocking Guidance\n\n${previousFeedback}\n\n` +
      `On this iteration, first decide whether the previous blocking issues were resolved.\n` +
      `Do not move the goalposts by inventing a stricter standard just because the writer revised the draft.\n\n`
    : ''

  return (
    `# Review Request (Iteration ${iteration})\n\n` +
    `${priorFeedbackSection}` +
    `**Content from ${producerName}:**\n\n${producerOutput}\n\n` +
    `## Instructions\n\n` +
    `Review the content above and include exactly one structured decision tag anywhere in your response:\n` +
    `<review_decision>APPROVE</review_decision> or <review_decision>REVISE</review_decision>\n` +
    `The runtime will parse that tag as the decision signal.\n` +
    `You may include rationale before or after the tag, but include exactly one valid review_decision tag.\n\n` +
    `- APPROVE — if the content meets quality standards\n` +
    `- REVISE — if the content needs changes\n\n` +
    `If you choose REVISE, your feedback MUST follow this structure exactly:\n\n` +
    `## Blocking Issues\n` +
    `1. [Section: exact heading or quoted phrase] — [what is wrong] — [exact change required]\n\n` +
    `## Warnings\n` +
    `1. [Section: exact heading or quoted phrase] — [improvement needed] — [exact change required]\n\n` +
    `Rules:\n` +
    `- Reference exact section headings or quote exact phrases from the draft.\n` +
    `- Do not give generic advice like "improve flow" without pointing to the exact place.\n` +
    `- First judge whether the prior blocking issues were resolved before introducing any new blocker.\n` +
    `- Do not introduce new BLOCKING issues unless they are clearly unresolved from the prior review, directly caused by the attempted fix, or severe enough that the draft still fails the brief.\n` +
    `- Prefer WARNING for secondary refinements once the main blocking issues have been addressed.\n` +
    `- If this is a general public-company overview and an exact current metric was not clearly required by the brief, prefer feedback that tells the writer to rewrite or remove the metric-specific claim rather than demanding a precise number.\n` +
    `- For general overviews, neutral descriptive language is acceptable once unsupported quantified or comparative claims have been removed.\n` +
    `- For simple overview-style documents, approve once the brief is covered and no concrete blocker remains; do not keep the loop open for polish-only wording preferences.\n` +
    `- Do not rewrite the whole draft.\n` +
    `- Limit yourself to the smallest set of issues needed for approval, prioritizing concrete blockers.\n` +
    `- If the draft is approvable, return APPROVE and a short rationale only.`
  )
}

export function resolveInitialReviewContent(
  teamConfig: TeamConfig,
  currentLevelId: string,
  outputPath: string,
  providedContent?: string,
): string {
  if (providedContent && providedContent.trim()) return providedContent
  const contracts = deriveEffectiveStageContractsForTeam(teamConfig, currentLevelId)
  for (const artifact of contracts.input.artifacts ?? []) {
    const artifactPath = path.join(outputPath, artifact.path)
    if (!fs.existsSync(artifactPath)) continue
    const content = fs.readFileSync(artifactPath, 'utf8')
    if (content.trim()) return content
  }
  return ''
}

function buildReviewBootstrapError(
  teamConfig: TeamConfig,
  currentLevelId: string,
  outputPath: string,
  providedContent?: string,
): string {
  if (providedContent && providedContent.trim()) {
    return `Review bootstrap failed: provided review content was empty after trimming for level '${currentLevelId}'.`
  }

  const contracts = deriveEffectiveStageContractsForTeam(teamConfig, currentLevelId)
  const artifactPreview = (contracts.input.artifacts ?? [])
    .map((artifact) => `\`${artifact.path}\``)
    .join(', ')

  return (
    `Review bootstrap failed: no initial review content was available for level '${currentLevelId}'. ` +
    `Expected one of the declared input artifacts ${artifactPreview || '`draft-package.md`'} to exist in \`${outputPath}\`, ` +
    `or explicit \`content\` to be passed to \`submit_for_review\`.`
  )
}

/** Format constraint status note. */
function buildConstraintNote(config: ReviewStageConfig, state: ReviewContext['state']): string {
  if (!config.config.constraints) return ''
  checkConstraints(config.config.constraints, state.startTime, state.totalCost, state.endTime)
  return `\n\n---\n**Constraints:** ${formatElapsed(state.startTime, state.endTime)} elapsed, ${formatCost(state.totalCost)} spent`
}

function buildReviewLoopResult(text: string) {
  return {
    details: undefined,
    content: [{ type: 'text' as const, text }],
  }
}

function finalizeReviewByPolicy(
  ctx: ReviewContext,
  reviewState: ReviewState,
  iterationSummaries: string[],
  state: ReviewContext['state'],
  mode: 'approve_latest' | 'approve_latest_with_warnings',
): ReturnType<typeof buildReviewLoopResult> {
  const placeholderError = getUnresolvedDraftPlaceholderError(reviewState.lastDraft)
  if (placeholderError) {
    traceReview(ctx, 'final.blocked.invalid_latest_draft', {
      iteration: reviewState.iteration,
      policy: mode,
      reason: placeholderError,
    })
    updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
    return buildReviewLoopResult(
      `**Review Blocked ${reviewState.iteration}/${reviewState.maxIterations}**\n\n` +
      `Max-iteration fallback was refused because the latest draft is still incomplete.\n\n` +
      `${placeholderError}\n\n` +
      iterationSummaries.join('\n\n') +
      buildConstraintNote(ctx.config, state),
    )
  }

  const outputFilePath = getReviewOutputPath(ctx.config, ctx.outputPath)
  const verdict = mode === 'approve_latest' ? 'MAX_ITERATIONS_APPROVE_LATEST' : 'MAX_ITERATIONS_APPROVE_WITH_WARNINGS'
  const status = mode === 'approve_latest' ? 'approved' : 'approved_with_warnings'
  const summaryLead = mode === 'approve_latest'
    ? 'The runtime promoted the latest draft after max iterations.'
    : 'The runtime promoted the latest draft with warnings after max iterations.'

  traceReview(ctx, 'final.write.start', {
    path: outputFilePath,
    iteration: reviewState.iteration,
    policy: mode,
  })
  writeMarkdownArtifact(
    outputFilePath,
    reviewState.lastDraft,
    buildArtifactMetadata({
      filePath: outputFilePath,
      rootDir: ctx.outputPath,
      artifactType: 'result',
      sessionId: state.sessionId,
      ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
      ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
      level: ctx.levelId,
      stageType: 'review',
      agent: 'runtime',
      from: ctx.config.producer,
      to: ctx.config.reviewer,
      status,
      iteration: reviewState.iteration,
      reviewed: ctx.config.reviewer,
      verdict,
      supersedes: `draft-v${reviewState.iteration}.md`,
    }),
  )
  traceReview(ctx, 'final.write.end', {
    path: outputFilePath,
    iteration: reviewState.iteration,
    policy: mode,
  })

  reviewState.lastVerdict = 'approve'
  updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)

  return buildReviewLoopResult(
    `**Review Complete ${reviewState.iteration}/${reviewState.maxIterations}**\n\n` +
    `${summaryLead}\n\n` +
    iterationSummaries.join('\n\n') +
    buildConstraintNote(ctx.config, state),
  )
}

function getReviewIterationDraftPath(outputPath: string, iteration: number): string {
  return path.join(outputPath, `draft-v${iteration}.md`)
}

function getReviewIterationFeedbackPath(outputPath: string, iteration: number): string {
  return path.join(outputPath, `review-feedback-v${iteration}.md`)
}

function getMeaningfulContentStats(content: string): { normalized: string; wordCount: number } {
  const normalized = content
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/[*_~`>#-]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  const wordCount = normalized ? normalized.split(/\s+/).filter(Boolean).length : 0
  return { normalized, wordCount }
}

function getNearEmptyDraftError(iteration: number, content: string): string | null {
  const { normalized, wordCount } = getMeaningfulContentStats(content)
  if (!normalized) {
    return `Producer returned an empty draft on review iteration ${iteration}.`
  }
  if (wordCount < 25) {
    return (
      `Producer returned a near-empty draft on review iteration ${iteration} ` +
      `(${wordCount} words after normalization).`
    )
  }
  return null
}

function getUnresolvedDraftPlaceholderError(content: string): string | null {
  const normalized = resolveRuntimeOwnedArtifactContent(content)
  if (/\[TODO:\s*[^\]]+\]/i.test(normalized)) {
    return 'Latest draft still contains unresolved `[TODO: ...]` placeholders.'
  }
  if (/^##\s+Placeholders\b/m.test(normalized)) {
    return 'Latest draft still contains a `## Placeholders` section, so the deliverable is incomplete.'
  }
  return null
}

function stripInlineMarkdown(text: string): string {
  return text
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[*_~`]/g, '')
    .trim()
}

function normalizeHeadingText(text: string): string {
  return stripInlineMarkdown(text).replace(/\s+/g, ' ').trim()
}

function slugifyTemplateToken(text: string): string {
  return normalizeHeadingText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

function extractMarkdownHeadings(content: string): string[] {
  const headings: string[] = []
  const regex = /^(#{1,6})\s+(.+)$/gm
  let match: RegExpExecArray | null = null
  while ((match = regex.exec(content)) !== null) {
    const heading = normalizeHeadingText(match[2] ?? '')
    if (heading) headings.push(heading)
  }
  return headings
}

function extractTemplateLabelFromBrief(briefContent: string): string | null {
  const parsed = resolveRuntimeOwnedArtifactContent(briefContent)
  const match = parsed.match(/^- \*\*Template:\*\*\s*([^\n-]+?)\s+[—-]\s+/m)
  if (match?.[1]) return normalizeHeadingText(match[1])
  const fallback = parsed.match(/^- \*\*Template:\*\*\s*([^\n]+)$/m)
  return fallback?.[1] ? normalizeHeadingText(fallback[1]) : null
}

function extractStyleProfileLabelFromBrief(briefContent: string): string | null {
  const parsed = resolveRuntimeOwnedArtifactContent(briefContent)
  const match = parsed.match(/^- \*\*Style profile:\*\*\s*\*\*([^*\n]+)\*\*\s*[—-]\s+/m)
  if (match?.[1]) return normalizeHeadingText(match[1])
  const fallback = parsed.match(/^- \*\*Style profile:\*\*\s*\*\*([^*\n]+)\*\*$/m)
  return fallback?.[1] ? normalizeHeadingText(fallback[1]) : null
}

function extractTemplateName(content: string): string | null {
  const match = content.match(/^template_name:\s*([^\n]+)$/m)
  if (!match?.[1]) return null
  return normalizeHeadingText(match[1].replace(/^['"]|['"]$/g, ''))
}

function extractTemplateTitle(content: string): string | null {
  const match = content.match(/^#\s+(.+)$/m)
  return match?.[1] ? normalizeHeadingText(match[1]) : null
}

function extractRequiredSectionsFromTemplate(content: string): string[] {
  const match = content.match(/^sections_required:\s*\n((?:\s*-\s+[^\n]+\n?)*)/m)
  if (!match?.[1]) return []
  return match[1]
    .split('\n')
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] ?? '')
    .map((section) => normalizeHeadingText(section))
    .filter(Boolean)
}

function resolveSelectedTemplatePath(
  templatesDir: string,
  selectedTemplateLabel: string,
): string | null {
  if (!fs.existsSync(templatesDir)) return null
  const selectedSlug = slugifyTemplateToken(selectedTemplateLabel)
  const candidateFiles = fs.readdirSync(templatesDir)
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => path.join(templatesDir, entry))

  for (const filePath of candidateFiles) {
    const content = fs.readFileSync(filePath, 'utf8')
    const frontmatterName = extractTemplateName(content)
    const title = extractTemplateTitle(content)
    const filename = path.basename(filePath, '.md')
    const slugs = [
      slugifyTemplateToken(filename),
      frontmatterName ? slugifyTemplateToken(frontmatterName) : '',
      title ? slugifyTemplateToken(title) : '',
    ].filter(Boolean)
    if (slugs.includes(selectedSlug)) return filePath
  }

  return null
}

function extractProfileName(content: string): string | null {
  const match = content.match(/^name:\s*([^\n]+)$/m)
  if (!match?.[1]) return null
  return normalizeHeadingText(match[1].replace(/^['"]|['"]$/g, ''))
}

function extractYamlList(content: string, key: string): string[] {
  const match = content.match(new RegExp(`^${key}:\\s*\\n((?:\\s*-\\s+[^\\n]+\\n?)*)`, 'm'))
  if (!match?.[1]) return []
  return match[1]
    .split('\n')
    .map((line) => line.match(/^\s*-\s+(.+?)\s*$/)?.[1] ?? '')
    .map((item) => item.replace(/^['"]|['"]$/g, ''))
    .map((item) => item.trim())
    .filter(Boolean)
}

function resolveSelectedStyleProfilePath(
  profilesDir: string,
  selectedProfileLabel: string,
): string | null {
  if (!fs.existsSync(profilesDir)) return null
  const selectedSlug = slugifyTemplateToken(selectedProfileLabel)
  const candidateFiles = fs.readdirSync(profilesDir)
    .filter((entry) => entry.endsWith('.yaml') || entry.endsWith('.yml'))
    .map((entry) => path.join(profilesDir, entry))

  for (const filePath of candidateFiles) {
    const content = fs.readFileSync(filePath, 'utf8')
    const profileName = extractProfileName(content)
    const filename = path.basename(filePath).replace(/\.(yaml|yml)$/i, '')
    const slugs = [
      slugifyTemplateToken(filename),
      profileName ? slugifyTemplateToken(profileName) : '',
    ].filter(Boolean)
    if (slugs.includes(selectedSlug)) return filePath
  }

  return null
}

function buildTemplateValidationFeedback(
  validation: TemplateStructureValidation,
  iteration: number,
): string {
  const blockingIssues: string[] = []

  for (const section of validation.missingSections) {
    blockingIssues.push(
      `[Section: "${section}"] — Required template heading is missing — ` +
      `Add a heading named exactly \`## ${section}\` and place the section content under it.`,
    )
  }

  if (validation.orderIssue) {
    blockingIssues.push(
      `[Section order] — Draft headings do not follow the selected template order — ` +
      `Rewrite the document so these required headings appear in this exact order: ` +
      `${validation.orderIssue.expectedOrder.join(' -> ')}. ` +
      `Current matched order: ${validation.orderIssue.actualMatchedOrder.join(' -> ') || 'none'}.`,
    )
  }

  const warnings = [
    `[Template: "${validation.templateLabel}"] — Deterministic template validation ran before editorial approval on iteration ${iteration} — ` +
    `Keep the title and short metadata if useful, but preserve every required section heading from ${path.basename(validation.templatePath)} exactly.`,
  ]

  return (
    `<review_decision>REVISE</review_decision>\n\n` +
    `## Blocking Issues\n` +
    blockingIssues.map((issue, index) => `${index + 1}. ${issue}`).join('\n') +
    `\n\n## Warnings\n` +
    warnings.map((warning, index) => `${index + 1}. ${warning}`).join('\n')
  )
}

function buildStyleProfileValidationFeedback(
  validation: StyleProfileValidation,
  iteration: number,
): string {
  const blockingIssues = validation.bannedPhrases.map((phrase) => (
    `[Style profile: "${validation.profileLabel}"] — Draft uses banned phrase "${phrase}" — ` +
    `Rewrite the sentence in the profile's required register and remove that phrase entirely.`
  ))

  const warnings = [
    `[Profile: "${validation.profileLabel}"] — Deterministic style validation ran before editorial approval on iteration ${iteration} — ` +
    `Keep the substance, but rewrite the draft in the required register from ${path.basename(validation.profilePath)}.`,
  ]

  return (
    `<review_decision>REVISE</review_decision>\n\n` +
    `## Blocking Issues\n` +
    blockingIssues.map((issue, index) => `${index + 1}. ${issue}`).join('\n') +
    `\n\n## Warnings\n` +
    warnings.map((warning, index) => `${index + 1}. ${warning}`).join('\n')
  )
}

function validateDraftTemplateStructure(
  ctx: ReviewContext,
  draftContent: string,
): TemplateStructureValidation | null {
  const briefBuilderArtifactPath = path.join(ctx.outputPath, 'chain-step-1-brief-builder.md')
  if (!fs.existsSync(briefBuilderArtifactPath)) return null

  const briefContent = fs.readFileSync(briefBuilderArtifactPath, 'utf8')
  const templateLabel = extractTemplateLabelFromBrief(briefContent)
  if (!templateLabel) return null

  const templatesDir = path.join(ctx.teamRootPath, 'templates')
  const templatePath = resolveSelectedTemplatePath(templatesDir, templateLabel)
  if (!templatePath) return null

  const templateContent = fs.readFileSync(templatePath, 'utf8')
  const requiredSections = extractRequiredSectionsFromTemplate(templateContent)
  if (requiredSections.length === 0) return null

  const draftHeadings = extractMarkdownHeadings(draftContent)
  const headingPositions = new Map<string, number>()
  draftHeadings.forEach((heading, index) => {
    if (!headingPositions.has(heading)) headingPositions.set(heading, index)
  })

  const missingSections = requiredSections.filter((section) => !headingPositions.has(section))
  const matchedSections = requiredSections.filter((section) => headingPositions.has(section))
  const matchedIndexes = matchedSections.map((section) => headingPositions.get(section) ?? -1)
  const isOrdered = matchedIndexes.every((index, pos) => {
    const previous = matchedIndexes[pos - 1]
    return previous === undefined || index > previous
  })

  if (missingSections.length === 0 && isOrdered) return null

  return {
    templatePath,
    templateLabel,
    requiredSections,
    draftHeadings,
    missingSections,
    orderIssue: missingSections.length === 0 && !isOrdered
      ? {
        expectedOrder: requiredSections,
        actualMatchedOrder: matchedSections,
      }
      : null,
  }
}

function validateDraftStyleProfile(
  ctx: ReviewContext,
  draftContent: string,
): StyleProfileValidation | null {
  const briefBuilderArtifactPath = path.join(ctx.outputPath, 'chain-step-1-brief-builder.md')
  if (!fs.existsSync(briefBuilderArtifactPath)) return null

  const briefContent = fs.readFileSync(briefBuilderArtifactPath, 'utf8')
  const profileLabel = extractStyleProfileLabelFromBrief(briefContent)
  if (!profileLabel) return null

  const profilesDir = path.join(ctx.teamRootPath, 'profiles')
  const profilePath = resolveSelectedStyleProfilePath(profilesDir, profileLabel)
  if (!profilePath) return null

  const profileContent = fs.readFileSync(profilePath, 'utf8')
  const bannedPhrases = [
    ...extractYamlList(profileContent, 'forbidden_hedges'),
    ...extractYamlList(profileContent, 'banned_additional'),
  ]
    .map((phrase) => normalizeHeadingText(phrase).toLowerCase())
    .filter(Boolean)

  if (bannedPhrases.length === 0) return null

  const normalizedDraft = normalizeHeadingText(resolveRuntimeOwnedArtifactContent(draftContent)).toLowerCase()
  const matchedBannedPhrases = bannedPhrases.filter((phrase) => normalizedDraft.includes(phrase))
  if (matchedBannedPhrases.length === 0) return null

  return {
    profilePath,
    profileLabel,
    bannedPhrases: matchedBannedPhrases,
  }
}

function persistRuntimeReviewFeedback(
  ctx: ReviewContext,
  reviewState: ReviewState,
  reviewText: string,
  status: 'approved' | 'revise',
  reviewerName = 'runtime',
): void {
  const feedbackArtifactPath = getReviewIterationFeedbackPath(ctx.outputPath, reviewState.iteration)
  writeMarkdownArtifact(
    feedbackArtifactPath,
    reviewText,
    buildArtifactMetadata({
      filePath: feedbackArtifactPath,
      rootDir: ctx.outputPath,
      artifactType: 'review-feedback',
      sessionId: ctx.state.sessionId,
      ...whenDefined(ctx.state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
      ...whenDefined(ctx.state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
      level: ctx.levelId,
      stageType: 'review',
      agent: reviewerName,
      status,
      iteration: reviewState.iteration,
      reviewed: ctx.config.producer,
    }),
  )
}

function runDeterministicDraftValidation(
  ctx: ReviewContext,
  reviewState: ReviewState,
  producerOutput: string,
): { reviewText: string; isApproved: boolean } | null {
  const researchPublicationValidation =
    validateDraftResearchPublication(
      ctx,
      producerOutput,
      reviewState.iteration,
    )
  if (researchPublicationValidation) {
    const { audit, feedback } = researchPublicationValidation
    reviewState.lastVerdict = 'revise'
    reviewState.lastFeedback = feedback
    persistRuntimeReviewFeedback(
      ctx,
      reviewState,
      feedback,
      'revise',
    )
    traceReview(ctx, 'validator.research-publication.failed', {
      iteration: reviewState.iteration,
      audit_id: audit.auditId,
      violation_codes: audit.violations.map((entry) => entry.code),
    })
    return { reviewText: feedback, isApproved: false }
  }

  const templateValidation = validateDraftTemplateStructure(ctx, producerOutput)
  if (templateValidation) {
    const feedback = buildTemplateValidationFeedback(templateValidation, reviewState.iteration)
    reviewState.lastVerdict = 'revise'
    reviewState.lastFeedback = feedback
    persistRuntimeReviewFeedback(ctx, reviewState, feedback, 'revise')

    traceReview(ctx, 'validator.template-structure.failed', {
      iteration: reviewState.iteration,
      template: path.basename(templateValidation.templatePath),
      missing_sections: templateValidation.missingSections,
      required_sections: templateValidation.requiredSections,
      draft_headings: templateValidation.draftHeadings,
      has_order_issue: Boolean(templateValidation.orderIssue),
    })

    return { reviewText: feedback, isApproved: false }
  }

  const styleValidation = validateDraftStyleProfile(ctx, producerOutput)
  if (styleValidation) {
    const feedback = buildStyleProfileValidationFeedback(styleValidation, reviewState.iteration)
    reviewState.lastVerdict = 'revise'
    reviewState.lastFeedback = feedback
    persistRuntimeReviewFeedback(ctx, reviewState, feedback, 'revise')

    traceReview(ctx, 'validator.style-profile.failed', {
      iteration: reviewState.iteration,
      profile: path.basename(styleValidation.profilePath),
      banned_phrases: styleValidation.bannedPhrases,
    })

    return { reviewText: feedback, isApproved: false }
  }

  return null
}

function validateDraftResearchPublication(
  ctx: ReviewContext,
  draftContent: string,
  iteration: number,
): ResearchPublicationValidation | null {
  const config = ctx.config.config.research_publication_validation
  if (!config) return null
  const sourcePath = resolveOwnedRunRelativePath({
    assignmentPath: ctx.outputPath,
    relativePath: config.source_artifact,
    label: 'Research publication source artifact',
  })
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(
      `Research publication validation source '${config.source_artifact}' does not exist.`,
    )
  }
  const graph = config.evidence_graph_artifact
    ? readPublicationEvidenceGraph(
        ctx.outputPath,
        config.evidence_graph_artifact,
      )
    : undefined
  // Audit the exact canonical form the publish transform will ship while
  // leaving the producer's editorial draft untouched for comparison and
  // recovery. Without an evidence graph, retain the legacy direct audit.
  const canonicalization = graph === undefined
    ? undefined
    : canonicalizeResearchCitations({
        markdown: draftContent,
        evidenceGraph: graph,
      })
  const audit = buildResearchPublicationAudit({
    sourceMarkdown: fs.readFileSync(sourcePath, 'utf8'),
    publicationMarkdown: canonicalization?.markdown ?? draftContent,
    evidenceGraph: graph,
    ...(canonicalization
      ? { canonicalization: canonicalization.summary }
      : {}),
  })
  const auditPath = resolveOwnedRunRelativePath({
    assignmentPath: ctx.outputPath,
    relativePath: config.audit_artifact,
    label: 'Research publication audit artifact',
  })
  const versionedAuditPath = resolveOwnedRunRelativePath({
    assignmentPath: ctx.outputPath,
    relativePath:
      `${config.audit_artifact.replace(/\.json$/iu, '')}-v${iteration}.json`,
    label: 'Versioned research publication audit artifact',
  })
  const contents = `${JSON.stringify(audit, null, 2)}\n`
  writeFileAtomicSync(versionedAuditPath, contents)
  writeFileAtomicSync(auditPath, contents)
  if (audit.decision === 'APPROVE') return null

  return {
    audit,
    feedback: [
      '<review_decision>REVISE</review_decision>',
      '',
      '## Blocking Issues',
      ...audit.violations.map(
        (entry, index) =>
          `${index + 1}. [Publication provenance] — ${entry.message} — ` +
          'Restore the validated source, numeral, caveat, or citation without adding new factual content.',
      ),
      '',
      '## Warnings',
      '1. [Publication audit] — Deterministic claim and citation validation failed — Preserve the research package exactly where factual provenance is concerned.',
    ].join('\n'),
  }
}

function readPublicationEvidenceGraph(
  assignmentPath: string,
  relativePath: string,
): unknown {
  const graphPath = resolveOwnedRunRelativePath({
    assignmentPath,
    relativePath,
    label: 'Research publication evidence graph',
  })
  if (!fs.existsSync(graphPath) || !fs.statSync(graphPath).isFile()) {
    throw new Error(
      `Research publication evidence graph '${relativePath}' does not exist.`,
    )
  }
  try {
    return JSON.parse(fs.readFileSync(graphPath, 'utf8'))
  } catch {
    throw new Error(
      `Research publication evidence graph '${relativePath}' is not valid JSON.`,
    )
  }
}

/** Run the producer agent for one iteration. */
async function runProducer(
  ctx: ReviewContext,
  reviewState: ReviewState,
  initialContent: string,
  signal: AbortSignal | undefined,
  budgetAdmission: BudgetDispatchAdmission | undefined,
): Promise<
  | { output: string; agentName: string; dispatchId?: string }
  | { error: string }
> {
  const { config, agents, rosterEntries, state, workspacePath, agentMetrics, onDashboardUpdate, outputPath } = ctx
  const producerName = config.producer
  const producer = agents.get(producerName)
  if (!producer) return { error: `Producer agent '${producerName}' not found.` }

  const producerMessage = buildProducerMessage(reviewState, initialContent, ctx.inputFilesContent)
  const producerTaskContent = reviewState.iteration === 1
    ? initialContent
    : producerMessage
  const artifactPath = getReviewIterationDraftPath(outputPath, reviewState.iteration)
  const finalPrompt = buildAgentPrompt(
    ctx.teamRootPath,
    producer,
    state,
    workspacePath,
    ctx.outputPath,
    artifactPath,
    producerTaskContent,
  )
  const producerMetrics = agentMetrics.get(producerName)
  const rosterEntry = rosterEntries.get(producerName)
  const teamWorkspacePath = rosterEntry?.type === 'team' && rosterEntry.team_path
    ? resolveChildWorkspacePath(rosterEntry.team_path)
    : undefined

  const producerPolicy = rosterEntry?.on_failure
  const resolvedPolicy = resolveFailurePolicy(
    producerName,
    STAGE_TYPE.REVIEW,
    ctx.stageFailureOverride,
    producerPolicy,
  )
  const fallbackName = resolvedPolicy.fallbackAgent
  const fallbackAgent = fallbackName ? ctx.agents.get(fallbackName) : undefined
  const fallbackRosterEntry = fallbackName ? ctx.rosterEntries.get(fallbackName) : undefined
  const fallbackFinalPrompt = fallbackAgent
    ? buildAgentPrompt(
      ctx.teamRootPath,
      fallbackAgent,
      state,
      workspacePath,
      ctx.outputPath,
      artifactPath,
      producerTaskContent,
    )
    : undefined

  try {
    const result = await dispatchWithFailurePolicy({
      agent: producer,
      rosterEntry,
      finalPrompt,
      userMessage: producerMessage,
      state,
      workspacePath,
      outputPath: ctx.outputPath,
      ...whenDefined(teamWorkspacePath, (definedValue) => ({ teamWorkspacePath: definedValue })),
      metrics: producerMetrics,
      ...whenDefined(ctx.shutdownSignal ? combineAbortSignals(signal, ctx.shutdownSignal) : signal, (definedValue) => ({ signal: definedValue })),
      ...whenDefined(onDashboardUpdate, (definedValue) => ({ onDashboardUpdate: definedValue })),
      triggerTool: 'submit_for_review',
      logicalInvocationId: buildStageDispatchInvocationId({
        sessionId: state.sessionId,
        levelId: ctx.levelId,
        visitCount: state.levelStates.get(ctx.levelId)?.visitCount ?? 0,
        stageType: STAGE_TYPE.REVIEW,
        slot: `producer:iteration:${reviewState.iteration}`,
        target: producerName,
      }),
      ...whenDefined(ctx.teamName, (definedValue) => ({ teamName: definedValue })),
      fromName: ctx.config.coordinator ?? 'coordinator',
      policy: resolvedPolicy,
      ...whenDefined(fallbackAgent, (definedValue) => ({ fallbackAgent: definedValue })),
      ...whenDefined(fallbackRosterEntry, (definedValue) => ({ fallbackRosterEntry: definedValue })),
      ...whenDefined(fallbackFinalPrompt, (definedValue) => ({ fallbackFinalPrompt: definedValue })),
      levelId: ctx.levelId,
      stageType: STAGE_TYPE.REVIEW,
      sessionId: state.sessionId,
      ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
      errorLogPath: ctx.outputPath,
      onFailureRecorded: (aName, error) => {
        const m = ctx.agentMetrics.get(aName)
        if (m) { m.failureCount++; m.lastError = error }
      },
      ...whenDefined(ctx.budgetLedger, (definedValue) => ({ budgetLedger: definedValue })),
      totalCost: state.totalCost,
      ...(budgetAdmission ? { budgetAdmission } : {}),
      ...whenDefined(ctx.config.config.constraints?.agent_timeout_minutes, (definedValue) => ({ timeoutMinutes: definedValue })),
    })

    if (result.interruption) {
      ctx.onStateCheckpoint?.()
      throw new AgentQuestionInterruptionError(result.interruption)
    }

    if (result.skipped) {
      // Producer skip means iteration fails — cannot produce content
      return { error: `Producer ${producerName} was skipped — cannot produce content for this iteration.` }
    }

    // Save draft
    const canonicalOutput = resolveRuntimeOwnedArtifactContent(result.text, artifactPath)
    writeMarkdownArtifact(
      artifactPath,
      canonicalOutput,
      buildArtifactMetadata({
        filePath: artifactPath,
        rootDir: outputPath,
        artifactType: 'draft',
        sessionId: state.sessionId,
        ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
        ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
        level: ctx.levelId,
        stageType: 'review',
        agent: producerName,
        status: 'draft',
        iteration: reviewState.iteration,
        reviewed: ctx.config.reviewer,
      }),
    )

    reviewState.lastDraft = canonicalOutput

    return {
      output: canonicalOutput,
      agentName: result.agentName ?? producerName,
      ...whenDefined(result.dispatchId, (dispatchId) => ({ dispatchId })),
    }
  } catch (err) {
    if (err instanceof AgentQuestionInterruptionError || signal?.aborted || ctx.shutdownSignal?.aborted) {
      throw err
    }
    if (err instanceof HaltError) {
      return { error: `Producer halted: ${err.message}` }
    }
    const errMsg = err instanceof Error ? err.message : String(err)
    return { error: `Producer error: ${errMsg}` }
  }
}

/** Run the reviewer agent and return verdict + review text. */
async function runReviewer(
  ctx: ReviewContext,
  reviewState: ReviewState,
  producerOutput: string,
  signal: AbortSignal | undefined,
  budgetAdmission: BudgetDispatchAdmission | undefined,
): Promise<{ reviewText: string; isApproved: boolean } | { error: string }> {
  const { config, agents, rosterEntries, state, workspacePath, agentMetrics, onDashboardUpdate } = ctx
  const reviewerName = config.reviewer
  const reviewer = agents.get(reviewerName)
  if (!reviewer) return { error: `Reviewer agent '${reviewerName}' not found.` }

  const reviewerMessage = buildReviewerMessage(
    config.producer,
    producerOutput,
    reviewState.iteration,
    reviewState.lastFeedback,
  )
  const feedbackArtifactPath = getReviewIterationFeedbackPath(ctx.outputPath, reviewState.iteration)
  const finalPrompt = buildAgentPrompt(
    ctx.teamRootPath,
    reviewer,
    state,
    workspacePath,
    ctx.outputPath,
    feedbackArtifactPath,
    producerOutput,
  )
  const reviewerMetrics = agentMetrics.get(reviewerName)
  const rosterEntry = rosterEntries.get(reviewerName)
  const teamWorkspacePath = rosterEntry?.type === 'team' && rosterEntry.team_path
    ? resolveChildWorkspacePath(rosterEntry.team_path)
    : undefined

  const reviewerPolicy = rosterEntry?.on_failure
  const resolvedPolicy = resolveFailurePolicy(
    reviewerName,
    STAGE_TYPE.REVIEW,
    ctx.stageFailureOverride,
    reviewerPolicy,
  )
  const fallbackName = resolvedPolicy.fallbackAgent
  const fallbackAgent = fallbackName ? ctx.agents.get(fallbackName) : undefined
  const fallbackRosterEntry = fallbackName ? ctx.rosterEntries.get(fallbackName) : undefined
  const fallbackFinalPrompt = fallbackAgent
    ? buildAgentPrompt(
      ctx.teamRootPath,
      fallbackAgent,
      state,
      workspacePath,
      ctx.outputPath,
      feedbackArtifactPath,
      producerOutput,
    )
    : undefined

  try {
    const result = await dispatchWithFailurePolicy({
      agent: reviewer,
      rosterEntry,
      finalPrompt,
      userMessage: reviewerMessage,
      state,
      workspacePath,
      outputPath: ctx.outputPath,
      ...whenDefined(teamWorkspacePath, (definedValue) => ({ teamWorkspacePath: definedValue })),
      metrics: reviewerMetrics,
      ...whenDefined(ctx.shutdownSignal ? combineAbortSignals(signal, ctx.shutdownSignal) : signal, (definedValue) => ({ signal: definedValue })),
      ...whenDefined(onDashboardUpdate, (definedValue) => ({ onDashboardUpdate: definedValue })),
      triggerTool: 'submit_for_review',
      logicalInvocationId: buildStageDispatchInvocationId({
        sessionId: state.sessionId,
        levelId: ctx.levelId,
        visitCount: state.levelStates.get(ctx.levelId)?.visitCount ?? 0,
        stageType: STAGE_TYPE.REVIEW,
        slot: `reviewer:iteration:${reviewState.iteration}`,
        target: reviewerName,
      }),
      ...whenDefined(ctx.teamName, (definedValue) => ({ teamName: definedValue })),
      fromName: ctx.config.coordinator ?? 'coordinator',
      policy: resolvedPolicy,
      ...whenDefined(fallbackAgent, (definedValue) => ({ fallbackAgent: definedValue })),
      ...whenDefined(fallbackRosterEntry, (definedValue) => ({ fallbackRosterEntry: definedValue })),
      ...whenDefined(fallbackFinalPrompt, (definedValue) => ({ fallbackFinalPrompt: definedValue })),
      levelId: ctx.levelId,
      stageType: STAGE_TYPE.REVIEW,
      sessionId: state.sessionId,
      ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
      errorLogPath: ctx.outputPath,
      onFailureRecorded: (aName, error) => {
        const m = ctx.agentMetrics.get(aName)
        if (m) { m.failureCount++; m.lastError = error }
      },
      ...whenDefined(ctx.budgetLedger, (definedValue) => ({ budgetLedger: definedValue })),
      totalCost: state.totalCost,
      ...(budgetAdmission ? { budgetAdmission } : {}),
      ...whenDefined(ctx.config.config.constraints?.agent_timeout_minutes, (definedValue) => ({ timeoutMinutes: definedValue })),
    })

    if (result.interruption) {
      ctx.onStateCheckpoint?.()
      throw new AgentQuestionInterruptionError(result.interruption)
    }

    if (result.skipped) {
      const warning = `⚠️ Reviewer ${reviewerName} was skipped because the agent failed.`
      if (config.config.on_reviewer_skip !== 'approve_latest') {
        reviewState.lastVerdict = 'revise'
        reviewState.lastFeedback = `${warning} Review approval is required, so this iteration cannot be approved.`
        persistRuntimeReviewFeedback(
          ctx,
          reviewState,
          reviewState.lastFeedback,
          'revise',
          reviewerName,
        )
        return { reviewText: reviewState.lastFeedback, isApproved: false }
      }

      // This downgrade is opt-in. The default preserves the review guarantee.
      reviewState.lastVerdict = 'approve'
      reviewState.lastFeedback = warning
      writeMarkdownArtifact(
        feedbackArtifactPath,
        `APPROVE\n${warning}`,
        buildArtifactMetadata({
          filePath: feedbackArtifactPath,
          rootDir: ctx.outputPath,
          artifactType: 'review-feedback',
          sessionId: state.sessionId,
          ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
          ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
          level: ctx.levelId,
          stageType: 'review',
          agent: reviewerName,
          status: 'approved',
          iteration: reviewState.iteration,
          reviewed: config.producer,
        }),
      )
      return { reviewText: warning, isApproved: true }
    }

    const rawReview = resolveRuntimeOwnedArtifactContent(result.text, feedbackArtifactPath)
    const canonicalReview = canonicalizeReviewFeedback(rawReview, ['APPROVE', 'REVISE'], 'review_decision')
    const verdict =
      parseTaggedVerdict(canonicalReview, ['APPROVE', 'REVISE'], 'review_decision') ??
      parseVerdict(canonicalReview, ['APPROVE', 'REVISE'])
    const isApproved = verdict === 'APPROVE'

    reviewState.lastVerdict = isApproved ? 'approve' : 'revise'
    reviewState.lastFeedback = verdict ? canonicalReview : `Invalid review verdict.\n\n${canonicalReview}`

    // Only a verdict the engine could read is a review. An unparseable one is
    // recorded as feedback for the next iteration, not published as an answer.
    if (verdict) {
      publishAcceptedTeamChatMessage(ctx, {
        agentName: result.agentName ?? reviewerName,
        ...whenDefined(result.dispatchId, (dispatchId) => ({ dispatchId })),
        stageType: STAGE_TYPE.REVIEW,
        text: reviewState.lastFeedback,
      })
    }

    writeMarkdownArtifact(
      feedbackArtifactPath,
      reviewState.lastFeedback,
      buildArtifactMetadata({
        filePath: feedbackArtifactPath,
        rootDir: ctx.outputPath,
        artifactType: 'review-feedback',
        sessionId: state.sessionId,
        ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
        ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
        level: ctx.levelId,
        stageType: 'review',
        agent: reviewerName,
        status: isApproved ? 'approved' : 'revise',
        iteration: reviewState.iteration,
        reviewed: config.producer,
      }),
    )

    return { reviewText: reviewState.lastFeedback, isApproved }
  } catch (err) {
    if (err instanceof AgentQuestionInterruptionError || signal?.aborted || ctx.shutdownSignal?.aborted) {
      throw err
    }
    if (err instanceof HaltError) {
      return { error: `Reviewer halted: ${err.message}` }
    }
    const errMsg = err instanceof Error ? err.message : String(err)
    return { error: `Reviewer error: ${errMsg}` }
  }
}

async function runReviewLoop(
  ctx: ReviewContext,
  reviewState: ReviewState,
  safeParams: { action?: 'produce' | 'status'; content?: string },
  signal: AbortSignal | undefined,
  budgetAdmission: BudgetDispatchAdmission | undefined,
) {
  const { config, state, outputPath, onDashboardUpdate } = ctx
  const onMaxIterations = config.config.on_max_iterations ?? 'block'

  if (reviewState.lastVerdict === 'approve') {
    updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)
    traceReview(ctx, 'guard.already-approved', { iteration: reviewState.iteration })
    return buildReviewLoopResult('Review already approved. No more iterations needed.')
  }

  if (nextReviewTurn(reviewState).kind === 'limit') {
    traceReview(ctx, 'guard.max-iterations', {
      iteration: reviewState.iteration,
      max_iterations: reviewState.maxIterations,
      on_max_iterations: onMaxIterations,
    })
    if (reviewState.lastDraft.trim()) {
      if (onMaxIterations === 'approve_latest' || onMaxIterations === 'approve_latest_with_warnings') {
        return finalizeReviewByPolicy(ctx, reviewState, [], state, onMaxIterations)
      }
    }
    updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
    if (onMaxIterations === 'escalate_to_user') {
      // Terminal, and said to be. Nothing is waiting for a reply and nothing
      // resumes in place, so the message names the one thing that does move
      // the work on: a new run.
      return buildReviewLoopResult(
        `**Review Blocked ${reviewState.iteration}/${reviewState.maxIterations}**\n\n` +
        `The review loop ended without approval and this run is over. ` +
        `Nothing is waiting for a reply — start a new run to try again.`,
      )
    }
    return buildReviewLoopResult(`Max iterations (${reviewState.maxIterations}) reached. Review loop ended.`)
  }

  const initialContent = resolveInitialReviewContent(
    ctx.teamConfig,
    ctx.levelId,
    outputPath,
    safeParams.content,
  )
  const inputContracts = deriveEffectiveStageContractsForTeam(ctx.teamConfig, ctx.levelId)
  traceReview(ctx, 'bootstrap.content-resolved', {
    provided_content_length: safeParams.content?.length ?? 0,
    resolved_content_length: initialContent.length,
    input_artifacts: inputContracts.input.artifacts?.map((artifact) => artifact.path) ?? [],
  })

  if (!initialContent.trim()) {
    const bootstrapError = buildReviewBootstrapError(ctx.teamConfig, ctx.levelId, outputPath, safeParams.content)
    updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
    traceReview(ctx, 'bootstrap.empty', { error: bootstrapError })
    return buildReviewLoopResult(bootstrapError)
  }

  if (reviewState.iteration === 0) {
    const briefPath = path.join(outputPath, 'brief.md')
    traceReview(ctx, 'brief.write.start', { path: briefPath })
    writeMarkdownArtifact(
      briefPath,
      `# Review Brief\n\n${initialContent}`,
      buildArtifactMetadata({
        filePath: briefPath,
        rootDir: outputPath,
        artifactType: 'brief',
        sessionId: state.sessionId,
        ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
        ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
        level: ctx.levelId,
        stageType: 'review',
        status: 'active',
      }),
    )
    traceReview(ctx, 'brief.write.end', { path: briefPath })
  }

  updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.RUNNING)

  const iterationSummaries: string[] = []
  let approvedOutput: string | null = null

  /**
   * An ordinary failure ends this review turn, so the phase it stopped in must
   * not survive to claim another turn: `nextReviewTurn` prefers `pendingPhase`
   * over the iteration count, so a leftover phase reruns the same iteration and
   * keeps `isReviewComplete` false for a review that can take no further turn.
   * A human question is the opposite case. `AgentQuestionInterruptionError`
   * unwinds past here without clearing anything, so the answer resumes in the
   * phase it paused in. That is why this is explicit at each ordinary exit
   * rather than a `finally`, which could not tell the two apart.
   */
  const abandonUnfinishedPhase = () => {
    delete reviewState.pendingPhase
    ctx.onStateCheckpoint?.()
  }

  while (true) {
    const next = nextReviewTurn(reviewState)
    if (next.kind === 'complete' || next.kind === 'limit') break
    reviewState.iteration = next.iteration
    reviewState.pendingPhase = next.kind
    ctx.onStateCheckpoint?.()

    if (next.kind === 'producer') {
      traceReview(ctx, 'iteration.incremented', { iteration: reviewState.iteration })

      updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.WAITING_ON_WORKER)
      traceReview(ctx, 'producer.dispatch.start', {
        agent: config.producer,
        iteration: reviewState.iteration,
      })
      const producerResult = await runProducer(
        ctx,
        reviewState,
        initialContent,
        signal,
        budgetAdmission,
      )
      if ('error' in producerResult) {
        updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
        traceReview(ctx, 'producer.dispatch.error', {
          error: producerResult.error,
          iteration: reviewState.iteration,
        })
        abandonUnfinishedPhase()
        return buildReviewLoopResult(producerResult.error)
      }
      updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.RUNNING)
      traceReview(ctx, 'producer.dispatch.end', {
        output_length: producerResult.output.length,
        iteration: reviewState.iteration,
      })

      const nearEmptyDraftError = getNearEmptyDraftError(reviewState.iteration, producerResult.output)
      if (nearEmptyDraftError) {
        updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
        traceReview(ctx, 'producer.output.invalid', {
          error: nearEmptyDraftError,
          iteration: reviewState.iteration,
          output_length: producerResult.output.length,
        })
        abandonUnfinishedPhase()
        return buildReviewLoopResult(nearEmptyDraftError)
      }

      // The draft has cleared the engine's own emptiness gate, so it is a
      // contribution rather than a provider reply. The reviewer's verdict is
      // published separately, only once it parses.
      publishAcceptedTeamChatMessage(ctx, {
        agentName: producerResult.agentName,
        ...whenDefined(producerResult.dispatchId, (dispatchId) => ({ dispatchId })),
        stageType: STAGE_TYPE.REVIEW,
        text: producerResult.output,
      })

      reviewState.pendingPhase = 'reviewer'
      ctx.onStateCheckpoint?.()
    }

    const acceptedDraft = reviewState.lastDraft
    updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.WAITING_ON_VALIDATOR)
    const deterministicValidationResult = runDeterministicDraftValidation(ctx, reviewState, acceptedDraft)
    const reviewerResult = deterministicValidationResult ?? await (async () => {
      traceReview(ctx, 'reviewer.dispatch.start', {
        agent: config.reviewer,
        iteration: reviewState.iteration,
      })
      return runReviewer(
        ctx,
        reviewState,
        acceptedDraft,
        signal,
        budgetAdmission,
      )
    })()
    if ('error' in reviewerResult) {
      updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.FAILED)
      traceReview(ctx, 'reviewer.dispatch.error', {
        error: reviewerResult.error,
        iteration: reviewState.iteration,
      })
      abandonUnfinishedPhase()
      return buildReviewLoopResult(reviewerResult.error)
    }
    delete reviewState.pendingPhase
    ctx.onStateCheckpoint?.()
    updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.RUNNING)
    traceReview(ctx, deterministicValidationResult ? 'validator.dispatch.end' : 'reviewer.dispatch.end', {
      approved: reviewerResult.isApproved,
      review_length: reviewerResult.reviewText.length,
      iteration: reviewState.iteration,
    })

    if (reviewerResult.isApproved) {
      const outputFilePath = getReviewOutputPath(config, outputPath)
      traceReview(ctx, 'final.write.start', {
        path: outputFilePath,
        iteration: reviewState.iteration,
      })
      writeMarkdownArtifact(
        outputFilePath,
        acceptedDraft,
        buildArtifactMetadata({
          filePath: outputFilePath,
          rootDir: outputPath,
          artifactType: 'result',
          sessionId: state.sessionId,
          ...whenDefined(state.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
          ...whenDefined(state.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
          level: ctx.levelId,
          stageType: 'review',
          agent: 'runtime',
          from: config.producer,
          to: config.reviewer,
          status: 'approved',
          iteration: reviewState.iteration,
          reviewed: config.reviewer,
          verdict: 'APPROVE',
          supersedes: `draft-v${reviewState.iteration}.md`,
        }),
      )
      traceReview(ctx, 'final.write.end', {
        path: outputFilePath,
        iteration: reviewState.iteration,
      })
      updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.COMPLETED)
      approvedOutput = acceptedDraft
      iterationSummaries.push(
        `Iteration ${reviewState.iteration}: APPROVE\n${reviewerResult.reviewText}`,
      )
      break
    }

    updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.REVISING)
    iterationSummaries.push(
      `Iteration ${reviewState.iteration}: REVISE\n${reviewerResult.reviewText}`,
    )
  }

  if (onDashboardUpdate) onDashboardUpdate()

  const constraintNote = buildConstraintNote(config, state)
  if (approvedOutput !== null) {
    return buildReviewLoopResult(
      `**Review Complete ${reviewState.iteration}/${reviewState.maxIterations}**\n\n` +
      `The runtime completed the review loop and approved the output.\n\n` +
      iterationSummaries.join('\n\n') +
      constraintNote,
    )
  }

  traceReview(ctx, 'loop.max-iterations-reached', {
    iteration: reviewState.iteration,
    max_iterations: reviewState.maxIterations,
    last_verdict: reviewState.lastVerdict,
    on_max_iterations: onMaxIterations,
  })

  if (reviewState.lastDraft.trim()) {
    if (onMaxIterations === 'approve_latest' || onMaxIterations === 'approve_latest_with_warnings') {
      return finalizeReviewByPolicy(ctx, reviewState, iterationSummaries, state, onMaxIterations)
    }
  }

  updateReviewStageStatus(ctx, STAGE_LIFECYCLE_STATUS.BLOCKED)
  if (onMaxIterations === 'escalate_to_user') {
    // Terminal, and said to be. See the note on the other exhaustion path: the
    // stage is blocked, nothing resumes in place, and a new run is the next
    // action. The iteration summaries are what the next run is started from.
    return buildReviewLoopResult(
      `**Review Blocked ${reviewState.iteration}/${reviewState.maxIterations}**\n\n` +
      `The review loop ended without approval and this run is over. ` +
      `Nothing is waiting for a reply — start a new run to try again.\n\n` +
      iterationSummaries.join('\n\n') +
      constraintNote,
    )
  }

  return buildReviewLoopResult(
    `**Review Blocked ${reviewState.iteration}/${reviewState.maxIterations}**\n\n` +
    `The runtime exhausted the review loop without approval.\n\n` +
    iterationSummaries.join('\n\n') +
    constraintNote,
  )
}

// ─── submit_for_review tool ──────────────────────────────────────────────────

/**
 * Create the `submit_for_review` tool for a review stage.
 */
export function createReviewTool(ctx: ReviewContext): ToolDefinition {
  return {
    name: 'submit_for_review',
    label: 'Submit for Review',
    description:
      `Start or continue the review loop for the current assignment draft. ` +
      `The runtime loads the current draft artifact automatically and the loop continues until APPROVE or max ${ctx.config.config.max_iterations} iterations.`,
    promptSnippet:
      `Use \`submit_for_review\` with no arguments to review the current assignment draft. ` +
      `Producer creates, reviewer approves/revises. Max ${ctx.config.config.max_iterations} iterations.`,
    promptGuidelines: [
      "If the reviewer's feedback surfaces questions that require user input, present them to the user before the next revision cycle.",
      'Call `submit_for_review` with no arguments. The runtime will load the previous level output artifact from the current assignment automatically.',
      "The reviewer is called automatically after production.",
      "Loop ends on APPROVE or after max iterations.",
    ],
    parameters: Type.Object({
      action: Type.Optional(Type.Union([
        Type.Literal('produce'),
        Type.Literal('status'),
      ])),
      content: Type.Optional(Type.String()),
      message: Type.Optional(Type.String()),
    }, {
      additionalProperties: true,
      description:
        'Optional review parameters as an object. Supports { action, content } and accepts message as an alias for content. The runtime auto-loads the current draft when no content is provided.',
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _extensionCtx) {
      const budgetAdmission = adoptBudgetDispatchAdmission({
        ledger: ctx.budgetLedger,
        adopt: ctx.adoptCapabilityBudget,
        toolCallId: _toolCallId,
      })
      try {
        const safeParams = normalizeReviewParams(params)
        const reviewState = getReviewState(ctx) ?? initReviewState(ctx)
        traceReview(ctx, 'tool.enter', {
          tool_call_id: _toolCallId,
          params: safeParams,
          iteration: reviewState.iteration,
          last_verdict: reviewState.lastVerdict,
        })

        // ── status ──
        const action = safeParams.action ?? 'produce'
        traceReview(ctx, 'action.resolved', { action })

        if (action === 'status') {
          traceReview(ctx, 'status.return', {
            iteration: reviewState.iteration,
            max_iterations: reviewState.maxIterations,
            last_verdict: reviewState.lastVerdict,
          })
          return {
            details: undefined,
            content: [{
              type: 'text' as const,
              text: `**Review Status:**\n` +
                `- Iteration: ${reviewState.iteration}/${reviewState.maxIterations}\n` +
                `- Last verdict: ${reviewState.lastVerdict || 'none'}\n` +
                `- Last feedback: ${reviewState.lastFeedback.slice(0, 200) || 'none'}`,
            }],
          }
        }
        return await runReviewLoop(
          ctx,
          reviewState,
          safeParams,
          _signal,
          budgetAdmission,
        )
      } catch (err) {
        if (err instanceof AgentQuestionInterruptionError || _signal?.aborted || ctx.shutdownSignal?.aborted) {
          throw err
        }
        const errMsg = err instanceof Error ? err.stack || err.message : String(err)
        traceReview(ctx, 'tool.exception', { error: errMsg })
        return {
          details: undefined,
          content: [{
            type: 'text' as const,
            text: `Review tool error: ${errMsg}`,
          }],
        }
      }
    },

    renderCall(args, theme) {
      const action = (args as Record<string, unknown>).action ?? 'produce'
      return new Text(`${theme.fg('accent', 'submit_for_review')} ${action}`)
    },

    renderResult(result, _options, theme) {
      const text = (result.content?.[0] as { text?: string })?.text ?? ''
      if (text.includes('APPROVED')) return new Text(theme.fg('success', 'Approved'))
      if (text.includes('REVISE')) return new Text(theme.fg('warning', 'Revision needed'))
      return new Text(theme.fg('dim', 'Review processed'))
    },
  }
}

// ─── Public Engine API ───────────────────────────────────────────────────────

export function isReviewComplete(state: ReviewState): boolean {
  return state.lastVerdict === 'approve' || (!state.pendingPhase && state.iteration >= state.maxIterations)
}

export function getReviewOutputPath(config: ReviewStageConfig, outputPath: string): string {
  const configuredPath = config.config.output.path
  const outputDir = configuredPath
    ? (path.isAbsolute(configuredPath) ? configuredPath : path.join(outputPath, configuredPath))
    : outputPath
  return path.join(outputDir, config.config.output.format)
}
