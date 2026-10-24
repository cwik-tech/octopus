import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'

import { startApiServer } from '../../server/api-server.js'
import { FileSystemRunStore, type RunStore } from '../../domains/run/run-store.js'
import { buildArtifactMetadata, writeMarkdownArtifact } from '../../domains/runtime/artifacts.js'
import { logRuntimeEvent, logSessionStart } from '../../domains/runtime/logger.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'api-run-lifecycle-'))
}

async function waitFor<T>(
  fn: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 2000,
  pollMs = 50,
): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn()
    if (predicate(value)) return value
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

test('POST /runs preserves validation status, error bodies, and accepted unknown fields', async () => {
  const workspacePath = makeWorkspace()
  const launches: unknown[] = []
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun(request) {
        launches.push(request)
        return { launched: true, pid: 4242, cwd: request.cwd }
      },
    },
  })

  try {
    const invalidObject = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'null',
    })
    assert.equal(invalidObject.status, 400)
    assert.deepEqual(await invalidObject.json(), {
      error: 'Request body must be a JSON object',
    })

    const invalidEnv = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: workspacePath, env: { COUNT: 1 } }),
    })
    assert.equal(invalidEnv.status, 400)
    assert.deepEqual(await invalidEnv.json(), {
      error: 'Field env.COUNT must be a string',
    })

    const accepted = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: `  ${workspacePath}  `,
        env: null,
        ignored: true,
      }),
    })
    assert.equal(accepted.status, 400)
    assert.deepEqual(await accepted.json(), {
      error: 'Field env must be an object of string values',
    })

    const launched = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        cwd: `  ${workspacePath}  `,
        ignored: true,
      }),
    })
    assert.equal(launched.status, 202)
    assert.deepEqual(launches, [{ cwd: `  ${workspacePath}  ` }])
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('API end-to-end run lifecycle: launch, list, stream, and fetch artifacts', async () => {
  const workspacePath = makeWorkspace()
  const runId = 'run-e2e'
  const assignmentPath = path.join(workspacePath, 'assignments', runId)

  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: {
      async startRun(request) {
        setTimeout(() => {
          fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
          logSessionStart(assignmentPath, runId, 'writing-team', ['writer'], runId)

          const metadata = buildArtifactMetadata({
            filePath: path.join(assignmentPath, 'output', 'report.md'),
            rootDir: assignmentPath,
            artifactType: 'report',
            sessionId: runId,
            rootSessionId: runId,
            team: 'writing-team',
            level: 'final',
            stageType: 'review',
            title: 'E2E Report',
          })
          writeMarkdownArtifact(path.join(assignmentPath, 'output', 'report.md'), '# E2E Report\n', metadata)

          logRuntimeEvent(assignmentPath, {
            timestamp: new Date().toISOString(),
            event: 'run.completed',
            session_id: runId,
            root_session_id: runId,
            assignment_path: assignmentPath,
            team: 'writing-team',
            level_id: 'final',
            stage_type: 'review',
          })
        }, 50)

        return {
          launched: true,
          pid: 4242,
          cwd: request.cwd,
        }
      },
    },
    eventPollIntervalMs: 20,
  })

  try {
    const launchResponse = await fetch(`${server.url}/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: workspacePath }),
    })
    const launchPayload = await launchResponse.json() as { launched: boolean; pid: number; cwd: string }

    assert.equal(launchResponse.status, 202)
    assert.equal(launchPayload.launched, true)
    assert.equal(launchPayload.pid, 4242)

    const runsPayload = await waitFor(
      async () => {
        const response = await fetch(`${server.url}/runs`)
        return response.json() as Promise<{ runs: Array<{ id: string }> }>
      },
      (payload) => payload.runs.some((run) => run.id === runId),
    )
    assert.ok(runsPayload.runs.some((run) => run.id === runId))

    const detailPayload = await waitFor(
      async () => {
        const response = await fetch(`${server.url}/runs/${runId}`)
        return response.json() as Promise<{ id: string; status: string; artifactPaths: string[] }>
      },
      (payload) => payload.status === 'completed',
    )

    assert.equal(detailPayload.id, runId)
    assert.equal(detailPayload.status, 'completed')
    assert.ok(detailPayload.artifactPaths.includes(path.join('output', 'report.md')))

    const sseEvents: string[] = await new Promise((resolve, reject) => {
      const seen: string[] = []
      const req = http.get(`${server.url}/runs/${runId}/events`, (res) => {
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

    assert.ok(sseEvents.includes('run.session_started'))
    assert.ok(sseEvents.includes('artifact.written'))
    assert.ok(sseEvents.includes('run.completed'))

    const artifactResponse = await fetch(`${server.url}/runs/${runId}/assignments/output/report.md`)
    const artifactText = await artifactResponse.text()
    assert.equal(artifactResponse.status, 200)
    assert.match(artifactText, /E2E Report/)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('GET run artifact streams retained MP4 bytes with download headers', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'video-run')
  const expected = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff])
  fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
  fs.writeFileSync(path.join(assignmentPath, 'output', 'source-video.mp4'), expected)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: { async startRun(request) { return { launched: true, pid: 1, cwd: request.cwd } } },
  })

  try {
    const response = await fetch(`${server.url}/runs/video-run/assignments/output/source-video.mp4`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.equal(response.headers.get('content-length'), String(expected.length))
    assert.match(response.headers.get('content-disposition') ?? '', /^attachment;/)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('GET run artifact streams retained WebM bytes and 404s for missing videos', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'video-run')
  const expected = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x00, 0xff])
  fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
  fs.writeFileSync(path.join(assignmentPath, 'output', 'source-video.webm'), expected)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: { async startRun(request) { return { launched: true, pid: 1, cwd: request.cwd } } },
  })

  try {
    const response = await fetch(`${server.url}/runs/video-run/assignments/output/source-video.webm`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/webm')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)

    const missing = await fetch(`${server.url}/runs/video-run/assignments/output/source-video.mp4`)
    assert.equal(missing.status, 404)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('GET run artifact serves byte ranges and validators for resumable video downloads', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'video-run')
  const expected = Buffer.alloc(4096, 0xab)
  fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
  fs.writeFileSync(path.join(assignmentPath, 'output', 'source-video.mp4'), expected)
  const server = await startApiServer({
    store: new FileSystemRunStore(workspacePath),
    launcher: { async startRun(request) { return { launched: true, pid: 1, cwd: request.cwd } } },
  })
  const artifactUrl = `${server.url}/runs/video-run/assignments/output/source-video.mp4`

  try {
    const full = await fetch(artifactUrl)
    assert.equal(full.status, 200)
    assert.equal(full.headers.get('accept-ranges'), 'bytes')
    const etag = full.headers.get('etag')
    assert.ok(etag)
    await full.arrayBuffer()

    const partial = await fetch(artifactUrl, { headers: { range: 'bytes=0-3' } })
    assert.equal(partial.status, 206)
    assert.equal(partial.headers.get('content-type'), 'video/mp4')
    assert.equal(partial.headers.get('content-length'), '4')
    assert.equal(partial.headers.get('content-range'), `bytes 0-3/${expected.length}`)
    assert.equal(partial.headers.get('accept-ranges'), 'bytes')
    assert.equal(partial.headers.get('etag'), etag)
    assert.deepEqual(Buffer.from(await partial.arrayBuffer()), expected.subarray(0, 4))

    const suffix = await fetch(artifactUrl, { headers: { range: 'bytes=4092-' } })
    assert.equal(suffix.status, 206)
    assert.equal(suffix.headers.get('content-range'), `bytes 4092-4095/${expected.length}`)
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), expected.subarray(4092))

    const clipped = await fetch(artifactUrl, { headers: { range: 'bytes=4000-99999' } })
    assert.equal(clipped.status, 206)
    assert.equal(clipped.headers.get('content-range'), `bytes 4000-4095/${expected.length}`)
    assert.deepEqual(Buffer.from(await clipped.arrayBuffer()), expected.subarray(4000))

    const unsatisfiable = await fetch(artifactUrl, { headers: { range: 'bytes=99999-' } })
    assert.equal(unsatisfiable.status, 416)
    assert.equal(
      unsatisfiable.headers.get('content-range'),
      `bytes */${expected.length}`,
    )

    const conditional = await fetch(artifactUrl, { headers: { 'if-none-match': etag } })
    assert.equal(conditional.status, 304)
    assert.equal(conditional.headers.get('etag'), etag)
    assert.deepEqual(Buffer.from(await conditional.arrayBuffer()), Buffer.alloc(0))
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('GET run artifact destroys the read stream when the client aborts mid-download', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'video-run')
  fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
  fs.writeFileSync(
    path.join(assignmentPath, 'output', 'source-video.mp4'),
    Buffer.alloc(32 * 1024 * 1024, 0xcd),
  )
  let openedStream: import('node:fs').ReadStream | undefined
  class CapturingRunStore extends FileSystemRunStore {
    override async openArtifactStream(runId: string, artifactPath: string): Promise<Awaited<ReturnType<FileSystemRunStore['openArtifactStream']>>> {
      const artifact = await super.openArtifactStream(runId, artifactPath)
      if (artifact) openedStream = artifact.stream
      return artifact
    }
  }
  const server = await startApiServer({
    store: new CapturingRunStore(workspacePath),
    launcher: { async startRun(request) { return { launched: true, pid: 1, cwd: request.cwd } } },
  })

  try {
    await new Promise<void>((resolve, reject) => {
      const request = http.get(`${server.url}/runs/video-run/assignments/output/source-video.mp4`, (response) => {
        response.resume()
        response.once('end', () => reject(new Error('download completed before the abort')))
      })
      request.once('response', () => {
        setTimeout(() => request.destroy(), 20)
      })
      request.once('error', () => resolve())
      request.once('close', () => resolve())
    })
    assert.ok(openedStream)
    await waitFor(
      () => Promise.resolve(openedStream!.destroyed),
      (destroyed) => destroyed,
      2000,
    )
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('GET run artifact falls back to buffered reads when the store cannot stream', async () => {
  const workspacePath = makeWorkspace()
  const assignmentPath = path.join(workspacePath, 'assignments', 'video-run')
  const expected = Buffer.from([0xff, 0x00, 0xfe, 0x80])
  fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
  fs.writeFileSync(path.join(assignmentPath, 'output', 'source-video.mp4'), expected)
  const streaming = new FileSystemRunStore(workspacePath)
  const store: RunStore = {
    listRuns: () => streaming.listRuns(),
    getRun: (runId) => streaming.getRun(runId),
    listRunEvents: (runId) => streaming.listRunEvents(runId),
    tailRunEvents: (runId, onEvent, options) => streaming.tailRunEvents(runId, onEvent, options),
    readArtifact: (runId, artifactPath, options) => streaming.readArtifact(runId, artifactPath, options),
    getRunDiagnostics: (runId) => streaming.getRunDiagnostics(runId),
  }
  const server = await startApiServer({
    store,
    launcher: { async startRun(request) { return { launched: true, pid: 1, cwd: request.cwd } } },
  })

  try {
    const response = await fetch(`${server.url}/runs/video-run/assignments/output/source-video.mp4`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'video/mp4')
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), expected)
  } finally {
    await server.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
