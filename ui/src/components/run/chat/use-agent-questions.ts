import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import type { AgentQuestionView } from '@contracts/agent-questions'
import { listAgentQuestions } from '@/lib/clients/agent-questions-client'
import type { WorkflowChatMessage } from '@/lib/utils/workflow-chat-events'

/**
 * A run's questions are read per task, and a conversation can hold many tasks.
 * Four at a time keeps a busy run from opening one request per task while still
 * finishing far sooner than reading them one after another.
 */
const MAX_CONCURRENT_QUESTION_READS = 4

/** A round nobody has finished answering and resuming yet. */
function isUnresolved(question: AgentQuestionView): boolean {
  return question.status === 'pending' || question.status === 'submitted' || question.status === 'resuming'
}

async function mapWithLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      const item = items[index]
      if (item !== undefined) results[index] = await run(item)
    }
  }))
  return results
}

export interface AgentQuestionProjection {
  readonly messages: WorkflowChatMessage[]
  /** Tasks whose question list this projection has actually read for the current revision. */
  readonly readTaskIds: ReadonlySet<string>
  /** Tasks whose durable question is still unresolved. */
  readonly waitingTaskIds: ReadonlySet<string>
}

export function useAgentQuestions(sessionId: string | undefined, taskRevision: string): AgentQuestionProjection {
  const [snapshot, setSnapshot] = useState<{ sessionId: string; taskRevision: string; taskIds: string[]; questions: AgentQuestionView[] } | null>(null)
  const [retryRevision, setRetryRevision] = useState(0)
  useEffect(() => {
    if (!sessionId) return
    const controller = new AbortController()
    const noticeId = `agent-questions-load:${sessionId}`
    // The task/event subscription changes this revision; no separate polling loop.
    const taskIds = taskRevision.split('|').map((item) => item.split(':')[0]).filter((id): id is string => Boolean(id))
    async function load() {
      const perTask = await mapWithLimit(taskIds, MAX_CONCURRENT_QUESTION_READS,
        (taskId) => listAgentQuestions(sessionId ?? '', taskId, controller.signal))
      if (!controller.signal.aborted) {
        setSnapshot({ sessionId: sessionId ?? '', taskRevision, taskIds, questions: perTask.flat() })
        toast.dismiss(noticeId)
      }
    }
    // Existing content remains readable during a transient refresh failure.
    void load().catch(() => {
      if (controller.signal.aborted) return
      toast.error('Could not load agent questions.', {
        id: noticeId,
        action: { label: 'Retry', onClick: () => setRetryRevision((revision) => revision + 1) },
      })
    })
    return () => { controller.abort(); toast.dismiss(noticeId) }
  }, [sessionId, taskRevision, retryRevision])
  const current = snapshot && snapshot.sessionId === sessionId ? snapshot : null
  // Cards stay readable while a refresh is in flight, but what the task pane
  // asks - is this task waiting on an agent question - may only be answered for
  // the revision actually read. A newer revision that has not landed yet is
  // unknown, not "no".
  const fresh = current && current.taskRevision === taskRevision ? current : null
  return useMemo(() => ({
    messages: (current?.questions ?? []).map((question) => ({
      id: `agent-question:${question.interactionId}`, role: 'assistant', text: question.request.progress,
      createdAt: question.requestedAt,
      speaker: { type: 'agent', id: question.agentId, name: question.agentDisplayName },
      workflow: { taskId: question.taskId, runId: question.childRunId }, agentQuestion: question,
    })),
    readTaskIds: new Set(fresh?.taskIds ?? []),
    waitingTaskIds: new Set((fresh?.questions ?? []).filter(isUnresolved).map((question) => question.taskId)),
  }), [current, fresh])
}
