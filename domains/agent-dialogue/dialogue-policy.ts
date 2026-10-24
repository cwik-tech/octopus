import { AGENT_DIALOGUE_MAX_CONSECUTIVE_FAILURES, AGENT_DIALOGUE_MIN_AGENTS, AGENT_DIALOGUE_PASS_TOKEN, type AgentDialogueRecord } from '../../contracts/agent-dialogue.js'
import type { ChatMessage } from '../../contracts/sessions.js'

export interface DialogueDeltaState {
  pending: string
  started: boolean
}

export function normalizeDialogueText(raw: string): { kind: 'reply'; text: string } | { kind: 'pass' | 'failure' } {
  if (raw.trim() === '') return { kind: 'failure' }
  const text = raw.replace(/\[pass\]/gi, '').trim()
  return text === '' ? { kind: 'pass' } : { kind: 'reply', text }
}

export function filterDialogueDelta(state: DialogueDeltaState, chunk: string): { state: DialogueDeltaState; delta: string } {
  const text = `${state.pending}${chunk}`.replace(/\[pass\]/gi, '')
  const candidate = text.trim().toLowerCase()
  if (!state.started && AGENT_DIALOGUE_PASS_TOKEN.startsWith(candidate)) {
    return { state: { pending: text, started: false }, delta: '' }
  }
  const bracket = text.lastIndexOf('[')
  const suffix = bracket < 0 ? undefined : text.slice(bracket).trim().toLowerCase()
  const boundary = suffix !== undefined && AGENT_DIALOGUE_PASS_TOKEN.startsWith(suffix)
    ? text.slice(0, bracket).trimEnd().length
    : text.trimEnd().length
  const delta = text.slice(0, boundary)
  return { state: { pending: text.slice(boundary), started: state.started || delta.length > 0 }, delta }
}

export function finishDialogueDelta(state: DialogueDeltaState): string {
  return state.pending.replace(/\[pass\]/gi, '').trimEnd()
}

export function settleDialogueTurn(
  record: AgentDialogueRecord,
  outcome: { kind: 'reply' | 'pass' | 'failure' },
  timestamp: string,
): AgentDialogueRecord {
  const participants = record.participants.map((participant, index) => {
    if (index !== record.nextSpeaker) return participant
    const consecutiveFailures = outcome.kind === 'failure' ? participant.consecutiveFailures + 1 : 0
    return { ...participant, consecutiveFailures, active: participant.active && consecutiveFailures < AGENT_DIALOGUE_MAX_CONSECUTIVE_FAILURES }
  })
  const activeCount = participants.filter((participant) => participant.active).length
  const replyCount = record.replyCount + (outcome.kind === 'reply' ? 1 : 0)
  const passStreak = outcome.kind === 'pass' ? record.passStreak + 1 : 0
  const endReason = activeCount < AGENT_DIALOGUE_MIN_AGENTS ? 'too_few_speakers'
    : replyCount >= record.limits.maxTurns ? 'turn_limit'
      : passStreak >= activeCount ? 'passes' : undefined
  const nextSpeaker = nextActiveSpeaker(participants, record.nextSpeaker)
  return {
    ...record, participants, replyCount, passStreak, nextSpeaker, nextSlot: record.nextSlot + 1, updatedAt: timestamp,
    ...(endReason === undefined ? {} : { endReason, status: endReason === 'too_few_speakers' ? 'failed' : 'ended' }),
  }
}

function nextActiveSpeaker(participants: AgentDialogueRecord['participants'], current: number): number {
  for (let offset = 1; offset <= participants.length; offset += 1) {
    const index = (current + offset) % participants.length
    if (participants[index]?.active) return index
  }
  return current
}

export function recoverDialogueRecord(record: AgentDialogueRecord, messages: readonly ChatMessage[], timestamp: string): AgentDialogueRecord {
  const acceptedSlots = new Set<number>()
  let nextSlot = record.nextSlot
  for (const message of messages) {
    if (message.source?.kind !== 'agent-dialogue' || message.source.dialogueId !== record.dialogueId) continue
    if (message.id === `${record.dialogueId}:user:topic`) continue
    nextSlot = Math.max(nextSlot, message.source.slot + (message.role === 'assistant' ? 1 : 0))
    if (message.role === 'assistant') acceptedSlots.add(message.source.slot)
  }
  for (const event of record.events) {
    if (event.slot !== undefined && event.type !== 'interjected') nextSlot = Math.max(nextSlot, event.slot + 1)
  }
  const active = record.status === 'running' || record.status === 'paused'
  const status = active ? record.stopRequested ? 'stopped' : 'interrupted' : record.status
  return {
    ...record, replyCount: acceptedSlots.size, nextSlot, updatedAt: timestamp,
    ...(active ? { status, endReason: record.stopRequested ? 'stopped' : 'interrupted', epoch: record.epoch + 1 } : {}),
  }
}
