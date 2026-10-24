import assert from 'node:assert/strict'
import * as http from 'node:http'
import test from 'node:test'
import { z } from 'zod/v4'
import { createDialogueMcpTools } from '../../server/voice-control/dialogue-mcp-tools.js'
import { createLoopbackRestClient } from '../../server/voice-control/loopback-rest-client.js'
import { readJsonBody } from '../../server/http.js'
import { createDialogueFixture } from '../helpers/agent-dialogue-fixture.js'

for (const scenario of [
  { name: 'a refused dialogue preserves a new chat another caller has already written into', method: 'POST', route: /^\/sessions\/([^/]+)\/dialogues$/ },
  { name: 'a refused dialogue preserves a message saved between its empty read and rollback deletion', method: 'DELETE', route: /^\/sessions\/([^/?]+)(?:\?.*)?$/ },
]) test(scenario.name, { timeout: 20_000 }, async (t) => {
  const fixture = await createDialogueFixture(t, [{ content: 'The independent message is saved.' }, { content: 'The independent message is saved.' }])
  let newSessionId: string | undefined
  // This real forwarding server orders two real REST callers. It substitutes
  // no local service or response; only the paid provider is replaced by the fixture.
  const proxy = http.createServer((request, response) => {
    const forward = async () => {
      const route = request.url ?? '/'
      const body = request.method === 'POST' ? await readJsonBody(request) : undefined
      const writeBefore = scenario.route.exec(route)
      if (request.method === scenario.method && writeBefore) {
        newSessionId = z.uuid().parse(writeBefore[1])
        const saved = await fetch(`${fixture.server.url}/sessions/${newSessionId}/messages`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, signal: t.signal,
          body: JSON.stringify({ text: 'Keep my independent message.', target: { kind: 'agents', agentNames: ['alpha-analyst'] } }),
        })
        assert.equal(saved.status, 201, await saved.clone().text())
      }
      const upstream = await fetch(`${fixture.server.url}${route}`, {
        method: request.method ?? 'GET', signal: t.signal,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
      })
      const text = await upstream.text()
      response.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' })
      response.end(text)
    }
    void forward().catch((error: unknown) => {
      response.writeHead(500, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Forwarding failed' }))
    })
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  t.after(async () => {
    proxy.closeAllConnections()
    await new Promise<void>((resolve) => proxy.close(() => resolve()))
  })
  const address = proxy.address()
  assert.ok(address && typeof address !== 'string')
  const rest = createLoopbackRestClient(() => `http://127.0.0.1:${address.port}`)
  const start = createDialogueMcpTools(rest, {}).find((tool) => tool.name === 'start_dialogue')
  assert.ok(start)

  const result = await start.run({
    agents: ['alpha-analyst', 'beta-builder'], topic: 'Refuse this unavailable continuation.',
    continues: '88888888-8888-4888-8888-888888888888',
  }, { signal: t.signal, sendProgress: async () => undefined })

  assert.equal(result.isError, true)
  assert.equal(result.structured.status, 404)
  assert.ok(newSessionId)
  assert.ok(await fixture.store.getSession(newSessionId), 'Refusal cleanup must preserve the concurrently written chat')
  assert.deepEqual((await fixture.store.listChatMessages(newSessionId)).map((message) => message.text), [
    'Keep my independent message.', 'The independent message is saved.',
  ])
})
