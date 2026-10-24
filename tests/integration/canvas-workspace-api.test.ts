import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { withFileLock } from '../../domains/sessions/session-file-locks.js'
import { handleCanvasRoutes } from '../../server/routes/canvas.js'
import { canvasWorkspaceSchema, CANVAS_MAX_PREVIEW_BYTES } from '../../contracts/canvas-workspace.js'

async function fixture() {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'canvas-api-'))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Canvas owner' })
  const other = await sessionStore.createSession({ title: 'Other chat' })
  await sessionStore.appendChatMessage(session.id, { id: 'delivery', role: 'assistant', text: 'Ready', createdAt: '2026-10-18T00:00:00.000Z', delivery: { taskId: 'task', artifacts: [{ runId: 'canvas-run', path: 'files/report.md', role: 'final' }] } })
  const dir = path.join(workspacePath, 'assignments', 'canvas-run', 'files')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'report.md'), '# Real report')
  const runStore = new FileSystemRunStore(workspacePath)
  const server = http.createServer((req, res) => {
    void handleCanvasRoutes({ req, res, url: new URL(req.url ?? '/', 'http://localhost'), sessionId: new URL(req.url ?? '/', 'http://localhost').pathname.split('/')[2] ?? '', options: { workspacePath, sessionStore, runStore } }).catch((error: unknown) => {
      res.statusCode = 500
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'Unexpected error' }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const base = `http://127.0.0.1:${address.port}`
  const request = (sessionId: string, action?: unknown) => fetch(`${base}/sessions/${sessionId}/canvas`, { method: action === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json' }, ...(action === undefined ? {} : { body: JSON.stringify(action) }), signal: AbortSignal.timeout(2000) })
  return { workspacePath, sessionStore, session, other, base, request, async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); await fs.rm(workspacePath, { recursive: true, force: true }) } }
}
const alpha = { runId: 'canvas-run', artifactPath: 'files/report.md' }

test('real API persists tab actions across reads and concurrent opens without replacing newer state', async () => {
  const f = await fixture()
  try {
    const responses = await Promise.all([f.request(f.session.id, { kind: 'open', target: alpha }), f.request(f.session.id, { kind: 'open', target: { ...alpha, artifactPath: 'files/second.md' } })])
    assert.deepEqual(responses.map((r) => r.status), [200, 200])
    const saved = canvasWorkspaceSchema.parse(await (await f.request(f.session.id)).json())
    assert.equal(saved.tabs.length, 2)
    const disk = canvasWorkspaceSchema.parse(JSON.parse(await fs.readFile(path.join(f.workspacePath, 'sessions', f.session.id, 'canvas.json'), 'utf8')))
    assert.deepEqual(disk, saved)
    assert.equal(saved.revision, 2)
  } finally { await f.close() }
})

test('real API refuses foreign runs, unsafe paths, extra keys and nonexistent sessions', async () => {
  const f = await fixture()
  try {
    assert.equal((await f.request(f.other.id, { kind: 'open', target: alpha })).status, 404)
    assert.equal((await f.request(f.session.id, { kind: 'open', target: { ...alpha, artifactPath: '../secret' } })).status, 400)
    assert.equal((await f.request(f.session.id, { kind: 'close', key: 'x', extra: true })).status, 400)
    assert.equal((await f.request('00000000-0000-4000-8000-000000000000', { kind: 'open', target: alpha })).status, 404)
    const state = canvasWorkspaceSchema.parse(await (await f.request(f.other.id)).json())
    assert.deepEqual(state.tabs, [])
  } finally { await f.close() }
})

test('corrupt or symlinked workspace state is refused without overwriting it', async () => {
  const f = await fixture()
  const file = path.join(f.workspacePath, 'sessions', f.session.id, 'canvas.json')
  try {
    await fs.writeFile(file, '{broken')
    assert.equal((await f.request(f.session.id, { kind: 'open', target: alpha })).status, 409)
    assert.equal(await fs.readFile(file, 'utf8'), '{broken')
    await fs.unlink(file)
    const external = path.join(f.workspacePath, 'external.json')
    await fs.writeFile(external, 'leave unchanged')
    await fs.symlink(external, file)
    assert.equal((await f.request(f.session.id, { kind: 'open', target: alpha })).status, 409)
    assert.equal(await fs.readFile(external, 'utf8'), 'leave unchanged')
  } finally { await f.close() }
})

test('a Canvas save queued behind session deletion never recreates the deleted directory', async () => {
  const f = await fixture()
  let release = () => {}
  const gate = new Promise<void>((resolve) => { release = resolve })
  let locked = () => {}
  const acquired = new Promise<void>((resolve) => { locked = resolve })
  const lock = withFileLock(path.join(f.workspacePath, 'sessions', '.locks', `${f.session.id}.lock`), async () => { locked(); await gate; await fs.rm(path.join(f.workspacePath, 'sessions', f.session.id), { recursive: true }) })
  try {
    await acquired
    const pending = f.request(f.session.id, { kind: 'open', target: alpha })
    release()
    await lock
    const response = await pending
    assert.equal(response.status, 404, await response.text())
    await assert.rejects(fs.stat(path.join(f.workspacePath, 'sessions', f.session.id)), { code: 'ENOENT' })
  } finally { release(); await lock; await f.close() }
})

test('Canvas content is chat-scoped and bounded before oversized data reaches the viewer', async () => {
  const f = await fixture()
  const query = new URLSearchParams(alpha)
  try {
    const response = await fetch(`${f.base}/sessions/${f.session.id}/canvas/content?${query}`, { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { content: '# Real report' })
    assert.equal((await fetch(`${f.base}/sessions/${f.other.id}/canvas/content?${query}`, { signal: AbortSignal.timeout(2000) })).status, 404)
    await fs.writeFile(path.join(f.workspacePath, 'assignments', 'canvas-run', 'files', 'report.md'), Buffer.alloc(CANVAS_MAX_PREVIEW_BYTES + 1, 65))
    assert.equal((await fetch(`${f.base}/sessions/${f.session.id}/canvas/content?${query}`, { signal: AbortSignal.timeout(2000) })).status, 404)
  } finally { await f.close() }
})

test('the encoded saved-state byte limit refuses another tab without making saved state unreadable', async () => {
  const f = await fixture()
  try {
    const targets = Array.from({ length: 22 }, (_, index) => ({ ...alpha, artifactPath: `files/${index}-${'字'.repeat(1000)}.md` }))
    const statuses: number[] = []
    // This checks the byte boundary. Concurrent admission is covered separately;
    // do not consume request deadlines waiting behind 22 serialized writes.
    for (const target of targets) {
      const response = await f.request(f.session.id, { kind: 'open', target })
      statuses.push(response.status)
      await response.arrayBuffer()
    }
    assert.equal(statuses.filter((status) => status === 200).length, 20)
    assert.equal(statuses.filter((status) => status === 409).length, 2)
    const response = await f.request(f.session.id)
    assert.equal(response.status, 200)
    assert.equal(canvasWorkspaceSchema.parse(await response.json()).tabs.length, 20)
  } finally { await f.close() }
})

test('HTML is served as source text rather than an executable preview', async () => {
  const f = await fixture()
  try {
    const content = '<h1>Source only</h1><script>window.neverExecute = true</script>'
    await fs.writeFile(path.join(f.workspacePath, 'assignments', 'canvas-run', 'files', 'example.html'), content)
    const query = new URLSearchParams({ ...alpha, artifactPath: 'files/example.html' })
    const response = await fetch(`${f.base}/sessions/${f.session.id}/canvas/content?${query}`, { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { content })
  } finally { await f.close() }
})

test('a symlinked chat directory cannot borrow another chat ownership for a preview', async () => {
  const f = await fixture()
  try {
    const alias = path.join(f.workspacePath, 'sessions', f.other.id)
    await fs.rm(alias, { recursive: true })
    await fs.symlink(f.session.id, alias, 'dir')
    const query = new URLSearchParams(alpha)
    const response = await fetch(`${f.base}/sessions/${f.other.id}/canvas/content?${query}`, { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 409)
  } finally { await f.close() }
})
