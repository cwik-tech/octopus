import * as z from 'zod/v4'
import { whenDefined } from '../../core/optional-properties.js'
import { THINKING_REQUEST_VALUES } from '../thinking-levels.js'

const looseObject = (message: string) =>
  z.object({}, { error: message }).passthrough()

function requiredTrimmedString(
  field: string,
  maxLength = 512,
): z.ZodPipe<z.ZodString, z.ZodTransform<string, string>> {
  return z
    .string({ error: `Field ${field} is required` })
    .superRefine((value, context) => {
      if (!value.trim()) {
        context.addIssue({
          code: 'custom',
          message: `Field ${field} is required`,
        })
      } else if (value.length > maxLength) {
        context.addIssue({
          code: 'custom',
          message: `Field ${field} is too long`,
        })
      }
    })
    .transform((value) => value.trim())
}

const providerConfigSchema = looseObject(
  'Request body must be a JSON object',
).superRefine((value, context) => {
  for (const [key, entry] of Object.entries(value)) {
    if (
      (key !== 'max_tokens' && key !== 'temperature') ||
      typeof entry !== 'number' ||
      !Number.isFinite(entry)
    ) {
      context.addIssue({
        code: 'custom',
        message: `Field providerConfig.${key} is invalid`,
      })
      return
    }
  }
})

/**
 * The one application-wide default effort.
 *
 * The same closed vocabulary every other boundary uses, so a level this
 * application cannot express is refused where it arrives rather than stored and
 * discovered later by a turn that cannot honour it.
 */
export const defaultEffortRequestSchema = z
  .object(
    { effort: z.enum(THINKING_REQUEST_VALUES, { error: 'Field effort is invalid' }) },
    { error: 'Request body must be a JSON object' },
  )
  .strict()

export const defaultModelRequestSchema = z
  .object(
    {
      provider: requiredTrimmedString('provider'),
      model: requiredTrimmedString('model'),
    },
    { error: 'Request body must be a JSON object' },
  )
  .passthrough()

export const providerExecuteRequestSchema = z
  .object(
    {
      provider: requiredTrimmedString('provider'),
      thinking: z.enum(THINKING_REQUEST_VALUES, {
        error: 'Field thinking is invalid',
      }),
      systemPrompt: requiredTrimmedString('systemPrompt', 200_000),
      userMessage: requiredTrimmedString('userMessage', 800_000),
      model: requiredTrimmedString('model'),
      providerConfig: providerConfigSchema.optional(),
    },
    { error: 'Request body must be a JSON object' },
  )
  .passthrough()

export const providerConnectionRequestSchema = looseObject(
  'Request body must be a JSON object',
).pipe(
  z.object({
    id: z.string({ error: 'Field id must be a string' }).optional(),
    kind: z.enum(['openrouter', 'openai-compatible', 'ollama', 'lm-studio'], {
      error: 'Field kind is invalid',
    }),
    name: z.string({ error: 'Fields name and baseUrl are required' }),
    baseUrl: z.string({ error: 'Fields name and baseUrl are required' }),
    apiKey: z.string({ error: 'Field apiKey must be a string' }).optional(),
    enabled: z.boolean({ error: 'Field enabled must be a boolean' }),
    maxConcurrentRequests: z.number({
      error: 'Field maxConcurrentRequests must be an integer from 1 to 32',
    }).int().min(1).max(32).optional(),
  }),
)
.transform((body) => ({
  kind: body.kind,
  name: body.name,
  baseUrl: body.baseUrl,
  enabled: body.enabled,
  ...whenDefined(body.id, (id) => ({ id })),
  ...whenDefined(body.apiKey, (apiKey) => ({ apiKey })),
  ...whenDefined(body.maxConcurrentRequests, (maxConcurrentRequests) => ({
    maxConcurrentRequests,
  })),
}))

export const enabledRequestSchema = z
  .object(
    {
      enabled: z.boolean({ error: 'Field enabled must be a boolean' }),
    },
    { error: 'Request body must be a JSON object' },
  )
  .passthrough()

export const modelEnabledRequestSchema = looseObject(
  'Request body must be a JSON object',
)
  .superRefine((body, context) => {
    if (typeof body.modelId !== 'string' || typeof body.enabled !== 'boolean') {
      context.addIssue({
        code: 'custom',
        message: 'Fields modelId and enabled are required',
      })
    }
  })
  .transform((body) => ({
    modelId: body.modelId as string,
    enabled: body.enabled as boolean,
  }))

export const browserModeRequestSchema = z
  .object(
    {
      mode: z.enum(['headed', 'headless'], {
        error: 'Browser mode is invalid',
      }),
    },
    { error: 'Browser mode is invalid' },
  )
  .passthrough()

export const youtubeSettingsUpdateRequestSchema = looseObject(
  'YouTube settings request must be an object.',
)
  .superRefine((input, context) => {
    if (
      typeof input.proxyEnabled !== 'boolean' ||
      (input.credentialMode !== 'api-token' &&
        input.credentialMode !== 'username-password') ||
      typeof input.proxyHost !== 'string' ||
      !Number.isSafeInteger(input.proxyPort) ||
      !Array.isArray(input.countries) ||
      input.countries.some((country) => typeof country !== 'string') ||
      typeof input.username !== 'string' ||
      (input.apiToken !== undefined && typeof input.apiToken !== 'string') ||
      (input.password !== undefined && typeof input.password !== 'string') ||
      (input.clearApiToken !== undefined &&
        typeof input.clearApiToken !== 'boolean') ||
      (input.clearPassword !== undefined &&
        typeof input.clearPassword !== 'boolean') ||
      (input.geminiApiKey !== undefined && typeof input.geminiApiKey !== 'string') ||
      (input.clearGeminiApiKey !== undefined &&
        typeof input.clearGeminiApiKey !== 'boolean') ||
      (input.geminiModel !== undefined && typeof input.geminiModel !== 'string') ||
      (input.geminiDailyVideoMinutesLimit !== undefined &&
        !Number.isSafeInteger(input.geminiDailyVideoMinutesLimit)) ||
      (input.geminiConfirmationThresholdMinutes !== undefined &&
        !Number.isSafeInteger(input.geminiConfirmationThresholdMinutes)) ||
      (input.deleteVideosAfterInfoExtraction !== undefined &&
        typeof input.deleteVideosAfterInfoExtraction !== 'boolean')
    ) {
      context.addIssue({
        code: 'custom',
        message: 'YouTube settings request is invalid.',
      })
    }
  })
  .transform((input) => ({
    proxyEnabled: input.proxyEnabled as boolean,
    credentialMode: input.credentialMode as
      | 'api-token'
      | 'username-password',
    proxyHost: input.proxyHost as string,
    proxyPort: input.proxyPort as number,
    countries: input.countries as string[],
    username: input.username as string,
    ...(typeof input.apiToken === 'string'
      ? { apiToken: input.apiToken }
      : {}),
    ...(typeof input.password === 'string'
      ? { password: input.password }
      : {}),
    ...(input.clearApiToken === true ? { clearApiToken: true as const } : {}),
    ...(input.clearPassword === true ? { clearPassword: true as const } : {}),
    ...(typeof input.geminiApiKey === 'string'
      ? { geminiApiKey: input.geminiApiKey }
      : {}),
    ...(input.clearGeminiApiKey === true
      ? { clearGeminiApiKey: true as const }
      : {}),
    ...(typeof input.geminiModel === 'string'
      ? { geminiModel: input.geminiModel }
      : {}),
    ...(typeof input.geminiDailyVideoMinutesLimit === 'number'
      ? { geminiDailyVideoMinutesLimit: input.geminiDailyVideoMinutesLimit }
      : {}),
    ...(typeof input.geminiConfirmationThresholdMinutes === 'number'
      ? { geminiConfirmationThresholdMinutes: input.geminiConfirmationThresholdMinutes }
      : {}),
    ...(typeof input.deleteVideosAfterInfoExtraction === 'boolean'
      ? { deleteVideosAfterInfoExtraction: input.deleteVideosAfterInfoExtraction }
      : {}),
  }))

export const youtubeGeminiCandidateValidationRequestSchema = z.object({
  apiKey: requiredTrimmedString('apiKey', 512),
  model: requiredTrimmedString('model', 120),
}, { error: 'Gemini validation request must be an object.' }).strict()

export const deepResearchSettingsPatchRequestSchema = looseObject(
  'Request body must be a JSON object.',
)
  .superRefine((body, context) => {
    const keys = Object.keys(body).sort()
    if (
      keys.length !== 2 ||
      keys[0] !== 'maxDurationMinutes' ||
      keys[1] !== 'maxResearcherAgents'
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Request body must contain only maxDurationMinutes and maxResearcherAgents.',
      })
      return
    }
    if (
      !Number.isInteger(body.maxDurationMinutes) ||
      (body.maxDurationMinutes as number) < 5 ||
      (body.maxDurationMinutes as number) > 120
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Maximum research duration must be an integer from 5 through 120 minutes.',
      })
      return
    }
    if (
      !Number.isInteger(body.maxResearcherAgents) ||
      (body.maxResearcherAgents as number) < 1 ||
      (body.maxResearcherAgents as number) > 8
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Maximum researcher agents must be an integer from 1 through 8.',
      })
    }
  })
  .transform((body) => ({
    maxDurationMinutes: body.maxDurationMinutes as number,
    maxResearcherAgents: body.maxResearcherAgents as number,
  }))

export const schedulingSettingsPatchRequestSchema = looseObject(
  'Request body must be a JSON object.',
)
  .superRefine((body, context) => {
    const keys = Object.keys(body)
    if (keys.length !== 1 || keys[0] !== 'maximumConcurrentTasks') {
      context.addIssue({
        code: 'custom',
        message: 'Request body must contain only maximumConcurrentTasks.',
      })
      return
    }
    if (
      !Number.isInteger(body.maximumConcurrentTasks) ||
      (body.maximumConcurrentTasks as number) < 1 ||
      (body.maximumConcurrentTasks as number) > 64
    ) {
      context.addIssue({
        code: 'custom',
        message:
          'Maximum concurrent tasks must be an integer from 1 through 64.',
      })
    }
  })
  .transform((body) => body.maximumConcurrentTasks as number)
