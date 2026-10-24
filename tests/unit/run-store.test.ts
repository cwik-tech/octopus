import { requiredValue } from '../../core/required-value.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { logRuntimeEvent, logSessionStart } from '../../domains/runtime/logger.js'
import { buildArtifactMetadata, writeMarkdownArtifact } from '../../domains/runtime/artifacts.js'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'run-store-'))
}

test('FileSystemRunStore lists runs with derived status and artifact paths', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-1')
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, 'run-1', 'writing-team', ['writer'], 'root-1')
    logRuntimeEvent(assignmentPath, {
      timestamp: new Date().toISOString(),
      event: 'run.completed',
      session_id: 'run-1',
      root_session_id: 'root-1',
      assignment_path: assignmentPath,
      team: 'writing-team',
      level_id: 'final',
      stage_type: 'review',
    })
    const metadata = buildArtifactMetadata({
      filePath: path.join(assignmentPath, 'report.md'),
      rootDir: assignmentPath,
      artifactType: 'report',
      sessionId: 'run-1',
      rootSessionId: 'root-1',
      team: 'writing-team',
    })
    writeMarkdownArtifact(path.join(assignmentPath, 'report.md'), '# Report\n', metadata)

    const store = new FileSystemRunStore(workspacePath)
    const runs = await store.listRuns()

    assert.equal(runs.length, 1)
    assert.equal(requiredValue(runs[0], 'tests/unit/run-store.test.ts:45').id, 'run-1')
    assert.equal(requiredValue(runs[0], 'tests/unit/run-store.test.ts:46').status, 'completed')
    assert.ok(requiredValue(runs[0], 'tests/unit/run-store.test.ts:47').artifactPaths.includes('report.md'))
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore reads artifacts and blocks path traversal', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-2')
    fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'output', 'report.md'), 'hello')
    const store = new FileSystemRunStore(workspacePath)

    const artifact = await store.readArtifact('run-2', 'output/report.md')
    const escaped = await store.readArtifact('run-2', '../secrets.txt')

    assert.equal(artifact?.content, 'hello')
    assert.equal(escaped, null)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore refuses an artifact above the caller byte limit before reading it', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-limited')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'report.md'), '12345')
    const store = new FileSystemRunStore(workspacePath)

    assert.equal(await store.readArtifact('run-limited', 'report.md', { maxBytes: 4 }), null)
    assert.equal(
      (await store.readArtifact('run-limited', 'report.md', { maxBytes: 5 }))?.content,
      '12345',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore preserves DOCX bytes and marks them for download', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-docx')
    fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
    const expected = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0xff, 0x10])
    fs.writeFileSync(path.join(assignmentPath, 'output', 'report.docx'), expected)

    const artifact = await new FileSystemRunStore(workspacePath)
      .readArtifact('run-docx', 'output/report.docx')

    assert.ok(Buffer.isBuffer(artifact?.content))
    assert.deepEqual(artifact?.content, expected)
    assert.equal(
      artifact?.contentType,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )
    assert.match(artifact?.contentDisposition ?? '', /^attachment;/)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore opens retained MP4 artifacts as bounded binary download streams', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-video')
    fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
    const expected = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0xff])
    fs.writeFileSync(path.join(assignmentPath, 'output', 'source-video.mp4'), expected)

    const artifact = await new FileSystemRunStore(workspacePath)
      .openArtifactStream('run-video', 'output/source-video.mp4')
    assert.ok(artifact)
    const chunks: Buffer[] = []
    for await (const chunk of artifact.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }

    assert.deepEqual(Buffer.concat(chunks), expected)
    assert.equal(artifact.contentLength, expected.length)
    assert.equal(artifact.contentType, 'video/mp4')
    assert.match(artifact.contentDisposition ?? '', /^attachment;/)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore keeps private runtime files out of artifact listings and reads', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-private-runtime')
    fs.mkdirSync(path.join(assignmentPath, '.runtime'), { recursive: true })
    fs.mkdirSync(path.join(assignmentPath, 'output', '.runtime'), { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'output', 'report.md'), 'public report')
    fs.writeFileSync(path.join(assignmentPath, '.runtime', 'checkpoint.json'), '{"private":true}')
    fs.writeFileSync(path.join(assignmentPath, 'output', '.runtime', 'state.json'), '{"private":true}')

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('run-private-runtime')

    assert.deepEqual(run?.artifactPaths, [path.join('output', 'report.md')])
    assert.equal(await store.readArtifact('run-private-runtime', '.runtime/checkpoint.json'), null)
    assert.equal(await store.readArtifact('run-private-runtime', 'output/.runtime/state.json'), null)
    assert.equal(
      (await store.readArtifact('run-private-runtime', 'output/report.md'))?.content,
      'public report',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore rejects artifact aliases into private runtime state', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-private-alias')
    const privateRuntimePath = path.join(assignmentPath, '.runtime')
    fs.mkdirSync(privateRuntimePath, { recursive: true })
    fs.writeFileSync(path.join(privateRuntimePath, 'checkpoint.json'), '{"private":true}')
    fs.symlinkSync(
      path.join(privateRuntimePath, 'checkpoint.json'),
      path.join(assignmentPath, 'checkpoint-alias.json'),
    )

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('run-private-alias')

    assert.deepEqual(run?.artifactPaths, [])
    assert.equal(await store.readArtifact('run-private-alias', 'checkpoint-alias.json'), null)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore rejects unsafe run ids and encoded path segments', async () => {
  const workspacePath = makeWorkspace()
  try {
    fs.mkdirSync(path.join(workspacePath, 'assignments'), { recursive: true })
    fs.writeFileSync(path.join(workspacePath, 'secret.txt'), 'outside assignments')
    const store = new FileSystemRunStore(workspacePath)

    assert.equal(await store.getRun('..'), null)
    assert.equal(await store.getRun('../outside'), null)
    assert.equal(await store.getRun('%2e%2e'), null)
    assert.equal(await store.readArtifact('..', 'secret.txt'), null)
    assert.equal(await store.readArtifact('run%2Foutside', 'secret.txt'), null)
    assert.equal(await store.readArtifact('run-safe', 'output/%2e%2e/secret.txt'), null)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore rejects artifacts that escape through symlinks', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-symlink')
    const outsidePath = path.join(workspacePath, 'secret.txt')
    fs.mkdirSync(assignmentPath, { recursive: true })
    fs.writeFileSync(outsidePath, 'outside assignment')
    fs.symlinkSync(outsidePath, path.join(assignmentPath, 'linked-secret.txt'))

    const store = new FileSystemRunStore(workspacePath)
    assert.equal(await store.readArtifact('run-symlink', 'linked-secret.txt'), null)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore rejects symlinked artifacts even when they stay inside the assignment', {
  skip: process.platform === 'win32',
}, async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-inside-symlink')
    fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'output', 'real-video.mp4'), 'video-bytes')
    fs.symlinkSync(
      path.join(assignmentPath, 'output', 'real-video.mp4'),
      path.join(assignmentPath, 'output', 'linked-video.mp4'),
    )

    const store = new FileSystemRunStore(workspacePath)
    assert.equal(await store.readArtifact('run-inside-symlink', 'output/linked-video.mp4'), null)
    assert.equal(
      await store.openArtifactStream('run-inside-symlink', 'output/linked-video.mp4'),
      null,
    )
    assert.notEqual(
      await store.readArtifact('run-inside-symlink', 'output/real-video.mp4'),
      null,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore openArtifactStream supports byte ranges for resumable downloads', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-ranged')
    const expected = Buffer.alloc(1024, 0x42)
    fs.mkdirSync(path.join(assignmentPath, 'output'), { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'output', 'source-video.mp4'), expected)

    const store = new FileSystemRunStore(workspacePath)
    const partial = await store.openArtifactStream(
      'run-ranged',
      'output/source-video.mp4',
      { range: { start: 4, end: 7 } },
    )
    assert.ok(partial)
    const chunks: Buffer[] = []
    for await (const chunk of partial.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    assert.deepEqual(Buffer.concat(chunks), expected.subarray(4, 8))
    assert.equal(partial.contentLength, 4)
    assert.equal(partial.contentType, 'video/mp4')
    assert.ok(partial.etag)

    const full = await store.openArtifactStream('run-ranged', 'output/source-video.mp4')
    assert.ok(full)
    assert.equal(full.contentLength, expected.length)
    assert.equal(full.etag, partial.etag)
    await new Promise<void>((resolve, reject) => {
      full!.stream.once('error', reject)
      full!.stream.once('end', () => resolve())
      full!.stream.resume()
    })

    assert.equal(
      await store.openArtifactStream('run-ranged', 'output/source-video.mp4', {
        range: { start: 2000, end: 3000 },
      }),
      null,
    )
    assert.equal(
      await store.openArtifactStream('run-ranged', 'output/source-video.mp4', {
        range: { start: 2, end: 1 },
      }),
      null,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore aggregates child artifact events with child run ids', async () => {
  const workspacePath = makeWorkspace()
  try {
    const rootAssignmentPath = path.join(workspacePath, 'assignments', 'root-run')
    const childAssignmentPath = path.join(workspacePath, 'assignments', 'child-run')
    fs.mkdirSync(rootAssignmentPath, { recursive: true })
    fs.mkdirSync(childAssignmentPath, { recursive: true })
    writeMarkdownArtifact(
      path.join(childAssignmentPath, 'incoming-brief.md'),
      'child input',
      buildArtifactMetadata({
        filePath: path.join(childAssignmentPath, 'incoming-brief.md'),
        rootDir: childAssignmentPath,
        artifactType: 'brief',
        sessionId: 'child-run',
        rootSessionId: 'root-run',
        parentSessionId: 'root-run',
      }),
    )

    const store = new FileSystemRunStore(workspacePath)
    const events = await store.listRunEvents('root-run')
    const artifactEvent = events.find((event) => event.type === 'artifact.written')
    const artifact = await store.readArtifact('child-run', 'incoming-brief.md')

    assert.equal(artifactEvent?.run_id, 'child-run')
    assert.equal(artifactEvent?.root_run_id, 'root-run')
    assert.equal(artifactEvent?.payload.path, 'incoming-brief.md')
    assert.equal(typeof artifact?.content, 'string')
    assert.match(artifact?.content as string, /child input/)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore tails appended engine events', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-3')
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, 'run-3', 'writing-team', ['writer'], 'root-3')
    const store = new FileSystemRunStore(workspacePath)

    const seen: string[] = []
    const stop = store.tailRunEvents(
      'run-3',
      (event) => {
        seen.push(event.type)
      },
      { fromIndex: 1, pollIntervalMs: 20 },
    )

    logRuntimeEvent(assignmentPath, {
      timestamp: new Date().toISOString(),
      event: 'run.completed',
      session_id: 'run-3',
      root_session_id: 'root-3',
      assignment_path: assignmentPath,
      team: 'writing-team',
      level_id: 'final',
      stage_type: 'review',
    })

    await new Promise((resolve) => setTimeout(resolve, 60))
    stop()

    assert.deepEqual(seen, ['run.completed'])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore includes child events in root run event streams', async () => {
  const workspacePath = makeWorkspace()
  try {
    const rootPath = path.join(workspacePath, 'assignments', 'root-run')
    const childPath = path.join(workspacePath, 'assignments', 'child-run')
    fs.mkdirSync(rootPath, { recursive: true })
    fs.mkdirSync(childPath, { recursive: true })

    logSessionStart(rootPath, 'root-run', 'workflow:test', ['runner'], 'root-run')
    logSessionStart(childPath, 'child-run', 'problem-thinking-board', ['agent'], 'root-run')
    logRuntimeEvent(childPath, {
      timestamp: '2026-05-01T12:01:00.000Z',
      event: 'discussion.message',
      session_id: 'child-run',
      root_session_id: 'root-run',
      assignment_path: childPath,
      team: 'problem-thinking-board',
      level_id: 'deliberation',
      stage_type: 'discussion',
      text: 'A live child message',
    })

    const store = new FileSystemRunStore(workspacePath)
    const events = await store.listRunEvents('root-run')

    assert.ok(events.some((event) => event.run_id === 'child-run' && event.type === 'discussion.message'))
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore keeps root status based on root terminal events', async () => {
  const workspacePath = makeWorkspace()
  try {
    const rootPath = path.join(workspacePath, 'assignments', 'root-active-with-child')
    const childPath = path.join(workspacePath, 'assignments', 'child-complete')
    fs.mkdirSync(rootPath, { recursive: true })
    fs.mkdirSync(childPath, { recursive: true })

    logSessionStart(rootPath, 'root-active-with-child', 'workflow:test', ['runner'], 'root-active-with-child')
    logRuntimeEvent(rootPath, {
      timestamp: '2026-05-01T12:00:10.000Z',
      event: 'host.agent_start',
      session_id: 'root-active-with-child',
      root_session_id: 'root-active-with-child',
      assignment_path: rootPath,
      team: 'workflow:test',
    })
    logSessionStart(childPath, 'child-complete', 'writing-team', ['writer'], 'root-active-with-child')
    logRuntimeEvent(childPath, {
      timestamp: '2026-05-01T12:01:00.000Z',
      event: 'run.completed',
      session_id: 'child-complete',
      root_session_id: 'root-active-with-child',
      assignment_path: childPath,
      team: 'writing-team',
    })

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('root-active-with-child')

    assert.equal(run?.status, 'active')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore derives failed status from run.failed events', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-failed')
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, 'run-failed', 'writing-team', ['writer'], 'root-failed')
    logRuntimeEvent(assignmentPath, {
      timestamp: new Date().toISOString(),
      event: 'run.failed',
      session_id: 'run-failed',
      root_session_id: 'root-failed',
      assignment_path: assignmentPath,
      team: 'writing-team',
      level_id: 'final',
      stage_type: 'review',
    })

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('run-failed')

    assert.equal(run?.status, 'failed')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

for (const terminalStatus of ['blocked', 'cancelled'] as const) {
  test(`FileSystemRunStore preserves run.${terminalStatus} as a distinct status`, async () => {
    const workspacePath = makeWorkspace()
    try {
      const runId = `run-${terminalStatus}`
      const assignmentPath = path.join(workspacePath, 'assignments', runId)
      fs.mkdirSync(assignmentPath, { recursive: true })
      logSessionStart(assignmentPath, runId, 'writing-team', ['writer'], runId)
      logRuntimeEvent(assignmentPath, {
        timestamp: '2026-07-10T12:00:00.000Z',
        event: 'run.completed',
        session_id: runId,
        root_session_id: runId,
        assignment_path: assignmentPath,
        team: 'writing-team',
      })
      logRuntimeEvent(assignmentPath, {
        timestamp: '2026-07-10T12:01:00.000Z',
        event: `run.${terminalStatus}`,
        session_id: runId,
        root_session_id: runId,
        assignment_path: assignmentPath,
        team: 'writing-team',
      })

      const run = await new FileSystemRunStore(workspacePath).getRun(runId)
      assert.equal(run?.status, terminalStatus)
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  })
}

test('an explicit cancellation outranks a later shutdown-incomplete diagnostic', async () => {
  const workspacePath = makeWorkspace()
  try {
    const runId = 'run-cancelled-before-process-exit'
    const assignmentPath = path.join(workspacePath, 'assignments', runId)
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, runId, 'writing-team', ['writer'], runId)
    logRuntimeEvent(assignmentPath, {
      timestamp: '2026-07-10T12:00:00.000Z',
      event: 'run.cancelled',
      session_id: runId,
      root_session_id: runId,
      assignment_path: assignmentPath,
      team: 'writing-team',
    })
    logRuntimeEvent(assignmentPath, {
      timestamp: '2026-07-10T12:00:01.000Z',
      event: 'run.incomplete',
      session_id: runId,
      root_session_id: runId,
      assignment_path: assignmentPath,
      team: 'writing-team',
      reason: 'signal_shutdown',
    })

    const run = await new FileSystemRunStore(workspacePath).getRun(runId)
    assert.equal(run?.status, 'cancelled')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore derives incomplete status from unfinished runs with no open activity', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-incomplete')
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, 'run-incomplete', 'writing-team', ['writer'], 'root-incomplete')
    logRuntimeEvent(assignmentPath, {
      timestamp: '2026-05-01T12:00:00.000Z',
      event: 'host.agent_start',
      session_id: 'run-incomplete',
      root_session_id: 'root-incomplete',
      assignment_path: assignmentPath,
      team: 'writing-team',
    })
    logRuntimeEvent(assignmentPath, {
      timestamp: '2026-05-01T12:01:00.000Z',
      event: 'host.agent_end',
      session_id: 'run-incomplete',
      root_session_id: 'root-incomplete',
      assignment_path: assignmentPath,
      team: 'writing-team',
    })

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('run-incomplete')

    assert.equal(run?.status, 'incomplete')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore preserves explicit run.incomplete terminal events', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-explicit-incomplete')
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, 'run-explicit-incomplete', 'writing-team', ['writer'], 'root-explicit-incomplete')
    logRuntimeEvent(assignmentPath, {
      timestamp: '2026-05-01T12:02:00.000Z',
      event: 'run.incomplete',
      session_id: 'run-explicit-incomplete',
      root_session_id: 'root-explicit-incomplete',
      assignment_path: assignmentPath,
      team: 'writing-team',
      reason: 'signal_shutdown',
    })

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('run-explicit-incomplete')

    assert.equal(run?.status, 'incomplete')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore keeps runs active while agent execution is still open', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-active')
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, 'run-active', 'writing-team', ['writer'], 'root-active')
    logRuntimeEvent(assignmentPath, {
      timestamp: '2026-05-01T12:00:00.000Z',
      event: 'host.agent_start',
      session_id: 'run-active',
      root_session_id: 'root-active',
      assignment_path: assignmentPath,
      team: 'writing-team',
    })

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('run-active')

    assert.equal(run?.status, 'active')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore reports unknown status for assignment folders with no events', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-unknown')
    fs.mkdirSync(path.join(assignmentPath, 'logs'), { recursive: true })
    fs.writeFileSync(path.join(assignmentPath, 'logs', 'engine-events.jsonl'), '')

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('run-unknown')

    assert.equal(run?.status, 'unknown')
    assert.equal(run?.eventCount, 0)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore sorts multiple runs by latest update time descending', async () => {
  const workspacePath = makeWorkspace()
  try {
    const olderPath = path.join(workspacePath, 'assignments', 'run-older')
    const newerPath = path.join(workspacePath, 'assignments', 'run-newer')
    fs.mkdirSync(olderPath, { recursive: true })
    fs.mkdirSync(newerPath, { recursive: true })

    logSessionStart(olderPath, 'run-older', 'writing-team', ['writer'], 'root-older')
    logRuntimeEvent(olderPath, {
      timestamp: '2026-04-17T10:00:00.000Z',
      event: 'run.completed',
      session_id: 'run-older',
      root_session_id: 'root-older',
      assignment_path: olderPath,
      team: 'writing-team',
      level_id: 'final',
      stage_type: 'review',
    })

    logSessionStart(newerPath, 'run-newer', 'writing-team', ['writer'], 'root-newer')
    logRuntimeEvent(newerPath, {
      timestamp: '2026-04-17T11:00:00.000Z',
      event: 'run.completed',
      session_id: 'run-newer',
      root_session_id: 'root-newer',
      assignment_path: newerPath,
      team: 'writing-team',
      level_id: 'final',
      stage_type: 'review',
    })

    const store = new FileSystemRunStore(workspacePath)
    const runs = await store.listRuns()

    assert.deepEqual(runs.map((run) => run.id), ['run-newer', 'run-older'])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore derives execution job titles from reception job requests', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-job-title')
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, 'run-job-title', 'reception-desk', ['receptionist'], 'run-job-title')
    writeMarkdownArtifact(
      path.join(assignmentPath, 'job-request.md'),
      [
        '# Job Request',
        '',
        '## Intake Summary',
        '',
        'Write a concise investor memo about Agridynamics Robotics for a general professional audience.',
      ].join('\n'),
      buildArtifactMetadata({
        filePath: path.join(assignmentPath, 'job-request.md'),
        rootDir: assignmentPath,
        artifactType: 'contract',
        sessionId: 'run-job-title',
        rootSessionId: 'run-job-title',
        team: 'reception-desk',
        title: 'Job request for writing-team',
      }),
    )

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('run-job-title')

    assert.equal(run?.jobTitle, 'Agridynamics Robotics Memo')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore prefers job_title from contract over the long intake summary', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-job-title-short')
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, 'run-job-title-short', 'reception-desk', ['receptionist'], 'run-job-title-short')

    const contract = {
      request_type: 'writing',
      target_team: 'writing-team',
      requested_result_type: 'artifact:report.md',
      job_title: 'Michigan State Overview',
      clarification_needed: false,
      missing_inputs: [],
      source: 'user',
      input_summary: 'Write a one-page overview of Michigan for a general professional audience using the active parsed input bundle.',
      rationale: 'Routed for writing.',
    }
    writeMarkdownArtifact(
      path.join(assignmentPath, 'job-request.md'),
      [
        '# Job Request',
        '',
        '## Title',
        '',
        contract.job_title,
        '',
        '## Contract',
        '',
        '```json',
        JSON.stringify(contract, null, 2),
        '```',
        '',
        '## Intake Summary',
        '',
        contract.input_summary,
      ].join('\n'),
      buildArtifactMetadata({
        filePath: path.join(assignmentPath, 'job-request.md'),
        rootDir: assignmentPath,
        artifactType: 'contract',
        sessionId: 'run-job-title-short',
        rootSessionId: 'run-job-title-short',
        team: 'reception-desk',
        title: 'Job request for writing-team',
      }),
    )

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('run-job-title-short')

    assert.equal(run?.jobTitle, 'Michigan State Overview')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore falls back to intake summary when contract lacks job_title', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-job-title-fallback')
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, 'run-job-title-fallback', 'reception-desk', ['receptionist'], 'run-job-title-fallback')

    const legacyContract = {
      request_type: 'writing',
      target_team: 'writing-team',
      input_summary: 'Investigate a niche manufacturing trend.',
    }
    writeMarkdownArtifact(
      path.join(assignmentPath, 'job-request.md'),
      [
        '# Job Request',
        '',
        '## Contract',
        '',
        '```json',
        JSON.stringify(legacyContract, null, 2),
        '```',
        '',
        '## Intake Summary',
        '',
        legacyContract.input_summary,
      ].join('\n'),
      buildArtifactMetadata({
        filePath: path.join(assignmentPath, 'job-request.md'),
        rootDir: assignmentPath,
        artifactType: 'contract',
        sessionId: 'run-job-title-fallback',
        rootSessionId: 'run-job-title-fallback',
        team: 'reception-desk',
        title: 'Job request for writing-team',
      }),
    )

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('run-job-title-fallback')

    assert.equal(run?.jobTitle, 'Niche Manufacturing Trend Research')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore ignores generic persisted job titles and derives the subject from input_summary', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-job-title-generic')
    fs.mkdirSync(assignmentPath, { recursive: true })
    logSessionStart(assignmentPath, 'run-job-title-generic', 'reception-desk', ['receptionist'], 'run-job-title-generic')

    const contract = {
      request_type: 'writing',
      target_team: 'writing-team',
      requested_result_type: 'artifact:report.md',
      job_title: 'Write a one-page report',
      clarification_needed: false,
      missing_inputs: [],
      source: 'user',
      input_summary: 'Write a one-page report on Ohio for a general professional audience.',
      rationale: 'Routed for writing.',
    }
    writeMarkdownArtifact(
      path.join(assignmentPath, 'job-request.md'),
      [
        '# Job Request',
        '',
        '## Title',
        '',
        contract.job_title,
        '',
        '## Contract',
        '',
        '```json',
        JSON.stringify(contract, null, 2),
        '```',
        '',
        '## Intake Summary',
        '',
        contract.input_summary,
      ].join('\n'),
      buildArtifactMetadata({
        filePath: path.join(assignmentPath, 'job-request.md'),
        rootDir: assignmentPath,
        artifactType: 'contract',
        sessionId: 'run-job-title-generic',
        rootSessionId: 'run-job-title-generic',
        team: 'reception-desk',
        title: 'Job request for writing-team',
      }),
    )

    const store = new FileSystemRunStore(workspacePath)
    const run = await store.getRun('run-job-title-generic')

    assert.equal(run?.jobTitle, 'Ohio Overview')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('FileSystemRunStore skips malformed engine event lines and keeps valid ones', async () => {
  const workspacePath = makeWorkspace()
  try {
    const assignmentPath = path.join(workspacePath, 'assignments', 'run-malformed')
    const logsPath = path.join(assignmentPath, 'logs')
    fs.mkdirSync(logsPath, { recursive: true })
    fs.writeFileSync(path.join(logsPath, 'engine-events.jsonl'), [
      '{"type":"run.session_started","timestamp":"2026-04-17T10:00:00.000Z","schema_version":1,"tenant_id":"local","run_id":"run-malformed","payload":{}}',
      '{not-json',
      '{"type":"run.completed","timestamp":"2026-04-17T10:05:00.000Z","schema_version":1,"tenant_id":"local","run_id":"run-malformed","payload":{}}',
    ].join('\n'))

    const store = new FileSystemRunStore(workspacePath)
    const events = await store.listRunEvents('run-malformed')
    const run = await store.getRun('run-malformed')

    assert.equal(events.length, 2)
    assert.deepEqual(events.map((event) => event.type), ['run.session_started', 'run.completed'])
    assert.equal(run?.status, 'completed')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
