import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  getHumanInputInteraction,
  submitHumanInput,
  type HumanInputInteractionSnapshot,
} from '@/lib/clients/session-client'
import {
  MAX_HUMAN_INPUT_MESSAGES,
  MAX_HUMAN_INPUT_TOTAL_CHARACTERS,
  resolveHumanInputMentions,
} from '@contracts/human-input'

type DraftRecipients = 'all' | string[]

interface DraftMessage {
  id: string
  text: string
  recipients: DraftRecipients
}

interface PersistedDraft {
  submissionId: string
  messages: DraftMessage[]
}

interface InteractionView {
  workflowRevision: number
  interaction: HumanInputInteractionSnapshot
  sourceText: string
  sourceTruncated: boolean
  sourceByteLength: number
}

interface HumanInputPanelProps {
  sessionId: string
  taskId: string
  onSubmitted?: (() => void) | undefined
}

function createId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
}

function createDraftMessage(): DraftMessage {
  return { id: createId(), text: '', recipients: 'all' }
}

function draftStorageKey(sessionId: string, taskId: string, interactionId: string): string {
  return `human-input-draft:${sessionId}:${taskId}:${interactionId}`
}

function loadDraft(key: string): PersistedDraft | null {
  try {
    const raw = globalThis.localStorage?.getItem(key)
    if (!raw) return null
    const value = JSON.parse(raw) as Partial<PersistedDraft>
    if (typeof value.submissionId !== 'string' || !Array.isArray(value.messages)) return null
    const messages = value.messages.filter((message): message is DraftMessage =>
      Boolean(message) &&
      typeof message.id === 'string' &&
      typeof message.text === 'string' &&
      (message.recipients === 'all' ||
        (Array.isArray(message.recipients) && message.recipients.every((id) => typeof id === 'string'))),
    )
    return messages.length > 0 ? { submissionId: value.submissionId, messages } : null
  } catch {
    return null
  }
}

function persistDraft(key: string, draft: PersistedDraft): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(draft))
  } catch {
    // Draft persistence is best effort when browser storage is unavailable.
  }
}

function removeDraft(key: string): void {
  try {
    globalThis.localStorage?.removeItem(key)
  } catch {
    // Ignore unavailable browser storage after a successful durable submission.
  }
}

function mentionQuery(text: string): string | null {
  return text.match(/(?:^|\s)@([A-Za-z0-9_-]*)$/)?.[1]?.toLowerCase() ?? null
}

export function HumanInputPanel({
  sessionId,
  taskId,
  onSubmitted,
}: HumanInputPanelProps) {
  return (
    <HumanInputPanelForTask
      key={`${sessionId}:${taskId}`}
      sessionId={sessionId}
      taskId={taskId}
      onSubmitted={onSubmitted}
    />
  )
}

function HumanInputPanelForTask({
  sessionId,
  taskId,
  onSubmitted,
}: HumanInputPanelProps) {
  const [snapshot, setSnapshot] = useState<InteractionView | null>(null)
  const [messages, setMessages] = useState<DraftMessage[]>([createDraftMessage()])
  const [submissionId, setSubmissionId] = useState(createId)
  const [draftReady, setDraftReady] = useState(false)
  const [activeMessageId, setActiveMessageId] = useState<string | null>(null)
  const [suggestionIndex, setSuggestionIndex] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    let disposed = false
    void getHumanInputInteraction(sessionId, taskId)
      .then((next) => {
        if (disposed) return
        const key = draftStorageKey(sessionId, taskId, next.interaction.interactionId)
        const restored = loadDraft(key)
        setSnapshot(next)
        setMessages(restored?.messages ?? [createDraftMessage()])
        setSubmissionId(restored?.submissionId ?? createId())
        setDraftReady(true)
        setError(null)
      })
      .catch((cause) => {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause))
      })
    return () => {
      disposed = true
    }
  }, [sessionId, taskId])

  const storageKey = snapshot
    ? draftStorageKey(sessionId, taskId, snapshot.interaction.interactionId)
    : null

  useEffect(() => {
    if (!draftReady || !storageKey || snapshot?.interaction.status !== 'pending') return
    persistDraft(storageKey, { submissionId, messages })
  }, [draftReady, messages, snapshot?.interaction.status, storageKey, submissionId])

  const messageErrors = useMemo(() => messages.map((message) => {
    if (!snapshot) return null
    const resolution = resolveHumanInputMentions(
      message.text,
      snapshot.interaction.eligibleRecipients,
    )
    return resolution.kind === 'unknown'
      ? `Unknown recipient @${resolution.mentionToken}`
      : resolution.kind === 'ambiguous'
        ? `Ambiguous recipient @${resolution.mentionToken}`
        : null
  }), [messages, snapshot])
  const mentionError = messageErrors.find((candidate) => candidate !== null) ?? null
  const totalCharacters = messages.reduce((total, message) => total + message.text.length, 0)
  const hasFeedback = messages.some((message) => message.text.trim().length > 0)
  const canContinueWithFeedback = hasFeedback &&
    messages.every((message) => message.text.trim().length > 0) &&
    totalCharacters <= MAX_HUMAN_INPUT_TOTAL_CHARACTERS &&
    !mentionError

  const updateMessage = (messageId: string, update: (message: DraftMessage) => DraftMessage) => {
    setMessages((current) => current.map((message) =>
      message.id === messageId ? update(message) : message,
    ))
  }

  const toggleRecipient = (messageId: string, recipientId: string) => {
    updateMessage(messageId, (message) => {
      const direct = message.recipients === 'all' ? [] : message.recipients
      const recipients = direct.includes(recipientId)
        ? direct.filter((candidate) => candidate !== recipientId)
        : [...direct, recipientId]
      return { ...message, recipients: recipients.length > 0 ? recipients : 'all' }
    })
  }

  const insertMention = (message: DraftMessage, mentionToken: string) => {
    updateMessage(message.id, (current) => ({
      ...current,
      text: current.text.replace(/@([A-Za-z0-9_-]*)$/, `@${mentionToken} `),
    }))
    setActiveMessageId(null)
    setSuggestionIndex(0)
  }

  const suggestionsFor = (message: DraftMessage) => {
    if (activeMessageId !== message.id || !snapshot) return []
    const query = mentionQuery(message.text)
    if (query === null) return []
    return snapshot.interaction.eligibleRecipients.filter((recipient) =>
      recipient.mentionToken.toLowerCase().startsWith(query) ||
      recipient.displayName.toLowerCase().startsWith(query),
    )
  }

  const handleComposerKeyDown = (
    event: KeyboardEvent<HTMLTextAreaElement>,
    message: DraftMessage,
  ) => {
    const suggestions = suggestionsFor(message)
    if (suggestions.length === 0) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setSuggestionIndex((current) =>
        (current + direction + suggestions.length) % suggestions.length,
      )
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const suggestion = suggestions[suggestionIndex % suggestions.length]
      if (!suggestion) throw new Error(`Mention suggestion index ${suggestionIndex} is out of range.`)
      insertMention(message, suggestion.mentionToken)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      setActiveMessageId(null)
    }
  }

  const submit = async (mode: 'feedback' | 'continue_without_feedback') => {
    if (!snapshot || submitting) return
    const trimmedMessages = messages.map((message) => ({
      ...message,
      text: message.text.trim(),
    }))
    if (mode === 'feedback' && trimmedMessages.some((message) => !message.text)) {
      setError('Every feedback message must contain text.')
      return
    }
    if (mode === 'feedback' && totalCharacters > MAX_HUMAN_INPUT_TOTAL_CHARACTERS) {
      setError(`Feedback supports at most ${MAX_HUMAN_INPUT_TOTAL_CHARACTERS} characters in total.`)
      return
    }
    if (mentionError) {
      setError(mentionError)
      return
    }
    const submittedMessages = mode === 'feedback'
      ? trimmedMessages.map((message) => {
          const resolution = resolveHumanInputMentions(
            message.text,
            snapshot.interaction.eligibleRecipients,
          )
          const recipients = resolution.kind === 'resolved' && resolution.recipientIds.length > 0
            ? resolution.recipientIds
            : message.recipients
          return { id: message.id, text: message.text, recipients }
        })
      : []
    setError(null)
    setSubmitting(true)
    try {
      await submitHumanInput(sessionId, taskId, snapshot.interaction.interactionId, {
        submissionId,
        expectedWorkflowRevision: snapshot.workflowRevision,
        expectedSourceArtifactSha256: snapshot.interaction.sourceArtifact.sha256,
        mode,
        messages: submittedMessages,
      })
      if (storageKey) removeDraft(storageKey)
      setSnapshot((current) => current
        ? { ...current, interaction: { ...current.interaction, status: 'submitted' } }
        : current)
      onSubmitted?.()
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      try {
        const refreshed = await getHumanInputInteraction(sessionId, taskId)
        setSnapshot(refreshed)
        if (refreshed.interaction.status === 'pending') {
          setError(`${message} The interaction was refreshed; review and retry.`)
        } else {
          if (storageKey) removeDraft(storageKey)
          setError(null)
        }
      } catch (refreshCause) {
        const refreshMessage = refreshCause instanceof Error ? refreshCause.message : String(refreshCause)
        setError(`${message} Refresh failed: ${refreshMessage}`)
      }
    } finally {
      setSubmitting(false)
    }
  }

  if (error && !snapshot) {
    return <div className="p-4 text-sm text-destructive">{error}</div>
  }
  if (!snapshot) {
    return <div className="p-4 text-sm text-muted-foreground">Loading human input…</div>
  }
  if (snapshot.interaction.status !== 'pending') {
    return (
      <div className="p-4 text-sm text-muted-foreground">
        Human feedback was submitted. The workflow will continue shortly.
      </div>
    )
  }

  return (
    <section aria-label="Human input" className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
      <div>
        <h2 className="text-sm font-semibold">Human input required</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Add ordered messages for everyone or selected participants. Literal <code>@name</code> mentions override a message&apos;s recipient buttons.
        </p>
      </div>

      <details className="rounded-lg border border-border/60 bg-muted/20 p-3">
        <summary className="cursor-pointer text-xs font-medium">Reviewed source</summary>
        <pre className="mt-3 max-h-72 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">
          {snapshot.sourceText}
        </pre>
        {snapshot.sourceTruncated ? (
          <p className="mt-2 text-xs text-muted-foreground">
            Preview truncated. The verified source is {snapshot.sourceByteLength.toLocaleString()} bytes.
          </p>
        ) : null}
      </details>

      <div className="space-y-3">
        {messages.map((message, index) => {
          const suggestions = suggestionsFor(message)
          return (
            <div key={message.id} className="rounded-lg border border-border/60 p-3">
              <div className="mb-2 flex items-center justify-between gap-2">
                <label htmlFor={`feedback-${message.id}`} className="text-xs font-medium">
                  Feedback message {index + 1}
                </label>
                {messages.length > 1 ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove feedback message ${index + 1}`}
                    onClick={() => setMessages((current) => current.filter((candidate) => candidate.id !== message.id))}
                  >
                    <Trash2 className="size-3" />
                  </Button>
                ) : null}
              </div>
              <div className="relative">
                <Textarea
                  id={`feedback-${message.id}`}
                  aria-label={`Feedback message ${index + 1}`}
                  value={message.text}
                  maxLength={MAX_HUMAN_INPUT_TOTAL_CHARACTERS}
                  onFocus={() => setActiveMessageId(message.id)}
                  onChange={(event) => {
                    setActiveMessageId(message.id)
                    setSuggestionIndex(0)
                    updateMessage(message.id, (current) => ({ ...current, text: event.target.value }))
                  }}
                  onKeyDown={(event) => handleComposerKeyDown(event, message)}
                  placeholder="Add feedback for the next discussion round…"
                />
                {suggestions.length > 0 ? (
                  <div role="listbox" aria-label={`Mention suggestions for message ${index + 1}`} className="absolute z-20 mt-1 w-full rounded-md border border-border bg-popover p-1 shadow-md">
                    {suggestions.map((recipient, recipientIndex) => (
                      <Button
                        key={recipient.id}
                        variant="ghost"
                        size="xs"
                        role="option"
                        aria-selected={recipientIndex === suggestionIndex}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => insertMention(message, recipient.mentionToken)}
                        className="h-auto w-full justify-start px-2 py-1.5 text-left font-normal aria-selected:bg-muted"
                      >
                        @{recipient.mentionToken} · {recipient.displayName}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="mt-2 flex flex-wrap gap-2" aria-label={`Feedback message ${index + 1} recipients`}>
                <Button
                  type="button"
                  size="xs"
                  aria-pressed={message.recipients === 'all'}
                  variant={message.recipients === 'all' ? 'default' : 'outline'}
                  onClick={() => updateMessage(message.id, (current) => ({ ...current, recipients: 'all' }))}
                >
                  Everyone
                </Button>
                {snapshot.interaction.eligibleRecipients.map((recipient) => {
                  const selected = message.recipients !== 'all' && message.recipients.includes(recipient.id)
                  return (
                    <Button
                      key={recipient.id}
                      type="button"
                      size="xs"
                      aria-pressed={selected}
                      variant={selected ? 'default' : 'outline'}
                      onClick={() => toggleRecipient(message.id, recipient.id)}
                    >
                      @{recipient.mentionToken}
                    </Button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={messages.length >= MAX_HUMAN_INPUT_MESSAGES}
        onClick={() => setMessages((current) => [...current, createDraftMessage()])}
        className="self-start gap-1.5"
      >
        <Plus className="size-3.5" />
        Add feedback message
      </Button>

      {(error || mentionError) && (
        <p role="alert" className="text-xs text-destructive">{error ?? mentionError}</p>
      )}

      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          disabled={submitting || !canContinueWithFeedback}
          onClick={() => void submit('feedback')}
        >
          Continue workflow
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={submitting || hasFeedback}
          onClick={() => void submit('continue_without_feedback')}
        >
          Continue without feedback
        </Button>
      </div>
    </section>
  )
}
