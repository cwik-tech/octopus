/**
 * The durable message a Team chat run records for one accepted contribution.
 *
 * Every Team engine reaches its own conclusion about when an agent's answer is
 * accepted, but what the reader sees afterwards must not depend on which
 * engine produced it. This contract is that shared shape: identity, speaker,
 * accepted text, and nothing else.
 *
 * Deliberately narrow. Hidden reasoning, raw provider responses, wire
 * payloads, prompts, headers, credentials, and uploaded file contents have no
 * field here, so no engine can persist them by accident.
 */

export const TEAM_CHAT_MESSAGE_EVENT_TYPE = 'team.message'

/**
 * The visible category of a Team chat message, matching the vocabulary the
 * transcript already uses so one projection can render both families.
 */
export type TeamChatMessageType = 'position' | 'framing' | 'synthesis' | 'error'

export interface TeamChatMessagePayload extends Record<string, unknown> {
  /** Stable across replay: see `teamChatMessageId`. */
  message_id: string
  run_id: string
  /** The concrete attempt whose answer this is. */
  dispatch_id: string
  /** The level the attempt belonged to. */
  stage_id: string
  /** Who actually spoke, which after a fallback is not the configured agent. */
  agent_name: string
  text: string
  timestamp: string
  message_type: string
}

/**
 * The identity of one durable message.
 *
 * Built from the run and the attempt rather than from the text or a counter,
 * because those are the two facts that survive a reconnect, a replay, and a
 * recovery process: the same attempt in the same run is the same message, and
 * a retry is a different attempt whether or not it produced identical prose.
 */
export function teamChatMessageId(input: {
  readonly runId: string
  readonly dispatchId: string
}): string {
  return `${input.runId}#${input.dispatchId}`
}

export function isTeamChatMessagePayload(
  value: unknown,
): value is TeamChatMessagePayload {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate: Record<string, unknown> = { ...value }
  return [
    'message_id',
    'run_id',
    'dispatch_id',
    'stage_id',
    'agent_name',
    'text',
    'timestamp',
    'message_type',
  ].every((field) => isPresentString(candidate[field]))
}

function isPresentString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
