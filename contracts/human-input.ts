export const MAX_HUMAN_INPUT_MESSAGES = 32
export const MAX_HUMAN_INPUT_RECIPIENTS_PER_MESSAGE = 8
export const MAX_HUMAN_INPUT_TOTAL_CHARACTERS = 32_000
export const MAX_HUMAN_INPUT_BODY_BYTES = 64 * 1024
export const MAX_HUMAN_INPUT_SOURCE_PREVIEW_BYTES = 256 * 1024
/** Bounded reviewed-source context sent to a successor Team runtime. */
export const MAX_HUMAN_INPUT_SOURCE_PROMPT_BYTES = 32 * 1024

const MENTION_START_CHARACTERS = 'A-Za-z0-9'
const MENTION_TOKEN_CHARACTERS = `${MENTION_START_CHARACTERS}_-`
const MENTION_PREFIX_CHARACTERS = `${MENTION_START_CHARACTERS}_.+%-`
const MENTION_PATTERN_SOURCE = `(^|[^${MENTION_PREFIX_CHARACTERS}])@([${MENTION_START_CHARACTERS}][${MENTION_TOKEN_CHARACTERS}]*)`

export interface HumanInputMentionCandidate {
  id: string
  mentionToken: string
}

/** Immutable, per-successor routing context derived from one submission. */
export interface HumanInputRoutingContext {
  interactionId: string
  source: string
  messages: Array<{
    id: string
    text: string
    recipients: 'all' | string[]
  }>
}

export function isHumanInputRoutingContext(value: unknown): value is HumanInputRoutingContext {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (
    typeof record.interactionId !== 'string' ||
    !record.interactionId ||
    typeof record.source !== 'string' ||
    !Array.isArray(record.messages)
  ) {
    return false
  }
  return record.messages.every((message) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return false
    const candidate = message as Record<string, unknown>
    return typeof candidate.id === 'string' &&
      typeof candidate.text === 'string' &&
      (candidate.recipients === 'all' ||
        (Array.isArray(candidate.recipients) &&
          candidate.recipients.every((recipient) => typeof recipient === 'string')))
  })
}

export function hasHumanInputBroadcast(context: HumanInputRoutingContext): boolean {
  return context.messages.some((message) => message.recipients === 'all')
}

export function humanInputDirectRecipientIds(
  context: HumanInputRoutingContext,
): Set<string> {
  const recipients = new Set<string>()
  for (const message of context.messages) {
    if (message.recipients === 'all') continue
    for (const recipient of message.recipients) recipients.add(recipient)
  }
  return recipients
}

export function humanInputMessagesForRecipient(
  context: HumanInputRoutingContext,
  recipientId: string,
): HumanInputRoutingContext['messages'] {
  return context.messages.filter(
    (message) => message.recipients === 'all' || message.recipients.includes(recipientId),
  )
}

export type HumanInputMentionResolution =
  | { kind: 'resolved'; recipientIds: string[] }
  | { kind: 'unknown'; mentionToken: string }
  | { kind: 'ambiguous'; mentionToken: string }

function createMentionPattern(): RegExp {
  return new RegExp(MENTION_PATTERN_SOURCE, 'g')
}

/** Return syntactically valid literal @mention tokens in textual order. */
export function findHumanInputMentionTokens(text: string): string[] {
  const tokens: string[] = []
  for (const match of text.matchAll(createMentionPattern())) {
    const mentionToken = match[2]?.toLowerCase()
    if (mentionToken) tokens.push(mentionToken)
  }
  return tokens
}

/**
 * Parse the literal @mentions persisted in human feedback against one frozen
 * recipient snapshot. The UI and API deliberately share this grammar.
 */
export function resolveHumanInputMentions(
  text: string,
  candidates: readonly HumanInputMentionCandidate[],
): HumanInputMentionResolution {
  const candidateIdsByToken = new Map<string, string[]>()
  for (const candidate of candidates) {
    const token = candidate.mentionToken.toLowerCase()
    const ids = candidateIdsByToken.get(token) ?? []
    ids.push(candidate.id)
    candidateIdsByToken.set(token, ids)
  }

  const recipientIds: string[] = []
  const seen = new Set<string>()
  for (const mentionToken of findHumanInputMentionTokens(text)) {
    const candidateIds = candidateIdsByToken.get(mentionToken)
    if (!candidateIds || candidateIds.length === 0) {
      return { kind: 'unknown', mentionToken }
    }
    if (candidateIds.length !== 1) {
      return { kind: 'ambiguous', mentionToken }
    }
    const [recipientId] = candidateIds
    if (recipientId === undefined) {
      throw new Error(`Human input mention ${mentionToken} has one candidate but no recipient id.`)
    }
    if (!seen.has(recipientId)) {
      seen.add(recipientId)
      recipientIds.push(recipientId)
    }
  }
  return { kind: 'resolved', recipientIds }
}
