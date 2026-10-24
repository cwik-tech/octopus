/**
 * Which Workflow run, if any, owns the conversation's composer.
 *
 * The composer refuses a message a running Workflow would never read, and
 * offers the Stop that ends it. Two runs are deliberately left out. A Team run
 * is the composer's own case and already states itself. A scheduled run belongs
 * to the schedule that fired it, and already says so above the composer.
 */
import { describe, expect, it } from 'vitest'

import { getWorkflowRunState } from '../workflow-run-state'
import type { TaskMode, TaskRunEntry } from '../task-strip'

function makeTask(overrides: Partial<TaskRunEntry> = {}): TaskRunEntry {
  return {
    taskId: 'task-1',
    runId: 'run-1',
    workflowId: 'deep-research-report',
    label: 'deep-research-report',
    mode: 'running',
    ...overrides,
  }
}

function ask(overrides: Partial<Parameters<typeof getWorkflowRunState>[0]> = {}) {
  return getWorkflowRunState({
    tasks: [makeTask()],
    hasTeamChatTask: false,
    scheduledNotice: null,
    ...overrides,
  })
}

/**
 * Every mode, and whether a run in it owns the composer.
 *
 * Annotated `Record<TaskMode, …>`, which is the point of writing it this way:
 * a mode added to the union stops this file compiling until someone decides
 * what the composer does about it. `awaiting_model_choice` reached the mode
 * union, the backend's cancellable statuses and the run pane's Stop while this
 * module said nothing about it, and a list of only the modes someone
 * remembered to type could never have caught that.
 *
 * `interrupted` is entered here with no recoveryDisposition, which is the
 * reading that releases. The dispositions get their own cases below.
 */
const COMPOSER_OWNERSHIP: Record<TaskMode, 'claims' | 'releases'> = {
  setup: 'releases',
  queued: 'claims',
  running: 'claims',
  // Released deliberately, and not by this change: the answer a run awaiting
  // human input is waiting for is given in the right pane's own panel, not in
  // the composer. It is the one mode where the misrouting argument below and
  // the surface that collects the answer disagree, and settling that is a
  // product decision, not a test matrix's.
  awaiting_input: 'releases',
  awaiting_model_choice: 'claims',
  interrupted: 'releases',
  done: 'releases',
  error: 'releases',
  blocked: 'releases',
  cancelled: 'releases',
}

// `Object.entries` types its keys as `string` whatever the object. The map
// above is declared total over `TaskMode`, so this restores what was written.
const OWNERSHIP_CASES = Object.entries(COMPOSER_OWNERSHIP) as ReadonlyArray<
  [TaskMode, 'claims' | 'releases']
>

describe('workflow run ownership of the composer', () => {
  it.each(OWNERSHIP_CASES)('a %s run %s the composer', (mode, ownership) => {
    const state = ask({ tasks: [makeTask({ mode })] })
    if (ownership === 'releases') {
      expect(state).toEqual({ notice: null, taskId: null })
      return
    }
    expect(state.taskId).toBe('task-1')
    expect(state.notice).not.toBeNull()
  })

  it('claims the composer while the run is running', () => {
    expect(ask({ tasks: [makeTask({ mode: 'running' })] })).toEqual({
      notice:
        'Deep Research Report is running. Chat is paused until it finishes, or until you stop the run.',
      taskId: 'task-1',
    })
  })

  /**
   * A run waiting for capacity is queued, and the notice has to say so. The
   * strip beside it shows a Queued icon and the start toast says "Waiting for
   * execution capacity"; a composer claiming the same run is running would be
   * the only one of the three that is wrong.
   *
   * It still claims the composer. A queued run has no conversation to read a
   * message either, so an open box would hand it to the General Agent — the
   * misrouting this rule exists to close — and queued becomes running with no
   * user action, so an open box would also be a race between typing and Send.
   */
  it('says a run waiting for capacity is queued, and still claims the composer', () => {
    expect(ask({ tasks: [makeTask({ mode: 'queued' })] })).toEqual({
      notice:
        'Deep Research Report is queued. Chat is paused until it finishes, or until you stop the run.',
      taskId: 'task-1',
    })
  })

  /**
   * A run stopped on a model choice has released its worker but not finished:
   * the decision is taken in the run pane, the continuation runs as a new
   * attempt, and the backend still accepts a cancel for it. Releasing the
   * composer here sent the user's next message to the General Agent while the
   * run pane beside it was still offering Stop for the same task.
   *
   * The notice says what the run is waiting for. "Running" would contradict
   * the pane's own "Model choice required" and describe work nothing is doing.
   */
  it('claims the composer for a run waiting on a model choice, and says so', () => {
    expect(ask({ tasks: [makeTask({ mode: 'awaiting_model_choice' })] })).toEqual({
      notice:
        'Deep Research Report is waiting for a model choice. Chat is paused until it finishes, or until you stop the run.',
      taskId: 'task-1',
    })
  })

  /**
   * The window this rule was written for. An automatic recovery is a run that
   * has not ended: it will speak again, so a composer released here would send
   * the user's next message to the General Agent — exactly the hole the notice
   * exists to close.
   *
   * It does not say "recovering". Automatic recovery is admitted when the task
   * queue starts, so between a worker dying and the next start nothing is
   * recovering, and the composer was the only surface claiming otherwise.
   */
  it('keeps the composer for an interrupted run that is waiting to resume', () => {
    expect(
      ask({
        tasks: [makeTask({ mode: 'interrupted', recoveryDisposition: 'automatic' })],
      }),
    ).toEqual({
      notice:
        'Deep Research Report is waiting to resume. Chat is paused until it finishes, or until you stop the run.',
      taskId: 'task-1',
    })
  })

  it.each(['manual', 'not_resumable'] as const)(
    'releases the composer when an interrupted run needs %s recovery',
    (recoveryDisposition) => {
      expect(
        ask({ tasks: [makeTask({ mode: 'interrupted', recoveryDisposition })] }),
      ).toEqual({ notice: null, taskId: null })
    },
  )

  it('names the Workflow, not the generated task id', () => {
    expect(
      ask({ tasks: [makeTask({ taskId: '3d50e57a4293', workflowId: 'packaged-smoke' })] }).notice,
    ).toBe(
      'Packaged Smoke is running. Chat is paused until it finishes, or until you stop the run.',
    )
  })

  /**
   * `label` is the generated task id whenever the record carries no
   * workflowId, so reaching for it as a name prints the very id this notice
   * promises never to show.
   */
  it('never prints the task id for a run whose record names no Workflow', () => {
    expect(
      ask({
        tasks: [
          makeTask({
            taskId: '3d50e57a4293',
            workflowId: undefined,
            label: '3d50e57a4293',
          }),
        ],
      }),
    ).toEqual({
      notice:
        'The workflow is running. Chat is paused until it finishes, or until you stop the run.',
      taskId: '3d50e57a4293',
    })
  })

  it('reads the newest task alone, so a finished run does not speak for the session', () => {
    expect(
      ask({ tasks: [makeTask(), makeTask({ taskId: 'task-2', mode: 'done' })] }),
    ).toEqual({ notice: null, taskId: null })
  })

  it('says nothing about a session that has run nothing', () => {
    expect(ask({ tasks: [] })).toEqual({ notice: null, taskId: null })
  })

  it('leaves a Team run to the composer, which states and stops it itself', () => {
    expect(ask({ hasTeamChatTask: true })).toEqual({ notice: null, taskId: null })
  })

  it('leaves a scheduled run to the schedule that fired it', () => {
    expect(
      ask({ scheduledNotice: 'Scheduled research is running. Please wait.' }),
    ).toEqual({ notice: null, taskId: null })
  })
})
