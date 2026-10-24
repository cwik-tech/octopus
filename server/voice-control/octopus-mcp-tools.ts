/**
 * The tools Octopus offers a voice layer. Each one sends the REST request the
 * window would send and turns the JSON reply into a sentence that can be read
 * aloud, with the data in `structuredContent`.
 */
import { randomUUID } from 'node:crypto'

import * as z from 'zod/v4'

import { isValidSessionId } from '../../contracts/sessions.js'
import { UNTITLED_SESSION_TITLE } from '../../domains/sessions/session-title.js'
import { createDialogueMcpTools, type DialogueMcpToolOptions } from './dialogue-mcp-tools.js'

import {
  defineAppMcpTool,
  type AppMcpTool,
  type AppMcpToolAnnotations,
  type AppMcpToolContext,
  type AppMcpToolResult,
} from './app-mcp-endpoint.js'
import type { LoopbackRestClient, RestResponse } from './loopback-rest-client.js'
import {
  findPendingQuestion,
  modelChoiceSchema,
  pendingQuestionSentence,
} from './pending-questions.js'
import {
  discardEmptyCreatedSession,
  failure,
  notFound,
  openingSentences,
  pathSegment,
  sessionPath,
  validateAgentIds,
} from './tool-support.js'

const READ_ONLY: AppMcpToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

const WRITE: AppMcpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
}

/** Stops or throws away work, so the voice layer asks for a spoken "yes". */
const DESTRUCTIVE: AppMcpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
}

const idSchema = z.string().trim().min(1).max(128)
/**
 * Sessions and tasks are named by UUID. Anything else is refused here, before
 * it can become a path segment: `..` survives encodeURIComponent, and the URL
 * parser would resolve it out of `/sessions` with the API token attached.
 */
const recordIdSchema = z.string().trim().refine(isValidSessionId, { error: 'Expected a UUID' })
const briefSchema = z.string().trim().min(1).max(20_000)

const sessionSchema = z.looseObject({ id: z.string(), title: z.string() })

const taskSchema = z.looseObject({
  id: z.string(),
  sessionId: z.string(),
  status: z.string(),
  workflowId: z.string().optional(),
  teamId: z.string().optional(),
  createdAt: z.string().optional(),
  completedAt: z.string().optional(),
  admission: z.looseObject({ source: z.string().optional() }).optional(),
})
type TaskView = z.infer<typeof taskSchema>

const STATUS_PHRASES: Readonly<Record<string, string>> = {
  queued: 'is waiting to start',
  running: 'is running',
  awaiting_input: 'is waiting for your answer',
  awaiting_model_choice: 'is waiting for you to choose a model',
  interrupted: 'was interrupted',
  done: 'is done',
  failed: 'failed',
  blocked: 'is blocked',
  cancelled: 'was cancelled',
}

function taskName(task: TaskView): string {
  return task.teamId ?? task.workflowId ?? 'The task'
}

function taskSentence(task: TaskView): string {
  return `${taskName(task)} ${STATUS_PHRASES[task.status] ?? `is ${task.status}`}.`
}

function taskView(task: TaskView): Record<string, unknown> {
  return {
    id: task.id,
    sessionId: task.sessionId,
    status: task.status,
    ...(task.workflowId === undefined ? {} : { workflowId: task.workflowId }),
    ...(task.teamId === undefined ? {} : { teamId: task.teamId }),
    ...(task.createdAt === undefined ? {} : { createdAt: task.createdAt }),
    ...(task.completedAt === undefined ? {} : { completedAt: task.completedAt }),
    ...(task.admission?.source === undefined ? {} : { admission: { source: task.admission.source } }),
  }
}

const chatMessageSchema = z.looseObject({
  id: z.string(),
  role: z.string(),
  text: z.string(),
})

const resultSchema = z.looseObject({
  id: z.string(),
  producer: z.looseObject({ kind: z.string(), id: z.string(), label: z.string() }),
  status: z.string(),
  completedAt: z.string().optional(),
  brief: z.string().optional(),
  excerpt: z.string().optional(),
  producerTaskId: z.string().optional(),
  source: z.discriminatedUnion('kind', [
    z.looseObject({ kind: z.literal('chat-message'), messageId: z.string() }),
    z.looseObject({ kind: z.literal('run-summary'), runId: z.string() }),
    z.looseObject({ kind: z.literal('artifact'), runId: z.string(), path: z.string() }),
  ]),
})
type ResultView = z.infer<typeof resultSchema>

/** How much of a result `read_result` returns in `structuredContent`. */
const MAX_RESULT_TEXT = 24_000
/** How much of an answer `ask` speaks. The rest is in `structuredContent`. */
const MAX_SPOKEN_ANSWER = 1_500

/** The most of a report or stream frame that is ever held in memory. */
const MAX_READ_BYTES = 256 * 1024

/**
 * Reads at most `maxBytes` of a body and cancels the rest, so a large file is
 * never held whole.
 */
async function readTextPrefix(
  response: Response,
  maxBytes: number,
): Promise<{ readonly text: string; readonly truncated: boolean }> {
  if (!response.body) return { text: '', truncated: false }
  const decoder = new TextDecoder()
  let text = ''
  let bytes = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return { text: text + decoder.decode(), truncated: false }
      const room = maxBytes - bytes
      if (value.byteLength > room) {
        text += decoder.decode(value.subarray(0, room), { stream: true })
        return { text: text + decoder.decode(), truncated: true }
      }
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** Reports that can be read aloud. Media and office files stay in the window. */
const SPOKEN_REPORT_EXTENSIONS = new Set(['.md', '.markdown', '.txt', '.json', '.csv', '.yaml', '.yml'])
const SAFE_RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/
// A path segment of an artifact: printable, no separators, no dot segments.
const SAFE_PATH_SEGMENT = /^[^/\\\u0000-\u001f]{1,255}$/

/**
 * The REST path of a readable report, or undefined when its location is not
 * one this tool reads: a malformed run ID, a dot or empty segment, a control
 * character, or a file that is not text.
 */
function reportPath(runId: string, artifactPath: string): string | undefined {
  if (!SAFE_RUN_ID.test(runId)) return undefined
  const segments = artifactPath.split('/')
  if (segments.length > 32) return undefined
  for (const segment of segments) {
    if (segment === '.' || segment === '..' || !SAFE_PATH_SEGMENT.test(segment)) return undefined
  }
  const last = segments[segments.length - 1] ?? ''
  const dot = last.lastIndexOf('.')
  if (dot === -1 || !SPOKEN_REPORT_EXTENSIONS.has(last.slice(dot).toLowerCase())) return undefined
  return `/runs/${encodeURIComponent(runId)}/assignments/${segments.map(encodeURIComponent).join('/')}`
}

const workflowListSchema = z.object({
  workflows: z.array(z.looseObject({ id: z.string(), description: z.string().optional() })),
})

const teamListSchema = z.object({
  teams: z.array(z.looseObject({ id: z.string(), name: z.string().optional(), description: z.string().optional() })),
})

const agentListSchema = z.object({
  agents: z.array(z.looseObject({ name: z.string(), description: z.string().optional() })),
})

const sessionListSchema = z.object({
  sessions: z.array(z.looseObject({ id: z.string(), title: z.string() })),
})

/** Changes only what the window shows. */
const UI_ONLY: AppMcpToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
}

export interface OctopusMcpToolOptions extends DialogueMcpToolOptions {
  /** Brings the window forward with a session open. Absent without a window. */
  readonly show?: (target: { readonly sessionId: string; readonly taskId?: string }) => Promise<void>
}

export function createOctopusMcpTools(
  rest: LoopbackRestClient,
  options: OctopusMcpToolOptions = {},
): readonly AppMcpTool<unknown>[] {
  /** The chat to use, creating one titled `title` when none was named. */
  const resolveSession = async (
    sessionId: string | undefined,
    title: string,
    signal: AbortSignal,
  ): Promise<{ readonly sessionId: string } | { readonly failure: AppMcpToolResult }> => {
    if (sessionId !== undefined) return { sessionId }
    const response = await rest.request('POST', '/sessions', { body: { title }, signal })
    const parsed = sessionSchema.safeParse(response.body)
    if (response.status >= 300 || !parsed.success) {
      return { failure: failure(response, 'create a chat for it') }
    }
    return { sessionId: parsed.data.id }
  }

  const startTask = async (
    sessionId: string,
    body: Record<string, unknown>,
    label: string,
    signal: AbortSignal,
  ): Promise<AppMcpToolResult> => {
    const response = await rest.request('POST', sessionPath(sessionId, 'tasks'), { body, signal })
    const parsed = taskSchema.safeParse(response.body)
    if (response.status !== 202 || !parsed.success) return failure(response, `start ${label}`)
    return {
      summary: `Started ${label}. I'll tell you when it needs you or finishes.`,
      structured: {
        sessionId: parsed.data.sessionId,
        taskId: parsed.data.id,
        status: parsed.data.status,
        task: taskView(parsed.data),
      },
    }
  }

  /**
   * Turns each piece of a turn's live text into a progress notification. The
   * text stream is display-only, so a stream that fails or never opens costs
   * the progress and nothing else.
   */
  const followTextStream = async (
    sessionId: string,
    turnId: string,
    signal: AbortSignal,
    sendProgress: AppMcpToolContext['sendProgress'],
  ): Promise<void> => {
    try {
      const response = await rest.open(
        `${sessionPath(sessionId, 'agent-chat', 'stream')}?channelId=${encodeURIComponent(turnId)}`,
        signal,
      )
      if (!response.ok || !response.body) {
        await response.body?.cancel()
        return
      }
      const decoder = new TextDecoder()
      let buffered = ''
      let pieces = 0
      let announced = false
      for await (const chunk of response.body) {
        buffered += decoder.decode(chunk, { stream: true })
        // A frame never comes near this. A stream that does is not followed.
        if (buffered.length > MAX_READ_BYTES) return
        let boundary = buffered.indexOf('\n\n')
        while (boundary !== -1) {
          const event = buffered.slice(0, boundary)
          buffered = buffered.slice(boundary + 2)
          if (!announced && /^event: (?:selection|delta)$/m.test(event)) {
            announced = true
            options.sessionChanged?.(sessionId)
          }
          if (/^event: delta$/m.test(event)) {
            pieces += 1
            await sendProgress(pieces, 'Writing the answer')
          }
          boundary = buffered.indexOf('\n\n')
        }
      }
    } catch {
      // Ended by the turn finishing, by cancellation, or by a fault. Either way
      // the answer still comes from the turn itself.
    }
  }

  const readResultText = async (
    sessionId: string,
    result: ResultView,
    signal: AbortSignal,
  ): Promise<{ readonly text: string } | { readonly failure: AppMcpToolResult }> => {
    const source = result.source
    if (source.kind === 'chat-message') {
      const response = await rest.request('GET', sessionPath(sessionId, 'messages'), { signal })
      const parsed = z.object({ messages: z.array(chatMessageSchema) }).safeParse(response.body)
      if (response.status !== 200 || !parsed.success) return { failure: failure(response, 'read that answer') }
      const message = parsed.data.messages.find((entry) => entry.id === source.messageId)
      if (!message) return { failure: notFound('That answer is no longer in the chat.') }
      return { text: message.text }
    }
    if (source.kind === 'artifact') {
      const location = reportPath(source.runId, source.path)
      if (location === undefined) {
        return { failure: notFound('That result is a file I can\'t read aloud. Open it in Octopus.') }
      }
      const response = await rest.open(location, signal)
      if (!response.ok) {
        await response.body?.cancel()
        return { failure: notFound('I couldn\'t open that report.') }
      }
      return { text: (await readTextPrefix(response, MAX_READ_BYTES)).text }
    }
    // A chat-only Team keeps its output in its run, which has no text of its
    // own to read back, so the stored opening is what there is.
    if (result.excerpt) return { text: result.excerpt }
    return { failure: notFound('That team finished in its chat. Open it in Octopus to read it.') }
  }

  return [
    ...createDialogueMcpTools(rest, options),
    defineAppMcpTool({
      name: 'list_workflows',
      title: 'List workflows',
      description: 'Lists the workflows you can start, with what each one does.',
      annotations: READ_ONLY,
      input: z.object({}),
      run: async (_input, { signal }) => {
        const response = await rest.request('GET', '/workflows', { signal })
        const parsed = workflowListSchema.safeParse(response.body)
        if (response.status !== 200 || !parsed.success) return failure(response, 'list the workflows')
        const workflows = parsed.data.workflows.map((workflow) => ({
          id: workflow.id,
          ...(workflow.description === undefined ? {} : { description: workflow.description }),
        }))
        return {
          summary: countSentence(workflows.length, 'workflow', workflows.map((workflow) => workflow.id)),
          structured: { workflows },
        }
      },
    }),
    defineAppMcpTool({
      name: 'list_teams',
      title: 'List teams',
      description: 'Lists the teams you can start on a brief.',
      annotations: READ_ONLY,
      input: z.object({}),
      run: async (_input, { signal }) => {
        const response = await rest.request('GET', '/create/team-builder/teams', { signal })
        const parsed = teamListSchema.safeParse(response.body)
        if (response.status !== 200 || !parsed.success) return failure(response, 'list the teams')
        const teams = parsed.data.teams.map((team) => ({
          id: team.id,
          ...(team.name === undefined ? {} : { name: team.name }),
          ...(team.description === undefined ? {} : { description: team.description }),
        }))
        return {
          summary: countSentence(teams.length, 'team', teams.map((team) => team.name ?? team.id)),
          structured: { teams },
        }
      },
    }),
    defineAppMcpTool({
      name: 'list_agents',
      title: 'List agents',
      description: 'Lists the agents you can ask questions in a chat.',
      annotations: READ_ONLY,
      input: z.object({}),
      run: async (_input, { signal }) => {
        const response = await rest.request('GET', '/create/agents', { signal })
        const parsed = agentListSchema.safeParse(response.body)
        if (response.status !== 200 || !parsed.success) return failure(response, 'list the agents')
        const agents = parsed.data.agents.map((agent) => ({
          name: agent.name,
          ...(agent.description === undefined ? {} : { description: agent.description }),
        }))
        return {
          summary: countSentence(agents.length, 'agent', agents.map((agent) => agent.name)),
          structured: { agents },
        }
      },
    }),
    defineAppMcpTool({
      name: 'list_sessions',
      title: 'List chats',
      description: 'Lists your chats (sessions), most recent first, with their IDs.',
      annotations: READ_ONLY,
      input: z.object({}),
      run: async (_input, { signal }) => {
        const response = await rest.request('GET', '/sessions', { signal })
        const parsed = sessionListSchema.safeParse(response.body)
        if (response.status !== 200 || !parsed.success) return failure(response, 'list your chats')
        const sessions = parsed.data.sessions.map((session) => ({ id: session.id, title: session.title }))
        return {
          summary: countSentence(sessions.length, 'chat', sessions.map((session) => session.title)),
          structured: { sessions },
        }
      },
    }),
    defineAppMcpTool({
      name: 'create_session',
      title: 'Create a chat',
      description: 'Creates a new chat (session) to start work in.',
      annotations: WRITE,
      input: z.object({ title: z.string().trim().min(1).max(200).optional() }),
      run: async ({ title }, { signal }) => {
        const response = await rest.request('POST', '/sessions', {
          body: title === undefined ? {} : { title },
          signal,
        })
        const parsed = sessionSchema.safeParse(response.body)
        if (response.status >= 300 || !parsed.success) return failure(response, 'create the chat')
        return {
          summary: `Created the chat ${parsed.data.title}.`,
          structured: { session: { id: parsed.data.id, title: parsed.data.title } },
        }
      },
    }),
    defineAppMcpTool({
      name: 'start_workflow',
      title: 'Start a workflow',
      description:
        'Starts a workflow on a brief and returns a task ID at once. The result arrives later as a notification. ' +
        'Without a sessionId, a new chat is created for it.',
      annotations: WRITE,
      input: z.object({
        sessionId: recordIdSchema.optional(),
        workflowId: idSchema,
        brief: briefSchema,
      }),
      run: async ({ sessionId, workflowId, brief }, { signal }) => {
        const session = await resolveSession(sessionId, workflowId, signal)
        if ('failure' in session) return session.failure
        return startTask(session.sessionId, { workflowId, brief }, workflowId, signal)
      },
    }),
    defineAppMcpTool({
      name: 'start_team',
      title: 'Start a team',
      description:
        'Starts a team on a brief and returns a task ID at once. The result arrives later as a notification. ' +
        'Without a sessionId, a new chat is created for it.',
      annotations: WRITE,
      input: z.object({
        sessionId: recordIdSchema.optional(),
        teamId: idSchema,
        brief: briefSchema,
      }),
      run: async ({ sessionId, teamId, brief }, { signal }) => {
        const session = await resolveSession(sessionId, teamId, signal)
        if ('failure' in session) return session.failure
        return startTask(session.sessionId, { teamId, brief }, teamId, signal)
      },
    }),
    defineAppMcpTool({
      name: 'get_task',
      title: 'Check a task',
      description: 'Says where a task is: waiting, running, waiting for you, done, failed or cancelled.',
      annotations: READ_ONLY,
      input: z.object({ sessionId: recordIdSchema, taskId: recordIdSchema }),
      run: async ({ sessionId, taskId }, { signal }) => {
        const response = await rest.request('GET', sessionPath(sessionId, 'tasks', taskId), { signal })
        const parsed = taskSchema.safeParse(response.body)
        if (response.status !== 200 || !parsed.success) return failure(response, 'find that task')
        return { summary: taskSentence(parsed.data), structured: { task: taskView(parsed.data) } }
      },
    }),
    defineAppMcpTool({
      name: 'list_tasks',
      title: 'List tasks in a chat',
      description: 'Lists the tasks started in a chat, with their status.',
      annotations: READ_ONLY,
      input: z.object({ sessionId: recordIdSchema }),
      run: async ({ sessionId }, { signal }) => {
        const response = await rest.request('GET', sessionPath(sessionId, 'tasks'), { signal })
        const parsed = z.object({ tasks: z.array(taskSchema) }).safeParse(response.body)
        if (response.status !== 200 || !parsed.success) return failure(response, 'list the tasks')
        const tasks = parsed.data.tasks
        return {
          summary: tasks.length === 0
            ? 'This chat has no tasks.'
            : tasks.slice(0, 5).map(taskSentence).join(' '),
          structured: { tasks: tasks.map(taskView) },
        }
      },
    }),
    defineAppMcpTool({
      name: 'ask',
      title: 'Ask an agent',
      description:
        'Asks an agent in a chat and returns its answer. Sends progress while the answer is written. ' +
        'Without agentName the chat\'s own coordinator answers; without sessionId a new chat is created. ' +
        'This synchronous tool has a 120-second REST deadline; a caller may set a shorter deadline. For long work, start a workflow instead.',
      annotations: WRITE,
      input: z.object({
        sessionId: recordIdSchema.optional(),
        agentName: idSchema.describe('Agent ID returned as a name by list_agents; do not use a display label.').optional(),
        text: briefSchema,
      }),
      run: async ({ sessionId, agentName, text }, { signal, sendProgress }) => {
        if (agentName !== undefined) {
          const refused = await validateAgentIds(rest, [agentName], signal)
          if (refused) return refused
        }
        const session = await resolveSession(sessionId, UNTITLED_SESSION_TITLE, signal)
        if ('failure' in session) return session.failure
        const turnId = randomUUID()
        const streamStop = new AbortController()
        const following = followTextStream(
          session.sessionId,
          turnId,
          AbortSignal.any([signal, streamStop.signal]),
          sendProgress,
        )
        let response: RestResponse
        try {
          response = await rest.request('POST', sessionPath(session.sessionId, 'messages'), {
            body: {
              text,
              turnId,
              ...(agentName === undefined ? {} : { target: { kind: 'agents', agentNames: [agentName] } }),
            },
            signal,
          })
        } finally {
          streamStop.abort()
          await following
        }
        const parsed = z.object({ messages: z.array(chatMessageSchema) }).safeParse(response.body)
        if (response.status >= 300 || !parsed.success) {
          if (sessionId === undefined && response.status >= 400 && response.status < 500) {
            await discardEmptyCreatedSession(rest, session.sessionId, signal)
          }
          return failure(response, 'ask that')
        }
        options.sessionChanged?.(session.sessionId)
        const replies = parsed.data.messages.filter((message) => message.role === 'assistant')
        const answer = replies.map((message) => message.text).join('\n\n').trim()
        return {
          summary: answer === '' ? 'No answer came back.' : answer.slice(0, MAX_SPOKEN_ANSWER),
          structured: {
            sessionId: session.sessionId,
            turnId,
            answer,
            messages: replies.map((message) => ({ id: message.id, text: message.text })),
          },
        }
      },
    }),
    defineAppMcpTool({
      name: 'list_results',
      title: 'List results',
      description: 'Lists the finished results in a chat: agent answers, team and workflow outputs.',
      annotations: READ_ONLY,
      input: z.object({ sessionId: recordIdSchema }),
      run: async ({ sessionId }, { signal }) => {
        const response = await rest.request('GET', sessionPath(sessionId, 'results'), { signal })
        const parsed = z.object({ results: z.array(resultSchema) }).safeParse(response.body)
        if (response.status !== 200 || !parsed.success) return failure(response, 'list the results')
        const results = parsed.data.results.map(resultView)
        return {
          summary: countSentence(results.length, 'result', parsed.data.results.map((result) => result.producer.label)),
          structured: { results },
        }
      },
    }),
    defineAppMcpTool({
      name: 'read_result',
      title: 'Read a result',
      description:
        'Reads a result aloud: its opening sentences first, the full text in the data. ' +
        'Name it by resultId, or by the taskId that produced it.',
      annotations: READ_ONLY,
      input: z
        .object({
          sessionId: recordIdSchema,
          resultId: idSchema.optional(),
          taskId: recordIdSchema.optional(),
        })
        .refine((value) => value.resultId !== undefined || value.taskId !== undefined, {
          error: 'Name the result by resultId or taskId',
        }),
      run: async ({ sessionId, resultId, taskId }, { signal }) => {
        const response = await rest.request('GET', sessionPath(sessionId, 'results'), { signal })
        const parsed = z.object({ results: z.array(resultSchema) }).safeParse(response.body)
        if (response.status !== 200 || !parsed.success) return failure(response, 'find that result')
        const result = parsed.data.results.find((entry) =>
          resultId !== undefined ? entry.id === resultId : entry.producerTaskId === taskId,
        )
        if (!result) return notFound('That result isn\'t ready yet.')
        const read = await readResultText(sessionId, result, signal)
        if ('failure' in read) return read.failure
        const opening = openingSentences(read.text)
        return {
          summary: opening === '' ? 'The result is empty.' : opening,
          structured: {
            result: resultView(result),
            text: read.text.slice(0, MAX_RESULT_TEXT),
            truncated: read.text.length > MAX_RESULT_TEXT,
          },
        }
      },
    }),
    defineAppMcpTool({
      name: 'get_question',
      title: 'Read what a task is waiting for',
      description:
        'Says what a task waiting for you needs: feedback on a workflow step, answers to an agent\'s questions, ' +
        'or approval to retry a failed model on the default.',
      annotations: READ_ONLY,
      input: z.object({ sessionId: recordIdSchema, taskId: recordIdSchema }),
      run: async ({ sessionId, taskId }, { signal }) => {
        const found = await findPendingQuestion(rest, sessionId, taskId, signal)
        if ('failure' in found) return found.failure
        const pending = found.pending
        return {
          summary: pendingQuestionSentence(pending),
          structured:
            pending.kind === 'feedback'
              ? { kind: pending.kind, text: pending.sourceText.slice(0, MAX_RESULT_TEXT) }
              : pending.kind === 'questions'
                ? { kind: pending.kind, agentName: pending.agentName, questions: [...pending.questions] }
                : pending.kind === 'model_choice'
                  ? {
                      kind: pending.kind,
                      agentName: pending.agentName,
                      failedModel: pending.failedModel,
                      proposedModel: pending.proposedModel,
                      reason: pending.reason,
                    }
                  : { kind: pending.kind },
        }
      },
    }),
    defineAppMcpTool({
      name: 'answer_question',
      title: 'Answer a task',
      description:
        'Answers what a task is waiting for. For workflow feedback, `answer` is the feedback; leave it out to continue ' +
        'without feedback. For agent questions, give `answer` for one question or `answers` in question order.',
      annotations: WRITE,
      input: z.object({
        sessionId: recordIdSchema,
        taskId: recordIdSchema,
        answer: z.string().trim().min(1).max(8_000).optional(),
        answers: z.array(z.string().trim().min(1).max(8_000)).min(1).max(8).optional(),
      }),
      run: async ({ sessionId, taskId, answer, answers }, { signal }) => {
        const found = await findPendingQuestion(rest, sessionId, taskId, signal)
        if ('failure' in found) return found.failure
        const pending = found.pending
        if (pending.kind === 'feedback') {
          const response = await rest.request(
            'POST',
            sessionPath(sessionId, 'tasks', taskId, 'human-in-the-loop', pending.interactionId, 'submit'),
            {
              body: {
                submissionId: randomUUID(),
                expectedWorkflowRevision: pending.workflowRevision,
                expectedSourceArtifactSha256: pending.sourceSha256,
                mode: answer === undefined ? 'continue_without_feedback' : 'feedback',
                messages: answer === undefined ? [] : [{ id: randomUUID(), text: answer, recipients: 'all' }],
              },
              signal,
            },
          )
          if (response.status !== 202) return failure(response, 'send your feedback')
          return {
            summary: answer === undefined ? 'The workflow continues without feedback.' : 'Sent. The workflow continues.',
            structured: { kind: pending.kind, status: 'submitted' },
          }
        }
        if (pending.kind === 'questions') {
          const given = answers ?? (answer === undefined ? [] : [answer])
          if (given.length !== pending.questionIds.length) {
            return {
              summary: `This needs ${pending.questionIds.length} answers, one for each question.`,
              structured: { kind: pending.kind, needed: pending.questionIds.length, given: given.length },
              isError: true,
            }
          }
          const response = await rest.request(
            'POST',
            sessionPath(sessionId, 'tasks', taskId, 'agent-questions', pending.interactionId, 'submit'),
            {
              body: {
                taskId,
                sessionId,
                interactionId: pending.interactionId,
                expectedInteractionRevision: pending.revision,
                expectedRequestDigest: pending.requestDigest,
                submissionId: randomUUID(),
                answers: Object.fromEntries(pending.questionIds.map((id, index) => [id, given[index] ?? ''])),
              },
              signal,
            },
          )
          if (response.status !== 202) return failure(response, 'send your answer')
          return {
            summary: `Sent to ${pending.agentName}. The task continues.`,
            structured: { kind: pending.kind, status: 'submitted' },
          }
        }
        return {
          summary: pending.kind === 'model_choice'
            ? 'There\'s no question waiting on this task. It is waiting for a model choice; use choose_model.'
            : 'There\'s no question waiting on this task.',
          structured: { kind: pending.kind },
          isError: true,
        }
      },
    }),
    defineAppMcpTool({
      name: 'choose_model',
      title: 'Retry on the default model',
      description:
        'Approves the one retry a task offers after its model failed: the same step again, on the app\'s default model.',
      annotations: WRITE,
      input: z.object({ sessionId: recordIdSchema, taskId: recordIdSchema }),
      run: async ({ sessionId, taskId }, { signal }) => {
        const path = sessionPath(sessionId, 'tasks', taskId, 'model-choice')
        const offered = await rest.request('GET', path, { signal })
        const parsed = modelChoiceSchema.safeParse(offered.body)
        if (offered.status !== 200 || !parsed.success) {
          return offered.status === 404
            ? notFound('This task isn\'t waiting for a model choice.')
            : failure(offered, 'read the model choice')
        }
        const response = await rest.request('POST', path, {
          body: { offerId: parsed.data.offer.offerId, idempotencyKey: randomUUID() },
          signal,
        })
        const accepted = z.looseObject({ task: taskSchema }).safeParse(response.body)
        if (response.status !== 202 || !accepted.success) return failure(response, 'approve the retry')
        return {
          summary: `Retrying on ${parsed.data.offer.proposedDefault.model}.`,
          structured: { task: taskView(accepted.data.task) },
        }
      },
    }),
    defineAppMcpTool({
      name: 'show',
      title: 'Show in Octopus',
      description:
        'Brings the Octopus window forward with a chat open, the one that holds the task when a taskId is given.',
      annotations: UI_ONLY,
      input: z.object({ sessionId: recordIdSchema, taskId: recordIdSchema.optional() }),
      run: async ({ sessionId, taskId }, { signal }) => {
        const response = await rest.request('GET', sessionPath(sessionId), { signal })
        const session = sessionSchema.safeParse(response.body)
        if (response.status !== 200 || !session.success) return failure(response, 'find that chat')
        if (taskId !== undefined) {
          const task = await rest.request('GET', sessionPath(sessionId, 'tasks', taskId), { signal })
          if (task.status !== 200) return failure(task, 'find that task')
        }
        if (options.show === undefined) {
          return {
            summary: 'Octopus is running with no window to show it in.',
            structured: { shown: false },
            isError: true,
          }
        }
        await options.show({ sessionId, ...(taskId === undefined ? {} : { taskId }) })
        return {
          summary: `Opened ${session.data.title} in Octopus.`,
          structured: { shown: true, sessionId, ...(taskId === undefined ? {} : { taskId }) },
        }
      },
    }),
    defineAppMcpTool({
      name: 'cancel_task',
      title: 'Cancel a task',
      description: 'Cancels a task. Work it has not finished is stopped.',
      annotations: DESTRUCTIVE,
      input: z.object({ sessionId: recordIdSchema, taskId: recordIdSchema }),
      run: async ({ sessionId, taskId }, { signal }) => {
        const response = await rest.request('DELETE', sessionPath(sessionId, 'tasks', taskId), { signal })
        const parsed = taskSchema.safeParse(response.body)
        if (response.status !== 200 || !parsed.success) return failure(response, 'cancel that task')
        return { summary: taskSentence(parsed.data), structured: { task: taskView(parsed.data) } }
      },
    }),
  ]
}

function resultView(result: ResultView): Record<string, unknown> {
  return {
    id: result.id,
    producer: { kind: result.producer.kind, id: result.producer.id, label: result.producer.label },
    status: result.status,
    ...(result.completedAt === undefined ? {} : { completedAt: result.completedAt }),
    ...(result.brief === undefined ? {} : { brief: result.brief }),
    ...(result.excerpt === undefined ? {} : { excerpt: result.excerpt }),
    ...(result.producerTaskId === undefined ? {} : { taskId: result.producerTaskId }),
  }
}

function countSentence(count: number, noun: string, names: readonly string[]): string {
  if (count === 0) return `There are no ${noun}s.`
  const plural = count === 1 ? noun : `${noun}s`
  const shown = names.slice(0, 5).join(', ')
  const more = names.length > 5 ? `, and ${names.length - 5} more` : ''
  return `${count} ${plural}: ${shown}${more}.`
}
