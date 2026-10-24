import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { PiRunLauncher } from '../../domains/run/run-launcher.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import type { SessionTask } from '../../contracts/sessions.js'

const repoRoot = process.cwd()
const enabled = process.env.PIPELINE_LIVE_YOUTUBE === '1'
const videoUrl = 'https://www.youtube.com/watch?v=XLEYtv3cMlw'
const videoId = 'XLEYtv3cMlw'
const directApiCredentials = [
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'CLAUDE_API_KEY',
  'DEEPSEEK_API_KEY',
  'XAI_API_KEY',
  'GROQ_API_KEY',
] as const

test('YouTube transcript workflow captures the supplied video end to end', {
  skip: enabled ? undefined : 'Set PIPELINE_LIVE_YOUTUBE=1 to run live YouTube workflow extraction.',
  timeout: 20 * 60_000,
}, async () => {
  await withLiveYoutubeWorkflow({
    workflowId: 'youtube-transcript-extraction',
    title: 'YouTube transcript E2E',
    brief: [
      `Capture the complete English transcript for ${videoUrl}.`,
      'This is transcript-only mode. Do not extract a methodology.',
      'Write extraction-report.md from the report template: video title, URL, publish date, and a plain-language summary of what the video is about.',
    ].join(' '),
    verify: ({ task, files }) => {
      const transcriptPath = requireFile(files, `output/transcripts/${videoId}.json`)
      const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')) as TranscriptArtifact
      assertCompleteTranscript(transcript)

      requireFile(files, `output/transcripts/${videoId}.md`)

      const reportPath = requireFile(files, 'extraction-report.md')
      const report = fs.readFileSync(reportPath, 'utf8')
      assert.match(report, new RegExp(videoId))
      assert.match(report, /^# .+/m, 'Report must open with a video title heading.')
      assert.match(report, /\*\*URL:\*\*/i, 'Report must include the video URL line.')
      assert.match(report, /\*\*Published:\*\*/i, 'Report must include the publish date line.')
      assert.match(report, /## What this video is about/, 'Report must include the plain-summary section.')
      assert.doesNotMatch(report, /## Per-video results|## Delivered artifacts|## Counts by Status|## Items Requiring User Action/, 'Report must not contain programmatic status sections.')
      assert.equal(
        files.some((filePath) => normalized(filePath).includes('/output/methods/')),
        false,
        'Transcript-only workflow must not create a methodology artifact.',
      )
      assertCodexSubscriptionRun(task, files)
    },
  })
})

test('YouTube methodology workflow extracts a source-linked method end to end', {
  skip: enabled ? undefined : 'Set PIPELINE_LIVE_YOUTUBE=1 to run live YouTube workflow extraction.',
  timeout: 20 * 60_000,
}, async () => {
  await withLiveYoutubeWorkflow({
    workflowId: 'youtube-methodology-extraction',
    title: 'YouTube methodology E2E',
    brief: [
      `Capture the complete English transcript for ${videoUrl}.`,
      'Extract the actionable methodology from the entire transcript using the loaded methodology skill.',
      'Persist the per-video method and write extraction-report.md with its artifact path.',
    ].join(' '),
    verify: ({ task, files }) => {
      const transcriptPath = requireFile(files, `output/transcripts/${videoId}.json`)
      const transcript = JSON.parse(fs.readFileSync(transcriptPath, 'utf8')) as TranscriptArtifact
      assertCompleteTranscript(transcript)

      const methodPath = requireFile(files, `output/methods/${videoId}.md`)
      const methodology = fs.readFileSync(methodPath, 'utf8')
      assert.ok(methodology.length > 1_000, 'Methodology artifact is unexpectedly short.')
      assert.match(methodology, new RegExp(videoId))
      assert.match(methodology, /youtube\.com\/watch\?v=XLEYtv3cMlw/)
      assert.match(methodology, /(?:\[\d{1,2}:\d{2}(?::\d{2})?\]|[?&]t=\d+s)/)
      assert.match(methodology, /prerequisite|required input/i)
      assert.match(methodology, /procedure|process|workflow|ordered steps/i)
      assert.match(methodology, /decision|branch/i)
      assert.match(methodology, /failure|constraint|caveat|limitation/i)
      assert.match(methodology, /# Source Method:/)
      assert.match(methodology, /## Outcome and intended use/)

      const reportPath = requireFile(files, 'extraction-report.md')
      const report = fs.readFileSync(reportPath, 'utf8')
      assert.match(report, /output\/methods\/XLEYtv3cMlw\.md/)
      assert.match(report, /^# .+/m, 'Report must open with a video title heading.')
      assert.match(report, /\*\*URL:\*\*/i)
      assert.match(report, /\*\*Published:\*\*/i)
      assert.match(report, /## What this video is about/)
      assert.match(report, /## Method/)
      assert.doesNotMatch(report, /## Per-video results|## Delivered artifacts|## Counts by Status|## Items Requiring User Action/, 'Report must not contain programmatic status sections.')
      assertCodexSubscriptionRun(task, files)
    },
  })
})

interface TranscriptArtifact {
  videoId: string
  url: string
  title: string
  language: string
  captureMethod: string
  segments: Array<{
    startMs: number
    durationMs: number
    text: string
  }>
}

async function withLiveYoutubeWorkflow(params: {
  workflowId: string
  title: string
  brief: string
  verify: (context: { task: SessionTask; files: string[] }) => void
}): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-workflow-live-'))
  const workspacePath = path.join(root, 'workspace')
  const keepWorkspace = process.env.PIPELINE_KEEP_LIVE_WORKSPACE === '1'
  const originalCredentials = Object.fromEntries(
    directApiCredentials.map((name) => [name, process.env[name]]),
  )
  for (const name of directApiCredentials) process.env[name] = ''

  const sessionStore = new FileSystemSessionStore(workspacePath)
  let server: StartedApiServer | undefined
  try {
    server = await startApiServer({
      store: new FileSystemRunStore(workspacePath),
      launcher: new PiRunLauncher(),
      sessionStore,
      recoverInterruptedTasks: true,
      repoRootPath: repoRoot,
      workflowsRegistryPath: path.join(repoRoot, 'workflows', 'registry.yaml'),
      workspacePath,
    })
    const session = await sessionStore.createSession({ title: params.title })
    const response = await fetch(`${server.url}/sessions/${session.id}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflowId: params.workflowId, brief: params.brief }),
    })
    const responseText = await response.text()
    assert.equal(response.status, 202, responseText)
    const launched = JSON.parse(responseText) as SessionTask
    const task = await waitForTerminalTask(sessionStore, session.id, launched.id)
    assert.equal(task.status, 'done', task.error ?? `${params.workflowId} did not complete.`)
    assert.ok(task.runPath, `${params.workflowId} did not publish a run path.`)
    const files = walkFiles(task.runPath)
    params.verify({ task, files })
  } finally {
    await server?.close().catch(() => undefined)
    for (const name of directApiCredentials) {
      const value = originalCredentials[name]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    if (keepWorkspace) {
      process.stderr.write(`Preserved live YouTube workflow workspace: ${root}\n`)
    } else {
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 100,
      })
    }
  }
}

async function waitForTerminalTask(
  store: FileSystemSessionStore,
  sessionId: string,
  taskId: string,
): Promise<SessionTask> {
  const deadline = Date.now() + 15 * 60_000
  while (Date.now() < deadline) {
    const task = await store.getTaskRecord(sessionId, taskId)
    if (task && ['done', 'failed', 'blocked', 'cancelled'].includes(task.status)) return task
    await new Promise((resolve) => setTimeout(resolve, 2_000))
  }
  throw new Error(`Timed out waiting for live YouTube task '${taskId}'.`)
}

function assertCompleteTranscript(transcript: TranscriptArtifact): void {
  assert.equal(transcript.videoId, videoId)
  assert.equal(transcript.url, videoUrl)
  assert.ok(transcript.title.trim().length > 0)
  assert.ok(transcript.language.trim().length > 0)
  assert.ok(['direct', 'webshare', 'authenticated', 'browser'].includes(transcript.captureMethod))
  assert.ok(transcript.segments.length > 10, 'Transcript contains too few segments.')
  assert.ok(
    transcript.segments.every((segment) =>
      Number.isSafeInteger(segment.startMs) &&
      segment.startMs >= 0 &&
      Number.isSafeInteger(segment.durationMs) &&
      segment.durationMs >= 0 &&
      segment.text.trim().length > 0,
    ),
    'Transcript segments must contain valid timing and non-empty text.',
  )
  assert.ok(
    transcript.segments.map((segment) => segment.text).join(' ').length > 1_000,
    'Transcript text is unexpectedly short.',
  )
}

function assertCodexSubscriptionRun(task: SessionTask, files: readonly string[]): void {
  assert.ok(task.runPath)
  const logs = files
    .filter((filePath) => /(?:host|provider)-events\.jsonl$|agent-runs\.jsonl$/.test(filePath))
    .map((filePath) => fs.readFileSync(filePath, 'utf8'))
    .join('\n')
  assert.match(logs, /"resolved_host_provider":"openai-codex"/)
  assert.match(logs, /"provider":"codex"/)
  assert.doesNotMatch(logs, /openai-responses-api|invalid_api_key|"provider":"groq"|\b401\b/)
}

function walkFiles(rootPath: string): string[] {
  const files: string[] = []
  for (const entry of fs.readdirSync(rootPath, { withFileTypes: true })) {
    const entryPath = path.join(rootPath, entry.name)
    if (entry.isDirectory()) files.push(...walkFiles(entryPath))
    else if (entry.isFile()) files.push(entryPath)
  }
  return files
}

function requireFile(files: readonly string[], suffix: string): string {
  const normalizedSuffix = normalized(suffix)
  const matches = files.filter((filePath) => normalized(filePath).endsWith(normalizedSuffix))
  assert.equal(matches.length, 1, `Expected exactly one ${suffix}, found ${matches.length}.`)
  return matches[0]!
}

function normalized(filePath: string): string {
  return filePath.split(path.sep).join('/')
}
