// Pure, view-agnostic helpers for turning a RunEvent stream into the shapes the
// stage renderers consume. Kept out of the .tsx component files so they can be
// shared without tripping react-refresh's "only export components" rule.

import type { RunEvent } from './index'

// ── Pipeline steps ──────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'done' | 'error'

export interface PipelineStep {
  stepIndex: number
  /** Display name derived from the first event in the group that has stageName. */
  stepName: string | undefined
  status: StepStatus
  artifactIn: string | undefined
  artifactOut: string | undefined
  /**
   * Run id of the child run this step delegated to (from workflow.step.completed).
   * The step's input/output artifacts live in this run's directory, so it is the
   * correct run id to fetch them from — not the parent run.
   */
  childRunId: string | undefined
  events: RunEvent[]
}

/**
 * Derives an ordered list of pipeline steps from the event stream.
 *
 * Strategy:
 * - Collect all events that carry a `stepIndex` field and group them.
 * - The step with the highest index that currently has events is `running`.
 * - All lower-index steps are `done` (they preceded the current one).
 * - Steps that are yet to receive events are not shown (unknowable in advance).
 *
 * `artifactIn` is taken from the first event in a group that has it;
 * `artifactOut` from the last. `stepName` is taken from the first event
 * that has a `stageName` field.
 */
export function buildPipelineSteps(events: RunEvent[]): PipelineStep[] {
  const stepMap = new Map<number, RunEvent[]>()

  for (const event of events) {
    if (event.stepIndex === undefined) continue
    const bucket = stepMap.get(event.stepIndex) ?? []
    bucket.push(event)
    stepMap.set(event.stepIndex, bucket)
  }

  const sortedIndices = Array.from(stepMap.keys()).sort((a, b) => a - b)
  const maxIdx = sortedIndices.at(-1)
  if (maxIdx === undefined) return []

  return sortedIndices.map((idx) => {
    const stepEvents = stepMap.get(idx)
    if (!stepEvents) throw new Error(`Pipeline step ${idx} has no event bucket`)

    // A step is done if a higher-index step exists (it ran after this one),
    // or if a terminal event (artifact.written, run.completed) was emitted.
    const isExplicitlyFailed = stepEvents.some((e) => e.type === 'workflow.step.failed')
    const isExplicitlyDone = stepEvents.some(
      (e) =>
        e.type === 'artifact.written' ||
        e.type === 'run.completed' ||
        e.type === 'workflow.step.completed' ||
        e.type === 'workflow.step.failed',
    )
    const status: StepStatus = isExplicitlyFailed
      ? 'error'
      : idx < maxIdx || isExplicitlyDone
        ? 'done'
        : 'running'

    const stepName = stepEvents.find((e) => e.stageName)?.stageName

    const artifactIn = stepEvents.find((e) => e.artifactIn)?.artifactIn
    const artifactOut = [...stepEvents]
      .reverse()
      .find((e) => e.artifactOut)?.artifactOut
    const childRunId = [...stepEvents].reverse().find((e) => e.childRunId)?.childRunId

    return { stepIndex: idx, stepName, status, artifactIn, artifactOut, childRunId, events: stepEvents }
  })
}

// ── Discussion / agent activity ─────────────────────────────────────────────

/**
 * Whether a RunEvent has something worth showing in the agent activity view.
 * Structural events (gate.transition, run.*, etc.) that carry no human-readable
 * content are skipped.
 */
export function isDisplayable(event: RunEvent): boolean {
  if (event.content) return true
  if (event.type === 'artifact.written' || event.type === 'artifact.delivery_selected') return true
  // tool.execution_logged events sometimes lack a content field but are
  // still meaningful in a discussion context
  if (event.type === 'tool.execution_logged') return true
  return false
}
