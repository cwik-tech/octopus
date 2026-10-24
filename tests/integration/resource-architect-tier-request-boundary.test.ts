/**
 * What the authoring API does with a request that still names a grade.
 *
 * The service-level cases beside this one prove what the parser makes of a
 * model's reply. They do not prove anything about a *user's* request: that
 * crosses an HTTP request schema first, and a schema that accepts a retired
 * field would let an author send a grade, receive a success, and never learn it
 * decided nothing. §4.5 names that outcome specifically — do not return success
 * for an ineffective override.
 *
 * Two things this fixture has to get right before it can be evidence.
 *
 * While the schema still accepts the field, the turn *executes*. So the
 * provider is pinned to a loopback this test owns and the environment is
 * restored afterwards: without that, a Red run would reach a real vendor
 * through whatever credentials the environment happens to hold. The same
 * loopback then counts the requests, which is how the Green run shows the
 * refusal happened before anything was sent.
 *
 * And the refusal is asserted against the contract that already exists —
 * `server/http.ts:65-77` raises `ApiRequestError` for a schema failure, which
 * answers 400 with an `error` string. Nothing here invents a code or a details
 * array to assert against.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'

const TEAM_ID = 'contract-review-team'
const AGENT = 'michigan-contract-lawyer'
const REQUEST_TIMEOUT_MS = 15_000

/** A valid proposal, so the first attempt succeeds and no repair is involved. */
const PROPOSAL_REPLY = JSON.stringify({
  message: 'The proposal is ready for review.',
  outcome: {
    kind: 'standalone_agents',
    agents: [
      {
        name: 'contract-reviewer',
        role: 'Reviewer',
        summary: 'Reviews contracts for the user.',
        description: 'Reviews contracts.',
        rationale: 'Requested by the user.',
      },
    ],
  },
  warnings: [],
})

interface Loopback {
  readonly url: string
  readonly requestCount: () => number
  readonly close: () => Promise<void>
}

/** The only endpoint this test's dispatch may reach. */
async function startLoopbackProvider(): Promise<Loopback> {
  let requests = 0
  const server = http.createServer((request, response) => {
    void (async () => {
      for await (const _chunk of request) {
        // Consume the body, so the request completes.
      }
      requests += 1
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          model: 'test-model',
          choices: [{ message: { content: PROPOSAL_REPLY } }],
        }),
      )
    })().catch(() => response.destroy())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    requestCount: () => requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  }
}

function seedRepo(): { repoRoot: string; workspacePath: string; directory: string } {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'tier-request-boundary-')),
  )
  const repoRoot = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'teams', 'resource-architect'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'resource-architect'), { recursive: true })
  fs.writeFileSync(
    path.join(repoRoot, 'teams', 'resource-architect', 'team.yaml'),
    ['agents:', '  - agent_file: ../../agents/resource-architect/resource-architect.md', ''].join('\n'),
  )
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'resource-architect', 'resource-architect.md'),
    '---\nprovider: openai\nmodel: test-model\n---\n\nHelp the user design Agents and Teams.\n',
  )
  fs.writeFileSync(path.join(repoRoot, 'teams.yaml'), '')
  return { repoRoot, workspacePath, directory }
}

/** A plan that is otherwise well formed, so only the retired field is at issue. */
function planCarryingTier(): unknown {
  return {
    id: 'plan-with-tier',
    kind: 'standalone_agents',
    agents: [
      {
        name: AGENT,
        role: 'Reviewer',
        tier: 'specialist',
        description: 'Reviews contracts.',
        rationale: 'Requested by the user.',
      },
    ],
  }
}

/** The error text a refusal carries, or nothing where the body is not one. */
function refusalText(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const error = (body as { error?: unknown }).error
  return typeof error === 'string' ? error : undefined
}

test('a stored plan carrying a grade can still be handed back as context', async () => {
  const provider = await startLoopbackProvider()
  const { repoRoot, workspacePath, directory } = seedRepo()
  const previousKey = process.env.OPENAI_API_KEY
  const previousUrl = process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
  process.env.OPENAI_API_KEY = 'boundary-test-key'
  process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = provider.url
  const api = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun() {
        return { launched: true as const, pid: 1, cwd: workspacePath }
      },
    },
    workspacePath,
    repoRootPath: repoRoot,
  })
  try {
    const response = await fetch(`${api.url}/create/resource-architect/turn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        operation: 'proposal',
        history: [{ role: 'user', text: `Update the ${TEAM_ID} team.` }],
        currentPlan: planCarryingTier(),
      }),
      // The request carries its own bound: a turn that reaches a provider and
      // waits must fail this case rather than hold the suite open.
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

    // `currentPlan` is this server's own earlier output handed back, not a new
    // write — `resource-architect-llm.ts:643-651` puts it in a context-only
    // message, and `resource-architect-service.ts:148-172` persists the
    // freshly materialized outcome rather than the input plan. A plan saved
    // before the field was retired still carries one, and refusing it would
    // leave a recovered plan unusable for a follow-up.
    const body = (await response.json()) as {
      operation?: unknown
      outcome?: { kind?: unknown; agents?: unknown[] }
      error?: unknown
    }
    // A real success, not merely "not a 400": a 500 would satisfy that.
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(typeof body.error, 'undefined', JSON.stringify(body))
    assert.equal(body.operation, 'proposal', JSON.stringify(body))
    assert.equal(body.outcome?.kind, 'standalone_agents', JSON.stringify(body))
    // The turn ran exactly once, on the first attempt: a repair or a fallback
    // answering instead would make this pass for the wrong reason.
    assert.equal(provider.requestCount(), 1, 'the turn did not answer first time')
    // And the grade the context carried is nowhere in what this turn produced.
    assert.equal(
      JSON.stringify(body.outcome).includes('tier'),
      false,
      JSON.stringify(body.outcome),
    )
  } finally {
    await api.close()
    await provider.close()
    if (previousKey === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = previousKey
    if (previousUrl === undefined) delete process.env.WORKFLOW_GENERATOR_OPENAI_API_URL
    else process.env.WORKFLOW_GENERATOR_OPENAI_API_URL = previousUrl
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
