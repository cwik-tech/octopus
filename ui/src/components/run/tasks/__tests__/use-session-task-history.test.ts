/**
 * What the renderer keeps asking the server about.
 *
 * A task record moves for reasons no open stream reports — the queue admitting
 * an automatic recovery when it next starts, another window resuming or
 * cancelling the run. Whatever this poll stops watching, the renderer's copy of
 * is frozen at whatever it last saw.
 */
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  shouldRefreshTaskStatus,
  useSessionTaskHistory,
} from '@/components/run/tasks/use-session-task-history'
import { useTaskEventStream } from '@/components/run/tasks/use-task-event-stream'
import { useTaskRunStore } from '@/components/run/tasks/use-task-run-store'
import { getWorkflowRunState } from '@/components/run/tasks/workflow-run-state'
import type { SessionSummary, SessionTask } from '@/lib/models/session-model'

describe('shouldRefreshTaskStatus', () => {
  it('keeps refreshing a task that is awaiting human input', () => {
    expect(shouldRefreshTaskStatus('awaiting_input')).toBe(true)
  })

  // A task waiting on a model choice is stopped, but it is not finished: the
  // offer arrives after the task reaches this state, and the approved
  // continuation arrives after it leaves. Stop refreshing and the pane never
  // shows the decision, then never notices it was taken.
  it('keeps refreshing a task that is awaiting a model choice', () => {
    expect(shouldRefreshTaskStatus('awaiting_model_choice')).toBe(true)
  })

  /**
   * An interrupted task is stopped and not finished either, and its live
   * stream has already been aborted — the worker that owned it is gone. The
   * record is the only thing that can still say the run came back, was resumed
   * from another window, or was cancelled, and only a read can report that.
   */
  it('keeps refreshing an interrupted task, whose record only a read can move', () => {
    expect(shouldRefreshTaskStatus('interrupted')).toBe(true)
  })

  it('does not poll terminal task statuses', () => {
    expect(shouldRefreshTaskStatus('done')).toBe(false)
  })
})

const session: SessionSummary = {
  id: 'session-1',
  title: 'Interrupted research',
  status: 'active',
  activityType: 'workflow',
  createdAt: '2026-09-12T09:00:00.000Z',
  updatedAt: '2026-09-12T09:00:00.000Z',
}

function taskRecord(overrides: Partial<SessionTask> = {}): SessionTask {
  return {
    id: 'task-1',
    sessionId: session.id,
    runId: 'run-1',
    workflowId: 'deep-research-report',
    brief: 'Research the thing',
    status: 'interrupted',
    createdAt: '2026-09-12T09:00:00.000Z',
    cwd: '/workspace',
    recoveryDisposition: 'automatic',
    recoveryReason: 'The workflow worker stopped before completion.',
    interruptedAt: '2026-09-12T09:01:00.000Z',
    ...overrides,
  }
}

/** What the server would answer right now. Rewritten mid-test, as a server is. */
let serverTask: SessionTask

function jsonResponse(body: unknown): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  )
}

/**
 * The task and event endpoints, served through `fetch`.
 *
 * Stubbed at the network rather than by replacing the session client: the
 * behaviour under test is whether this hook keeps asking, and a stand-in for
 * the asking cannot show that.
 */
function installFetch(): void {
  vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost')
    if (url.pathname.endsWith(`/sessions/${session.id}/tasks`)) {
      return jsonResponse({ tasks: [serverTask] })
    }
    if (url.pathname.endsWith(`/runs/${serverTask.runId}/events`)) {
      return jsonResponse({ events: [] })
    }
    return Promise.reject(new Error(`Unexpected request: ${url.pathname}`))
  })
}

const noop = () => {}

function mountHistory() {
  return renderHook(() => {
    const store = useTaskRunStore()
    const stream = useTaskEventStream({
      appendTaskEvent: store.appendTaskEvent,
      onInjectChatMessage: noop,
      onReloadChatMessages: noop,
      setTasks: store.setTasks,
    })
    useSessionTaskHistory({
      clearResumingTaskIds: noop,
      onLatestTaskWorkflowChange: noop,
      resetWorkflowSelection: noop,
      session,
      store,
      stream,
      taskRefreshKey: 0,
    })
    return {
      composer: getWorkflowRunState({
        tasks: store.tasks,
        hasTeamChatTask: false,
        scheduledNotice: null,
      }),
      tasks: store.tasks,
    }
  })
}

/** Runs the poll `ticks` times over, flushing each read it starts. */
async function pass(ticks = 1): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ticks * 1_000)
  })
}

describe('a session whose run was interrupted', () => {
  beforeEach(() => {
    serverTask = taskRecord()
    installFetch()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  /**
   * The lock has to be able to come off inside the session it went on in.
   *
   * An automatic recovery is admitted when the task queue starts, and the run's
   * live stream was aborted the moment it was interrupted, so nothing in the
   * renderer can hear the run come back. Left unpolled, the composer stayed
   * shut on a run that had already finished, and its Stop — the one way out the
   * notice offers — answered 409 on a task the server considers done.
   */
  it('lets the composer go once the server has moved the interrupted run on', async () => {
    const { result } = mountHistory()
    await pass()

    expect(result.current.composer.notice).toBe(
      'Deep Research Report is waiting to resume. Chat is paused until it finishes, ' +
        'or until you stop the run.',
    )

    serverTask = taskRecord({
      status: 'done',
      completedAt: '2026-09-12T09:05:00.000Z',
    })
    await pass()

    expect(result.current.tasks.at(-1)?.mode).toBe('done')
    expect(result.current.composer).toEqual({ notice: null, taskId: null })
  })

  /**
   * The other half of the same read: a recovery that is under way says so, and
   * the notice stops promising a resume that already happened.
   */
  it('follows the same run back into running', async () => {
    const { result } = mountHistory()
    await pass()

    serverTask = taskRecord({
      status: 'running',
      startedAt: '2026-09-12T09:02:00.000Z',
      executionAttemptId: 'attempt-2',
      executionKind: 'recovery',
    })
    await pass()

    expect(result.current.tasks.at(-1)?.mode).toBe('running')
    expect(result.current.composer.notice).toBe(
      'Deep Research Report is running. Chat is paused until it finishes, ' +
        'or until you stop the run.',
    )
  })
})

/**
 * A follow-up message in a conversation that already holds a Team run.
 *
 * The earlier run's replies are not chat lines. They are rebuilt on screen
 * from that run's events, so whatever this hook drops, the transcript drops.
 * The follow-up used to clear every task and event and read the whole session
 * back before showing anything: the earlier answers vanished, the Team
 * workspace could fall back to a plain chat, and the new run's live stream
 * opened only after every finished run's history had been downloaded again.
 */
describe('a follow-up that starts another run in the same session', () => {
  function teamRun(overrides: Partial<SessionTask>): SessionTask {
    return {
      id: 'task-1',
      sessionId: session.id,
      runId: 'run-1',
      workflowId: 'team-chat-prompt-creators',
      targetKind: 'team-chat',
      teamId: 'prompt-creators',
      brief: 'Research methodologies since the 1950s',
      status: 'done',
      createdAt: '2026-09-12T09:00:00.000Z',
      cwd: '/workspace',
      ...overrides,
    }
  }
  const finishedRun = teamRun({ completedAt: '2026-09-12T09:02:00.000Z' })
  const followUpRun = teamRun({
    id: 'task-2',
    runId: 'run-2',
    status: 'running',
    createdAt: '2026-09-12T09:03:00.000Z',
    startedAt: '2026-09-12T09:03:00.000Z',
  })
  const finishedRunReply = {
    schema_version: 1,
    timestamp: '2026-09-12T09:01:00.000Z',
    tenant_id: 'local',
    category: 'agent',
    type: 'agent.message',
    run_id: 'run-1',
    root_run_id: 'run-1',
    payload: { agent_name: 'domain-researcher', text: 'First answer' },
  }

  interface Held<T> {
    readonly arrived: Promise<void>
    release(value: T): void
  }

  function hold<T>(): Held<T> & { reached(): void; response: Promise<T> } {
    let reached = () => {}
    let release: (value: T) => void = () => {}
    const arrived = new Promise<void>((resolve) => {
      reached = resolve
    })
    const response = new Promise<T>((resolve) => {
      release = resolve
    })
    return { arrived, reached, release, response }
  }

  let taskLists: SessionTask[][]
  let heldTaskList: ReturnType<typeof hold<SessionTask[]>> | null
  let snapshotReads: string[]
  let streamOpened: ReturnType<typeof hold<void>>

  /**
   * The session's task list, each run's event snapshot, and the live stream,
   * served through `fetch`. A real stream body stays open until the hook
   * aborts it, as the server's does.
   */
  function installSessionServer(): void {
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input), 'http://localhost')
      if (url.pathname.endsWith(`/sessions/${session.id}/tasks`)) {
        const held = heldTaskList
        if (held) {
          heldTaskList = null
          held.reached()
          return held.response.then((tasks) => jsonResponse({ tasks }))
        }
        return jsonResponse({ tasks: taskLists.shift() ?? [] })
      }
      const run = /\/runs\/([^/]+)\/events$/.exec(url.pathname)?.[1]
      if (run && url.searchParams.get('snapshot') === '1') {
        snapshotReads.push(run)
        return jsonResponse({
          events: run === 'run-1' ? [finishedRunReply] : [],
        })
      }
      if (run === 'run-2') {
        streamOpened.reached()
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            init?.signal?.addEventListener('abort', () => controller.close())
          },
        })
        return Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
        )
      }
      return Promise.reject(new Error(`Unexpected request: ${url.href}`))
    })
  }

  interface Shown {
    taskIds: string[]
    finishedRunEvents: number
  }

  /** Every state the hook rendered, in order, and a way to wait for one. */
  function mountConversation() {
    const shown: Shown[] = []
    const waiters: { test: (state: Shown) => boolean; resolve: () => void }[] = []
    const hook = renderHook(
      ({ taskRefreshKey }: { taskRefreshKey: number }) => {
        const store = useTaskRunStore()
        const stream = useTaskEventStream({
          appendTaskEvent: store.appendTaskEvent,
          onInjectChatMessage: noop,
          onReloadChatMessages: noop,
          setTasks: store.setTasks,
        })
        useSessionTaskHistory({
          clearResumingTaskIds: noop,
          onLatestTaskWorkflowChange: noop,
          resetWorkflowSelection: noop,
          session,
          store,
          stream,
          taskRefreshKey,
        })
        const state: Shown = {
          taskIds: store.tasks.map((task) => task.taskId),
          finishedRunEvents: store.taskEvents['task-1']?.length ?? 0,
        }
        shown.push(state)
        for (const waiter of [...waiters]) {
          if (waiter.test(state)) {
            waiters.splice(waiters.indexOf(waiter), 1)
            waiter.resolve()
          }
        }
        return state
      },
      { initialProps: { taskRefreshKey: 0 } },
    )
    /**
     * Resolves on the render that first shows `test`.
     *
     * Waited for outside `act`, as Testing Library's own async utilities do:
     * inside it React holds every update until the callback settles, and this
     * callback settles only once an update has rendered.
     */
    const rendered = async (test: (state: Shown) => boolean) => {
      if (shown.length > 0 && test(shown[shown.length - 1] as Shown)) return
      const reactGlobal = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
      const actEnvironment = reactGlobal.IS_REACT_ACT_ENVIRONMENT
      reactGlobal.IS_REACT_ACT_ENVIRONMENT = false
      try {
        await new Promise<void>((resolve) => {
          waiters.push({ test, resolve })
        })
      } finally {
        if (actEnvironment === undefined) delete reactGlobal.IS_REACT_ACT_ENVIRONMENT
        else reactGlobal.IS_REACT_ACT_ENVIRONMENT = actEnvironment
      }
    }
    return { ...hook, rendered, shown }
  }

  beforeEach(() => {
    taskLists = [[finishedRun]]
    heldTaskList = null
    snapshotReads = []
    streamOpened = hold<void>()
    installSessionServer()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  async function loadFinishedConversation() {
    const conversation = mountConversation()
    await conversation.rendered(
      (state) => state.taskIds.join() === 'task-1' && state.finishedRunEvents === 1,
    )
    return conversation
  }

  it("keeps the earlier run's answers on screen while the follow-up's task loads", async () => {
    const conversation = await loadFinishedConversation()
    const shownBeforeFollowUp = conversation.shown.length
    const followUpList = hold<SessionTask[]>()
    heldTaskList = followUpList

    conversation.rerender({ taskRefreshKey: 1 })
    await followUpList.arrived
    followUpList.release([finishedRun, followUpRun])
    await conversation.rendered((state) => state.taskIds.join() === 'task-1,task-2')

    const shownDuringFollowUp = conversation.shown.slice(shownBeforeFollowUp)
    expect(
      shownDuringFollowUp.filter(
        (state) => !state.taskIds.includes('task-1') || state.finishedRunEvents !== 1,
      ),
    ).toEqual([])
  })

  it("opens the follow-up run's live stream without re-reading the finished run's history", async () => {
    const conversation = await loadFinishedConversation()
    taskLists = [[finishedRun, followUpRun]]

    conversation.rerender({ taskRefreshKey: 1 })
    await streamOpened.arrived
    await conversation.rendered((state) => state.taskIds.join() === 'task-1,task-2')

    expect(snapshotReads).toEqual(['run-1', 'run-2'])
  })
})
