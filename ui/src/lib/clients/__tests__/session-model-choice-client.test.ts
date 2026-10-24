/**
 * The task model-choice boundary, which crosses the network.
 *
 * An offer names a pair a person is about to authorise. Half of one displayed
 * as whole would ask them to agree to something nobody can state, so the
 * decoder proves the entire shape before it calls the result an offer — the
 * scope and its identifiers, both pairs whole, the reason from the allowlist,
 * and an optional field only when it is the right type.
 *
 * The approval carries the offer identity and an idempotency key and nothing
 * else: a body that could name a pair would be an arbitrary model-override API.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  approveTaskModelChoice,
  getTaskModelChoice,
  MODEL_CHOICE_REQUEST_TIMEOUT_MS,
} from '@/lib/clients/session-client'

const SESSION_ID = 'session-1'
const TASK_ID = 'task-1'

function validOffer(): Record<string, unknown> {
  return {
    offerId: 'offer-1',
    scope: { kind: 'task', sessionId: SESSION_ID, taskId: TASK_ID },
    agentName: 'writer',
    logicalInvocationId: 'write',
    expectedRevision: '3',
    failedChoice: { provider: 'connection:absent', model: 'fake/pinned' },
    proposedDefault: { provider: 'connection:present', model: 'fake/default' },
    reason: 'missing-credential',
  }
}

/** The shape the desktop API actually returns for a task. */
function admittedTask(status = 'queued'): Record<string, unknown> {
  return {
    id: TASK_ID,
    sessionId: SESSION_ID,
    runId: 'run-1',
    workflowId: 'wf-1',
    brief: 'Draft.',
    status,
    createdAt: '2026-09-06T10:00:00.000Z',
    updatedAt: '2026-09-06T10:00:01.000Z',
    cwd: '/tmp/task-1',
    runPath: '/tmp/run-1',
    assignmentPath: '/tmp/assignment-1',
    inputSnapshotPath: '/tmp/input-1',
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

let fetchMock: Mock<typeof fetch>

beforeEach(() => {
  fetchMock = vi.fn<typeof fetch>()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getTaskModelChoice', () => {
  it('returns a fully proven offer', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ workflowRevision: 4, stepId: 'write', offer: validOffer() }),
    )
    const result = await getTaskModelChoice(SESSION_ID, TASK_ID)
    expect(result?.stepId).toBe('write')
    expect(result?.offer.proposedDefault).toEqual({
      provider: 'connection:present',
      model: 'fake/default',
    })
  })

  it('reads a task with nothing pending as no decision rather than a failure', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    expect(await getTaskModelChoice(SESSION_ID, TASK_ID)).toBeNull()
  })

  for (const malformed of [
    {
      name: 'a scope of the wrong kind',
      offer: { ...validOffer(), scope: { kind: 'chat', sessionId: SESSION_ID, turnId: 't' } },
    },
    {
      name: 'a task scope missing its task id',
      offer: { ...validOffer(), scope: { kind: 'task', sessionId: SESSION_ID } },
    },
    {
      name: 'a failed pair with no model',
      offer: { ...validOffer(), failedChoice: { provider: 'connection:absent' } },
    },
    {
      name: 'a proposed pair with no provider',
      offer: { ...validOffer(), proposedDefault: { model: 'fake/default' } },
    },
    {
      name: 'a reason outside the allowlist',
      offer: { ...validOffer(), reason: 'because' },
    },
    {
      name: 'an optional invocation id of the wrong type',
      offer: { ...validOffer(), logicalInvocationId: 7 },
    },
    {
      name: 'a missing expected revision',
      offer: (() => {
        const offer = validOffer()
        delete offer.expectedRevision
        return offer
      })(),
    },
  ]) {
    it(`refuses ${malformed.name}`, async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ workflowRevision: 4, stepId: 'write', offer: malformed.offer }),
      )
      await expect(getTaskModelChoice(SESSION_ID, TASK_ID)).rejects.toThrow()
    })
  }

  // Shape is not content. A revision that is not a whole count, or an
  // identifier that is blank once trimmed, names nothing a person could be
  // shown or a server could be asked about.
  for (const malformed of [
    { name: 'a fractional revision', envelope: { workflowRevision: 4.5 } },
    { name: 'a negative revision', envelope: { workflowRevision: -1 } },
    { name: 'an infinite revision', envelope: { workflowRevision: Number.POSITIVE_INFINITY } },
    { name: 'a blank step id', envelope: { stepId: '   ' } },
    { name: 'a blank offer id', offer: { offerId: ' ' } },
    { name: 'a blank agent name', offer: { agentName: '\t' } },
    { name: 'a blank expected revision', offer: { expectedRevision: '' } },
    { name: 'a blank invocation id', offer: { logicalInvocationId: '  ' } },
    { name: 'a blank failed provider', offer: { failedChoice: { provider: ' ', model: 'm' } } },
    { name: 'a blank proposed model', offer: { proposedDefault: { provider: 'p', model: ' ' } } },
  ]) {
    it(`refuses ${malformed.name}`, async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          workflowRevision: 4,
          stepId: 'write',
          ...malformed.envelope,
          offer: { ...validOffer(), ...malformed.offer },
        }),
      )
      await expect(getTaskModelChoice(SESSION_ID, TASK_ID)).rejects.toThrow()
    })
  }

  // A well-formed offer is not thereby this task's offer. What the person
  // approves is a pair for one named agent on one named task, so the scope has
  // to be the task that was asked about — otherwise a response meant for a
  // different task could be shown here and approved against this path.
  for (const foreign of [
    {
      name: 'another session',
      scope: { kind: 'task', sessionId: 'session-2', taskId: TASK_ID },
    },
    {
      name: 'another task in this session',
      scope: { kind: 'task', sessionId: SESSION_ID, taskId: 'task-2' },
    },
  ]) {
    it(`refuses an otherwise valid offer scoped to ${foreign.name}`, async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({
          workflowRevision: 4,
          stepId: 'write',
          offer: { ...validOffer(), scope: foreign.scope },
        }),
      )
      await expect(getTaskModelChoice(SESSION_ID, TASK_ID)).rejects.toThrow()
    })
  }
})

describe('model-choice request lifetime', () => {
  // The pane can be closed, or the task can move on, while a read is in flight.
  // Both requests take a signal so a caller can stop waiting; and each carries
  // its own deadline, because a request that never settles leaves a decision
  // surface stuck on "loading" with nothing to act on.
  it('passes the caller’s signal through and abandons the read when it aborts', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation((_url: unknown, init: unknown) => {
      const signal = isRecord(init) && init.signal instanceof AbortSignal ? init.signal : null
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Aborted', 'AbortError')),
          { once: true },
        )
      })
    })

    const read = getTaskModelChoice(SESSION_ID, TASK_ID, { signal: controller.signal })
    controller.abort()
    await expect(read).rejects.toThrow()
  })

  // Driven by the deadline actually firing rather than by a mocked clock: the
  // rejection is the event this waits on.
  it('gives up on a read that never answers', async () => {
    fetchMock.mockImplementation((_url: unknown, init: unknown) => {
      const signal = isRecord(init) && init.signal instanceof AbortSignal ? init.signal : null
      return new Promise((_resolve, reject) => {
        signal?.addEventListener(
          'abort',
          () => reject(new DOMException('Timed out', 'TimeoutError')),
          { once: true },
        )
      })
    })

    await expect(
      getTaskModelChoice(SESSION_ID, TASK_ID, { timeoutMs: 5 }),
    ).rejects.toThrow()
  })

  it('has a deadline even when the caller names none', () => {
    expect(MODEL_CHOICE_REQUEST_TIMEOUT_MS).toBeGreaterThan(0)
  })
})

describe('approveTaskModelChoice', () => {
  it('sends only the offer identity and an idempotency key', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ task: admittedTask(), stepId: 'write' }, 202),
    )
    await approveTaskModelChoice(SESSION_ID, TASK_ID, {
      offerId: 'offer-1',
      idempotencyKey: 'key-1',
    })
    const sent = fetchMock.mock.calls.map(([url, init]) => {
      const body: unknown = isRecord(init) ? JSON.parse(String(init.body)) : undefined
      return { url: String(url), method: isRecord(init) ? init.method : undefined, body }
    })
    const modelChoiceUrl: unknown = expect.stringContaining(
      `/sessions/${SESSION_ID}/tasks/${TASK_ID}/model-choice`,
    )
    expect(sent).toEqual([
      {
        url: modelChoiceUrl,
        method: 'POST',
        body: { offerId: 'offer-1', idempotencyKey: 'key-1' },
      },
    ])
  })

  it('returns the admitted task so the caller can refresh from it', async () => {
    // The 202 already carries the task the approval produced. Discarding it
    // would make the panel guess when to re-read, and a guess is what leaves a
    // stale pane after the run resumes.
    fetchMock.mockResolvedValue(
      jsonResponse(
        { task: admittedTask('queued'), stepId: 'write', workflowRevision: 5 },
        202,
      ),
    )
    const result = await approveTaskModelChoice(SESSION_ID, TASK_ID, {
      offerId: 'offer-1',
      idempotencyKey: 'key-1',
    })
    expect(result.stepId).toBe('write')
    expect(result.task.id).toBe(TASK_ID)
    expect(result.task.status).toBe('queued')
  })

  // The path said which task was being approved. A response naming a different
  // one is not an answer to that request, however well formed it is, and
  // adopting it would point the pane at a task nobody approved.
  for (const foreign of [
    { name: 'a different task', task: { ...admittedTask(), id: 'task-2' } },
    { name: 'a different session', task: { ...admittedTask(), sessionId: 'session-2' } },
  ]) {
    it(`refuses an approval answered for ${foreign.name}`, async () => {
      fetchMock.mockResolvedValue(
        jsonResponse({ task: foreign.task, stepId: 'write' }, 202),
      )
      await expect(
        approveTaskModelChoice(SESSION_ID, TASK_ID, {
          offerId: 'offer-1',
          idempotencyKey: 'key-1',
        }),
      ).rejects.toThrow()
    })
  }

  it('refuses an approval answered for a blank step', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ task: admittedTask(), stepId: '  ' }, 202),
    )
    await expect(
      approveTaskModelChoice(SESSION_ID, TASK_ID, {
        offerId: 'offer-1',
        idempotencyKey: 'key-1',
      }),
    ).rejects.toThrow()
  })

  it('refuses an approval response that does not carry a task', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ stepId: 'write' }, 202))
    await expect(
      approveTaskModelChoice(SESSION_ID, TASK_ID, {
        offerId: 'offer-1',
        idempotencyKey: 'key-1',
      }),
    ).rejects.toThrow()
  })
})
