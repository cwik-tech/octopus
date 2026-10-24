/**
 * The voice-control contract shared by Octopus and the voice layer (Hexa
 * Puffs). A copy of this file lives in each repository until a third app joins
 * (docs/feature-voice-control-mcp.md, D2); `contract` is the version check.
 *
 * Two MCP links: each app serves its own tools to the voice layer, and the
 * voice layer serves the fixed tools below to each app.
 */
import * as z from 'zod/v4'

export const VOICE_CONTROL_CONTRACT = 'voice-control/1'

/** Lowercase kebab-case, so an id can name a file without leaving its folder. */
const appIdSchema = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { error: 'appId must be lowercase kebab-case' })
  .max(64)

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]'])

/**
 * A descriptor names where a participant's server is. It is not proof that the
 * participant is trusted, so a reader accepts only plain HTTP on loopback with
 * no credentials in the URL. Anything else could point a reader's bearer token
 * at another machine.
 */
export function isLoopbackMcpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return (
    url.protocol === 'http:' &&
    url.username === '' &&
    url.password === '' &&
    LOOPBACK_HOSTNAMES.has(url.hostname)
  )
}

export const voiceControlDescriptorSchema = z.object({
  contract: z.literal(VOICE_CONTROL_CONTRACT),
  appId: appIdSchema,
  name: z.string().min(1).max(128),
  role: z.enum(['app', 'voice']),
  pid: z.number().int().positive(),
  mcp: z.object({
    type: z.literal('http'),
    url: z.string().refine(isLoopbackMcpUrl, {
      error: 'mcp.url must be http on a loopback address',
    }),
    headers: z.record(z.string(), z.string()).optional(),
  }),
  updatedAt: z.iso.datetime(),
})

export type VoiceControlDescriptor = z.infer<typeof voiceControlDescriptorSchema>

/**
 * Per-app credential for the app-to-voice link, written by the voice layer to
 * `<dir>/voice/<appId>.json` when it enrolls an app. It replaces the shared
 * token, so the voice layer can tell which app a call came from.
 */
export const voiceControlAppGrantSchema = z.object({
  contract: z.literal(VOICE_CONTROL_CONTRACT),
  appId: appIdSchema,
  headers: z.record(z.string(), z.string()),
})

export type VoiceControlAppGrant = z.infer<typeof voiceControlAppGrantSchema>

export const voiceSourceSchema = z.object({
  appId: appIdSchema,
  name: z.string().min(1).max(128),
})

export const voiceSubjectSchema = z.object({
  type: z.string().min(1).max(64),
  id: z.string().min(1).max(256),
  label: z.string().min(1).max(256),
})

export const VOICE_STATES = [
  'idle',
  'working',
  'needs_input',
  'needs_approval',
  'needs_review',
  'failed',
] as const

export const voiceStateSchema = z.enum(VOICE_STATES)
export type VoiceState = z.infer<typeof voiceStateSchema>

/** The states worth interrupting someone for. `notify` carries one of these. */
export const voiceNotifyKindSchema = z.enum([
  'needs_input',
  'needs_approval',
  'needs_review',
  'failed',
])
export type VoiceNotifyKind = z.infer<typeof voiceNotifyKindSchema>

export const voicePrioritySchema = z.enum(['low', 'normal', 'urgent'])

const jsonArgumentsSchema = z.record(z.string(), z.unknown())

/** A follow-up you can trigger by voice: a tool on the source app. */
export const voiceActionSchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(256),
  tool: z.object({
    appId: appIdSchema,
    name: z.string().min(1).max(128),
    arguments: jsonArgumentsSchema,
  }),
})

export const voiceSetStatusInputSchema = z.object({
  source: voiceSourceSchema,
  subject: voiceSubjectSchema,
  state: voiceStateSchema,
  label: z.string().max(256),
})
export type VoiceSetStatusInput = z.infer<typeof voiceSetStatusInputSchema>

export const voiceNotifyInputSchema = z.object({
  source: voiceSourceSchema,
  subject: voiceSubjectSchema,
  kind: voiceNotifyKindSchema,
  title: z.string().min(1).max(256),
  speech: z.string().min(1).max(2_000),
  priority: voicePrioritySchema,
  actions: z.array(voiceActionSchema).max(8),
  dedupeKey: z.string().min(1).max(512),
})
export type VoiceNotifyInput = z.infer<typeof voiceNotifyInputSchema>

export const voiceSayInputSchema = z.object({
  source: voiceSourceSchema,
  text: z.string().min(1).max(2_000),
  subject: voiceSubjectSchema.optional(),
  speaker: z.object({ id: z.string().min(1).max(256), label: z.string().min(1).max(256) }).optional(),
  utteranceId: z.string().min(1).max(256).optional(),
}).superRefine((value, context) => {
  const dialogueIdentityPresent = value.subject !== undefined || value.speaker !== undefined
  if (dialogueIdentityPresent && (value.subject?.type !== 'dialogue' || value.speaker === undefined || value.utteranceId === undefined)) {
    context.addIssue({ code: 'custom', message: 'Dialogue speech requires subject, speaker and utteranceId.' })
  }
})
export type VoiceSayInput = z.infer<typeof voiceSayInputSchema>

export const voiceSayProgressSchema = z.object({
  utteranceId: z.string().min(1).max(256),
  state: z.enum(['started', 'progress']),
  heardChars: z.number().int().nonnegative(),
  totalChars: z.number().int().positive(),
}).refine((value) => value.heardChars <= value.totalChars, { error: 'heardChars exceeds totalChars' })
export type VoiceSayProgress = z.infer<typeof voiceSayProgressSchema>

export const voiceSayResultSchema = z.object({
  utteranceId: z.string().min(1).max(256),
  outcome: z.enum(['spoken', 'interrupted', 'cancelled', 'dropped']),
  heardChars: z.number().int().nonnegative(),
})
export type VoiceSayResult = z.infer<typeof voiceSayResultSchema>

export const voiceAskInputSchema = z.object({
  source: voiceSourceSchema,
  question: z.string().min(1).max(2_000),
  choices: z.array(z.string().min(1).max(256)).max(8).optional(),
  timeoutSeconds: z.number().int().positive().max(600),
})
