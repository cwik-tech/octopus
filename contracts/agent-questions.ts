import { z } from 'zod'
import { canonicalizeJson } from './canonical-json.js'
import { PROVIDER_DEFAULT_THINKING, THINKING_LEVELS } from './thinking-levels.js'

/**
 * Execution ceilings for an agent turn that runs the native provider loop.
 *
 * The loop applies them per invocation (`domains/provider/provider-tool-loop.ts`).
 * A question spends them cumulatively instead: the saved evidence carries what
 * the asking turn already used and the continuation is granted only the
 * remainder (`core/agent-question-clock.ts`), so both halves of one question
 * share a single allowance rather than each getting a fresh one.
 */
export const MAX_PROVIDER_ROUNDS = 8
export const MAX_TOOL_CALLS = 32

export const MAX_AGENT_QUESTIONS_PER_ROUND = 5
export const MAX_AGENT_QUESTION_CHARACTERS = 2_000
export const MAX_AGENT_QUESTION_PROGRESS_CHARACTERS = 8_000

export const agentQuestionClockSchema = z.object({
  startTime: z.number().finite().nonnegative(),
  questionPausedAt: z.number().finite().nonnegative().optional(),
})
export type AgentQuestionClock = z.infer<typeof agentQuestionClockSchema>

const questionTextSchema = z.string().trim().min(1).max(MAX_AGENT_QUESTION_CHARACTERS)

export const agentQuestionRequestSchema = z.object({
  progress: z.string().trim().min(1).max(MAX_AGENT_QUESTION_PROGRESS_CHARACTERS),
  questions: z.array(z.object({
    question: questionTextSchema,
    reason: questionTextSchema,
  }).strict()).min(1).max(MAX_AGENT_QUESTIONS_PER_ROUND),
}).strict()

export const agentQuestionRoundSchema = z.object({
  rootRunId: z.string().min(1),
  agentId: z.string().min(1),
  logicalInvocationId: z.string().min(1),
  requestDigest: z.string().regex(/^[a-f0-9]{64}$/),
  interactionId: z.string().min(1),
}).strict()

export const agentQuestionRoundDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('allow') }).strict(),
  z.object({ kind: z.literal('replay'), interactionId: z.string().min(1) }).strict(),
  z.object({ kind: z.literal('rejected'), code: z.literal('question_limit_reached') }).strict(),
])

export const agentQuestionWaitSchema = z.object({
  kind: z.literal('awaiting_input'),
  interactionId: z.string().min(1),
}).strict()

export const agentQuestionBlockCodeSchema = z.enum(['question_limit_reached', 'continuation_indeterminate', 'continuation_unavailable'])
export const agentQuestionBlockSchema = z.object({
  kind: z.literal('blocked'), code: agentQuestionBlockCodeSchema,
}).strict()

export const agentQuestionInterruptionSchema = z.discriminatedUnion('kind', [agentQuestionWaitSchema, agentQuestionBlockSchema])
export const agentQuestionTurnOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('awaiting_input'), interruption: agentQuestionWaitSchema }).strict(),
  z.object({ kind: z.literal('blocked'), interruption: agentQuestionBlockSchema }).strict(),
])
export type AgentQuestionTurnOutcome = z.infer<typeof agentQuestionTurnOutcomeSchema>

export type AgentQuestionRequest = z.infer<typeof agentQuestionRequestSchema>
export type AgentQuestionRound = z.infer<typeof agentQuestionRoundSchema>
export type AgentQuestionRoundDecision = z.infer<typeof agentQuestionRoundDecisionSchema>
export type AgentQuestionInterruption = z.infer<typeof agentQuestionInterruptionSchema>

const identifierSchema = z.string().min(1).max(256)
const digestSchema = z.string().regex(/^[a-f0-9]{64}$/)
export const agentQuestionInvocationSchema = z.object({
  agentId: identifierSchema,
  agentDisplayName: z.string().min(1).max(256),
  logicalInvocationId: identifierSchema,
  dispatchId: identifierSchema,
  childRunId: identifierSchema,
  workflowChildRunId: identifierSchema.optional(),
  teamId: identifierSchema,
  stageId: identifierSchema,
  definitionHash: digestSchema,
  timeoutMs: z.number().int().positive().max(86_400_000).optional(),
}).strict()

export const agentQuestionContextSchema = agentQuestionInvocationSchema.pick({
  logicalInvocationId: true, dispatchId: true, teamId: true, stageId: true, timeoutMs: true,
})
export type AgentQuestionContext = z.infer<typeof agentQuestionContextSchema>

/** Provider schema metadata is JSON data, bounded at the worker boundary. */
export const agentQuestionOutputSchema = z.record(z.string(), z.json()).refine((schema) =>
  schema.type === 'object' && JSON.stringify(schema).length <= 262_144,
)
export type AgentQuestionOutputSchema = z.infer<typeof agentQuestionOutputSchema>

export const agentQuestionToolResultSchema = z.object({
    capabilityId: identifierSchema, arguments: z.record(z.string(), z.json()),
    content: z.string().max(524_288), isError: z.boolean(),
}).strict()
export const agentQuestionContinuationEvidenceSchema = z.object({
  completedTools: z.array(agentQuestionToolResultSchema).max(MAX_TOOL_CALLS),
  activeDurationMs: z.number().finite().nonnegative(),
  providerRounds: z.number().int().nonnegative().max(MAX_PROVIDER_ROUNDS),
  toolCalls: z.number().int().nonnegative().max(MAX_TOOL_CALLS),
}).strict().refine((evidence) => JSON.stringify(evidence).length <= 2_000_000)
export type AgentQuestionContinuationEvidence = z.infer<typeof agentQuestionContinuationEvidenceSchema>

export const agentQuestionContinuationSchema = z.object({
  systemPrompt: z.string().min(1).max(2_000_000),
  userMessage: z.string().min(1).max(2_000_000),
  provider: identifierSchema,
  model: identifierSchema,
  // The whole effort vocabulary, not a copy of part of it. A question asked by
  // an agent running at a widened level has to be savable, and
  // `provider-default` has to come back as itself rather than as some level
  // nobody chose.
  thinking: z.enum([...THINKING_LEVELS, PROVIDER_DEFAULT_THINKING]),
  providerOptions: z.record(z.string().max(128), z.union([z.string().max(8_000), z.number().finite(), z.boolean()])).optional(),
  outputSchema: agentQuestionOutputSchema.optional(),
  evidence: agentQuestionContinuationEvidenceSchema.optional(),
}).strict()

/** The most bytes one saved question content file holds: its canonical JSON as UTF-8. */
export const MAX_AGENT_QUESTION_CONTENT_BYTES = 8_000_000

/**
 * Whether a value's canonical JSON fits in one saved content file.
 *
 * The continuation and result schemas admit more than that (two 2,000,000
 * character prompts, a 4,000,000 character result, provider options with no
 * entry limit), so the operations that save them refuse an oversized value as
 * input, before anything is written. A value the canonical form refuses for
 * another reason passes here and is reported where it is saved, as before.
 */
function fitsSavedQuestionContent(value: unknown): boolean {
  let text: string
  try {
    text = canonicalizeJson(value)
  } catch {
    return true
  }
  return new TextEncoder().encode(text).byteLength <= MAX_AGENT_QUESTION_CONTENT_BYTES
}
const SAVED_QUESTION_CONTENT_LIMIT = { message: 'A saved question content must fit in 8,000,000 bytes.' }

export const agentQuestionContentReferenceSchema = z.object({
  sha256: digestSchema,
  byteLength: z.number().int().nonnegative().max(MAX_AGENT_QUESTION_CONTENT_BYTES),
}).strict()

const agentQuestionInteractionBaseSchema = z.object({
  schemaVersion: z.literal(1),
  interactionId: identifierSchema,
  revision: z.number().int().nonnegative(),
  rootRunId: identifierSchema,
  taskId: identifierSchema,
  sessionId: identifierSchema,
  workflowId: identifierSchema,
  stepId: identifierSchema,
  ownerExecutionAttemptId: identifierSchema,
  invocation: agentQuestionInvocationSchema,
  requestDigest: digestSchema,
  requestContent: agentQuestionContentReferenceSchema,
  continuationContent: agentQuestionContentReferenceSchema,
  requestedAt: z.iso.datetime(),
  questionIds: z.array(identifierSchema).min(1).max(MAX_AGENT_QUESTIONS_PER_ROUND),
}).strict()

const submittedAgentQuestionSchema = agentQuestionInteractionBaseSchema.extend({
  submission: z.object({
      submissionId: identifierSchema, answerDigest: digestSchema,
      answerContent: agentQuestionContentReferenceSchema, submittedAt: z.iso.datetime(),
  }).strict(),
})

const resumingAgentQuestionSchema = submittedAgentQuestionSchema.extend({
  continuation: z.object({
    admissionRequestId: identifierSchema, executionAttemptId: identifierSchema,
    startedAt: z.iso.datetime(),
    providerStartedAt: z.iso.datetime().optional(),
  }).strict(),
})

export const agentQuestionResultSchema = z.object({
  text: z.string().trim().min(1).max(4_000_000),
  model: identifierSchema.optional(),
  toolCallCount: z.number().int().nonnegative(),
  executedToolCallCount: z.number().int().nonnegative(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative(),
  }).strict().refine((usage) => usage.inputTokens + usage.outputTokens === usage.totalTokens),
}).strict()
export type AgentQuestionResult = z.infer<typeof agentQuestionResultSchema>

export const resolveAgentQuestionSchema = z.object({
  executionAttemptId: identifierSchema, interactionId: identifierSchema,
  agentId: identifierSchema, logicalInvocationId: identifierSchema,
  result: agentQuestionResultSchema.refine(fitsSavedQuestionContent, SAVED_QUESTION_CONTENT_LIMIT),
}).strict()

export const beginAgentQuestionProviderSchema = resolveAgentQuestionSchema.omit({ result: true })

export const agentQuestionInteractionSchema = z.discriminatedUnion('status', [
  agentQuestionInteractionBaseSchema.extend({ status: z.literal('pending') }),
  submittedAgentQuestionSchema.extend({ status: z.literal('submitted') }),
  resumingAgentQuestionSchema.extend({ status: z.literal('resuming') }),
  resumingAgentQuestionSchema.extend({
    status: z.literal('resolved'), resultContent: agentQuestionContentReferenceSchema,
    resolvedAt: z.iso.datetime(),
    /**
     * Set when this agent asked again after its one round was answered. The
     * answered round stays `resolved` so the conversation keeps it, and the
     * refusal rides along so a recovered run still refuses it rather than
     * buying another provider turn.
     */
    blockCode: agentQuestionBlockCodeSchema.optional(), blockedAt: z.iso.datetime().optional(),
  }),
  agentQuestionInteractionBaseSchema.extend({
    status: z.literal('blocked'), blockedAt: z.iso.datetime(), blockCode: agentQuestionBlockCodeSchema,
    submission: submittedAgentQuestionSchema.shape.submission.optional(),
    continuation: resumingAgentQuestionSchema.shape.continuation.optional(),
    resultContent: agentQuestionContentReferenceSchema.optional(), resolvedAt: z.iso.datetime().optional(),
  }),
  agentQuestionInteractionBaseSchema.extend({
    status: z.literal('cancelled'), cancelledAt: z.iso.datetime(), cancellationReason: z.string().min(1).max(2_000),
    submission: submittedAgentQuestionSchema.shape.submission.optional(),
    continuation: resumingAgentQuestionSchema.shape.continuation.optional(),
  }),
])

export const claimAgentQuestionContinuationSchema = z.object({
  interactionId: identifierSchema, submissionId: identifierSchema,
  expectedOwnerExecutionAttemptId: identifierSchema, nextExecutionAttemptId: identifierSchema,
  continuationAdmissionRequestId: identifierSchema,
}).strict()

export const MAX_AGENT_ANSWER_CHARACTERS = 8_000
export const MAX_AGENT_ANSWERS_TOTAL_CHARACTERS = 32_000
export const agentQuestionAnswersSchema = z.unknown().superRefine((value, context) => {
  // Zod normalizes records; reject dangerous raw keys before that can hide one.
  if (typeof value === 'object' && value !== null &&
      Object.getOwnPropertyNames(value).some((key) => ['__proto__', 'prototype', 'constructor'].includes(key))) {
    context.addIssue({ code: 'custom', message: 'Invalid question identifier.' })
  }
}).pipe(z.record(identifierSchema,
  z.string().trim().min(1).max(MAX_AGENT_ANSWER_CHARACTERS),
).refine((answers) =>
  Object.keys(answers).length > 0 && Object.keys(answers).length <= MAX_AGENT_QUESTIONS_PER_ROUND &&
  Object.values(answers).reduce((total, answer) => total + answer.length, 0) <= MAX_AGENT_ANSWERS_TOTAL_CHARACTERS,
))

export const submitAgentInputSchema = z.object({
  taskId: identifierSchema, sessionId: identifierSchema, interactionId: identifierSchema,
  expectedInteractionRevision: z.number().int().nonnegative(), expectedRequestDigest: digestSchema,
  submissionId: identifierSchema, answers: agentQuestionAnswersSchema,
}).strict()

export const agentQuestionsStateSchema = z.object({
  schemaVersion: z.literal(1),
  interactions: z.array(agentQuestionInteractionSchema),
}).strict()

export const requestAgentInputSchema = z.object({
  executionAttemptId: identifierSchema,
  stepId: identifierSchema,
  invocation: agentQuestionInvocationSchema,
  request: agentQuestionRequestSchema,
  continuation: agentQuestionContinuationSchema.refine(fitsSavedQuestionContent, SAVED_QUESTION_CONTENT_LIMIT),
}).strict()

export const pauseAgentQuestionSchema = z.object({
  executionAttemptId: identifierSchema, interactionId: identifierSchema,
}).strict()

export type AgentQuestionContentReference = z.infer<typeof agentQuestionContentReferenceSchema>
export type AgentQuestionInteraction = z.infer<typeof agentQuestionInteractionSchema>
export type AgentQuestionsState = z.infer<typeof agentQuestionsStateSchema>
export type RequestAgentInput = z.infer<typeof requestAgentInputSchema>

/** Display projection deliberately excludes original prompts and private content references. */
export const agentQuestionViewSchema = agentQuestionInteractionBaseSchema.pick({
  interactionId: true, revision: true, taskId: true, sessionId: true,
  requestDigest: true, requestedAt: true, questionIds: true,
}).extend({
  agentId: identifierSchema, agentDisplayName: z.string().min(1).max(256),
  dispatchId: identifierSchema, childRunId: identifierSchema,
  status: z.enum(['pending', 'submitted', 'resuming', 'resolved', 'blocked', 'cancelled']),
  blockCode: agentQuestionBlockCodeSchema.optional(),
  cancellationReason: z.string().optional(),
  canSubmit: z.boolean(),
  request: agentQuestionRequestSchema,
  answers: agentQuestionAnswersSchema.optional(),
}).strict()
export const agentQuestionViewsSchema = z.array(agentQuestionViewSchema)
export type AgentQuestionView = z.infer<typeof agentQuestionViewSchema>

export const blockAgentQuestionsSchema = z.object({
  executionAttemptId: identifierSchema, agentId: identifierSchema, code: agentQuestionBlockCodeSchema,
}).strict()
