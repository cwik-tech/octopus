/**
 * The two credentials this process issues must stay disjoint.
 *
 * The provider broker token authorizes exactly one endpoint, and the delta
 * token authorizes exactly one channel. Neither is allowed to become a way of
 * reaching the other's authority, so both directions are asserted rather than
 * one being inferred from the other.
 */
import assert from 'node:assert/strict'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { AgentTextStreamHub } from '../../domains/runtime/agent-text-stream-hub.js'
import { AgentTextDeltaTokenRegistry } from '../../domains/runtime/agent-text-delta-tokens.js'

const INGEST_PATH = '/internal/agent-text-stream'
const API_TOKEN = 'a'.repeat(43)
const BROKER_TOKEN = 'b'.repeat(43)

interface Scoped {
  readonly server: StartedApiServer
  readonly base: string
  readonly hub: AgentTextStreamHub
  readonly deltaToken: string
  readonly channelId: string
}

async function withScopedServer(run: (scoped: Scoped) => Promise<void>): Promise<void> {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'delta-scope-')),
  )
  const workspacePath = path.join(directory, 'workspace')
  fs.mkdirSync(workspacePath, { recursive: true })
  const hub = new AgentTextStreamHub()
  const tokens = new AgentTextDeltaTokenRegistry()
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: new PiRunLauncher(),
    sessionStore: new FileSystemSessionStore(workspacePath),
    workspacePath,
    apiToken: API_TOKEN,
    brokerToken: BROKER_TOKEN,
    agentTextStreamHub: hub,
    agentTextStreamDeltaTokens: tokens,
  })
  const channelId = crypto.randomUUID()
  hub.openChannel(channelId, 'owner')
  const deltaToken = tokens.issue({ channelId, runId: 'run-1' })
  // `server.url` carries the api token; the plain origin is what the child gets.
  const base = new URL(server.url).origin
  try {
    await run({ server, base, hub, deltaToken, channelId })
  } finally {
    await server.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

test('the broker credential cannot post display frames', async () => {
  await withScopedServer(async ({ base, hub, channelId }) => {
    const response = await fetch(`${base}${INGEST_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${BROKER_TOKEN}`,
      },
      body: JSON.stringify({
        channelId,
        frames: [{ type: 'delta', replyId: 'd', channel: 'text', text: 'no' }],
      }),
    })

    assert.equal(response.status, 403)
    assert.deepEqual(hub.read(channelId, 0)?.frames ?? [], [])
  })
})

test('the delta credential cannot reach the credential broker, or any other route', async () => {
  await withScopedServer(async ({ base, deltaToken }) => {
    // The delta token is not a path credential, so presenting it as one is
    // simply an unknown token.
    const broker = await fetch(
      `${base}/_pipeline/${encodeURIComponent(deltaToken)}/settings/provider-execute`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ provider: 'openai' }),
      },
    )
    assert.equal(broker.status, 401)

    // Nor does it work as a header on an ordinary route.
    const sessions = await fetch(
      `${base}/_pipeline/${encodeURIComponent(API_TOKEN)}/sessions`,
      { headers: { authorization: `Bearer ${deltaToken}` } },
    )
    // The api token is what authorized that one; the delta token added nothing
    // and took nothing away.
    assert.equal(sessions.status, 200)

    const unauthorized = await fetch(`${base}/sessions`, {
      headers: { authorization: `Bearer ${deltaToken}` },
    })
    assert.equal(unauthorized.status, 401)
  })
})
