import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'

test('API server wires workspace Deep Research settings and reloads them after restart', async () => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-api-'))
  const start = () => startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun(request) {
        return { launched: true, pid: 1, cwd: request.cwd }
      },
    },
    workspacePath,
  })

  let server = await start()
  try {
    const defaultResponse = await fetch(`${server.url}/settings/deep-research`)
    assert.equal(defaultResponse.status, 200)
    assert.equal(defaultResponse.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await defaultResponse.json(), {
      schemaVersion: 3,
      maxDurationMinutes: 20,
      maxResearcherAgents: 8,
      constraints: {
        maxDurationMinutes: { minimum: 5, maximum: 120 },
        maxResearcherAgents: { minimum: 1, maximum: 8 },
      },
      source: 'default',
      editable: true,
    })

    const savedResponse = await fetch(`${server.url}/settings/deep-research`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        maxDurationMinutes: 50,
        maxResearcherAgents: 5,
      }),
    })
    assert.equal(savedResponse.status, 200)
    assert.equal(((await savedResponse.json()) as { source: string }).source, 'persisted')

    await server.close()
    server = await start()
    const restartedResponse = await fetch(`${server.url}/settings/deep-research`)
    assert.equal(restartedResponse.status, 200)
    assert.match(restartedResponse.headers.get('content-type') ?? '', /^application\/json/)
    assert.deepEqual(await restartedResponse.json(), {
      schemaVersion: 3,
      maxDurationMinutes: 50,
      maxResearcherAgents: 5,
      constraints: {
        maxDurationMinutes: { minimum: 5, maximum: 120 },
        maxResearcherAgents: { minimum: 1, maximum: 8 },
      },
      source: 'persisted',
      editable: true,
    })
  } finally {
    await server.close().catch(() => undefined)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
