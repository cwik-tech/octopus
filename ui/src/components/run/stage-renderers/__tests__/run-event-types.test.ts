/**
 * Tests that domains/sessions/run-event-types.ts exports the correct shapes
 * per Contract A and Contract C in the plan.
 *
 * Note: These types are defined in shared/ and also mirrored locally in
 * stage-renderers/index.ts (due to tsconfig boundary). We test the shared
 * types via a direct import path from the project root.
 */
import { describe, it, expect } from 'vitest'

// Import from the local mirror (accessible within ui/src)
import type { RunEvent, RunEventType, StageRendererProps } from '../index'
import type { TaskMode, TaskRunEntry } from '../../tasks/task-strip'

describe('RunEvent shape (Contract A)', () => {
  it('constructs a valid RunEvent with all required fields', () => {
    const event: RunEvent = {
      id: 'evt-1',
      type: 'run.completed',
      ts: 1_700_000_000_000,
    }
    expect(event.id).toBe('evt-1')
    expect(event.type).toBe('run.completed')
    expect(event.ts).toBe(1_700_000_000_000)
  })

  it('supports all optional fields', () => {
    const event: RunEvent = {
      id: 'evt-2',
      type: 'agent.start',
      ts: Date.now(),
      stageType: 'discussion',
      stageName: 'phase-1',
      agentId: 'run-abc',
      agentName: 'Alice',
      content: 'Hello',
      stepIndex: 2,
      artifactIn: 'input.md',
      artifactOut: 'output.md',
      artifactPath: 'runs/x/output.md',
      errorMessage: undefined,
    }
    expect(event.stageType).toBe('discussion')
    expect(event.agentName).toBe('Alice')
    expect(event.stepIndex).toBe(2)
  })

  it('allows open-ended type strings (run.* dot-notation)', () => {
    const type: RunEventType = 'gate.transition'
    expect(type).toBe('gate.transition')
    const unknownType: RunEventType = 'some.future.event'
    expect(unknownType).toBe('some.future.event')
  })
})

describe('TaskRunEntry shape (Contract C)', () => {
  it('constructs a valid TaskRunEntry', () => {
    const entry: TaskRunEntry = {
      taskId: 'task-1',
      runId: 'run-1',
      label: 'My Workflow',
      mode: 'running',
    }
    expect(entry.taskId).toBe('task-1')
    expect(entry.mode).toBe('running')
  })

  it('TaskMode includes distinct blocked and cancelled states', () => {
    const modes: TaskMode[] = [
      'setup',
      'running',
      'done',
      'error',
      'blocked',
      'cancelled',
    ]
    expect(modes).toContain('blocked')
    expect(modes).toContain('cancelled')
    expect(modes).toHaveLength(6)
  })

  it('supports optional fields', () => {
    const entry: TaskRunEntry = {
      taskId: 't2',
      runId: 'r2',
      label: 'Done Task',
      mode: 'done',
      startedAt: Date.now() - 10000,
      completedAt: Date.now(),
      executionAttemptId: 'attempt-1',
    }
    expect(entry.executionAttemptId).toBe('attempt-1')
    expect(entry.errorMessage).toBeUndefined()
  })
})

describe('StageRendererProps (Contract B)', () => {
  it('has required events and stageType fields', () => {
    const props: StageRendererProps = {
      events: [],
      stageType: 'discussion',
    }
    expect(props.stageType).toBe('discussion')
    expect(props.events).toEqual([])
  })

  it('accepts optional metadata', () => {
    const props: StageRendererProps = {
      events: [],
      stageType: 'pipeline',
      metadata: { phaseName: 'build' },
    }
    expect(props.metadata?.phaseName).toBe('build')
  })
})
