/// <reference types="node" />
import { createServer } from 'node:http'
import { once } from 'node:events'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { agentQuestionViewSchema, submitAgentInputSchema } from '@contracts/agent-questions'
import { AgentQuestionCard } from '../agent-question-card'
import { DiscussionMessageCard } from '../../discussion/discussion-message-card'

function makeQuestion() {
  return agentQuestionViewSchema.parse({
    interactionId: 'question-one', revision: 1, taskId: 'task-one', sessionId: 'session-one',
    requestDigest: 'a'.repeat(64), requestedAt: '2026-09-19T12:00:00.000Z', questionIds: ['recipient'],
    agentId: 'writer', agentDisplayName: 'Writer', dispatchId: 'dispatch-one', childRunId: 'child-one',
    status: 'pending', canSubmit: true,
    request: { progress: 'I need the recipient.', questions: [{ question: 'Who is it for?', reason: 'The dedication needs a recipient.' }] },
  })
}

afterEach(() => { cleanup(); localStorage.clear(); sessionStorage.clear() })

it('keeps one answer form when the partial response is opened for reading', async () => {
  const user = userEvent.setup()
  const question = makeQuestion()
  const progress = <p>{question.request.progress}</p>
  render(<DiscussionMessageCard colorClass={null} readingContent={progress} message={{
    id: 'question-message', role: 'assistant', text: question.request.progress,
    createdAt: question.requestedAt, workflow: { taskId: question.taskId }, agentQuestion: question,
  }}>{progress}<AgentQuestionCard question={question} /></DiscussionMessageCard>)
  await user.type(screen.getByLabelText('Who is it for?'), 'Marta')
  await user.click(screen.getByRole('button', { name: 'Maximize message' }))
  await screen.findByRole('dialog')
  expect(screen.getAllByRole('textbox', { hidden: true })).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: 'Close' }))
  expect(screen.getByLabelText('Who is it for?')).toHaveValue('Marta')
})

it('restores a failed answer and retries the same submission before becoming read-only', async () => {
  const submissions: unknown[] = []
  const statuses = [503, 202]
  const server = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk: string) => { body += chunk })
    request.on('end', () => {
      submissions.push(submitAgentInputSchema.parse(JSON.parse(body)))
      response.writeHead(statuses.shift() ?? 500, { 'Content-Type': 'application/json' })
      response.end('{}')
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  sessionStorage.setItem('pipeline.desktop-api-base-url', `http://127.0.0.1:${address.port}/_pipeline/${'a'.repeat(43)}`)
  try {
    const question = makeQuestion()
    const first = render(<AgentQuestionCard question={question} />)
    expect(screen.getByRole('button', { name: 'Submit and continue' })).toBeDisabled()
    fireEvent.change(screen.getByLabelText('Who is it for?'), { target: { value: 'Marta' } })
    fireEvent.click(screen.getByRole('button', { name: 'Submit and continue' }))
    await screen.findByRole('alert')
    expect(screen.getByLabelText('Who is it for?')).toHaveValue('Marta')
    first.unmount()

    const second = render(<AgentQuestionCard question={question} />)
    expect(screen.getByLabelText('Who is it for?')).toHaveValue('Marta')
    fireEvent.click(screen.getByRole('button', { name: 'Submit and continue' }))
    await screen.findByText('Answer received; waiting to continue')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(submissions).toHaveLength(2)
    expect(submissions[1]).toEqual(submissions[0])
    second.rerender(<AgentQuestionCard question={{ ...question, status: 'resolved', canSubmit: false, answers: { recipient: 'Marta' } }} />)
    expect(screen.getByText('Answered')).toBeVisible()
    await waitFor(() => expect(localStorage.getItem('agent-question:session-one:task-one:question-one')).toBeNull())
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it('explains the total answer limit before allowing submission', () => {
  const question = makeQuestion()
  question.questionIds = ['a', 'b', 'c', 'd', 'e']
  question.request.questions = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ question: `Detail ${id}`, reason: 'Required detail.' }))
  render(<AgentQuestionCard question={question} />)
  fireEvent.change(screen.getByLabelText('Detail a'), { target: { value: 'a'.repeat(8_000) } })
  fireEvent.change(screen.getByLabelText('Detail b'), { target: { value: 'b'.repeat(8_000) } })
  fireEvent.change(screen.getByLabelText('Detail c'), { target: { value: 'c'.repeat(8_000) } })
  fireEvent.change(screen.getByLabelText('Detail d'), { target: { value: 'd'.repeat(8_000) } })
  fireEvent.change(screen.getByLabelText('Detail e'), { target: { value: 'e' } })
  expect(screen.getByRole('alert')).toHaveTextContent('32,000 characters in total')
  expect(screen.getByRole('button', { name: 'Submit and continue' })).toBeDisabled()
})

it('keeps the answered exchange visible and says why the run stopped when the agent asked again', () => {
  const question = makeQuestion()
  render(<AgentQuestionCard question={{
    ...question, status: 'resolved', canSubmit: false,
    answers: { recipient: 'Marta' }, blockCode: 'question_limit_reached',
  }} />)

  expect(screen.getByText('Who is it for?')).toBeTruthy()
  expect(screen.getByText('Marta')).toBeTruthy()
  expect(screen.getByRole('status').textContent).toContain('requested another question round')
})
