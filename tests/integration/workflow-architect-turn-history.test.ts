/**
 * What a reopened Create can learn about turns that already ran.
 *
 * The route records how each Workflow Architect turn chose its model, before
 * the provider is called and again when the turn ends. Nothing could read those
 * records back, so a person who reopened Create saw a transcript with no
 * account of which model produced it — and the only other way to answer would
 * be to re-derive it from Settings, which is exactly the wrong answer once the
 * default has moved on.
 *
 * Driven through the real route handler over a real store on disk, because the
 * property is that the *file* still says what ran.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { URL } from 'node:url'

import { CreateJobRegistry } from '../../server/create-job-registry.js'
import { handleWorkflowRoutes } from '../../server/routes/workflows.js'
import { TurnMetricStore } from '../../server/turn-metric-store.js'
import type { ResourceArchitectTurnMetric } from '../../contracts/resource-architect.js'

/** Bounded, so a route that never answers fails with a message. */
const DEADLINE_MS = 10_000

async function getJson(url: string): Promise<{
  status: number
  headers: Headers
  body: unknown
  text: string
}> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(DEADLINE_MS),
  })
  // Read once. Consuming the body inside an assertion message spends it, and
  // the parse that follows then fails for a reason unrelated to the test.
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = undefined
  }
  return { status: response.status, headers: response.headers, body, text }
}

const DIRECTORY = 'workflow-architect'

function metric(
  jobId: string,
  status: ResourceArchitectTurnMetric['status'],
  model: string,
): ResourceArchitectTurnMetric {
  return {
    schemaVersion: 1,
    recordedAt: '2026-09-09T10:00:00.000Z',
    jobId,
    operation: 'conversation',
    status,
    provider: 'connection:fixture',
    model,
    selection: {
      provider: 'connection:fixture',
      model,
      source: 'app-default',
      reason: 'agent-default',
      caller: 'authoring',
    },
    reasoning: 'medium',
    outcomeKind: null,
    fallback: false,
    timing: {
      contextAssemblyMs: 1,
      providerDurationMs: 2,
      processSpawnMs: null,
      firstProviderEventMs: null,
      firstTextMs: null,
      parseDurationMs: 1,
      repairOccurred: false,
      repairDurationMs: 0,
      totalDurationMs: 4,
      context: {
        instructionsChars: 1,
        operationChars: 1,
        uploadedDocumentPolicyChars: 0,
        visualizationPolicyChars: 0,
        teamLibraryChars: 0,
        agentLibraryChars: 0,
        totalChars: 2,
        historyChars: 0,
      },
    },
  }
}

/**
 * The real route, over a store built fresh on the same workspace.
 *
 * Fresh on purpose: a server handed the instance that wrote the rows would
 * answer from memory, and dropping the read from disk entirely would still
 * pass. What is under test is that the *file* still says what ran.
 */
async function startRouteServer(
  workspacePath: string,
): Promise<{ url: string; close: () => Promise<void> }> {
  const registry = new CreateJobRegistry()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    handleWorkflowRoutes({
      req,
      res,
      url,
      options: {
        repoRootPath: '/does-not-matter',
        workflowsRegistryPath: '/does-not-matter/registry.yaml',
        createJobRegistry: registry,
        isAbortLike: (error: unknown) =>
          error instanceof Error && error.name === 'AbortError',
        workflowArchitectTurnStore: new TurnMetricStore(
          workspacePath,
          DIRECTORY,
        ),
      },
    })
      .then((handled) => {
        if (!handled && !res.writableEnded) res.writeHead(404).end('{}')
      })
      .catch((error: unknown) => {
        // Reported rather than left to hang: a route that throws should fail a
        // test with its own message, not with a timeout.
        if (res.writableEnded) return
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: String(error) }))
      })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      registry.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

test('a finished turn can be read back with the pair it actually ran on', async () => {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'architect-history-')),
  )
  // Written by one store, served by another over the same directory.
  const store = new TurnMetricStore(workspacePath, DIRECTORY)
  const route = await startRouteServer(workspacePath)
  try {
    // Two turns, each recorded the way the route records them: a `running` row
    // written before the provider is called, replaced by the outcome.
    await store.save(metric('job-a', 'running', 'fake/app-default'))
    await store.save(metric('job-a', 'completed', 'fake/app-default'))
    await store.save(metric('job-b', 'running', 'fake/app-default'))
    await store.save(metric('job-b', 'completed', 'fake/app-default'))

    const response = await getJson(
      `${route.url}/create/workflow-architect/turns`,
    )
    assert.equal(response.status, 200, response.text)
    assert.equal(
      response.headers.get('cache-control'),
      'no-store',
      'history that can change must not be cached',
    )

    const payload = response.body as {
      turns?: { jobId?: string; selection?: { model?: string } }[]
    }
    assert.equal(payload.turns?.length, 2, JSON.stringify(payload))
    assert.deepEqual(
      payload.turns?.map((turn) => turn.jobId),
      ['job-a', 'job-b'],
      'one entry per turn, in the order they happened',
    )
    for (const turn of payload.turns ?? []) {
      assert.deepEqual(turn.selection, {
        provider: 'connection:fixture',
        model: 'fake/app-default',
        source: 'app-default',
        reason: 'agent-default',
        caller: 'authoring',
      })
    }
  } finally {
    await route.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a turn that never resolved a pair is reported without inventing one', async () => {
  // A turn that failed before choosing has no selection, and the reader must
  // not fill one in — from Settings or from anywhere else. It is still listed,
  // because the turn happened.
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'architect-history-none-')),
  )
  const store = new TurnMetricStore(workspacePath, DIRECTORY)
  const route = await startRouteServer(workspacePath)
  try {
    const { selection: _dropped, ...withoutSelection } = metric(
      'job-c',
      'failed',
      'fake/app-default',
    )
    await store.save(withoutSelection as ResourceArchitectTurnMetric)
    // Still in flight, and stopped: both are turns that happened, and neither
    // has an outcome that would justify inventing a pair for it.
    const { selection: _running, ...runningNoPair } = metric(
      'job-d',
      'running',
      'fake/app-default',
    )
    await store.save(runningNoPair as ResourceArchitectTurnMetric)
    const { selection: _cancelled, ...cancelledNoPair } = metric(
      'job-e',
      'cancelled',
      'fake/app-default',
    )
    await store.save(cancelledNoPair as ResourceArchitectTurnMetric)

    const response = await getJson(
      `${route.url}/create/workflow-architect/turns`,
    )
    const payload = response.body as {
      turns?: { jobId?: string; status?: string; selection?: unknown }[]
    }
    assert.deepEqual(
      payload.turns?.map((turn) => turn.jobId),
      ['job-c', 'job-d', 'job-e'],
      'every turn that happened is listed',
    )
    for (const turn of payload.turns ?? []) {
      assert.equal(turn.selection, undefined, `${turn.jobId} invented no pair`)
    }
  } finally {
    await route.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('history is bounded by what the caller asks for', async () => {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'architect-history-limit-')),
  )
  const store = new TurnMetricStore(workspacePath, DIRECTORY)
  const route = await startRouteServer(workspacePath)
  try {
    for (const jobId of ['job-1', 'job-2', 'job-3']) {
      await store.save(metric(jobId, 'completed', 'fake/app-default'))
    }

    const response = await getJson(
      `${route.url}/create/workflow-architect/turns?limit=2`,
    )
    const payload = response.body as { turns?: { jobId?: string }[] }
    assert.deepEqual(
      payload.turns?.map((turn) => turn.jobId),
      ['job-2', 'job-3'],
      'the most recent, not the oldest',
    )
  } finally {
    await route.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})


test('a pair somebody chose is reported as their choice, not as a default', async () => {
  // The reader publishes the record as written. Only an `app-default` record
  // describes a turn nobody picked a model for, and the panel discloses on that
  // basis — so a record that says `user` has to arrive saying `user`.
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'architect-history-explicit-')),
  )
  const store = new TurnMetricStore(workspacePath, DIRECTORY)
  const route = await startRouteServer(workspacePath)
  try {
    const chosen = metric('job-x', 'completed', 'fake/chosen')
    await store.save({
      ...chosen,
      selection: {
        provider: 'connection:fixture',
        model: 'fake/chosen',
        source: 'user',
        reason: 'explicit-user-choice',
        caller: 'authoring',
      },
    })

    const response = await getJson(
      `${route.url}/create/workflow-architect/turns`,
    )
    const payload = response.body as {
      turns?: { selection?: { source?: string; reason?: string } }[]
    }
    assert.equal(payload.turns?.[0]?.selection?.source, 'user')
    assert.equal(
      payload.turns?.[0]?.selection?.reason,
      'explicit-user-choice',
    )
  } finally {
    await route.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
