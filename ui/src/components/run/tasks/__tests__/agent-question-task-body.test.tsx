import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { TaskBody } from '../task-body'

afterEach(cleanup)

it('directs an agent question to its conversation card without a second answer form', () => {
  render(<TaskBody sessionId="session-one" task={{ taskId: 'task-one', runId: 'root-one', label: 'Dedication', mode: 'awaiting_input' }}
    events={[{ id: 'wait-one', type: 'workflow.agent_question.requested', ts: 1 }]} />)
  expect(screen.getByRole('button', { name: 'Answer in conversation' })).toBeVisible()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})

/**
 * The durable question list is the canonical answer for the revision it was
 * read at. Three outcomes, not two: this task is waiting on an agent question,
 * it is not, or the current answer has not been read yet.
 */
function renderAwaitingTask(projection: {
  readonly read?: ReadonlySet<string>
  readonly waiting?: ReadonlySet<string>
  readonly events: Array<{ id: string; type: string; ts: number }>
}) {
  render(<TaskBody sessionId="session-one" task={{ taskId: 'task-one', runId: 'root-one', label: 'Dedication', mode: 'awaiting_input' }}
    {...(projection.read ? { agentQuestionReadTaskIds: projection.read } : {})}
    {...(projection.waiting ? { agentQuestionWaitTaskIds: projection.waiting } : {})}
    events={projection.events} />)
}

it('trusts the durable question when the newest recorded event is a human-input request', () => {
  renderAwaitingTask({
    read: new Set(['task-one']), waiting: new Set(['task-one']),
    events: [
      { id: 'question-one', type: 'workflow.agent_question.requested', ts: 1 },
      { id: 'human-one', type: 'workflow.human_input.requested', ts: 2 },
    ],
  })
  expect(screen.getByRole('button', { name: 'Answer in conversation' })).toBeVisible()
})

it('shows the predefined human step when a read question list holds nothing unresolved', () => {
  renderAwaitingTask({
    read: new Set(['task-one']), waiting: new Set(),
    // A stale agent-question event is still the newest of the two.
    events: [
      { id: 'human-one', type: 'workflow.human_input.requested', ts: 1 },
      { id: 'question-one', type: 'workflow.agent_question.requested', ts: 2 },
    ],
  })
  expect(screen.queryByRole('button', { name: 'Answer in conversation' })).not.toBeInTheDocument()
  // Rendering nothing must not satisfy this: the predefined step is what shows.
  expect(screen.getByText('Loading human input…')).toBeVisible()
})

it('waits rather than guessing when this task\'s questions have not been read yet', () => {
  renderAwaitingTask({
    read: new Set(), waiting: new Set(),
    events: [{ id: 'human-one', type: 'workflow.human_input.requested', ts: 1 }],
  })
  expect(screen.queryByRole('button', { name: 'Answer in conversation' })).not.toBeInTheDocument()
  expect(screen.getByRole('status').textContent).toContain('Checking what this task is waiting for')
})
