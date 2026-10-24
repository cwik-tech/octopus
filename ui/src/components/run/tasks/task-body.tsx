import {
  Activity,
  Info,
  Network,
} from 'lucide-react'

import { ArtifactPreviewSheet } from '@/components/run/pickers/artifact-preview-sheet'
import { useEffect, useState, type ReactElement } from 'react'

import { ProcessTimelineTable } from '@/components/process-timeline-table'
import TaskSetupControls from '@/components/run/tasks/task-setup-controls'
import type { ArtifactPreviewTarget, RunEvent } from '@/components/run/stage-renderers/index'
import { SlotHoldNotice, TaskRunSummary } from '@/components/run/tasks/task-run-summary'
import { HumanInputPanel } from '@/components/run/tasks/human-input-panel'
import { TaskModelChoicePanel } from '@/components/run/tasks/task-model-choice-panel'
import type { TaskRunEntry } from '@/components/run/tasks/task-strip'
import { getWorkflowStages } from '@/lib/clients/session-client'
import type { WorkflowStageInfo } from '@/lib/models/session-model'
import type { SessionTask } from '@contracts/sessions'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  buildExecutionProjectionFromRootEvents,
  type EngineEventCategory,
  type EngineEventEnvelope,
} from '@/lib/models/runtime-model'

// ── Props ──────────────────────────────────────────────────────────────────

export interface TaskBodyProps {
  task: TaskRunEntry
  sessionId: string
  runName?: string
  onCancelTask?: (taskId: string) => void
  onResumeTask?: (taskId: string) => void
  /** The task an approved model choice admitted, ready to be adopted. */
  onModelChoiceApproved?: ((task: SessionTask) => void) | undefined
  /** Test seam for the model-choice idempotency key; production uses crypto. */
  newIdempotencyKey?: () => string
  isResuming?: boolean
  /**
   * Tasks whose durable agent question is still unresolved, for the revision
   * the conversation has actually read. Absent means unknown, not "no".
   */
  agentQuestionWaitTaskIds?: ReadonlySet<string>
  /** Tasks the conversation has actually read questions for, at this revision. */
  agentQuestionReadTaskIds?: ReadonlySet<string>
  /**
   * Live SSE events for this task.
   * T4 wires the SSE subscription in RunPanel and passes events here.
   * T6 will complete this wiring with dynamic stage-renderer selection.
   * Defaults to an empty array until wired.
   */
  events?: RunEvent[]
}

// ── SetupView ──────────────────────────────────────────────────────────────

function SetupView() {
  const [selectedWorkflow, setSelectedWorkflow] = useState<string | null>(null)

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <TaskSetupControls
        selectedWorkflow={selectedWorkflow}
        onSelectWorkflow={setSelectedWorkflow}
      />
    </div>
  )
}

// ── Declared stages ─────────────────────────────────────────────────────────

/**
 * Loads declared stages only to calculate the summary's completed-task ratio.
 */
function useDeclaredStages(workflowId: string | undefined): {
  stages: WorkflowStageInfo[]
} {
  const [stages, setStages] = useState<WorkflowStageInfo[]>([])

  useEffect(() => {
    // TaskProgressView is keyed by taskId, so this hook remounts per task and
    // workflowId is stable for its lifetime — no synchronous reset is needed.
    if (!workflowId) return

    let cancelled = false
    void getWorkflowStages(workflowId)
      .then((result) => {
        if (cancelled) return
        setStages(result)
      })
      .catch(() => {
        if (cancelled) return
        setStages([])
      })

    return () => {
      cancelled = true
    }
  }, [workflowId])

  return { stages }
}

function SectionLabel({
  icon: Icon,
  label,
}: {
  icon: typeof Activity
  label: string
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      <Icon className="size-3.5" />
      {label}
    </div>
  )
}

// ── Process timeline ───────────────────────────────────────────────────────

function inferEventCategory(type: string): EngineEventCategory {
  if (type.startsWith('run.')) return 'run'
  if (type.startsWith('agent.')) return 'agent'
  if (type.startsWith('tool.')) return 'tool'
  if (type.startsWith('artifact.')) return 'artifact'
  if (type.startsWith('delegation.')) return 'delegation'
  if (type.startsWith('gate.')) return 'gate'
  return 'stage'
}

function toTimelineEnvelope(
  event: RunEvent,
  rootRunId: string,
): EngineEventEnvelope {
  if (event.sourceEnvelope) return event.sourceEnvelope
  return {
    schema_version: 1,
    timestamp: new Date(event.ts).toISOString(),
    tenant_id: 'local',
    category: inferEventCategory(event.type),
    type: event.type,
    run_id: event.runId ?? rootRunId,
    root_run_id: rootRunId,
    level_id: event.stageName ?? null,
    stage_type: event.stageType ?? null,
    payload: {
      ...(event.agentName ? { agent_name: event.agentName } : {}),
      ...(event.artifactPath ? { path: event.artifactPath } : {}),
      ...(event.artifactType ? { artifact_type: event.artifactType } : {}),
      ...(event.artifactTitle ? { title: event.artifactTitle } : {}),
      ...(event.content ? { text: event.content } : {}),
      ...(event.errorMessage ? { error: event.errorMessage } : {}),
    },
  }
}

function ProcessTimelineView({
  events,
  onOpenArtifact,
  task,
}: {
  events: RunEvent[]
  onOpenArtifact: (target: ArtifactPreviewTarget) => void
  task: TaskRunEntry
}) {
  const envelopes = events.map((event) => toTimelineEnvelope(event, task.runId))
  const projection = buildExecutionProjectionFromRootEvents(task.runId, envelopes)

  return (
    <section
      aria-label="Process timeline"
      className="flex min-h-[30rem] flex-1 flex-col p-4 pr-5"
    >
      {projection.story.length === 0 ? (
        <>
          <div className="mb-3 flex shrink-0 items-center gap-1">
            <SectionLabel icon={Network} label="Process timeline" />
          </div>
          <div className="flex flex-1 items-center justify-center py-6 text-center text-xs text-muted-foreground">
            Waiting for the workflow to report process events…
          </div>
        </>
      ) : (
        <ProcessTimelineTable
          key={task.runId}
          items={projection.story}
          anchorByIndex={(index) => `run-process-event-${index}`}
          containerClassName="min-h-[24rem]"
          isArtifactSelected={() => false}
          onArtifactSelect={(target) =>
            onOpenArtifact({
              artifactPath: target.path,
              runId: target.runId || task.runId,
            })
          }
          toolbarStart={
            <>
              <SectionLabel icon={Network} label="Process timeline" />
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        aria-label="About process timeline"
                        className="text-muted-foreground"
                        size="icon-xs"
                        type="button"
                        variant="ghost"
                      />
                    }
                  >
                    <Info className="size-3.5" />
                  </TooltipTrigger>
                  <TooltipContent
                    align="start"
                    className="max-w-72 whitespace-normal leading-relaxed"
                    side="top"
                  >
                    End-to-end workflow events, including delegated teams,
                    artifacts, and failures.
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </>
          }
        />
      )}
    </section>
  )
}

function TaskProgressView({
  events,
  isResuming,
  onCancel,
  onResume,
  runName,
  task,
}: {
  events: RunEvent[]
  isResuming: boolean
  onCancel?: (() => void) | undefined
  onResume?: (() => void) | undefined
  runName?: string | undefined
  task: TaskRunEntry
}) {
  const [previewTarget, setPreviewTarget] = useState<ArtifactPreviewTarget | null>(null)
  const declaredStagesState = useDeclaredStages(task.workflowId)

  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <TaskRunSummary
          declaredStages={declaredStagesState.stages}
          events={events}
          isResuming={isResuming}
          onCancel={onCancel}
          onResume={onResume}
          runName={runName}
          task={task}
        />

        <ProcessTimelineView
          events={events}
          onOpenArtifact={setPreviewTarget}
          task={task}
        />
      </div>

      <ArtifactPreviewSheet
        open={previewTarget !== null}
        target={previewTarget}
        onOpenArtifact={setPreviewTarget}
        onOpenChange={(open) => {
          if (!open) setPreviewTarget(null)
        }}
      />
    </>
  )
}

// ── TaskBody ───────────────────────────────────────────────────────────────

/**
 * Right-pane body for a single TaskRunEntry.
 * Switches between task modes based on task.mode:
 *   setup     → WorkflowPicker
 *   awaiting_input → durable human-feedback surface
 *   awaiting_model_choice → the pending decision above the run's own record,
 *     because the question is about what runs next and is unanswerable without
 *     what already ran
 *   queued/running/interrupted/terminal → concise summary + process record
 *
 * Detailed blocked and error explanations belong to the center journey view,
 * so the right pane intentionally exposes status only.
 */
export function TaskBody({
  task,
  sessionId,
  runName,
  onCancelTask,
  onResumeTask,
  onModelChoiceApproved,
  newIdempotencyKey,
  isResuming = false,
  events = [],
  agentQuestionWaitTaskIds,
  agentQuestionReadTaskIds,
}: TaskBodyProps) {
  switch (task.mode) {
    case 'setup':
      return <SetupView />

    case 'queued':
    case 'running':
    case 'interrupted':
    case 'done':
    case 'error':
    case 'blocked':
    case 'cancelled':
      return (
        <TaskProgressView
          key={task.taskId}
          events={events}
          isResuming={isResuming}
          onCancel={
            onCancelTask
              ? () => onCancelTask(task.taskId)
              : undefined
          }
          onResume={
            onResumeTask
              ? () => onResumeTask(task.taskId)
              : undefined
          }
          runName={runName}
          task={task}
        />
      )

    case 'awaiting_model_choice':
      return (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <TaskModelChoicePanel
            // Keyed by session as well as task: an offer, its idempotency key
            // and the endpoint it came from all belong to one session, and a
            // session switch can leave the same task entry mounted for a render.
            key={`${sessionId}:${task.taskId}`}
            sessionId={sessionId}
            taskId={task.taskId}
            onApproved={onModelChoiceApproved}
            newIdempotencyKey={newIdempotencyKey}
          />
          <TaskProgressView
            key={`${task.taskId}:progress`}
            events={events}
            isResuming={isResuming}
            onCancel={
              onCancelTask
                ? () => onCancelTask(task.taskId)
                : undefined
            }
            onResume={
              onResumeTask
                ? () => onResumeTask(task.taskId)
                : undefined
            }
            runName={runName}
            task={task}
          />
        </div>
      )

    case 'awaiting_input': {
      // Which of the two waits this is has three answers, not two. The durable
      // question list decides it for the revision it was read at; a task that
      // list has not covered yet is unknown, and guessing from event order is
      // what put an agent question behind a second answer form. Only where no
      // projection is supplied at all does the event rule still decide.
      const projection = agentQuestionReadTaskIds && agentQuestionWaitTaskIds
        ? (agentQuestionReadTaskIds.has(task.taskId)
            ? (agentQuestionWaitTaskIds.has(task.taskId) ? 'agent-question' : 'human-step')
            : 'unread')
        : 'unavailable'
      // A wait held for its descendants still asks for its answer; the notice
      // only adds that its slot is still in use.
      const withSlotHold = (body: ReactElement): ReactElement => task.slotHold
        ? <>
            <div className="px-4 pt-4"><SlotHoldNotice slotHold={task.slotHold} /></div>
            {body}
          </>
        : body
      if (projection === 'unread') {
        return withSlotHold(<div className="space-y-3 p-4">
          <p role="status">Checking what this task is waiting for…</p>
        </div>)
      }
      const waitsOnAgentQuestion = projection === 'agent-question' || (projection === 'unavailable' &&
        events.filter((event) => event.type === 'workflow.agent_question.requested' || event.type === 'workflow.human_input.requested').at(-1)?.type === 'workflow.agent_question.requested')
      if (waitsOnAgentQuestion) {
        return withSlotHold(<div className="space-y-3 p-4">
          <p>Waiting for your answer in the conversation.</p>
          <Button variant="outline" onClick={() => {
            const card = Array.from(document.querySelectorAll<HTMLElement>('[data-agent-question-task]'))
              .find((element) => element.dataset.agentQuestionTask === task.taskId && element.querySelector('textarea'))
            card?.scrollIntoView({ block: 'center', behavior: 'smooth' })
            card?.querySelector('textarea')?.focus({ preventScroll: true })
          }}>Answer in conversation</Button>
        </div>)
      }
      return withSlotHold(
        <HumanInputPanel
          key={task.taskId}
          sessionId={sessionId}
          taskId={task.taskId}
        />,
      )
    }

    default:
      return null
  }
}

export default TaskBody
