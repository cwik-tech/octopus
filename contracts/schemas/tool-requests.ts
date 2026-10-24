import * as z from 'zod/v4'
import { whenDefined } from '../../core/optional-properties.js'
import { agentQuestionContextSchema, agentQuestionOutputSchema } from '../agent-questions.js'
import { THINKING_REQUEST_VALUES } from '../thinking-levels.js'

const MAX_IDENTIFIER_LENGTH = 512
const MAX_PROVIDER_LENGTH = 256
const MAX_MODEL_LENGTH = 512
const MAX_PROMPT_BYTES = 2 * 1_024 * 1_024

const youtubeActionSchema = z.enum([
  'inspect',
  'capture',
  'resume',
  'capture_authenticated',
  'read_transcript',
  'write_methodology',
  'write_consolidation',
])

export const youtubeToolInputRequestSchema = z
  .object({
    action: youtubeActionSchema,
    url: z.string().optional(),
    languages: z.array(z.string()).max(10).optional(),
    limit: safeInteger(1, 500).optional(),
    all: z.boolean().optional(),
    includeShorts: z.boolean().optional(),
    minDurationSeconds: safeInteger(0, 86_400).optional(),
    videoId: z.string().optional(),
    chunkIndex: safeInteger(0).optional(),
    content: z.string().max(250_000).optional(),
    fileName: z.string().max(180).optional(),
  })
  .strict()

export const browserToolInputRequestSchema = z
  .object({
    action: z.enum([
      'open',
      'observe',
      'navigate',
      'go_back',
      'click',
      'type',
      'select',
      'press',
      'scroll',
      'wait',
      'read_content',
      'search_content',
      'screenshot',
      'download',
      'close',
    ]),
    pageId: z.string().optional(),
    url: z.string().optional(),
    ref: z.string().optional(),
    text: z.string().optional(),
    value: z.string().optional(),
    key: z.string().optional(),
    direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
    amount: safeInteger(1, 10_000).optional(),
    waitFor: z
      .enum(['delay', 'text', 'url', 'element', 'change', 'network_idle'])
      .optional(),
    query: z.string().optional(),
    snapshotId: z.string().optional(),
    contentId: z.string().optional(),
    chunkIndex: safeInteger(0).optional(),
    waitMs: safeInteger(100, 600_000).optional(),
    timeoutMs: safeInteger(100, 600_000).optional(),
  })
  .strict()

export const researchWebToolInputRequestSchema = z
  .object({
    action: z.enum([
      'search',
      'acquire',
      'extract',
      'read_content',
      'search_content',
    ]),
    query: z.string().max(2_000).optional(),
    url: z.string().max(8_192).optional(),
    contentId: z.string().max(256).optional(),
    chunkIndex: safeInteger(0).optional(),
    searchText: z.string().max(1_000).optional(),
    schema: z.record(z.string(), z.unknown()).optional(),
    requiredFields: z.array(z.string().max(512)).max(100).optional(),
    mode: z.enum(['best-effort', 'strict']).optional(),
    extractionInstructions: z.string().max(4_000).optional(),
    maximumResults: safeInteger(1, 20).optional(),
    includeDomains: z.array(z.string().max(253)).max(20).optional(),
    excludeDomains: z.array(z.string().max(253)).max(20).optional(),
    publishedAfter: z.string().max(64).optional(),
    publishedBefore: z.string().max(64).optional(),
    sourceValue: z
      .enum(['replaceable', 'important', 'unique-primary'])
      .optional(),
    allowBrowserFallback: z.boolean().optional(),
    allowManagedReaderFallback: z.boolean().optional(),
  })
  .strict()

export const runtimeCapabilityActivityScopeSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .refine((value) => !/[\0-\x1f\x7f]/.test(value))

export const generateWordToolInputRequestSchema = z
  .object({
    action: z.enum(['list_profiles', 'generate']),
    inputPath: z.string().optional(),
    markdown: z.string().max(10 * 1_024 * 1_024).optional(),
    outputPath: z.string().optional(),
    profile: z.string().optional(),
    tableOfContents: z.boolean().optional(),
    renderMermaid: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action === 'generate') {
      const hasInputPath = boundedNonBlankPath(input.inputPath)
      const hasMarkdown = typeof input.markdown === 'string' && Boolean(input.markdown.trim())
      if (hasInputPath === hasMarkdown) {
        addInvalidIssue(context)
      }
      if (!boundedNonBlankPath(input.outputPath)) {
        addInvalidIssue(context)
      }
      return
    }
    if (
      input.inputPath !== undefined ||
      input.markdown !== undefined ||
      input.outputPath !== undefined ||
      input.profile !== undefined ||
      input.tableOfContents !== undefined ||
      input.renderMermaid !== undefined
    ) {
      addInvalidIssue(context)
    }
  })

export const generateExcelToolInputRequestSchema = z
  .object({
    action: z.enum([
      'list_profiles',
      'list_templates',
      'generate',
      'fill_template',
    ]),
    inputPath: z.string().optional(),
    outputPath: z.string().optional(),
    profile: z.string().optional(),
    template: z.string().optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action === 'generate' || input.action === 'fill_template') {
      if (!boundedNonBlankPath(input.inputPath)) {
        addInvalidIssue(context)
      }
      if (!boundedNonBlankPath(input.outputPath)) {
        addInvalidIssue(context)
      }
      if (input.action === 'generate' && input.template !== undefined) {
        addInvalidIssue(context)
      }
      if (
        input.action === 'fill_template' &&
        (
          typeof input.template !== 'string' ||
          !input.template.trim() ||
          input.template.length > 128 ||
          input.profile !== undefined
        )
      ) {
        addInvalidIssue(context)
      }
      return
    }
    if (
      input.inputPath !== undefined ||
      input.outputPath !== undefined ||
      input.profile !== undefined ||
      input.template !== undefined
    ) {
      addInvalidIssue(context)
    }
  })

export function createBrokerToolRequestSchema<
  const RuntimeContractVersion extends number,
  const ToolContractVersion extends number,
  InputSchema extends z.ZodType,
>(params: {
  readonly runtimeContractVersion: RuntimeContractVersion
  readonly toolContractVersion: ToolContractVersion
  readonly inputSchema: InputSchema
  readonly normalizeAgentPath: (value: string) => string | null
}) {
  const identifierSchema = z
    .string()
    .min(1)
    .max(MAX_IDENTIFIER_LENGTH)
    .refine((value) => !/[\0-\x1f\x7f]/.test(value))
  const contextSchema = z.object({
    contractVersion: z.literal(params.runtimeContractVersion),
    requestId: identifierSchema,
    leaseId: identifierSchema,
    sessionId: identifierSchema,
    runId: identifierSchema,
    assignmentId: identifierSchema,
    taskId: identifierSchema,
    processIdentity: identifierSchema,
    workflowId: identifierSchema.optional(),
    workflowStepId: identifierSchema.optional(),
    agentPath: normalizedAgentPathSchema(params.normalizeAgentPath),
    agentId: identifierSchema.optional(),
    agentDisplayName: identifierSchema.optional(),
    activityScopeId: identifierSchema.optional(),
  }).transform((context) => ({
    contractVersion: context.contractVersion,
    requestId: context.requestId,
    leaseId: context.leaseId,
    sessionId: context.sessionId,
    runId: context.runId,
    assignmentId: context.assignmentId,
    taskId: context.taskId,
    processIdentity: context.processIdentity,
    agentPath: context.agentPath,
    ...whenDefined(context.workflowId, (workflowId) => ({ workflowId })),
    ...whenDefined(context.workflowStepId, (workflowStepId) => ({ workflowStepId })),
    ...whenDefined(context.agentId, (agentId) => ({ agentId })),
    ...whenDefined(context.agentDisplayName, (agentDisplayName) => ({ agentDisplayName })),
    ...whenDefined(context.activityScopeId, (activityScopeId) => ({ activityScopeId })),
  }))

  // Zod objects strip unknown keys by default. That matches the existing
  // permissive envelopes, which accept but do not forward unknown fields.
  return z.object({
    version: z.literal(params.toolContractVersion),
    context: contextSchema,
    toolCallId: z
      .string()
      .max(256)
      .refine((value) => Boolean(value.trim())),
    input: params.inputSchema,
  })
}

export function createMcpWorkerTurnRequestSchema<
  const ContractVersion extends number,
>(params: {
  readonly contractVersion: ContractVersion
  readonly isSessionId: (value: string) => boolean
  readonly isSafePathSegment: (value: string) => boolean
  readonly normalizeAgentPath: (value: string) => string | null
  readonly utf8ByteLength: (value: string) => number
  /**
   * The behavioural settings a child may name, injected rather than imported.
   *
   * Contracts do not reach outward into provider modules, and the vocabulary is
   * owned by the adapters that read it — so the caller that knows both supplies
   * it here. A name outside this set is refused whole: the point of the closed
   * boundary is that an unrecognised setting is a request to do something this
   * field is not for, not something to ignore quietly.
   */
  readonly behaviouralProviderOptions: ReadonlySet<string>
}) {
  const safeSegmentSchema = z
    .string()
    .min(1)
    .max(512)
    .refine((value) => value.trim() === value)
    .refine(params.isSafePathSegment)
  const boundedIdentifierSchema = (maxLength: number) =>
    z
      .string()
      .min(1)
      .max(maxLength)
      .refine((value) => value.trim() === value)
      .refine((value) => !/[\0-\x1f\x7f]/.test(value))
  const promptSchema = z.string().refine(
    (value) => params.utf8ByteLength(value) <= MAX_PROMPT_BYTES,
  )

  return z
    .object({
      version: z.literal(params.contractVersion),
      sessionId: z
        .string()
        .min(1)
        .refine((value) => value.trim() === value)
        .refine(params.isSessionId),
      runId: safeSegmentSchema,
      assignmentId: safeSegmentSchema,
      activityScopeId: safeSegmentSchema.optional(),
      agentDisplayName: boundedIdentifierSchema(256).optional(),
      taskId: safeSegmentSchema,
      processIdentity: safeSegmentSchema,
      workflowId: safeSegmentSchema,
      workflowStepId: safeSegmentSchema,
      agentPath: normalizedAgentPathSchema(params.normalizeAgentPath),
      provider: boundedIdentifierSchema(MAX_PROVIDER_LENGTH),
      model: boundedIdentifierSchema(MAX_MODEL_LENGTH),
      thinking: z.enum(THINKING_REQUEST_VALUES),
      governedWebEvidenceMode: z
        .enum(['acquire', 'reuse-existing'])
        .optional(),
      // Scalars only, by name only. `providerConfig` stays refused by
      // `.strict()`: it carries endpoints, headers and process permissions, and
      // `domains/mcp/mcp-provider-tool-target.ts` honours a `base_url` using
      // the *parent's* credentials.
      //
      // Checked over the raw value rather than through `z.record`, because the
      // installed Zod drops `__proto__` from a record before any refinement can
      // see it — so a check written over the parsed value would accept a
      // request as though that key had never been sent, while the other parser
      // refuses it. A closed boundary that disagrees with itself is not closed.
      providerOptions: z
        .unknown()
        .superRefine((value, ctx) => {
          // The raw keys, before the record normalizes them away. The installed
          // Zod drops `__proto__` from a record, so a name check written after
          // parsing would accept a request as though that key had never been
          // sent — while `parseMcpWorkerTurnRequest` refuses it. A closed
          // boundary that disagrees with itself is not closed.
          if (
            typeof value !== 'object' ||
            value === null ||
            Array.isArray(value) ||
            Object.getOwnPropertyNames(value).some(
              (key) => !params.behaviouralProviderOptions.has(key),
            )
          ) {
            ctx.addIssue({ code: 'custom', message: 'invalid provider options' })
          }
        })
        .pipe(
          // The values, checked and rebuilt by the record itself rather than
          // by a second hand-written scalar test.
          z.record(
            z.string(),
            z.union([z.string(), z.number(), z.boolean()]),
          ),
        )
        .optional(),
      systemPrompt: promptSchema,
      userMessage: promptSchema,
      questionContext: agentQuestionContextSchema.optional(),
      questionOutputSchema: agentQuestionOutputSchema.optional(),
    })
    .strict()
    .refine((request) => request.questionOutputSchema === undefined || request.questionContext !== undefined,
      { message: 'A question output schema requires a resumable invocation.' })
    .transform((request) => ({
      version: request.version,
      sessionId: request.sessionId,
      runId: request.runId,
      assignmentId: request.assignmentId,
      taskId: request.taskId,
      processIdentity: request.processIdentity,
      workflowId: request.workflowId,
      workflowStepId: request.workflowStepId,
      agentPath: request.agentPath,
      provider: request.provider,
      model: request.model,
      thinking: request.thinking,
      ...whenDefined(
        request.governedWebEvidenceMode,
        (governedWebEvidenceMode) => ({ governedWebEvidenceMode }),
      ),
      // An empty map is nothing to carry, and is reported as absent so both
      // parsers describe such a request the same way.
      ...whenDefined(
        request.providerOptions !== undefined &&
          Object.keys(request.providerOptions).length > 0
          ? request.providerOptions
          : undefined,
        (providerOptions) => ({ providerOptions }),
      ),
      systemPrompt: request.systemPrompt,
      userMessage: request.userMessage,
      ...whenDefined(request.questionContext, (questionContext) => ({ questionContext })),
      ...whenDefined(request.questionOutputSchema, (questionOutputSchema) => ({ questionOutputSchema })),
      ...whenDefined(request.activityScopeId, (activityScopeId) => ({ activityScopeId })),
      ...whenDefined(request.agentDisplayName, (agentDisplayName) => ({ agentDisplayName })),
    }))
}

function safeInteger(minimum: number, maximum?: number) {
  let schema = z
    .number()
    .refine((value) => Number.isSafeInteger(value))
    .refine((value) => value >= minimum)
  if (maximum !== undefined) {
    schema = schema.refine((value) => value <= maximum)
  }
  return schema
}

function boundedNonBlankPath(value: string | undefined): boolean {
  return (
    typeof value === 'string' &&
    Boolean(value.trim()) &&
    value.length <= 512
  )
}

function normalizedAgentPathSchema(
  normalize: (value: string) => string | null,
) {
  return z.string().transform((value, context) => {
    const normalized = normalize(value)
    if (!normalized) {
      context.addIssue({ code: 'custom', message: 'Agent path is invalid' })
      return z.NEVER
    }
    return normalized
  })
}

function addInvalidIssue(context: z.RefinementCtx): void {
  context.addIssue({ code: 'custom', message: 'Tool input is invalid' })
}
