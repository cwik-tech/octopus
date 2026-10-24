/// <reference types="node" />
import { createServer } from 'node:http'
import { once } from 'node:events'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { Toaster, toast } from 'sonner'
import { agentQuestionViewSchema } from '@contracts/agent-questions'
import { useAgentQuestions } from '../use-agent-questions'

function Conversation({ revision }: { revision: string }) {
  const { messages, waitingTaskIds, readTaskIds } = useAgentQuestions('session-one', revision)
  return <><Toaster /><div data-waiting-tasks={[...waitingTaskIds].sort().join(',')} data-read-tasks={[...readTaskIds].sort().join(',')}>
    {messages.map((message) => <p key={message.id} data-agent-id={message.speaker?.id}
      data-interaction-id={message.agentQuestion?.interactionId} data-dispatch-id={message.agentQuestion?.dispatchId}>{message.text}</p>)}
  </div></>
}

function makeQuestionView(overrides: Record<string, unknown>) {
  return agentQuestionViewSchema.parse({
    interactionId: 'question-one', revision: 0, taskId: 'task-one', sessionId: 'session-one',
    requestDigest: 'a'.repeat(64), requestedAt: '2026-09-19T12:00:00.000Z', questionIds: ['recipient'],
    agentId: 'writer', agentDisplayName: 'Writer', dispatchId: 'dispatch-one', childRunId: 'child-one',
    status: 'pending', canSubmit: true,
    request: { progress: 'I need the recipient.', questions: [{ question: 'Who?', reason: 'Required.' }] },
    ...overrides,
  })
}

afterEach(() => { cleanup(); toast.dismiss(); sessionStorage.clear() })

it('keeps the current questions readable and offers a retry when a refresh fails', async () => {
  const question = agentQuestionViewSchema.parse({
    interactionId: 'question-one', revision: 0, taskId: 'task-one', sessionId: 'session-one',
    requestDigest: 'a'.repeat(64), requestedAt: '2026-09-19T12:00:00.000Z', questionIds: ['recipient'],
    agentId: 'writer', agentDisplayName: 'Writer', dispatchId: 'dispatch-one', childRunId: 'child-one',
    status: 'pending', canSubmit: true,
    request: { progress: 'I need the recipient.', questions: [{ question: 'Who?', reason: 'Required.' }] },
  })
  const responses = [{ status: 200, body: [question] }, { status: 503, body: [] }, { status: 200, body: [] }]
  const server = createServer((_request, response) => {
    const next = responses.shift()
    response.writeHead(next?.status ?? 500, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(next?.body ?? []))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  sessionStorage.setItem('pipeline.desktop-api-base-url', `http://127.0.0.1:${address.port}/_pipeline/${'a'.repeat(43)}`)
  try {
    const conversation = render(<Conversation revision="task-one:0" />)
    const progress = await screen.findByText('I need the recipient.')
    expect(progress).toHaveAttribute('data-agent-id', 'writer')
    expect(progress).toHaveAttribute('data-interaction-id', 'question-one')
    expect(progress).toHaveAttribute('data-dispatch-id', 'dispatch-one')
    conversation.rerender(<Conversation revision="task-one:1" />)
    await screen.findByText('Could not load agent questions.')
    expect(screen.getByText('I need the recipient.')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(screen.queryByText('I need the recipient.')).not.toBeInTheDocument())
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it('reports only the tasks whose question is still unresolved', async () => {
  const byTask: Record<string, unknown[]> = {
    'task-waiting': [makeQuestionView({ interactionId: 'waiting-one', taskId: 'task-waiting', status: 'submitted', canSubmit: false, answers: { recipient: 'Marta' } })],
    'task-done': [makeQuestionView({ interactionId: 'done-one', taskId: 'task-done', status: 'resolved', canSubmit: false, answers: { recipient: 'Marta' } })],
  }
  const server = createServer((request, response) => {
    const taskId = decodeURIComponent(request.url?.split('/tasks/')[1]?.split('/')[0] ?? '')
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(byTask[taskId] ?? []))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  sessionStorage.setItem('pipeline.desktop-api-base-url', `http://127.0.0.1:${address.port}/_pipeline/${'a'.repeat(43)}`)
  try {
    render(<Conversation revision="task-waiting:0|task-done:0" />)

    await waitFor(() => expect(document.querySelector('[data-waiting-tasks]'))
      .toHaveAttribute('data-waiting-tasks', 'task-waiting'))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it('reads a run\'s questions several at a time without opening one request per task', async () => {
  // Every response is held open, so the number outstanding IS the number in
  // flight. Nothing here depends on how fast this machine answers.
  const held: Array<() => void> = []
  let peakInFlight = 0
  const server = createServer((_request, response) => {
    held.push(() => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('[]')
    })
    peakInFlight = Math.max(peakInFlight, held.length)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  sessionStorage.setItem('pipeline.desktop-api-base-url', `http://127.0.0.1:${address.port}/_pipeline/${'a'.repeat(43)}`)
  const taskIds = Array.from({ length: 8 }, (_value, index) => `task-${index}`)
  try {
    render(<Conversation revision={taskIds.map((id) => `${id}:0`).join('|')} />)

    // Hold the first wave until the full limit has arrived, so the parallelism
    // assertion is deliberate rather than a race the drain happens to win.
    await waitFor(() => expect(held.length).toBe(4))

    // Then drain all eight, always waiting for the next arrival rather than for
    // the queue to look empty, so a later wave is never left held forever.
    for (let released = 0; released < taskIds.length; released += 1) {
      await waitFor(() => expect(held.length).toBeGreaterThan(0))
      expect(held.length).toBeLessThanOrEqual(4)
      held.shift()?.()
    }

    await waitFor(() => expect(document.querySelector('[data-read-tasks]'))
      .toHaveAttribute('data-read-tasks', [...taskIds].sort().join(',')))
    expect(peakInFlight).toBe(4)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

it('stops claiming a task is read once a newer revision has not been loaded yet', async () => {
  const held: Array<() => void> = []
  let answered = 0
  const server = createServer((_request, response) => {
    const send = () => {
      answered += 1
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end('[]')
    }
    if (answered === 0) { send(); return }
    held.push(send)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing loopback address')
  sessionStorage.setItem('pipeline.desktop-api-base-url', `http://127.0.0.1:${address.port}/_pipeline/${'a'.repeat(43)}`)
  try {
    const conversation = render(<Conversation revision="task-one:0" />)
    await waitFor(() => expect(document.querySelector('[data-read-tasks]'))
      .toHaveAttribute('data-read-tasks', 'task-one'))

    // The task now awaits an agent answer. Until that newer revision is read,
    // the projection must not answer for it from the previous load.
    conversation.rerender(<Conversation revision="task-one:1" />)

    await waitFor(() => expect(held.length).toBe(1))
    await waitFor(() => expect(document.querySelector('[data-read-tasks]'))
      .toHaveAttribute('data-read-tasks', ''))

    held[0]?.()

    await waitFor(() => expect(document.querySelector('[data-read-tasks]'))
      .toHaveAttribute('data-read-tasks', 'task-one'))
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})
