import { useEffect, useId, useRef, useState } from 'react'
import { z } from 'zod'
import { MAX_AGENT_ANSWER_CHARACTERS, MAX_AGENT_ANSWERS_TOTAL_CHARACTERS, type AgentQuestionView } from '@contracts/agent-questions'
import { cancelSessionTask } from '@/lib/clients/session-client'
import { submitAgentAnswers } from '@/lib/clients/agent-questions-client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import { formatAgentDisplayName } from '@/components/run/shared/agent-identity-model'

const draftSchema = z.object({ submissionId: z.string().uuid(), answers: z.record(z.string(), z.string()) }).strict()

const blockedReasons = {
  question_limit_reached: 'This run stopped because an agent requested another question round.',
  continuation_indeterminate: 'The agent stopped while continuing. Its outcome is unknown, so this run cannot resume automatically.',
  continuation_unavailable: 'The saved context, provider, or remaining budget cannot support a safe continuation.',
}

/**
 * An answered round keeps its status and carries the refusal of a later one, so
 * a recorded reason is read before the status. A blocked round with no reason
 * gets neutral wording rather than a cause nobody established.
 */
function readonlyStatusText(question: AgentQuestionView): string {
  if (question.blockCode) return blockedReasons[question.blockCode]
  switch (question.status) {
    case 'blocked': return 'This run stopped.'
    case 'cancelled': return question.cancellationReason ?? 'Cancelled'
    case 'resolved': return 'Answered'
    case 'resuming': return 'Continuing with your answer'
    default: return 'Answer received; waiting to continue'
  }
}

function readDraft(key: string) {
  try {
    const raw = localStorage.getItem(key)
    const parsed = draftSchema.safeParse(raw ? JSON.parse(raw) : undefined)
    if (parsed.success) return parsed.data
  } catch {
    // An unavailable browser draft does not affect the durable question.
  }
  return { submissionId: crypto.randomUUID(), answers: {} }
}

export function AgentQuestionCard({ question }: { question: AgentQuestionView }) {
  const key = `agent-question:${question.sessionId}:${question.taskId}:${question.interactionId}`
  const [draft, setDraft] = useState(() => readDraft(key))
  const [submitted, setSubmitted] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const request = useRef<AbortController | null>(null)
  const fieldPrefix = useId()
  const readonly = submitted || question.status !== 'pending'
  const answers = question.answers ?? draft.answers
  const name = formatAgentDisplayName(question.agentDisplayName)
  const exceedsTotal = Object.values(draft.answers).reduce((total, answer) => total + answer.trim().length, 0) > MAX_AGENT_ANSWERS_TOTAL_CHARACTERS
  useEffect(() => () => request.current?.abort(), [])
  useEffect(() => {
    try {
      if (question.status === 'resolved' || question.status === 'cancelled' || question.status === 'blocked') localStorage.removeItem(key)
      else localStorage.setItem(key, JSON.stringify(draft))
    } catch {
      // Submission remains usable when draft storage is unavailable.
    }
  }, [draft, key, question.status])

  async function submit() {
    if (busy || readonly || exceedsTotal || !question.canSubmit) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(null)
    try {
      await submitAgentAnswers({
        sessionId: question.sessionId, taskId: question.taskId, interactionId: question.interactionId,
        expectedInteractionRevision: question.revision, expectedRequestDigest: question.requestDigest,
        submissionId: draft.submissionId, answers: draft.answers,
      }, controller.signal)
      if (!controller.signal.aborted) setSubmitted(true)
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not submit your answer.')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  async function cancel() {
    if (busy) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true)
    setError(null)
    try {
      await cancelSessionTask(question.sessionId, question.taskId, AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not cancel this run.')
    } finally {
      if (!controller.signal.aborted) setBusy(false)
    }
  }

  const showCancel = ['pending', 'submitted', 'resuming'].includes(question.status)
  return <Card role="region" aria-label={`${name} needs your input`} id={`agent-question-${question.interactionId}`} data-agent-question-task={question.taskId} className="mt-4 rounded-none bg-transparent py-0 ring-0">
    <CardHeader className="px-0"><CardTitle>{name} needs your input</CardTitle></CardHeader>
    <CardContent className="space-y-4 px-0">
      {question.request.questions.map((item, index) => {
        const questionId = question.questionIds[index]
        if (!questionId) return null
        const fieldId = `${fieldPrefix}-${index}`
        return <div key={questionId} className="space-y-2">
          <label className="font-medium" htmlFor={fieldId}>{item.question}</label>
          <p className="text-sm text-muted-foreground" id={`${fieldId}-reason`}>{item.reason}</p>
          {readonly ? <p className="whitespace-pre-wrap">{answers[questionId]}</p> : <Textarea
            id={fieldId} aria-describedby={`${fieldId}-reason`} value={draft.answers[questionId] ?? ''}
            maxLength={MAX_AGENT_ANSWER_CHARACTERS} disabled={busy}
            onChange={(event) => setDraft((current) => ({ ...current, answers: { ...current.answers, [questionId]: event.target.value } }))}
          />}
        </div>
      })}
      {error ? <p role="alert" className="text-destructive">{error}</p> : null}
      {exceedsTotal && !readonly ? <p role="alert" className="text-destructive">Keep your answers within 32,000 characters in total.</p> : null}
      {readonly ? <p role="status" className="text-sm text-muted-foreground">{readonlyStatusText(question)}</p> : null}
      {showCancel || !readonly ? <div className="flex flex-wrap items-center justify-end gap-6">
        {showCancel ? <Button variant="outline" disabled={busy} onClick={() => { void cancel() }}>Cancel run</Button> : null}
        {readonly ? null : <Button
          disabled={busy || exceedsTotal || !question.canSubmit || question.questionIds.some((id) => !draft.answers[id]?.trim())}
          onClick={() => { void submit() }}
        >{busy ? 'Submitting…' : 'Submit and continue'}</Button>}
      </div> : null}
    </CardContent>
  </Card>
}
