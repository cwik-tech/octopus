import { whenDefined } from '../../core/optional-properties.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import {
  browserFallbackDisposition,
  canonicalYoutubeUrl,
  classifyYoutubePlayability,
  createDeadlineFetch,
  enrichVideoCandidateFromBasicInfo,
  parseJson3Transcript,
  parseCaptureOptions,
  publishedAtFromPages,
  proxyFallbackDisposition,
  replaceManifestVideo,
  requireVideoId,
  safeMarkdownName,
  selectCaptionTrack,
  shouldWaitForPremieres,
  YoutubeExtractionRuntime,
  YoutubeRuntimeError,
} from '../../domains/youtube/youtube-extraction.js'
import { subscribeEngineEvents } from '../../domains/runtime/runtime-events.js'
import type { YoutubeCaptureManifest } from '../../domains/youtube/youtube-types.js'
import { targetedUsername } from '../../domains/proxy/webshare-proxy.js'
import { isYoutubeHost } from '../../domains/youtube/youtube-network.js'
import { parseYoutubeToolInput } from '../../services/youtube-tool-service.js'
import { requireLoopbackCapabilityUrl } from '../../domains/youtube/youtube-tool-client.js'
import { BrowserRuntimeError } from '../../domains/browser/browser-manager.js'
import { Value } from 'typebox/value'
import { createYoutubeTool } from '../../domains/youtube/youtube-tool.js'

test('JSON3 transcript parsing preserves timing and joins caption pieces', () => {
  assert.deepEqual(parseJson3Transcript({
    events: [
      {
        tStartMs: 1_250,
        dDurationMs: 2_500,
        segs: [{ utf8: 'Build ' }, { utf8: 'the system' }],
      },
      { tStartMs: 4_000, dDurationMs: 500, segs: [{ utf8: '   ' }] },
    ],
  }), [{ startMs: 1_250, durationMs: 2_500, text: 'Build the system' }])
})

test('caption selection prefers a requested manual track over generated captions', () => {
  const selected = selectCaptionTrack([
    { base_url: 'generated', language_code: 'en', kind: 'asr', is_translatable: true },
    { base_url: 'manual', language_code: 'en-GB', is_translatable: true },
    { base_url: 'polish', language_code: 'pl', is_translatable: true },
  ], ['en'])
  assert.equal(selected?.base_url, 'manual')
})

test('published date selection scans all response pages and falls back to upload date', () => {
  assert.equal(publishedAtFromPages([
    { video_details: {} },
    { microformat: { publish_date: '2026-07-18T16:30:06-07:00' } },
  ]), '2026-07-18T16:30:06-07:00')
  assert.equal(publishedAtFromPages([
    undefined,
    { microformat: { publish_date: '', upload_date: '2026-07-17' } },
  ]), '2026-07-17')
  assert.equal(publishedAtFromPages([{ microformat: null }]), undefined)
})

test('an upcoming premiere is pending until its scheduled availability instead of requiring authentication', () => {
  assert.deepEqual(classifyYoutubePlayability({
    status: 'LOGIN_REQUIRED',
    isUpcoming: true,
    startTimestamp: new Date('2026-08-14T16:00:00.000Z'),
  }), {
    kind: 'premiere_pending',
    availableAt: '2026-08-14T16:00:00.000Z',
  })
})

test('resume waits for a pending premiere only before its scheduled availability', () => {
  const manifest: YoutubeCaptureManifest = {
    schemaVersion: 1,
    source: {
      type: 'video',
      id: 'Cc0_nyxROBA',
      url: 'https://www.youtube.com/watch?v=Cc0_nyxROBA',
    },
    options: {
      languages: ['en'],
      limit: 10,
      includeShorts: false,
      minDurationSeconds: 0,
    },
    startedAt: '2026-08-14T13:27:00.000Z',
    updatedAt: '2026-08-14T13:27:00.000Z',
    videos: [{
      videoId: 'Cc0_nyxROBA',
      url: 'https://www.youtube.com/watch?v=Cc0_nyxROBA',
      status: 'premiere_pending',
      availableAt: '2026-08-14T16:00:00.000Z',
      attempts: 1,
    }],
  }

  assert.equal(shouldWaitForPremieres(manifest, new Date('2026-08-14T15:59:59.000Z')), true)
  assert.equal(shouldWaitForPremieres(manifest, new Date('2026-08-14T16:00:00.000Z')), false)
})

test('manual inspection retains author and publication metadata from YouTube basic info', () => {
  assert.deepEqual(enrichVideoCandidateFromBasicInfo({
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Listing title',
  }, {
    basic_info: {
      title: 'Canonical title',
      author: 'Example Author',
      duration: 123,
    },
    page: [{ microformat: { publish_date: '2026-08-01' } }],
  }), {
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Canonical title',
    channelName: 'Example Author',
    durationSeconds: 123,
    publishedAt: '2026-08-01',
  })
})

test('Webshare country targeting produces a rotating username once', () => {
  assert.equal(targetedUsername('workspace-user', ['us', 'gb']), 'workspace-user-us-gb-rotate')
  assert.equal(targetedUsername('workspace-user-us-rotate', ['gb']), 'workspace-user-us-rotate')
})

test('YouTube tool input rejects unknown fields and accepts bounded capture input', () => {
  assert.deepEqual(parseYoutubeToolInput({
    action: 'capture',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    limit: 10,
    languages: ['en'],
  }), {
    action: 'capture',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    languages: ['en'],
    limit: 10,
  })
  assert.throws(
    () => parseYoutubeToolInput({ action: 'capture', cookie: 'secret' }),
    /invalid/i,
  )
})

test('YouTube tool input accepts bounded manual-generation controls', () => {
  assert.deepEqual(parseYoutubeToolInput({
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    templateId: 'step-by-step',
    outputLanguage: 'fr-CA',
    freshAnalysis: true,
    geminiConfirmed: true,
  }), {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    templateId: 'step-by-step',
    outputLanguage: 'fr-CA',
    freshAnalysis: true,
    geminiConfirmed: true,
  })
  assert.throws(() => parseYoutubeToolInput({
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    templateId: 'unbounded',
  }), /invalid/i)
})

test('agent-facing YouTube tool exposes every manual-generation action and control', () => {
  const tool = createYoutubeTool({ getAgentPath: () => 'agents/youtube-extractor' })

  assert.match(tool.description, /screenshot-rich.*manual/i)
  assert.match(tool.promptSnippet ?? '', /capture.*before.*prepare_manual/i)
  assert.match(tool.promptSnippet ?? '', /premierePending.*never.*capture_authenticated/i)
  assert.equal(Value.Check(tool.parameters, {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    templateId: 'quick-guide',
    outputLanguage: 'en',
    freshAnalysis: true,
    geminiConfirmed: true,
    manualRunId: 'manual-run-1',
  }), true)
  assert.equal(Value.Check(tool.parameters, {
    action: 'write_manual_plan',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'manual-run-1',
    content: '{"manualPlanSchemaVersion":1}',
  }), true)
  assert.equal(Value.Check(tool.parameters, {
    action: 'build_manual',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'manual-run-1',
  }), true)
})

test('YouTube URL, video ID, filename, and capture options reject unsafe input precisely', () => {
  assert.equal(
    canonicalYoutubeUrl('http://youtu.be/dQw4w9WgXcQ#fragment').toString(),
    'https://youtu.be/dQw4w9WgXcQ',
  )
  for (const value of ['https://example.com/watch?v=dQw4w9WgXcQ', 'not-a-url']) {
    assert.throws(
      () => canonicalYoutubeUrl(value),
      (error) => error instanceof YoutubeRuntimeError && error.code === 'invalid_request',
    )
  }
  assert.equal(requireVideoId('dQw4w9WgXcQ'), 'dQw4w9WgXcQ')
  assert.throws(() => requireVideoId('../outside'), /video ID is invalid/i)
  assert.equal(safeMarkdownName('../../Unsafe Method.MD'), 'unsafe-method.md')
  assert.deepEqual(parseCaptureOptions({
    action: 'capture',
    languages: ['EN', 'pl', 'EN'],
    all: true,
    includeShorts: true,
    minDurationSeconds: 60,
  }), {
    languages: ['EN', 'pl'],
    limit: 'all',
    includeShorts: true,
    minDurationSeconds: 60,
  })
  assert.throws(
    () => parseCaptureOptions({ action: 'capture', languages: ['not_valid'] }),
    (error) => error instanceof YoutubeRuntimeError &&
      error.code === 'invalid_request' &&
      error.retryable === false,
  )
})

test('cookie and capability host policies accept only exact YouTube and loopback hosts', () => {
  for (const host of ['youtube.com', 'www.youtube.com', 'music.youtube.com']) {
    assert.equal(isYoutubeHost(host), true)
  }
  for (const host of ['evilyoutube.com', 'youtube.com.example.org', 'youtu.be']) {
    assert.equal(isYoutubeHost(host), false)
  }
  assert.equal(
    requireLoopbackCapabilityUrl('http://127.0.0.1:3001/private-path'),
    'http://127.0.0.1:3001/private-path',
  )
  for (const url of [
    'https://127.0.0.1/private-path',
    'http://example.com/private-path',
    'http://127.0.0.1/',
    'http://127.0.0.1/private-path?token=secret',
  ]) {
    assert.throws(() => requireLoopbackCapabilityUrl(url))
  }
})

test('manifest replacement updates video metadata and keeps unavailable separate from failed', () => {
  const manifest: YoutubeCaptureManifest = {
    schemaVersion: 1,
    source: {
      type: 'video',
      id: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    },
    options: {
      languages: ['en'],
      limit: 10,
      includeShorts: false,
      minDurationSeconds: 0,
    },
    startedAt: '2026-07-19T00:00:00.000Z',
    updatedAt: '2026-07-19T00:00:00.000Z',
    videos: [{
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      status: 'pending',
      attempts: 0,
    }],
  }
  const replaced = replaceManifestVideo(manifest, {
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    title: 'Resolved title',
    status: 'no_transcript',
    attempts: 1,
    error: {
      code: 'transcript_unavailable',
      message: 'No transcript.',
      retryable: false,
    },
  }, new Date('2026-07-19T01:00:00.000Z'))
  assert.equal(replaced.source.title, 'Resolved title')
  assert.equal(replaced.videos[0]?.status, 'no_transcript')
  assert.equal(replaced.updatedAt, '2026-07-19T01:00:00.000Z')
})

test('resuming an all-upcoming manifest writes a blocked report without authenticated fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-premiere-blocked-'))
  try {
    fs.mkdirSync(path.join(root, 'output'), { recursive: true })
    fs.writeFileSync(path.join(root, 'output', 'youtube-manifest.json'), `${JSON.stringify({
      schemaVersion: 1,
      source: {
        type: 'video',
        id: 'Cc0_nyxROBA',
        url: 'https://www.youtube.com/watch?v=Cc0_nyxROBA',
        title: 'Scheduled Premiere',
      },
      options: {
        languages: ['en'],
        limit: 10,
        includeShorts: false,
        minDurationSeconds: 0,
      },
      startedAt: '2026-08-14T13:27:00.000Z',
      updatedAt: '2026-08-14T13:27:00.000Z',
      videos: [{
        videoId: 'Cc0_nyxROBA',
        url: 'https://www.youtube.com/watch?v=Cc0_nyxROBA',
        title: 'Scheduled Premiere',
        status: 'premiere_pending',
        availableAt: '2026-08-14T16:00:00.000Z',
        attempts: 1,
        error: {
          code: 'premiere_pending',
          message: 'This premiere is scheduled but not yet available.',
          retryable: true,
        },
      }],
    }, null, 2)}\n`)
    const runtime = new YoutubeExtractionRuntime({
      assignmentPath: root,
      settings: { runtimeProxy: async () => disabledRuntimeProxy() },
      now: () => new Date('2026-08-14T13:30:00.000Z'),
    })

    const result = await runtime.capture({ action: 'resume' })

    assert.equal(result.ok, false)
    assert.equal(result.premierePending, 1)
    assert.equal(result.authenticatedFallbackRequired, 0)
    assert.equal(result.error?.code, 'premiere_pending')
    const report = fs.readFileSync(path.join(root, 'extraction-report.md'), 'utf8')
    assert.match(report, /\*\*Status:\*\* BLOCKED/)
    assert.match(report, /2026-08-14T16:00:00\.000Z/)
    assert.match(report, /Run this workflow again after/i)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('proxy fallback keeps configuration and retrieval failures out of auth_required', () => {
  assert.equal(proxyFallbackDisposition('no_transcript'), 'no_transcript')
  assert.equal(String(proxyFallbackDisposition('premiere_pending')), 'premiere_pending')
  assert.equal(proxyFallbackDisposition('auth_required'), 'auth_required')
  assert.equal(proxyFallbackDisposition('retrieval'), 'proxy_failed')
  assert.equal(proxyFallbackDisposition(undefined), 'proxy_failed')
})

test('browser fallback treats timeouts and crashes as retryable failures, not missing transcripts', () => {
  assert.equal(
    browserFallbackDisposition(new BrowserRuntimeError('empty_content', 'No transcript.')),
    'no_transcript',
  )
  assert.equal(
    browserFallbackDisposition(new BrowserRuntimeError('timeout', 'Timed out.', true)),
    'browser_failed',
  )
  assert.equal(browserFallbackDisposition(new Error('Target closed')), 'browser_failed')
})

test('YouTube fetch wrapper aborts stalled real HTTP requests at its deadline', async (context) => {
  const server = http.createServer((_request, response) => {
    setTimeout(() => response.end('late'), 1_000)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  context.after(() => {
    server.closeAllConnections()
    server.close()
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const boundedFetch = createDeadlineFetch(fetch, undefined, 20)
  await assert.rejects(boundedFetch(`http://127.0.0.1:${address.port}/stalled`))
})

test('write_methodology publishes an artifact.written event so the file surfaces in delivery', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-method-event-'))
  const videoId = 'dQw4w9WgXcQ'
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath: root,
    settings: { runtimeProxy: async () => disabledRuntimeProxy() },
    artifactContext: {
      sessionId: 'assignment-1',
      rootSessionId: 'run-1',
      team: 'youtube-extraction',
      level: 'extract',
      stageType: 'chain',
    },
  })
  const captured = captureArtifactEvents()

  const result = await runtime.writeMethodology({
    action: 'write_methodology',
    videoId,
    content: `# Source Method: t\n\n## Outcome and intended use\n\n- [Source states](https://www.youtube.com/watch?v=${videoId}&t=10s) Demo.`,
  })
  captured.unsubscribe()

  assert.equal(result.ok, true)
  assert.equal(result.artifactPath, `output/methods/${videoId}.md`)
  const events = captured.events.filter(
    (event) =>
      event.type === 'artifact.written' &&
      (event.payload as Record<string, unknown>).path === `output/methods/${videoId}.md`,
  )
  assert.equal(events.length, 1, 'expected exactly one artifact.written event for the method file')
  const payload = events[0]!.payload as Record<string, unknown>
  assert.equal(payload.artifact_role, 'intermediate')
  assert.equal(payload.artifact_type, 'result')
  assert.equal(events[0]!.team, 'youtube-extraction')
  assert.equal(events[0]!.level_id, 'extract')
  assert.equal(events[0]!.run_id, 'assignment-1')
  assert.equal(events[0]!.root_run_id, 'run-1')

  fs.rmSync(root, { recursive: true, force: true })
})

test('write_consolidation publishes a final artifact.written event for the playbook', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-consolidation-event-'))
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath: root,
    settings: { runtimeProxy: async () => disabledRuntimeProxy() },
    artifactContext: {
      sessionId: 'assignment-2',
      rootSessionId: 'run-2',
    },
  })
  const captured = captureArtifactEvents()

  const result = await runtime.writeConsolidation({
    action: 'write_consolidation',
    fileName: 'youtube-deal-screening.md',
    content: '# Consolidated Playbook\n\n## Outcome, scope, and non-goals\n\nDemo body.',
  })
  captured.unsubscribe()

  assert.equal(result.ok, true)
  assert.equal(result.artifactPath, 'output/generalized-methodology/youtube-deal-screening.md')
  const events = captured.events.filter(
    (event) =>
      event.type === 'artifact.written' &&
      (event.payload as Record<string, unknown>).path === result.artifactPath,
  )
  assert.equal(events.length, 1)
  const payload = events[0]!.payload as Record<string, unknown>
  assert.equal(payload.artifact_role, 'final')
  assert.equal(payload.artifact_type, 'report')

  fs.rmSync(root, { recursive: true, force: true })
})

test('a multi-video capture announces the manifest once, not once per revision', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-manifest-once-'))
  const videoIds = ['aaaaaaaaaaa', 'bbbbbbbbbbb', 'ccccccccccc']
  const manifest: YoutubeCaptureManifest = {
    schemaVersion: 1,
    source: { id: 'PLdemo', type: 'playlist', url: 'https://www.youtube.com/playlist?list=PLdemo' },
    options: { languages: ['en'], limit: 10, includeShorts: false, minDurationSeconds: 0 },
    startedAt: '2026-08-13T12:00:00.000Z',
    updatedAt: '2026-08-13T12:00:00.000Z',
    videos: videoIds.map((videoId) => ({
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title: `Video ${videoId}`,
      status: 'auth_required' as const,
      attempts: 1,
    })),
  }
  fs.mkdirSync(path.join(root, 'output'), { recursive: true })
  fs.writeFileSync(
    path.join(root, 'output', 'youtube-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  )
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath: root,
    settings: { runtimeProxy: async () => disabledRuntimeProxy() },
    browserManager: {
      youtubeCookieHeader: async () => undefined,
      captureYoutubeTranscript: async (videoId: string) => ({
        title: `Video ${videoId}`,
        language: 'en',
        segments: [{ startMs: 0, durationMs: 1_000, text: 'Demo transcript.' }],
      }),
    },
    artifactContext: { sessionId: 'assignment-3', rootSessionId: 'run-3' },
  })
  const captured = captureArtifactEvents()

  const result = await runtime.captureAuthenticated({ action: 'capture_authenticated' })
  captured.unsubscribe()

  assert.equal(result.ok, true)
  const manifestEvents = captured.events.filter(
    (event) =>
      event.type === 'artifact.written' &&
      (event.payload as Record<string, unknown>).path === 'output/youtube-manifest.json',
  )
  // The manifest is re-saved after each of the three videos so an interrupted
  // capture stays resumable, but it names one file, so it is one artifact.
  assert.equal(
    manifestEvents.length,
    1,
    'expected exactly one manifest artifact event for a three-video capture',
  )
  const transcriptEvents = captured.events.filter(
    (event) =>
      event.type === 'artifact.written' &&
      String((event.payload as Record<string, unknown>).path ?? '')
        .startsWith('output/transcripts/'),
  )
  // Per-video progress stays visible through the transcripts themselves.
  assert.equal(transcriptEvents.length, videoIds.length)

  fs.rmSync(root, { recursive: true, force: true })
})

test('runtime without artifactContext writes files but emits no events', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-no-context-'))
  const videoId = 'aaaaaaaaaaa'
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath: root,
    settings: { runtimeProxy: async () => disabledRuntimeProxy() },
  })
  const captured = captureArtifactEvents()

  const result = await runtime.writeMethodology({
    action: 'write_methodology',
    videoId,
    content: '# Source Method\n\n- Demo.',
  })
  captured.unsubscribe()

  assert.equal(result.ok, true)
  assert.equal(captured.events.filter((event) => event.type === 'artifact.written').length, 0)
  assert.ok(fs.existsSync(path.join(root, result.artifactPath!)))

  fs.rmSync(root, { recursive: true, force: true })
})

function disabledRuntimeProxy() {
  return {
    proxyEnabled: false,
    credentialMode: 'username-password' as const,
    proxyHost: 'p.webshare.io',
    proxyPort: 80,
    countries: ['us'],
    username: '',
  }
}

function captureArtifactEvents(): {
  events: Array<{ type: string; payload: unknown; team?: string | null; level_id?: string | null; run_id?: string; root_run_id?: string }>
  unsubscribe: () => void
} {
  const events: Array<{ type: string; payload: unknown; team?: string | null; level_id?: string | null; run_id?: string; root_run_id?: string }> = []
  const unsubscribe = subscribeEngineEvents((event) => {
    if (event.category === 'artifact') {
      events.push({
        type: event.type,
        payload: event.payload,
        ...whenDefined(event.team, (team) => ({ team: team })),
        ...whenDefined(event.level_id, (level_id) => ({ level_id: level_id })),
        ...whenDefined(event.run_id, (run_id) => ({ run_id: run_id })),
        ...whenDefined(event.root_run_id, (root_run_id) => ({ root_run_id: root_run_id })),
      })
    }
  })
  return { events, unsubscribe }
}

test('new manual requests require explicit formats, purpose and user instructions', () => {
  assert.throws(() => parseYoutubeToolInput({ action: 'prepare_manual', url: 'https://www.youtube.com/watch?v=b2tjnxX8IHU' }), /invalid/i)
  const documentRequest = { formats: ['markdown'], purpose: 'takeaways', instructions: 'MD with screenshots and main takeaways.' }
  assert.deepEqual(parseYoutubeToolInput({ action: 'prepare_manual', documentRequest }).documentRequest, documentRequest)
})
