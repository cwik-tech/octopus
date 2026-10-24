import { z } from 'zod/v4'
import { workspaceProjectContextSelectionSchema } from './schemas/project-requests.js'
import { MAX_CONTEXT_RESULTS_PER_TURN } from './schemas/result-reference.js'

export const AGENT_DIALOGUE_MIN_AGENTS = 2
export const AGENT_DIALOGUE_MAX_AGENTS = 5
export const AGENT_DIALOGUE_DEFAULT_TURN_LIMIT = 12
export const AGENT_DIALOGUE_TURN_LIMIT_CAP = 50
export const AGENT_DIALOGUE_MAX_CONSECUTIVE_FAILURES = 2
export const AGENT_DIALOGUE_PASS_TOKEN = '[pass]'

const identity = z.string().trim().min(1).max(200)
export const agentDialogueDeliverySchema = z.enum(['text', 'voice'])
export const agentDialogueStatusSchema = z.enum(['running', 'paused', 'ended', 'stopped', 'failed', 'interrupted'])
export const agentDialogueEndReasonSchema = z.enum(['passes', 'turn_limit', 'time_limit', 'stopped', 'too_few_speakers', 'interrupted'])
export const agentDialoguePauseReasonSchema = z.enum(['speech_interrupted', 'voice_unavailable', 'voice_refused', 'speech_dropped'])
const contextFields = {
  projectContext: workspaceProjectContextSelectionSchema.optional(),
  contextResultIds: z.array(z.string().trim().min(1).max(400)).max(MAX_CONTEXT_RESULTS_PER_TURN).optional(),
}

export const startAgentDialogueRequestSchema = z.object({
  agents: z.array(identity).min(AGENT_DIALOGUE_MIN_AGENTS).max(AGENT_DIALOGUE_MAX_AGENTS)
    .refine((agents) => new Set(agents).size === agents.length, 'Select distinct Agents'),
  topic: z.string().trim().min(1).max(100_000),
  delivery: agentDialogueDeliverySchema.default('text'),
  maxTurns: z.number().int().min(1).max(AGENT_DIALOGUE_TURN_LIMIT_CAP).default(AGENT_DIALOGUE_DEFAULT_TURN_LIMIT),
  maxMinutes: z.number().finite().positive().optional(),
  continues: z.uuid().optional(),
  ...contextFields,
})

export const interjectAgentDialogueRequestSchema = z.object({
  messageId: identity,
  text: z.string().trim().min(1).max(100_000),
})

export const agentDialogueParticipantSchema = z.object({
  id: identity,
  label: identity,
  consecutiveFailures: z.number().int().nonnegative(),
  active: z.boolean(),
})

export const agentDialogueEventSchema = z.object({
  sequence: z.number().int().nonnegative(),
  type: z.enum(['started', 'turn_started', 'turn_saved', 'turn_passed', 'turn_discarded', 'speaker_failed', 'interjected', 'paused', 'resumed', 'ended']),
  createdAt: z.string(),
  channelId: z.uuid().optional(),
  replyId: identity.optional(),
  speaker: agentDialogueParticipantSchema.optional(),
  slot: z.number().int().nonnegative().optional(),
  messageId: z.string().optional(),
  status: agentDialogueStatusSchema.optional(),
  endReason: agentDialogueEndReasonSchema.optional(),
  pauseReason: agentDialoguePauseReasonSchema.optional(),
})

export const agentDialogueRecordSchema = z.object({
  schemaVersion: z.literal(1),
  dialogueId: z.uuid(),
  sessionId: z.uuid(),
  topic: z.string(),
  continues: z.uuid().optional(),
  ...contextFields,
  participants: z.array(agentDialogueParticipantSchema).min(AGENT_DIALOGUE_MIN_AGENTS).max(AGENT_DIALOGUE_MAX_AGENTS),
  delivery: agentDialogueDeliverySchema,
  limits: z.object({
    maxTurns: z.number().int().min(1).max(AGENT_DIALOGUE_TURN_LIMIT_CAP),
    maxMinutes: z.number().finite().positive().optional(),
    runningMs: z.number().finite().nonnegative(),
  }),
  status: agentDialogueStatusSchema,
  endReason: agentDialogueEndReasonSchema.optional(),
  pauseReason: agentDialoguePauseReasonSchema.optional(),
  nextSlot: z.number().int().nonnegative(),
  replyCount: z.number().int().nonnegative(),
  passStreak: z.number().int().nonnegative(),
  nextSpeaker: z.number().int().nonnegative(),
  epoch: z.number().int().nonnegative(),
  ownerLaunchId: z.uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stopRequested: z.boolean(),
  events: z.array(agentDialogueEventSchema),
})

export const agentDialogueListSchema = z.object({ dialogues: z.array(agentDialogueRecordSchema) })
export type StartAgentDialogueRequest = z.infer<typeof startAgentDialogueRequestSchema>
export type InterjectAgentDialogueRequest = z.infer<typeof interjectAgentDialogueRequestSchema>
export type AgentDialogueRecord = z.infer<typeof agentDialogueRecordSchema>
export type AgentDialogueEvent = z.infer<typeof agentDialogueEventSchema>
export type AgentDialogueParticipant = z.infer<typeof agentDialogueParticipantSchema>
export type AgentDialoguePauseReason = z.infer<typeof agentDialoguePauseReasonSchema>
