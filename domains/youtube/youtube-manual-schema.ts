import * as z from 'zod/v4'
import { youtubeDocumentRequestSchema } from '../../contracts/youtube-document-request.js'
import { whenDefined } from '../../core/optional-properties.js'

import { YOUTUBE_MANUAL_TEMPLATES } from './manual-templates/index.js'
import {
  YOUTUBE_MANUAL_PLAN_SCHEMA_VERSION,
  type YoutubeManualPlan,
  type YoutubeManualTemplateId,
  type YoutubeManualVideo,
  type YoutubeVideoAnalysis,
  type YoutubeVisualCue,
} from './youtube-manual-types.js'

const MAX_STEPS = 500
const MAX_CHAPTERS = 100
const MAX_CUES = 1_000
const MAX_REPORTED_FAILURES = 10
const idSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,127}$/)
const textSchema = (maximum: number) => z.string().trim().min(1).max(maximum)
const languageSchema = z.string().trim().min(2).max(64).refine(isLanguageTag)
const timestampSchema = z.number().finite().min(0)

const visualCueSchema = z.object({
  timestampSeconds: timestampSchema,
  importance: z.enum(['required', 'supporting']),
  reason: textSchema(2_000),
  caption: textSchema(1_000),
  altText: textSchema(1_000).refine((value) => !/^(image|screenshot|picture)$/i.test(value)),
}).strict()

const analysisStepSchema = z.object({
  id: idSchema,
  title: textSchema(500),
  explanation: textSchema(10_000),
  startSeconds: timestampSchema,
  endSeconds: timestampSchema,
  visualCandidates: z.array(visualCueSchema).min(1).max(100),
}).strict()

const videoAnalysisSchema = z.object({
  analysisSchemaVersion: z.literal(1),
  sourceRevisionFingerprint: textSchema(256),
  model: textSchema(128).optional(),
  analysisPromptVersion: textSchema(128),
  outputLanguage: languageSchema,
  detectedSourceLanguage: languageSchema.optional(),
  generatedAt: z.iso.datetime(),
  summary: textSchema(20_000),
  prerequisites: z.array(textSchema(2_000)).max(100).optional(),
  warnings: z.array(textSchema(2_000)).max(100).optional(),
  steps: z.array(analysisStepSchema).min(1).max(MAX_STEPS),
}).strict().transform((analysis) => ({
  analysisSchemaVersion: analysis.analysisSchemaVersion,
  sourceRevisionFingerprint: analysis.sourceRevisionFingerprint,
  analysisPromptVersion: analysis.analysisPromptVersion,
  outputLanguage: analysis.outputLanguage,
  generatedAt: analysis.generatedAt,
  summary: analysis.summary,
  steps: analysis.steps,
  ...whenDefined(analysis.model, (model) => ({ model })),
  ...whenDefined(analysis.detectedSourceLanguage, (detectedSourceLanguage) => ({ detectedSourceLanguage })),
  ...whenDefined(analysis.prerequisites, (prerequisites) => ({ prerequisites })),
  ...whenDefined(analysis.warnings, (warnings) => ({ warnings })),
}))

const manualPlanSchema = z.object({
  documentRequest: youtubeDocumentRequestSchema.optional(),
  manualPlanSchemaVersion: z.literal(1),
  video: z.object({
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    url: z.url(),
    title: textSchema(1_000),
    channelName: textSchema(500).optional(),
    publishedAt: textSchema(64).optional(),
    durationSeconds: z.number().finite().positive().max(86_400),
  }).strict(),
  templateId: z.enum(['quick-guide', 'step-by-step', 'dense-visual']),
  sourceLanguage: languageSchema.optional(),
  outputLanguage: languageSchema,
  analysis: z.object({
    mode: z.enum(['gemini', 'transcript']),
    model: textSchema(128).optional(),
    generatedAt: z.iso.datetime(),
    warnings: z.array(textSchema(2_000)).max(100),
  }).strict(),
  prerequisites: z.array(textSchema(2_000)).max(100).optional(),
  summary: textSchema(20_000),
  chapters: z.array(z.object({
    id: idSchema,
    order: z.number().int().positive(),
    title: textSchema(500),
    stepIds: z.array(idSchema).min(1).max(MAX_STEPS),
  }).strict()).min(1).max(MAX_CHAPTERS),
  steps: z.array(z.object({
    id: idSchema,
    order: z.number().int().positive(),
    title: textSchema(500),
    explanation: textSchema(10_000),
    startSeconds: timestampSchema,
    endSeconds: timestampSchema,
    visualCues: z.array(visualCueSchema).min(1).max(150),
  }).strict()).min(1).max(MAX_STEPS),
}).strict()

export function parseYoutubeVideoAnalysis(value: unknown): YoutubeVideoAnalysis {
  const result = videoAnalysisSchema.safeParse(value)
  if (!result.success) throw new Error('YouTube video analysis is invalid.')
  const ids = new Set<string>()
  for (const step of result.data.steps) {
    if (ids.has(step.id) || step.startSeconds > step.endSeconds) {
      throw new Error('YouTube video analysis is invalid.')
    }
    ids.add(step.id)
  }
  return result.data
}

export function parseYoutubeManualPlan(value: unknown): YoutubeManualPlan {
  const result = manualPlanSchema.safeParse(value)
  if (!result.success) {
    throw invalidPlan(result.error.issues.map((issue) => describeSchemaIssue(issue, value)))
  }
  const plan = result.data
  const canonicalUrl = `https://www.youtube.com/watch?v=${plan.video.videoId}`
  const template = YOUTUBE_MANUAL_TEMPLATES[plan.templateId]
  const ids = new Set<string>()
  const failures: string[] = []
  let cueCount = 0
  if (plan.video.url !== canonicalUrl) {
    failures.push('video.url must be the canonical watch URL for video.videoId')
  }
  for (const [index, step] of plan.steps.entries()) {
    const at = `steps[${index}]`
    if (step.order !== index + 1) failures.push(`${at}.order must be ${index + 1}`)
    if (ids.has(step.id)) failures.push(`${at}.id must be unique across steps`)
    if (step.startSeconds > step.endSeconds) {
      failures.push(`${at}.startSeconds must not be after ${at}.endSeconds`)
    }
    if (step.endSeconds > plan.video.durationSeconds) {
      failures.push(`${at}.endSeconds must not exceed video.durationSeconds`)
    }
    if (!step.visualCues.some((cue) => cue.importance === 'required')) {
      failures.push(`${at}.visualCues must contain at least one cue with importance "required"`)
    }
    for (const [cueIndex, cue] of step.visualCues.entries()) {
      if (cue.timestampSeconds > plan.video.durationSeconds) {
        failures.push(
          `${at}.visualCues[${cueIndex}].timestampSeconds must not exceed video.durationSeconds`,
        )
      }
    }
    if (step.visualCues.length > template.maximumCuesPerStep) {
      failures.push(
        `${at}.visualCues must hold at most ${template.maximumCuesPerStep} cues for the ${plan.templateId} template`,
      )
    }
    ids.add(step.id)
    cueCount += step.visualCues.length
  }
  if (cueCount > MAX_CUES || cueCount > template.maximumFrames) {
    failures.push(
      `steps must hold at most ${Math.min(MAX_CUES, template.maximumFrames)} visual cues in total for the ${plan.templateId} template`,
    )
  }
  for (const [index, chapter] of plan.chapters.entries()) {
    if (chapter.order !== index + 1) failures.push(`chapters[${index}].order must be ${index + 1}`)
    if (chapter.stepIds.some((id) => !ids.has(id))) {
      failures.push(`chapters[${index}].stepIds must name ids declared in steps`)
    }
  }
  if (failures.length > 0) throw invalidPlan(failures)
  return plan as YoutubeManualPlan
}

/**
 * Name the fields and rules a rejected plan broke so the authoring agent can
 * repair it. Field paths and rules only: plan content never reaches the agent
 * through an error message.
 */
function invalidPlan(failures: readonly string[]): Error {
  const named = failures.slice(0, MAX_REPORTED_FAILURES)
  const remaining = failures.length - named.length
  return new Error([
    'YouTube manual plan is invalid:',
    `${named.join('; ')}${remaining > 0 ? `; and ${remaining} more` : ''}.`,
  ].join(' '))
}

function describeSchemaIssue(issue: z.core.$ZodIssue, value: unknown): string {
  const location = formatIssuePath(issue.path)
  if (issue.code === 'unrecognized_keys') {
    return `${location} has keys the plan schema does not define`
  }
  if (issue.code === 'invalid_type' && isMissingAtPath(value, issue.path)) {
    return `${location} is required`
  }
  return `${location} is invalid (${issue.message})`
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return 'the plan'
  return path.reduce<string>((formatted, key) =>
    typeof key === 'number'
      ? `${formatted}[${key}]`
      : formatted ? `${formatted}.${String(key)}` : String(key), '')
}

function isMissingAtPath(value: unknown, path: readonly PropertyKey[]): boolean {
  let current = value
  for (const key of path) {
    if (current === null || typeof current !== 'object') return true
    current = Reflect.get(current, key)
  }
  return current === undefined
}

export function composeYoutubeManualPlan(input: {
  readonly analysis: YoutubeVideoAnalysis
  readonly templateId: YoutubeManualTemplateId
  readonly video: YoutubeManualVideo
  readonly mode?: 'gemini' | 'transcript'
  readonly documentRequest?: import('../../contracts/youtube-document-request.js').YoutubeDocumentRequest
}): YoutubeManualPlan {
  const analysis = parseYoutubeVideoAnalysis(input.analysis)
  const template = YOUTUBE_MANUAL_TEMPLATES[input.templateId]
  const steps = analysis.steps.map((step, index) => ({
    id: step.id,
    order: index + 1,
    title: step.title,
    explanation: step.explanation,
    startSeconds: step.startSeconds,
    endSeconds: step.endSeconds,
    visualCues: selectCues(step.visualCandidates, template.maximumCuesPerStep),
  }))
  const requiredCues = steps.reduce((count, step) =>
    count + step.visualCues.filter((cue) => cue.importance === 'required').length, 0)
  if (requiredCues > template.maximumFrames) {
    throw new Error('YouTube manual plan is invalid.')
  }
  let remaining = template.maximumFrames - requiredCues
  const boundedSteps = steps.map((step) => ({
    ...step,
    visualCues: step.visualCues.filter((cue) => {
      if (cue.importance === 'required') return true
      if (remaining <= 0) return false
      remaining -= 1
      return true
    }),
  }))
  return parseYoutubeManualPlan({
    manualPlanSchemaVersion: YOUTUBE_MANUAL_PLAN_SCHEMA_VERSION,
    video: input.video,
    ...(input.documentRequest ? { documentRequest: input.documentRequest } : {}),
    templateId: input.templateId,
    ...(analysis.detectedSourceLanguage
      ? { sourceLanguage: analysis.detectedSourceLanguage }
      : {}),
    outputLanguage: analysis.outputLanguage,
    analysis: {
      mode: input.mode ?? (analysis.model ? 'gemini' : 'transcript'),
      ...(analysis.model ? { model: analysis.model } : {}),
      generatedAt: analysis.generatedAt,
      warnings: analysis.warnings ?? [],
    },
    ...(analysis.prerequisites?.length ? { prerequisites: analysis.prerequisites } : {}),
    summary: analysis.summary,
    chapters: [{
      id: 'instructions',
      order: 1,
      title: input.documentRequest?.purpose === 'takeaways' ? 'Key takeaways' : 'Instructions',
      stepIds: boundedSteps.map((step) => step.id),
    }],
    steps: boundedSteps,
  })
}

function selectCues(candidates: readonly YoutubeVisualCue[], maximum: number): YoutubeVisualCue[] {
  const required = candidates.filter((cue) => cue.importance === 'required')
  const supporting = candidates.filter((cue) => cue.importance === 'supporting')
  return [...required, ...supporting].slice(0, Math.max(maximum, required.length))
}

function isLanguageTag(value: string): boolean {
  try {
    return new Intl.Locale(value).toString().length > 0
  } catch {
    return false
  }
}
