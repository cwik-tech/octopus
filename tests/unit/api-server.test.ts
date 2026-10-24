import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  DEFAULT_EVENT_POLL_INTERVAL_MS,
  startApiServer,
} from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { logRuntimeEvent, logSessionStart } from '../../domains/runtime/logger.js'
import { appendProviderProtocolTranscriptEvent } from '../../domains/runtime/transcript.js'
import { recordDelegationLifecycle } from '../../domains/delegation/delegation-lifecycle.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'api-server-'))
}

/**
 * A throwaway repository root holding a real shipped team, with the workspace
 * directory the API server is pointed at nested inside it.
 *
 * `loadRunTeamFlow` derives the repository root as `path.dirname(workspacePath)`,
 * so a test that wants the shipped team definitions has to hand the server a
 * workspace path whose parent contains `teams/`. Deriving that from
 * `process.cwd()` would aim the whole composition — journal enrollment and the
 * workspace tenant pin included — at the developer's own gitignored `workspace/`
 * directory, which a forced-authoritative run then writes durable state into.
 * The team is copied rather than stubbed so the assertions still describe the
 * team the product actually ships.
 */
function makeTeamFlowRepo(teamName: string): {
  repoRootPath: string
  workspacePath: string
} {
  const repoRootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'api-server-flow-repo-'))
  fs.cpSync(
    path.join(process.cwd(), 'teams', teamName),
    path.join(repoRootPath, 'teams', teamName),
    { recursive: true },
  )
  const workspacePath = path.join(repoRootPath, 'workspace')
  fs.mkdirSync(workspacePath)
  return { repoRootPath, workspacePath }
}

function makeAgentArchitectRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-architect-repo-'))
  fs.mkdirSync(path.join(repoRoot, 'teams', 'workflow-architect'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'workflow-architect'), { recursive: true })
  fs.writeFileSync(
    path.join(repoRoot, 'teams', 'workflow-architect', 'team.yaml'),
    [
      'agents:',
      '  - name: workflow-architect',
      '    role: Architect',
      '    agent_file: ../../agents/workflow-architect/workflow-architect.md',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'workflow-architect', 'workflow-architect.md'),
    // The architect runs with its own agent file's pair.
    ['---', 'provider: openai', 'model: test-model', '---', '', 'Return an agent draft as JSON.', ''].join('\n'),
  )
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  return repoRoot
}

test('API server defaults run-event polling to 250 ms', () => {
  assert.equal(DEFAULT_EVENT_POLL_INTERVAL_MS, 250)
})

test('API server refuses non-loopback bind addresses', async () => {
  const workspacePath = makeWorkspace()
  await assert.rejects(
    startApiServer({
      host: '0.0.0.0',
      store: new FileSystemRunStore(workspacePath),
      launcher: {
        async startRun() {
          return { launched: true, pid: 1, cwd: workspacePath }
        },
      },
    }),
    /loopback-only/,
  )
  fs.rmSync(workspacePath, { recursive: true, force: true })
})

test('API server requires a master API token for a broker token', async () => {
  const workspacePath = makeWorkspace()
  await assert.rejects(
    startApiServer({
      brokerToken: 'broker-only-token',
      store: new FileSystemRunStore(workspacePath),
      launcher: {
        async startRun() {
          return { launched: true, pid: 1, cwd: workspacePath }
        },
      },
    }),
    /brokerToken requires apiToken/,
  )
  fs.rmSync(workspacePath, { recursive: true, force: true })
})

test('API server lists runs and returns run details', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'run-a')
  fs.mkdirSync(assignmentPath, { recursive: true })
  logSessionStart(assignmentPath, 'run-a', 'writing-team', ['writer'], 'root-a')

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 123, cwd: workspacePath }
      },
    },
  })

  try {
    const runsResponse = await fetch(`${server.url}/runs`)
    const runsPayload = await runsResponse.json() as { runs: Array<{ id: string }> }
    assert.equal(runsResponse.status, 200)
    assert.equal(requiredValue(runsPayload.runs[0], 'tests/unit/api-server.test.ts:104').id, 'run-a')

    const runResponse = await fetch(`${server.url}/runs/run-a`)
    const runPayload = await runResponse.json() as { id: string; status: string }
    assert.equal(runResponse.status, 200)
    assert.equal(runPayload.id, 'run-a')
    assert.equal(runPayload.status, 'incomplete')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server rejects missing and incorrect API tokens while accepting the tokenized URL', async () => {
  const workspacePath = makeWorkspace()
  const apiToken = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'
  const server = await startApiServer({
    apiToken,
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 123, cwd: workspacePath }
      },
    },
  })

  try {
    const baseUrl = `http://${server.host}:${server.port}`
    const missingTokenResponse = await fetch(`${baseUrl}/health`)
    const wrongTokenResponse = await fetch(
      `${baseUrl}/_pipeline/${'f'.repeat(apiToken.length)}/health`,
    )
    const correctTokenResponse = await fetch(`${server.url}/health`)

    assert.equal(missingTokenResponse.status, 401)
    assert.equal(wrongTokenResponse.status, 401)
    assert.equal(correctTokenResponse.status, 200)
    assert.deepEqual(await missingTokenResponse.json(), { error: 'Unauthorized' })
    assert.deepEqual(await wrongTokenResponse.json(), { error: 'Unauthorized' })
    assert.deepEqual(await correctTokenResponse.json(), { ok: true })
    assert.equal(missingTokenResponse.headers.get('cache-control'), 'no-store')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server keeps auth ahead of API routes and limits compatibility aliases', async () => {
  const workspacePath = makeWorkspace()
  const repoRootPath = fs.mkdtempSync(path.join(os.tmpdir(), 'api-route-aliases-'))
  const apiToken = 'route-table-auth-token'
  const server = await startApiServer({
    apiToken,
    repoRootPath,
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 123, cwd: workspacePath }
      },
    },
  })

  try {
    const baseUrl = `http://${server.host}:${server.port}`
    const unauthenticatedRoute = await fetch(`${baseUrl}/runs`)
    const createAlias = await fetch(`${server.url}/api/create/chat-defaults`)
    const unaliasedCreateRoot = await fetch(`${server.url}/api/create`)
    const teamAlias = await fetch(`${server.url}/api/team`)
    const teamCanonical = await fetch(`${server.url}/team`)
    const unaliasedApiPath = await fetch(`${server.url}/api/runs`)
    const teamSuffix = await fetch(`${server.url}/api/team/extra`)

    assert.equal(unauthenticatedRoute.status, 401)
    assert.equal(createAlias.status, 200)
    assert.equal(unaliasedCreateRoot.status, 404)
    assert.equal(teamAlias.status, 200)
    assert.equal(teamCanonical.status, 200)
    assert.equal(unaliasedApiPath.status, 404)
    assert.equal(teamSuffix.status, 404)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(repoRootPath, { recursive: true, force: true })
  }
})

test('API server permits authenticated loopback renderer CORS and rejects other preflight origins', async () => {
  const workspacePath = makeWorkspace()
  const server = await startApiServer({
    apiToken: 'desktop-dev-cors-token',
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 123, cwd: workspacePath }
      },
    },
  })

  try {
    const rendererOrigin = 'http://127.0.0.1:5173'
    const healthResponse = await fetch(`${server.url}/health`, {
      headers: { origin: rendererOrigin },
    })
    const preflightResponse = await fetch(`${server.url}/sessions`, {
      method: 'OPTIONS',
      headers: {
        origin: rendererOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type,x-filename',
      },
    })
    const disallowedResponse = await fetch(`${server.url}/sessions`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://example.com',
        'access-control-request-method': 'POST',
      },
    })

    assert.equal(healthResponse.status, 200)
    assert.equal(
      healthResponse.headers.get('access-control-allow-origin'),
      rendererOrigin,
    )
    assert.equal(preflightResponse.status, 204)
    assert.equal(
      preflightResponse.headers.get('access-control-allow-origin'),
      rendererOrigin,
    )
    assert.match(
      preflightResponse.headers.get('access-control-allow-headers') ?? '',
      /x-filename/,
    )
    assert.equal(disallowedResponse.status, 403)
    assert.equal(disallowedResponse.headers.get('access-control-allow-origin'), null)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server serves assignment artifacts through the store boundary', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'run-artifact')
  fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
  logSessionStart(assignmentPath, 'run-artifact', 'writing-team', ['writer'], 'root-artifact')
  fs.writeFileSync(path.join(assignmentPath, 'output', 'report.md'), 'artifact-body')

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 123, cwd: workspacePath }
      },
    },
  })

  try {
    const response = await fetch(`${server.url}/runs/run-artifact/assignments/output/report.md`)
    const text = await response.text()

    assert.equal(response.status, 200)
    assert.equal(text, 'artifact-body')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server serves DOCX artifacts byte-for-byte as attachments', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'run-docx-artifact')
  fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
  logSessionStart(assignmentPath, 'run-docx-artifact', 'writing-team', ['writer'], 'root-docx')
  const expected = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10])
  fs.writeFileSync(path.join(assignmentPath, 'output', 'report.docx'), expected)

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 123, cwd: workspacePath }
      },
    },
  })

  try {
    const response = await fetch(
      `${server.url}/runs/run-docx-artifact/assignments/output/report.docx`,
    )

    assert.equal(response.status, 200)
    assert.equal(
      response.headers.get('content-type'),
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server starts runs through the launcher boundary', async () => {
  const workspacePath = makeWorkspace()
  let launchedCwd: string | null = null

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun(request) {
        launchedCwd = request.cwd
        return { launched: true, pid: 321, cwd: request.cwd }
      },
    },
  })

  try {
    const response = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project' }),
    })
    const payload = await response.json() as { launched: boolean; pid: number; cwd: string }

    assert.equal(response.status, 202)
    assert.equal(payload.launched, true)
    assert.equal(payload.pid, 321)
    assert.equal(launchedCwd, '/tmp/project')
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server blocks cross-origin and non-JSON drive-by run requests', async () => {
  const workspacePath = makeWorkspace()
  let launchCount = 0
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun(request) {
        launchCount += 1
        return { launched: true, pid: 321, cwd: request.cwd }
      },
    },
  })

  try {
    const crossOriginResponse = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: {
        origin: 'https://attacker.example',
        'content-type': 'text/plain',
      },
      body: JSON.stringify({ cwd: '/tmp/drive-by' }),
    })
    const nonJsonResponse = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ cwd: '/tmp/drive-by' }),
    })

    assert.equal(crossOriginResponse.status, 403)
    assert.deepEqual(await crossOriginResponse.json(), { error: 'Origin not allowed' })
    assert.equal(nonJsonResponse.status, 415)
    assert.deepEqual(await nonJsonResponse.json(), {
      error: 'Content-Type must be application/json',
    })
    assert.equal(launchCount, 0)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server streams existing and appended run events over SSE', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'run-sse')
  fs.mkdirSync(assignmentPath, { recursive: true })
  logSessionStart(assignmentPath, 'run-sse', 'writing-team', ['writer'], 'root-sse')

  const server = await startApiServer({
    apiToken: 'authenticated-sse-test-token',
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
    eventPollIntervalMs: 20,
  })

  try {
    const events: string[] = await new Promise((resolve, reject) => {
      const seen: string[] = []
      const req = http.get(`${server.url}/runs/run-sse/events`, (res) => {
        assert.match(
          res.headers['content-type'] ?? '',
          /^text\/event-stream/,
        )
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          const matches = [...chunk.matchAll(/event: ([^\n]+)/g)].map((match) => match[1])
          seen.push(...matches)
          if (seen.includes('run.completed')) {
            req.destroy()
            resolve(seen)
          }
        })
        res.on('error', reject)
      })
      req.on('error', reject)

      setTimeout(() => {
        logRuntimeEvent(assignmentPath, {
          timestamp: new Date().toISOString(),
          event: 'run.completed',
          session_id: 'run-sse',
          root_session_id: 'root-sse',
          assignment_path: assignmentPath,
          team: 'writing-team',
          level_id: 'final',
          stage_type: 'review',
        })
      }, 30)
    })

    assert.ok(events.includes('run.session_started'))
    assert.ok(events.includes('run.completed'))
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server returns a JSON snapshot of run events', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'run-snapshot')
  fs.mkdirSync(assignmentPath, { recursive: true })
  logSessionStart(assignmentPath, 'run-snapshot', 'writing-team', ['writer'], 'root-snapshot')
  logRuntimeEvent(assignmentPath, {
    timestamp: new Date().toISOString(),
    event: 'run.completed',
    session_id: 'run-snapshot',
    root_session_id: 'root-snapshot',
    assignment_path: assignmentPath,
    team: 'writing-team',
    level_id: 'final',
    stage_type: 'review',
  })

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
  })

  try {
    const response = await fetch(`${server.url}/runs/run-snapshot/events?snapshot=1`)
    const payload = await response.json() as { events: Array<{ type: string }> }

    assert.equal(response.status, 200)
    assert.deepEqual(payload.events.map((event) => event.type), [
      'run.session_started',
      'run.completed',
    ])
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server returns parsed team flow metadata for a run', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'run-flow')
  fs.mkdirSync(assignmentPath, { recursive: true })
  logSessionStart(assignmentPath, 'run-flow', 'writing-team', ['writer'], 'root-flow')
  const flowRepo = makeTeamFlowRepo('writing-team')

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
    workspacePath: flowRepo.workspacePath,
  })

  try {
    const response = await fetch(`${server.url}/runs/run-flow/flow`)
    const payload = await response.json() as {
      entryLevelId: string
      levels: Array<{ id: string; loopLabel: string | null }>
      team: string
      transitions: Array<{ from: string; label: string; to: string }>
    }

    assert.equal(response.status, 200)
    assert.equal(payload.team, 'writing-team')
    assert.equal(payload.entryLevelId, 'brief-and-draft')
    assert.deepEqual(payload.levels.map((level) => level.id), ['brief-and-draft', 'editorial-review'])
    assert.match(payload.levels[1]?.loopLabel ?? '', /Review loop/)
    assert.deepEqual(payload.transitions.map((transition) => [transition.from, transition.to]), [
      ['brief-and-draft', 'editorial-review'],
      ['editorial-review', 'done'],
    ])
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(flowRepo.repoRootPath, { recursive: true, force: true })
  }
})

test('API server routes team-builder CRUD through the Create workspace boundary', async () => {
  const workspacePath = makeWorkspace()
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'team-builder-api-repo-'))
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
    repoRootPath: repoRoot,
  })

  try {
    const createResponse = await fetch(`${server.url}/create/team-builder/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'sample-team',
        description: 'Sample team.',
        tags: ['public'],
      }),
    })
    const createPayload = await createResponse.json() as { team: { id: string } }

    const listResponse = await fetch(`${server.url}/create/team-builder/teams`)
    const listPayload = await listResponse.json() as { teams: Array<{ id: string }> }

    const missingResponse = await fetch(`${server.url}/create/team-builder/teams/missing-team`)
    const missingPayload = await missingResponse.json() as { error: string }

    const deleteResponse = await fetch(`${server.url}/create/team-builder/teams/sample-team`, {
      method: 'DELETE',
    })
    const deletePayload = await deleteResponse.json() as { deleted: boolean }

    assert.equal(createResponse.status, 201)
    assert.equal(createPayload.team.id, 'sample-team')
    assert.equal(listResponse.status, 200)
    assert.deepEqual(listPayload.teams.map((team) => team.id), ['sample-team'])
    assert.equal(missingResponse.status, 400)
    assert.equal(missingPayload.error, 'Team not found: missing-team')
    assert.equal(deleteResponse.status, 200)
    assert.equal(deletePayload.deleted, true)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('API server reports agent provider health through Create routes', async () => {
  const workspacePath = makeWorkspace()
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-health-repo-'))
  const previousOpenAiKey = process.env.OPENAI_API_KEY

  fs.mkdirSync(path.join(repoRoot, 'agents', 'analyst'), { recursive: true })
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'analyst', 'analyst.md'),
    [
      '---',
      'name: analyst',
      'provider: openai',
      'model: gpt-5.4',
      '---',
      '',
      'Analyze the request.',
    ].join('\n'),
  )

  delete process.env.OPENAI_API_KEY

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
    repoRootPath: repoRoot,
  })

  try {
    const response = await fetch(`${server.url}/create/agents/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentNames: ['analyst'] }),
    })
    const payload = await response.json() as {
      health: Array<{ agentName: string; provider?: string; model?: string; status: string; message?: string }>
    }

    assert.equal(response.status, 200)
    assert.equal(payload.health[0]?.agentName, 'analyst')
    assert.equal(payload.health[0]?.provider, 'openai')
    assert.equal(payload.health[0]?.model, 'gpt-5.4')
    assert.equal(payload.health[0]?.status, 'error')
    assert.match(payload.health[0]?.message ?? '', /OPENAI_API_KEY/)
  } finally {
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey
    }
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('API server returns run diagnostics for transcripts delegations and bash risk', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'run-diagnostics')
  fs.mkdirSync(assignmentPath, { recursive: true })
  logSessionStart(assignmentPath, 'run-diagnostics', 'writing-team', ['writer'], 'root-diagnostics')
  logRuntimeEvent(assignmentPath, {
    timestamp: new Date().toISOString(),
    event: 'tool.call_observed',
    session_id: 'run-diagnostics',
    root_session_id: 'root-diagnostics',
    assignment_path: assignmentPath,
    team: 'writing-team',
    level_id: 'draft',
    stage_type: 'chain',
    tool_name: 'bash',
    tool_call_id: 'tool-bash-1',
    command: 'npm test && npm run build',
  })
  appendProviderProtocolTranscriptEvent(assignmentPath, {
    kind: 'text',
    provider: 'codex',
    text: 'Done',
    rawType: 'item.completed',
    raw: { type: 'item.completed', item: { text: 'Done' } },
  }, {
    sessionId: 'run-diagnostics',
    rootSessionId: 'root-diagnostics',
    agentName: 'writer',
    model: 'gpt-5.4-mini',
  })
  recordDelegationLifecycle(assignmentPath, {
    jobId: 'job-1',
    rootJobId: 'root-diagnostics',
    delegationId: 'delegation-1',
    fromTeam: 'reception-desk',
    fromLevel: 'intake',
    fromAgent: 'receptionist',
    toTeam: 'writing-team',
    requestedResultType: 'artifact:final-draft.md',
    startedAt: new Date().toISOString(),
    status: 'running',
  })

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
  })

  try {
    const response = await fetch(`${server.url}/runs/run-diagnostics/diagnostics`)
    const payload = await response.json() as {
      bashRisks: Array<{ risk: string; flags: string[] }>
      delegations: { lifecycle: Array<{ status: string }>; state: Record<string, { status: string }> }
      transcript: { canonical: Array<{ kind: string; text?: string }>; raw: unknown[] }
    }

    assert.equal(response.status, 200)
    assert.equal(payload.transcript.raw.length, 1)
    assert.equal(requiredValue(payload.transcript.canonical[0], 'tests/unit/api-server.test.ts:696').kind, 'text')
    assert.equal(requiredValue(payload.transcript.canonical[0], 'tests/unit/api-server.test.ts:697').text, 'Done')
    assert.equal(requiredValue(payload.delegations.lifecycle[0], 'tests/unit/api-server.test.ts:698').status, 'running')
    assert.equal(requiredValue(Object.values(payload.delegations.state)[0], 'tests/unit/api-server.test.ts:699').status, 'running')
    assert.equal(requiredValue(payload.bashRisks[0], 'tests/unit/api-server.test.ts:700').risk, 'medium')
    assert.deepEqual(requiredValue(payload.bashRisks[0], 'tests/unit/api-server.test.ts:701').flags, ['shell_chaining'])
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server returns 404 for unknown runs and missing artifacts', async () => {
  const workspacePath = makeWorkspace()
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
  })

  try {
    const runResponse = await fetch(`${server.url}/runs/missing-run`)
    const artifactResponse = await fetch(`${server.url}/runs/missing-run/assignments/output/report.md`)

    assert.equal(runResponse.status, 404)
    assert.equal(artifactResponse.status, 404)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server blocks encoded run-id and artifact path traversal over HTTP', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'run-safe')
  fs.mkdirSync(assignmentPath, { recursive: true })
  fs.writeFileSync(path.join(workspacePath, 'secret.txt'), 'workspace secret')
  logSessionStart(assignmentPath, 'run-safe', 'writing-team', ['writer'], 'root-safe')

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
  })

  try {
    const runIdTraversal = await fetch(
      `${server.url}/runs/..%2F./assignments/secret.txt`,
    )
    const artifactTraversal = await fetch(
      `${server.url}/runs/run-safe/assignments/%2e%2e%2F%2e%2e%2Fsecret.txt`,
    )
    const malformedEncoding = await fetch(`${server.url}/runs/%E0%A4%A`)

    assert.equal(runIdTraversal.status, 400)
    assert.equal(artifactTraversal.status, 400)
    assert.equal(malformedEncoding.status, 400)
    assert.doesNotMatch(await runIdTraversal.text(), /workspace secret/)
    assert.doesNotMatch(await artifactTraversal.text(), /workspace secret/)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server returns 400 when POST /runs omits cwd', async () => {
  const workspacePath = makeWorkspace()
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
  })

  try {
    const response = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    const payload = await response.json() as { error: string }

    assert.equal(response.status, 400)
    assert.match(payload.error, /cwd/)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server returns 400 on invalid JSON body and 500 on launcher failures', async () => {
  const workspacePath = makeWorkspace()
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        throw new Error('launcher failed')
      },
    },
  })

  try {
    const invalidJsonResponse = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"cwd":',
    })
    const invalidJsonPayload = await invalidJsonResponse.json() as { error: string }

    const launcherFailureResponse = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project' }),
    })
    const launcherFailurePayload = await launcherFailureResponse.json() as { error: string }

    assert.equal(invalidJsonResponse.status, 400)
    assert.match(invalidJsonPayload.error, /Invalid JSON/)
    assert.equal(launcherFailureResponse.status, 500)
    assert.match(launcherFailurePayload.error, /launcher failed/)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server cancels an active workflow generator job', async () => {
  const workspacePath = makeWorkspace()
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'create-cancel-repo-'))
  const previousDeepseekKey = process.env.DEEPSEEK_API_KEY
  const previousDeepseekUrl = process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL

  let resolveModelHit!: () => void
  const modelHit = new Promise<void>((resolve) => {
    resolveModelHit = resolve
  })

  const modelServer = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(404).end()
      return
    }
    resolveModelHit()
    setTimeout(() => {
      if (res.destroyed || res.writableEnded) return
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        model: 'test-model',
        choices: [
          {
            message: {
              content: '```json\n{"message":"late result","draft":null}\n```',
            },
          },
        ],
      }))
    }, 1000)
  })

  await new Promise<void>((resolve) => {
    modelServer.listen(0, '127.0.0.1', resolve)
  })
  const modelAddress = modelServer.address()
  assert.ok(modelAddress && typeof modelAddress === 'object')

  fs.mkdirSync(path.join(repoRoot, 'teams', 'workflow-architect'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'workflow-architect'), { recursive: true })
  fs.writeFileSync(
    path.join(repoRoot, 'teams', 'workflow-architect', 'team.yaml'),
    [
      'agents:',
      '  - name: workflow-architect',
      '    role: Architect',
      '    agent_file: ../../agents/workflow-architect/workflow-architect.md',
      '',
    ].join('\n'),
  )
  // The architect runs with its own agent's explicit pair. Declaring it here,
  // rather than in a team tier table, is what actually routes this turn at the
  // loopback provider below.
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'workflow-architect', 'workflow-architect.md'),
    ['---', 'provider: deepseek', 'model: test-model', '---', '', 'Return JSON.', ''].join('\n'),
  )
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')

  process.env.DEEPSEEK_API_KEY = 'test-key'
  process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL =
    `http://127.0.0.1:${modelAddress.port}/chat`

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
    repoRootPath: repoRoot,
  })

  try {
    const jobId = 'cancel-test-job'
    const turnPromise = fetch(`${server.url}/create/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId,
        history: [{ role: 'user', text: 'Build a workflow.' }],
        currentDraft: null,
      }),
    })

    // The cancel step is only meaningful once a provider request is actually
    // in flight. If the turn instead completes or fails early — a configuration
    // error, say — say so here rather than waiting forever for a request that
    // will never arrive.
    const reached = await Promise.race([
      modelHit.then(() => 'provider' as const),
      turnPromise.then(() => 'turn' as const),
    ])
    if (reached === 'turn') {
      const early = await turnPromise
      assert.fail(
        `the architect turn finished before reaching the provider: ${early.status} ${await early.clone().text()}`,
      )
    }

    const cancelResponse = await fetch(`${server.url}/create/jobs/${jobId}/cancel`, {
      method: 'POST',
    })
    const cancelPayload = await cancelResponse.json() as { cancelled: boolean }
    assert.equal(cancelResponse.status, 200)
    assert.equal(cancelPayload.cancelled, true)

    const turnResponse = await turnPromise
    const turnPayload = await turnResponse.json() as { cancelled: boolean }
    assert.equal(turnResponse.status, 200)
    assert.equal(turnPayload.cancelled, true)
  } finally {
    await server.close()
    await new Promise<void>((resolve) => modelServer.close(() => resolve()))
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(repoRoot, { recursive: true, force: true })
    if (previousDeepseekKey === undefined) {
      delete process.env.DEEPSEEK_API_KEY
    } else {
      process.env.DEEPSEEK_API_KEY = previousDeepseekKey
    }
    if (previousDeepseekUrl === undefined) {
      delete process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
    } else {
      process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL = previousDeepseekUrl
    }
  }
})

test('API server rejects malformed and oversized Create cancellation ids', async () => {
  const workspacePath = makeWorkspace()
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'create-job-id-repo-'))
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
    repoRootPath: repoRoot,
    workspacePath,
  })

  try {
    const malformed = await fetch(
      `${server.url}/create/jobs/%E0%A4%A/cancel`,
      { method: 'POST' },
    )
    const oversized = await fetch(
      `${server.url}/create/jobs/${'x'.repeat(129)}/cancel`,
      { method: 'POST' },
    )
    assert.equal(malformed.status, 400)
    assert.equal(oversized.status, 400)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('API server drafts an agent from chat without selected skills', async () => {
  const workspacePath = makeWorkspace()
  const repoRoot = makeAgentArchitectRepo()
  const previousOpenAiKey = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
    repoRootPath: repoRoot,
  })

  try {
    const response = await fetch(`${server.url}/create/agents/draft`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId: 'agent-chat-create',
        chatHistory: [
          {
            role: 'user',
            text: 'Create an expert in value proposition validation.',
          },
        ],
      }),
    })
    const payload = await response.json() as {
      error?: string
      generatedSkills?: Array<{ name: string; body: string }>
      jobId?: string
      suggestedName?: string
    }

    assert.equal(response.status, 200)
    assert.equal(payload.error, undefined)
    assert.equal(payload.jobId, 'agent-chat-create')
    assert.ok(payload.suggestedName)
    assert.equal(payload.generatedSkills?.length, 1)
    assert.match(payload.generatedSkills?.[0]?.body ?? '', /^---\nname:/)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(repoRoot, { recursive: true, force: true })
    if (previousOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY
    } else {
      process.env.OPENAI_API_KEY = previousOpenAiKey
    }
  }
})

test('API server commits generated skills when no source skills are selected', async () => {
  const workspacePath = makeWorkspace()
  const repoRoot = makeAgentArchitectRepo()

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
    repoRootPath: repoRoot,
  })

  try {
    const response = await fetch(`${server.url}/create/agents/commit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        approvedName: 'value-proposition-validator',
        personaMarkdown: [
          '---',
          'name: value-proposition-validator',
          'description: Validates business value propositions and assumptions.',
          'tier: specialist',
          'provider: openai',
          'model: gpt-5.4',
          'thinking: medium',
          'tools: none',
          '---',
          '',
          '# Value Proposition Validator',
        ].join('\n'),
        generatedSkills: [
          {
            name: 'value-proposition-validation',
            body: [
              '---',
              'name: value-proposition-validation',
              'description: Tests value proposition and assumption quality. Use when a business case needs its assumptions challenged.',
              '---',
              '',
              '# Value Proposition Validation',
            ].join('\n'),
          },
        ],
      }),
    })
    const payload = await response.json() as {
      agentName?: string
      generatedSkills?: string[]
      importedSkills?: string[]
    }

    assert.equal(response.status, 201)
    assert.equal(payload.agentName, 'value-proposition-validator')
    assert.deepEqual(payload.importedSkills, [])
    assert.deepEqual(payload.generatedSkills, ['value-proposition-validation'])
    assert.ok(
      fs.existsSync(
        path.join(
          repoRoot,
          'agents',
          'value-proposition-validator',
          'skills',
          'value-proposition-validation',
          'SKILL.md',
        ),
      ),
    )
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('API server rejects invalid run-start request shapes', async () => {
  const workspacePath = makeWorkspace()
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
  })

  try {
    const arrayBodyResponse = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([]),
    })
    const badEnvResponse = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp/project', env: { OPENAI_API_KEY: 123 } }),
    })

    assert.equal(arrayBodyResponse.status, 400)
    assert.equal(badEnvResponse.status, 400)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API server SSE respects the from offset and returns 404 for unknown runs', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'run-offset')
  fs.mkdirSync(assignmentPath, { recursive: true })
  logSessionStart(assignmentPath, 'run-offset', 'writing-team', ['writer'], 'root-offset')
  logRuntimeEvent(assignmentPath, {
    timestamp: new Date().toISOString(),
    event: 'run.completed',
    session_id: 'run-offset',
    root_session_id: 'root-offset',
    assignment_path: assignmentPath,
    team: 'writing-team',
    level_id: 'final',
    stage_type: 'review',
  })

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true, pid: 1, cwd: workspacePath }
      },
    },
    eventPollIntervalMs: 20,
  })

  try {
    const unknownResponse = await fetch(`${server.url}/runs/unknown/events`)
    assert.equal(unknownResponse.status, 404)

    const offsetEvents: string[] = await new Promise((resolve, reject) => {
      const seen: string[] = []
      const req = http.get(`${server.url}/runs/run-offset/events?from=1`, (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          const matches = [...chunk.matchAll(/event: ([^\n]+)/g)].map((match) => match[1])
          seen.push(...matches)
          if (seen.includes('run.completed')) {
            req.destroy()
            resolve(seen)
          }
        })
        res.on('error', reject)
      })
      req.on('error', reject)
    })

    assert.deepEqual(offsetEvents, ['run.completed'])
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
