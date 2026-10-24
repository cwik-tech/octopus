import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import { startApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { loadArchitectConfig } from '../../domains/provider/architect-model-config.js'
import { readApiKey } from '../../domains/provider/model-client.js'

function writeWorkflowArchitectRepo(repoRoot: string): void {
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
    "---\nmodel: test-model\nprovider: deepseek\n---\n\n" + ('Return JSON.'),
  )
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name]
  } else {
    process.env[name] = value
  }
}

function liveSkipReason(): string | false {
  if (process.env.RUN_LIVE_WORKFLOW_GENERATOR_CANCEL !== '1') {
    return 'set RUN_LIVE_WORKFLOW_GENERATOR_CANCEL=1 to run live provider cancellation test'
  }
  try {
    const config = loadArchitectConfig(process.cwd())
    const keyResult = readApiKey(config.provider)
    if (keyResult.apiKey == null) {
      return `missing ${keyResult.envVar} for live workflow generator cancellation test`
    }
    return false
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function cancelUntilAccepted(params: {
  serverUrl: string
  jobId: string
  turnPromise: Promise<Response>
  timeoutMs: number
}): Promise<{ cancelled: boolean; turnFinishedFirst: boolean }> {
  const deadline = Date.now() + params.timeoutMs
  while (Date.now() < deadline) {
    const turnState = await Promise.race([
      params.turnPromise.then(() => 'finished' as const),
      wait(0).then(() => 'pending' as const),
    ])
    if (turnState === 'finished') {
      return { cancelled: false, turnFinishedFirst: true }
    }

    const cancelResponse = await fetch(
      `${params.serverUrl}/create/jobs/${encodeURIComponent(params.jobId)}/cancel`,
      { method: 'POST' },
    )
    const cancelPayload = await cancelResponse.json() as {
      cancelled: boolean
      status: string
    }
    assert.equal(cancelResponse.status, 200)
    if (cancelPayload.cancelled) {
      return { cancelled: true, turnFinishedFirst: false }
    }
    await wait(25)
  }
  return { cancelled: false, turnFinishedFirst: false }
}

test('workflow generator cancellation handles stop-before-registration race', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'race-create-cancel-'))
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'race-create-repo-'))
  const previousDeepseekKey = process.env.DEEPSEEK_API_KEY
  const previousDeepseekUrl = process.env.WORKFLOW_GENERATOR_DEEPSEEK_API_URL
  let modelHits = 0

  const modelServer = await new Promise<http.Server>((resolve) => {
    const server = http.createServer((_req, res) => {
      modelHits += 1
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
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
  const modelAddress = modelServer.address()
  assert.ok(modelAddress && typeof modelAddress === 'object')

  writeWorkflowArchitectRepo(repoRoot)
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
    const jobId = 'race-cancel-before-turn'
    const cancelResponse = await fetch(`${server.url}/create/jobs/${jobId}/cancel`, {
      method: 'POST',
    })
    const cancelPayload = await cancelResponse.json() as {
      cancelled: boolean
      status: string
    }
    assert.equal(cancelResponse.status, 200)
    assert.equal(cancelPayload.cancelled, true)
    assert.equal(cancelPayload.status, 'pending')

    const turnResponse = await fetch(`${server.url}/create/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jobId,
        history: [{ role: 'user', text: 'Build a workflow.' }],
        currentDraft: null,
      }),
    })
    const turnPayload = await turnResponse.json() as {
      cancelled?: boolean
      message?: string
      yaml?: string | null
      mermaid?: string | null
    }
    assert.equal(turnResponse.status, 200)
    assert.equal(turnPayload.cancelled, true)
    assert.equal(turnPayload.message, undefined)
    assert.equal(turnPayload.yaml, undefined)
    assert.equal(turnPayload.mermaid, undefined)
    assert.equal(modelHits, 0)
  } finally {
    await server.close()
    await new Promise<void>((resolve) => modelServer.close(() => resolve()))
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(repoRoot, { recursive: true, force: true })
    restoreEnv('DEEPSEEK_API_KEY', previousDeepseekKey)
    restoreEnv('WORKFLOW_GENERATOR_DEEPSEEK_API_URL', previousDeepseekUrl)
  }
})

test(
  'live workflow generator cancellation stops an active Create job',
  { skip: liveSkipReason(), timeout: 90_000 },
  async () => {
    const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'live-create-cancel-'))
    const server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: {
        async startRun() {
          return { launched: true, pid: 1, cwd: workspacePath }
        },
      },
      repoRootPath: process.cwd(),
    })

    try {
      const jobId = `live-cancel-${Date.now()}`
      const turnPromise = fetch(`${server.url}/create/turn`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId,
          history: [
            {
              role: 'user',
              text:
                'Create a workflow draft for a large multi-agent market research pipeline. Include enough detail to require a real model response, but do not save anything.',
            },
          ],
          currentDraft: null,
        }),
      })

      const cancelResult = await cancelUntilAccepted({
        serverUrl: server.url,
        jobId,
        turnPromise,
        timeoutMs: 5_000,
      })

      assert.equal(
        cancelResult.cancelled,
        true,
        cancelResult.turnFinishedFirst
          ? 'live provider finished before cancellation was accepted'
          : 'cancel endpoint did not accept the active live job',
      )

      const turnResponse = await turnPromise
      const turnPayload = await turnResponse.json() as {
        cancelled?: boolean
        message?: string
        yaml?: string | null
        mermaid?: string | null
      }

      assert.equal(turnResponse.status, 200)
      assert.equal(turnPayload.cancelled, true)
      assert.equal(turnPayload.message, undefined)
      assert.equal(turnPayload.yaml, undefined)
      assert.equal(turnPayload.mermaid, undefined)
    } finally {
      await server.close()
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  },
)
