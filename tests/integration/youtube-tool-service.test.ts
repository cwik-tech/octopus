import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { test, type TestContext } from 'node:test'

import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import type {
  McpBrokerRequestContext,
  McpJsonObject,
} from '../../domains/mcp/mcp-runtime.js'
import { YoutubeSettingsService } from '../../services/youtube-settings-service.js'
import {
  YoutubeToolService,
  type YoutubePreparedCapability,
  type YoutubeMediaTools,
} from '../../services/youtube-tool-service.js'
import { YoutubeGeminiUsageLedger } from '../../services/youtube-gemini-usage-ledger.js'
import { BrowserRuntimeError } from '../../domains/browser/browser-manager.js'
import { YoutubeGeminiAnalysisError } from '../../domains/youtube/youtube-gemini-analysis.js'
import { YoutubeExtractionRuntime, YoutubeRuntimeError } from '../../domains/youtube/youtube-extraction.js'
import type {
  YoutubeManifestVideo,
  YoutubeToolOutput,
} from '../../domains/youtube/youtube-types.js'
import {
  YOUTUBE_BUILTIN_SOURCE,
  YoutubeCapabilityDispatchGateway,
} from '../../services/youtube-capability-adapter.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'
import { youtubeToolModule } from '../../server/tools/youtube.js'
import {
  writeCookieRecordingYtDlp,
  writeMediaProbe,
} from '../support/youtube-media-stubs.js'

function youtubeContext(): McpBrokerRequestContext {
  return {
    contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
    requestId: 'request-1',
    leaseId: 'lease-1',
    sessionId: 'session-1',
    runId: 'run-1',
    assignmentId: 'assignment-1',
    agentPath: 'agents/youtube-extractor',
  }
}

async function executeYoutubeDomain(
  service: YoutubeToolService,
  context: McpBrokerRequestContext,
  toolCallId: string,
  input: McpJsonObject,
  signal?: AbortSignal,
): Promise<YoutubeToolOutput> {
  const preparation = await service.prepareCapability(context, toolCallId, input)
  if (preparation.kind === 'rejected') return preparation.output
  const capability = preparation.capability
  if (capability.policyDecision.kind === 'require-approval') {
    throw new Error('Approval-required actions must be exercised through the capability dispatcher.')
  }
  const authorization = await service.authorizeCapability(
    capability,
    'before-execute',
  )
  if (authorization.kind === 'deny') return authorization.output
  try {
    const output = await service.executeCapability(capability, signal)
    return await service.acceptCapabilityResult(capability, output)
  } catch {
    return terminalYoutubeDomainOutput(capability)
  }
}

function terminalYoutubeDomainOutput(
  capability: YoutubePreparedCapability,
): YoutubeToolOutput {
  return capability.terminalOutput ?? {
    ok: false,
    action: capability.input.action,
    error: {
      code: 'internal',
      message: 'YouTube extraction failed. No credential or cookie details were retained.',
      retryable:
        capability.input.action === 'capture' ||
        capability.input.action === 'resume',
    },
  }
}

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('Deferred promise is not initialized') }
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function makeLazyMediaFixture(context: TestContext) {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-lazy-media-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(workspacePath, 'sessions/session-1/runs/run-1/assignments/assignment-1')
  await fs.mkdir(assignmentPath, { recursive: true })
  const probeStarted = deferred<void>()
  const mediaTools = deferred<YoutubeMediaTools>()
  const callsPath = path.join(workspacePath, 'binary-checks.jsonl')
  // Bundled executable startup is nondeterministic. Replace only that boundary;
  // service preparation, concurrent callers, cancellation and manifests are real.
  const resolveMediaTools = async () => {
    await fs.appendFile(callsPath, 'verified\n')
    probeStarted.resolve()
    return mediaTools.promise
  }
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
    resolveMediaTools,
    inspectManualVideo: async () => ({
      videoId: 'dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Lazy media tools', durationSeconds: 60,
    }),
  })
  const resolved: YoutubeMediaTools = { youtubeBinaries: {
    ytDlpPath: '/fixture/yt-dlp', ffmpegPath: '/fixture/ffmpeg', ffprobePath: '/fixture/ffprobe',
    ytDlpVersion: '2026.08.01', ffmpegVersion: '8.0', ffprobeVersion: '8.0',
  } }
  return { workspacePath, assignmentPath, probeStarted, mediaTools, service, resolved, callsPath, resolveMediaTools }
}

test('manual requests initialize media tools once and persist their verified versions', async (context) => {
  const fixture = await makeLazyMediaFixture(context)
  await executeYoutubeDomain(fixture.service, youtubeContext(), 'method', {
    action: 'write_methodology', videoId: 'dQw4w9WgXcQ', content: '# Method',
  })
  await assert.rejects(fs.access(fixture.callsPath), { code: 'ENOENT' })
  const prepare = (id: string) => executeYoutubeDomain(fixture.service, youtubeContext(), id, {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' }, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', manualRunId: id,
  })
  const first = prepare('first')
  const second = prepare('second')
  fixture.mediaTools.resolve(fixture.resolved)
  const results = await Promise.all([first, second])
  assert.equal(results[0]?.ok, true)
  assert.equal(results[1]?.ok, true)
  assert.equal((await prepare('third')).ok, true)
  const manifest = JSON.parse(await fs.readFile(path.join(
    fixture.assignmentPath, 'output/manuals/dQw4w9WgXcQ/first/generation-manifest.json',
  ), 'utf8'))
  assert.deepEqual(manifest.binaries.map((binary: { version: string }) => binary.version), ['2026.08.01', '8.0', '8.0'])
  assert.equal(await fs.readFile(fixture.callsPath, 'utf8'), 'verified\n')
})

test('cancelling a manual request leaves shared media initialization available to other requests', async (context) => {
  const fixture = await makeLazyMediaFixture(context)
  const controller = new AbortController()
  const first = executeYoutubeDomain(fixture.service, youtubeContext(), 'cancelled', {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' }, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', manualRunId: 'cancelled',
  }, controller.signal)
  await fixture.probeStarted.promise
  const second = executeYoutubeDomain(fixture.service, youtubeContext(), 'surviving', {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' }, url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', manualRunId: 'surviving',
  })
  controller.abort()
  assert.equal((await first).error?.code, 'cancelled')
  fixture.mediaTools.resolve(fixture.resolved)
  assert.equal((await second).ok, true)
  assert.equal(await fs.readFile(fixture.callsPath, 'utf8'), 'verified\n')
  await assert.rejects(fs.access(path.join(fixture.assignmentPath, 'output/manuals/dQw4w9WgXcQ/cancelled')), { code: 'ENOENT' })
})

test('the YouTube module passes deferred media checks to the service without starting them', async (context) => {
  const fixture = await makeLazyMediaFixture(context)
  const contribution = youtubeToolModule.build({
    workspacePath: fixture.workspacePath,
    moduleOptions: { youtube: { resolveMediaTools: fixture.resolveMediaTools } },
  })
  await assert.rejects(fs.access(fixture.callsPath), { code: 'ENOENT' })
  const service = contribution.services.youtubeToolService
  assert.ok(service)
  const prepared = await service.prepareCapability(youtubeContext(), 'manual', {
    action: 'build_manual', videoId: 'dQw4w9WgXcQ', manualRunId: 'missing-plan',
  })
  assert.equal(prepared.kind, 'prepared')
  if (prepared.kind !== 'prepared') throw new Error('Manual capability was rejected')
  fixture.mediaTools.resolve(fixture.resolved)
  await assert.rejects(service.executeCapability(prepared.capability), /write_manual_plan/)
  assert.equal(await fs.readFile(fixture.callsPath, 'utf8'), 'verified\n')
})

test('YouTube tool service confines writes to the dedicated agent assignment', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-tool-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(
    workspacePath,
    'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  )
  await fs.mkdir(assignmentPath, { recursive: true })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
  })
  const contextValue = youtubeContext()

  const output = await executeYoutubeDomain(service, contextValue, 'call-1', {
    action: 'write_methodology',
    videoId: 'dQw4w9WgXcQ',
    content: '# Source method',
  })
  assert.equal(output.ok, true)
  assert.equal(output.artifactPath, 'output/methods/dQw4w9WgXcQ.md')
  assert.equal(
    await fs.readFile(path.join(assignmentPath, 'output', 'methods', 'dQw4w9WgXcQ.md'), 'utf8'),
    '# Source method\n',
  )

  const denied = await executeYoutubeDomain(
    service,
    { ...contextValue, agentPath: 'agents/quick-scout' },
    'call-2',
    { action: 'write_methodology', videoId: 'dQw4w9WgXcQ', content: '# Denied' },
  )
  assert.equal(denied.ok, false)
  assert.equal(denied.error?.code, 'invalid_request')
})

test('prepare_manual routes a single video through the optional Gemini coordinator', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-tool-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(
    workspacePath,
    'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  )
  await fs.mkdir(assignmentPath, { recursive: true })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
    inspectManualVideo: async () => ({
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      durationSeconds: 600,
    }),
  })

  const output = await executeYoutubeDomain(service, youtubeContext(), 'call-manual', {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    templateId: 'step-by-step',
    outputLanguage: 'en',
  })

  assert.equal(output.ok, true)
  assert.equal(output.action, 'prepare_manual')
  assert.equal(output.analysisMode, 'transcript')
  assert.equal(output.notices?.[0]?.code, 'gemini_key_missing')
  assert.ok(output.manualRunId)
  assert.match(output.manifestPath ?? '', /^output\/manuals\/dQw4w9WgXcQ\//)
  const events = (await fs.readFile(
    path.join(assignmentPath, 'logs', 'engine-events.jsonl'),
    'utf8',
  )).trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(events.at(-1)?.type, 'youtube.manual.analysis_fallback')
  assert.equal(events.at(-1)?.payload.error_code, 'gemini_key_missing')
  assert.equal(events.at(-1)?.payload.analysis_mode, 'transcript')
})

test('prepare_manual records a safe Gemini fallback code in the engine timeline', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-event-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(
    workspacePath,
    'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  )
  await fs.mkdir(assignmentPath, { recursive: true })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({
      environment: { GEMINI_API_KEY: 'private-key' },
    }),
    inspectManualVideo: async () => ({
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      durationSeconds: 600,
    }),
    youtubeAnalysis: {
      analyze: async () => {
        throw new YoutubeGeminiAnalysisError(
          'invalid_response',
          'Gemini returned an invalid analysis response.',
        )
      },
    },
  })

  const output = await executeYoutubeDomain(service, youtubeContext(), 'call-manual-event', {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    outputLanguage: 'en',
  })

  assert.equal(output.notices?.[0]?.code, 'gemini_invalid_response')
  const events = (await fs.readFile(
    path.join(assignmentPath, 'logs', 'engine-events.jsonl'),
    'utf8',
  )).trim().split('\n').map((line) => JSON.parse(line))
  assert.deepEqual(events.at(-1), {
    schema_version: 1,
    tenant_id: 'local',
    timestamp: events.at(-1)?.timestamp,
    category: 'tool',
    type: 'youtube.manual.analysis_fallback',
    run_id: 'assignment-1',
    root_run_id: 'run-1',
    assignment_path: await fs.realpath(assignmentPath),
    team: 'youtube-extraction',
    level_id: 'extract',
    stage_type: 'chain',
    payload: {
      action: 'prepare_manual',
      error_code: 'gemini_invalid_response',
      analysis_mode: 'transcript',
      manual_run_id: output.manualRunId,
      emitter_name: 'youtube-tool-service',
    },
  })
})

test('prepare_manual resume reuses persisted metadata instead of reinspecting YouTube', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-tool-resume-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  await fs.mkdir(path.join(
    workspacePath, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  ), { recursive: true })
  let inspections = 0
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
    inspectManualVideo: async () => {
      inspections += 1
      return {
        videoId: 'dQw4w9WgXcQ',
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Build a workflow',
        durationSeconds: 600,
      }
    },
  })
  const first = await executeYoutubeDomain(service, youtubeContext(), 'call-manual-first', {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    templateId: 'step-by-step',
    outputLanguage: 'en',
    manualRunId: 'metadata-resume-run',
  })
  assert.equal(first.manualRunId, 'metadata-resume-run')
  const second = await executeYoutubeDomain(service, youtubeContext(), 'call-manual-second', {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    templateId: 'step-by-step',
    outputLanguage: 'en',
    manualRunId: 'metadata-resume-run',
  })

  assert.equal(second.reused, true)
  assert.equal(inspections, 1)
})

test('manual tool calls share the workspace Gemini usage ledger', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-ledger-tool-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  await fs.mkdir(path.join(
    workspacePath,
    'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  ), { recursive: true })
  const now = () => new Date('2026-08-12T12:00:00.000Z')
  const ledger = new YoutubeGeminiUsageLedger({
    storagePath: path.join(workspacePath, '.settings', 'youtube-gemini-usage.json'),
    now,
  })
  await ledger.reserve({
    runId: 'prior', videoId: 'other-video', estimatedMinutes: 115, limitMinutes: 120,
  })
  await ledger.complete('prior', { actualMinutes: 115 })
  const service = new YoutubeToolService({
    workspacePath,
    youtubeUsageLedger: ledger,
    now,
    settings: {
      runtimeProxy: async () => ({
        proxyEnabled: false,
        credentialMode: 'username-password' as const,
        proxyHost: 'p.webshare.io',
        proxyPort: 80,
        countries: ['us'],
        username: '',
      }),
      runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash', source: 'persisted' }),
      snapshot: async () => ({
        geminiDailyVideoMinutesLimit: 120,
        geminiConfirmationThresholdMinutes: 30,
      } as never),
    },
    inspectManualVideo: async () => ({
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      durationSeconds: 600,
    }),
  })

  const output = await executeYoutubeDomain(service, youtubeContext(), 'call-ledger', {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  })

  assert.equal(output.confirmationRequired, true)
  assert.equal(output.notices?.[0]?.code, 'gemini_cost_confirmation_required')
})

test('governed authenticated YouTube capture fails closed without operator approval', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-approval-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  await fs.mkdir(path.join(
    workspacePath,
    'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  ), { recursive: true })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
  })
  const gateway = new YoutubeCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher([], {
      approval: {
        request: async (input) => {
          const interaction = {
            interactionId: 'youtube-integration-denied',
            reused: false,
          }
          await input.onInteraction(interaction)
          return { outcome: 'denied', interaction }
        },
      },
    }),
    service,
  })
  const output = await gateway.execute({
    context: youtubeContext(),
    authority: { kind: 'mcp-lease', leaseId: 'lease-1' },
    source: YOUTUBE_BUILTIN_SOURCE,
    toolCallId: 'call-1',
    input: { action: 'capture_authenticated' },
  })
  assert.equal(output.ok, false)
  assert.equal(output.error?.code, 'approval_denied')
})

test('validation failures retain precise non-retryable invalid_request errors without network access', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-validation-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  await fs.mkdir(path.join(
    workspacePath,
    'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  ), { recursive: true })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
  })
  const cases = [
    [{ action: 'capture' }, /requires a YouTube URL/i],
    [{ action: 'capture', url: 'https://example.com/video' }, /Only YouTube URLs/i],
    [{ action: 'capture', url: 'https://youtube.com/watch?v=dQw4w9WgXcQ', languages: ['invalid_code'] }, /language codes/i],
    [{ action: 'resume' }, /No resumable YouTube manifest/i],
  ] as const
  for (const [input, message] of cases) {
    const output = await executeYoutubeDomain(
      service,
      youtubeContext(),
      `call-${String(input.action)}`,
      input,
    )
    assert.equal(output.ok, false)
    assert.equal(output.error?.code, 'invalid_request')
    assert.equal(output.error?.retryable, false)
    assert.match(output.error?.message ?? '', message)
  }
  const manifestDirectory = path.join(
    workspacePath,
    'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1', 'output',
  )
  await fs.mkdir(manifestDirectory)
  await fs.writeFile(path.join(manifestDirectory, 'youtube-manifest.json'), '{broken')
  const corruptManifest = await executeYoutubeDomain(
    service,
    youtubeContext(),
    'call-corrupt-manifest',
    { action: 'resume' },
  )
  assert.equal(corruptManifest.error?.code, 'invalid_request')
  assert.equal(corruptManifest.error?.retryable, false)
  assert.match(corruptManifest.error?.message ?? '', /manifest is invalid/i)
})

test('a rejected manual plan names the offending field and rule instead of a generic sentence', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-plan-reason-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  await fs.mkdir(path.join(
    workspacePath, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  ), { recursive: true })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
  })

  const output = await executeYoutubeDomain(service, youtubeContext(), 'call-plan-reason', {
    action: 'write_manual_plan',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'plan-reason-run',
    content: JSON.stringify(makeManualPlan({ mode: 'transcript', warnings: [] })),
  })

  assert.equal(output.ok, false)
  assert.equal(output.error?.code, 'invalid_request')
  assert.equal(output.error?.retryable, false)
  assert.match(output.error?.message ?? '', /analysis\.generatedAt is required/)
})

test('building a manual before a plan exists tells the agent to write the plan first', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-no-plan-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  await fs.mkdir(path.join(
    workspacePath, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  ), { recursive: true })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
  })

  const output = await executeYoutubeDomain(service, youtubeContext(), 'call-no-plan', {
    action: 'build_manual',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'no-plan-run',
  })

  assert.equal(output.ok, false)
  assert.equal(output.error?.code, 'invalid_request')
  assert.match(output.error?.message ?? '', /write_manual_plan/)
})

test('the deferred binary resolution reason reaches the build through the service that owns the coordinator', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-tools-reason-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const bundlePath = path.join(
    workspacePath, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
    'output', 'manuals', 'dQw4w9WgXcQ', 'tools-reason-run',
  )
  await fs.mkdir(bundlePath, { recursive: true })
  await fs.writeFile(path.join(bundlePath, 'generation-manifest.json'), '{"stages":{}}')
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
    resolveMediaTools: async () => ({ binariesUnavailableReason: 'Bundled ffprobe checksum does not match.' }),
    browserManager: {
      youtubeCookieHeader: async () => undefined,
      captureYoutubeTranscript: async () => { throw new Error('must not run') },
      captureYoutubeFrames: async () => {
        throw new Error('The application browser stopped responding.')
      },
    },
  })
  await executeYoutubeDomain(service, youtubeContext(), 'call-tools-reason-plan', {
    action: 'write_manual_plan',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'tools-reason-run',
    content: JSON.stringify(makeManualPlan({
      mode: 'transcript', generatedAt: '2026-09-11T12:00:00.000Z', warnings: [],
    })),
  })

  const output = await executeYoutubeDomain(service, youtubeContext(), 'call-tools-reason-build', {
    action: 'build_manual',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'tools-reason-run',
  })

  assert.equal(output.ok, false)
  const manifest = JSON.parse(await fs.readFile(
    path.join(bundlePath, 'generation-manifest.json'), 'utf8',
  ))
  const notice = manifest.notices.find(
    (entry: { code: string }) => entry.code === 'media_tools_unavailable',
  )
  assert.match(notice?.message ?? '', /Bundled ffprobe checksum does not match\./)
})

test('a manual build with no browser running starts the profile and reaches yt-dlp with its cookies', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-cookie-wiring-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const bundlePath = path.join(
    workspacePath, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
    'output', 'manuals', 'dQw4w9WgXcQ', 'cookie-wiring-run',
  )
  await fs.mkdir(bundlePath, { recursive: true })
  await fs.writeFile(path.join(bundlePath, 'generation-manifest.json'), '{"stages":{}}')
  const toolsPath = path.join(workspacePath, 'youtube-tools')
  await fs.mkdir(toolsPath, { recursive: true })
  const ffprobePath = await writeMediaProbe(toolsPath)
  const profile = stoppedProfileBrowser({ cookieHeader: SIGNED_IN_PROFILE_COOKIE_HEADER })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
    youtubeBinaries: {
      ytDlpPath: await writeCookieRecordingYtDlp(toolsPath),
      ffmpegPath: ffprobePath,
      ffprobePath,
    },
    browserManager: profile.manager,
  })
  await executeYoutubeDomain(service, youtubeContext(), 'call-cookie-wiring-plan', {
    action: 'write_manual_plan',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'cookie-wiring-run',
    content: JSON.stringify(makeManualPlan({
      mode: 'transcript', generatedAt: '2026-09-11T12:00:00.000Z', warnings: [],
    })),
  })

  await executeYoutubeDomain(service, youtubeContext(), 'call-cookie-wiring-build', {
    action: 'build_manual',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'cookie-wiring-run',
  })

  assert.equal(profile.state.launchRequests, 1)
  const jar = JSON.parse(await fs.readFile(path.join(toolsPath, 'download-jar.json'), 'utf8'))
  assert.match(
    jar.contents,
    /^\.youtube\.com\tTRUE\t\/\tTRUE\t\d{10}\tSID\tk1TvA-signed-in-session-value$/m,
  )
})

test('a profile browser that cannot start leaves the download anonymous and still publishes the manual', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-no-profile-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  await fs.mkdir(path.join(
    workspacePath, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  ), { recursive: true })
  const toolsPath = path.join(workspacePath, 'youtube-tools')
  await fs.mkdir(toolsPath, { recursive: true })
  const ffprobePath = await writeMediaProbe(toolsPath)
  const profile = stoppedProfileBrowser({
    cookieHeader: SIGNED_IN_PROFILE_COOKIE_HEADER,
    launchFails: true,
  })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
    youtubeBinaries: {
      ytDlpPath: await writeCookieRecordingYtDlp(toolsPath),
      ffmpegPath: ffprobePath,
      ffprobePath,
    },
    // The stub ffmpeg reports no frame quality, so the build takes its usual
    // screenshot fallback after the download it could not read cookies for.
    browserManager: { ...profile.manager, captureYoutubeFrames: captureOneBrowserFrame },
    inspectManualVideo: async (url) => ({
      videoId: 'dQw4w9WgXcQ',
      url,
      title: 'Build a workflow',
      durationSeconds: 600,
    }),
  })
  await executeYoutubeDomain(service, youtubeContext(), 'call-no-profile-prepare', {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    templateId: 'quick-guide',
    manualRunId: 'no-profile-run',
  })
  await executeYoutubeDomain(service, youtubeContext(), 'call-no-profile-plan', {
    action: 'write_manual_plan',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'no-profile-run',
    content: JSON.stringify({ documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' }, ...makeManualPlan({
      mode: 'transcript', generatedAt: '2026-09-11T12:00:00.000Z', warnings: [],
    }) }),
  })

  const output = await executeYoutubeDomain(service, youtubeContext(), 'call-no-profile-build', {
    action: 'build_manual',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'no-profile-run',
  })

  assert.equal(profile.state.launchRequests, 1)
  assert.equal(output.ok, true)
  const args = JSON.parse(await fs.readFile(path.join(toolsPath, 'download-args.json'), 'utf8'))
  assert.equal(args.includes('--cookies'), false)
})

test('the actions that are not a media download never start the profile browser', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-no-launch-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(
    workspacePath, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  )
  // Each action is given the state its real path needs, so none of them stops
  // at a missing manifest or artifact before any browser code could run.
  await writePendingManifest(assignmentPath, [{
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    status: 'success',
    attempts: 1,
    captureMethod: 'direct',
    transcriptJson: 'output/transcripts/dQw4w9WgXcQ.json',
    transcriptMarkdown: 'output/transcripts/dQw4w9WgXcQ.md',
    language: 'en',
  }])
  await fs.mkdir(path.join(assignmentPath, 'output', 'transcripts'), { recursive: true })
  await fs.writeFile(
    path.join(assignmentPath, 'output', 'transcripts', 'dQw4w9WgXcQ.md'),
    '# Transcript\n\nComplete text.\n',
  )
  let captureRequests = 0
  const originalFetch = globalThis.fetch
  // `capture` is the one action here that reaches the network, so it runs
  // against a refusing loopback of its own rather than YouTube.
  globalThis.fetch = (async () => {
    captureRequests += 1
    return new Response('', { status: 500 })
    // Node's `fetch` type carries properties a plain function cannot declare.
  }) as typeof globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  const profile = stoppedProfileBrowser({ cookieHeader: SIGNED_IN_PROFILE_COOKIE_HEADER })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserManager: profile.manager,
    inspectManualVideo: async (url) => ({
      videoId: 'dQw4w9WgXcQ',
      url,
      title: 'Build a workflow',
      durationSeconds: 600,
    }),
  })

  const prepared = await executeYoutubeDomain(service, youtubeContext(), 'call-no-launch-prepare', {
    action: 'prepare_manual', documentRequest: { formats: ['markdown', 'docx'], purpose: 'instructions', instructions: 'Create an illustrated manual in Markdown and Word.' },
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    templateId: 'quick-guide',
    manualRunId: 'no-launch-run',
  })
  await executeYoutubeDomain(service, youtubeContext(), 'call-no-launch-capture', {
    action: 'capture',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  })
  const resumed = await executeYoutubeDomain(service, youtubeContext(), 'call-no-launch-resume', {
    action: 'resume',
  })
  const transcript = await executeYoutubeDomain(service, youtubeContext(), 'call-no-launch-transcript', {
    action: 'read_transcript',
    videoId: 'dQw4w9WgXcQ',
  })
  const methodology = await executeYoutubeDomain(service, youtubeContext(), 'call-no-launch-methodology', {
    action: 'write_methodology',
    videoId: 'dQw4w9WgXcQ',
    content: '# Source method',
  })

  assert.equal(profile.state.launchRequests, 0)
  assert.equal(prepared.ok, true)
  assert.ok(captureRequests > 0)
  assert.equal(resumed.completed, 1)
  assert.equal(transcript.chunk?.videoId, 'dQw4w9WgXcQ')
  assert.equal(methodology.ok, true)
})

test('the approved authenticated capture is the other reader of the profile', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-auth-launch-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(
    workspacePath, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  )
  await writePendingManifest(assignmentPath)
  const originalFetch = globalThis.fetch
  // The signed-in session this capture builds reaches YouTube; refuse it here
  // so the capture falls back to the browser transcript without a network call.
  globalThis.fetch = (async () => new Response('', { status: 500 })) as typeof globalThis.fetch
  context.after(() => { globalThis.fetch = originalFetch })
  const profile = stoppedProfileBrowser({ cookieHeader: SIGNED_IN_PROFILE_COOKIE_HEADER })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserManager: {
      ...profile.manager,
      captureYoutubeTranscript: async () => ({
        title: 'Authenticated transcript',
        language: 'en',
        segments: [{ startMs: 0, durationMs: 1_000, text: 'Complete text.' }],
      }),
    },
  })
  const gateway = new YoutubeCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher(),
    service,
  })

  const output = await gateway.execute({
    context: youtubeContext(),
    authority: { kind: 'mcp-lease', leaseId: 'lease-1' },
    source: YOUTUBE_BUILTIN_SOURCE,
    toolCallId: 'call-auth-launch',
    input: { action: 'capture_authenticated' },
  })

  assert.equal(output.ok, true)
  assert.equal(profile.state.launchRequests, 1)
})

test('a signed-in download that fails keeps its cookie jar out of the manifest and the surfaced error', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-cookie-leak-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const bundlePath = path.join(
    workspacePath, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
    'output', 'manuals', 'dQw4w9WgXcQ', 'cookie-leak-run',
  )
  await fs.mkdir(bundlePath, { recursive: true })
  await fs.writeFile(path.join(bundlePath, 'generation-manifest.json'), '{"stages":{}}')
  const toolsPath = path.join(workspacePath, 'youtube-tools')
  await fs.mkdir(toolsPath, { recursive: true })
  const ffprobePath = await writeMediaProbe(toolsPath)
  const profile = stoppedProfileBrowser({ cookieHeader: SIGNED_IN_PROFILE_COOKIE_HEADER })
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
    youtubeBinaries: {
      // The failing stub echoes the jar it was handed on stderr, which is the
      // only way real yt-dlp could name the file or its contents.
      ytDlpPath: await writeCookieRecordingYtDlp(toolsPath, { download: 'fail' }),
      ffmpegPath: ffprobePath,
      ffprobePath,
    },
    browserManager: profile.manager,
  })
  await executeYoutubeDomain(service, youtubeContext(), 'call-cookie-leak-plan', {
    action: 'write_manual_plan',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'cookie-leak-run',
    content: JSON.stringify(makeManualPlan({
      mode: 'transcript', generatedAt: '2026-09-11T12:00:00.000Z', warnings: [],
    })),
  })

  const output = await executeYoutubeDomain(service, youtubeContext(), 'call-cookie-leak-build', {
    action: 'build_manual',
    videoId: 'dQw4w9WgXcQ',
    manualRunId: 'cookie-leak-run',
  })

  const jar = JSON.parse(await fs.readFile(path.join(toolsPath, 'download-jar.json'), 'utf8'))
  const manifest = await fs.readFile(path.join(bundlePath, 'generation-manifest.json'), 'utf8')
  const surfaced = `${output.error?.message ?? ''} ${JSON.stringify(output)}`
  // The download presented the sign-in and still failed, which is the run whose
  // manifest most needs to say so — and to say nothing else about the jar.
  assert.equal(JSON.parse(manifest).sourceMedia.usedProfileSession, true)
  for (const trace of [
    jar.path,
    SIGNED_IN_PROFILE_COOKIE_HEADER,
    'k1TvA-signed-in-session-value',
    'SID=',
  ]) {
    assert.equal(manifest.includes(trace), false, `the manifest carried ${trace}`)
    assert.equal(surfaced.includes(trace), false, `the tool output carried ${trace}`)
  }
})

test('an authenticated capture failure keeps the generic sentence so proxy credentials never reach the agent', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-capture-generic-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(
    workspacePath, 'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  )
  await fs.mkdir(assignmentPath, { recursive: true })
  await writePendingManifest(assignmentPath)
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserManager: {
      youtubeCookieHeader: async () => {
        throw new Error('proxy http://user:s3cret@p.webshare.io:80 refused the request')
      },
      captureYoutubeTranscript: async () => { throw new Error('must not run') },
      captureYoutubeFrames: async () => { throw new Error('must not run') },
    },
  })
  const gateway = new YoutubeCapabilityDispatchGateway({
    dispatcher: createCapabilityTestDispatcher(),
    service,
  })

  const output = await gateway.execute({
    context: youtubeContext(),
    authority: { kind: 'mcp-lease', leaseId: 'lease-1' },
    source: YOUTUBE_BUILTIN_SOURCE,
    toolCallId: 'call-capture-generic',
    input: { action: 'capture_authenticated' },
  })

  assert.equal(output.ok, false)
  assert.equal(
    output.error?.message,
    'YouTube extraction failed. No credential or cookie details were retained.',
  )
  assert.equal(output.error?.message.includes('s3cret'), false)
})

test('artifact writes reject a symlink below the owned assignment', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-symlink-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(
    workspacePath,
    'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  )
  const outsidePath = path.join(workspacePath, 'outside')
  await fs.mkdir(assignmentPath, { recursive: true })
  await fs.mkdir(outsidePath)
  await fs.symlink(outsidePath, path.join(assignmentPath, 'output'), 'dir')
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
  })
  const output = await executeYoutubeDomain(service, youtubeContext(), 'call-symlink', {
    action: 'write_methodology',
    videoId: 'dQw4w9WgXcQ',
    content: '# Must stay confined',
  })
  assert.equal(output.ok, false)
  assert.equal(output.error?.code, 'internal')
  assert.equal(
    await fs.access(path.join(outsidePath, 'methods', 'dQw4w9WgXcQ.md')).then(
      () => true,
      () => false,
    ),
    false,
  )
})

test('resume returns a completed manifest without reprocessing or network access', async (context) => {
  const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-resume-'))
  context.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const assignmentPath = path.join(
    workspacePath,
    'sessions', 'session-1', 'runs', 'run-1', 'assignments', 'assignment-1',
  )
  const outputPath = path.join(assignmentPath, 'output')
  await fs.mkdir(outputPath, { recursive: true })
  await fs.writeFile(path.join(outputPath, 'youtube-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    source: {
      type: 'video',
      id: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Completed source',
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
      title: 'Completed source',
      status: 'success',
      attempts: 1,
      captureMethod: 'direct',
      transcriptJson: 'output/transcripts/dQw4w9WgXcQ.json',
      transcriptMarkdown: 'output/transcripts/dQw4w9WgXcQ.md',
      language: 'en',
    }],
  }))
  const service = new YoutubeToolService({
    workspacePath,
    settings: new YoutubeSettingsService({ environment: {} }),
  })
  const result = await executeYoutubeDomain(
    service,
    youtubeContext(),
    'call-resume',
    { action: 'resume' },
  )
  assert.equal(result.ok, true)
  assert.equal(result.completed, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.unavailable, 0)
  assert.equal(result.videos?.[0]?.status, 'success')
})

test('resume preserves terminal no-transcript results in a mixed manifest', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-resume-terminal-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  await writePendingManifest(assignmentPath, [{
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    status: 'no_transcript',
    attempts: 1,
    error: {
      code: 'transcript_unavailable',
      message: 'No transcript is available.',
      retryable: false,
    },
  }, {
    videoId: '9bZkp7q19f0',
    url: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
    status: 'success',
    attempts: 1,
    captureMethod: 'direct',
    transcriptJson: 'output/transcripts/9bZkp7q19f0.json',
    transcriptMarkdown: 'output/transcripts/9bZkp7q19f0.md',
    language: 'en',
  }])
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
  })

  const result = await runtime.capture({ action: 'resume' })

  assert.equal(result.completed, 1)
  assert.equal(result.unavailable, 1)
  const manifest = JSON.parse(await fs.readFile(
    path.join(assignmentPath, 'output', 'youtube-manifest.json'),
    'utf8',
  ))
  assert.equal(manifest.videos[0].status, 'no_transcript')
  assert.equal(manifest.videos[0].attempts, 1)
})

test('authenticated capture propagates cancellation without changing manifest attempts', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-auth-cancel-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  await writePendingManifest(assignmentPath)
  const controller = new AbortController()
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserManager: {
      youtubeCookieHeader: async () => undefined,
      captureYoutubeTranscript: async () => {
        controller.abort()
        throw new BrowserRuntimeError('cancelled', 'Cancelled during browser capture.')
      },
    },
  })
  await assert.rejects(
    runtime.captureAuthenticated({ action: 'capture_authenticated' }, controller.signal),
    (error) => error instanceof Error && error.name === 'AbortError',
  )
  const manifest = JSON.parse(await fs.readFile(
    path.join(assignmentPath, 'output', 'youtube-manifest.json'),
    'utf8',
  ))
  assert.equal(manifest.videos[0].attempts, 1)
  assert.equal(manifest.videos[0].status, 'auth_required')
})

test('authenticated capture propagates artifact persistence errors instead of reporting no transcript', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-auth-disk-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  await writePendingManifest(assignmentPath)
  await fs.writeFile(path.join(assignmentPath, 'output', 'transcripts'), 'blocks-directory')
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserManager: {
      youtubeCookieHeader: async () => undefined,
      captureYoutubeTranscript: async () => ({
        title: 'Browser transcript',
        language: 'en',
        segments: [{ startMs: 0, durationMs: 1_000, text: 'Complete text.' }],
      }),
    },
  })
  await assert.rejects(
    runtime.captureAuthenticated({ action: 'capture_authenticated' }),
    (error) => error instanceof YoutubeRuntimeError && error.code === 'internal',
  )
  const manifest = JSON.parse(await fs.readFile(
    path.join(assignmentPath, 'output', 'youtube-manifest.json'),
    'utf8',
  ))
  assert.equal(manifest.videos[0].status, 'auth_required')
})

test('concurrent authenticated captures serialize the manifest read-modify-write cycle', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-auth-lock-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  await writePendingManifest(assignmentPath)
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  const entered = new Promise<void>((resolve) => { started = resolve })
  let browserCalls = 0
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserManager: {
      youtubeCookieHeader: async () => undefined,
      captureYoutubeTranscript: async () => {
        browserCalls += 1
        started()
        await gate
        return {
          title: 'Serialized transcript',
          language: 'en',
          segments: [{ startMs: 0, durationMs: 1_000, text: 'Complete text.' }],
        }
      },
    },
  })
  const first = runtime.captureAuthenticated({ action: 'capture_authenticated' })
  await entered
  const second = runtime.captureAuthenticated({ action: 'capture_authenticated' })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(browserCalls, 1)
  release()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.completed, 1)
  assert.equal(secondResult.completed, 1)
  assert.equal(browserCalls, 1)
  const manifest = JSON.parse(await fs.readFile(
    path.join(assignmentPath, 'output', 'youtube-manifest.json'),
    'utf8',
  ))
  assert.equal(manifest.videos[0].attempts, 2)
})

test('browser timeouts become retryable failed items rather than no_transcript', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-auth-timeout-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  await writePendingManifest(assignmentPath)
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserManager: {
      youtubeCookieHeader: async () => undefined,
      captureYoutubeTranscript: async () => {
        throw new BrowserRuntimeError('timeout', 'Authenticated capture timed out.', true)
      },
    },
  })
  const result = await runtime.captureAuthenticated({ action: 'capture_authenticated' })
  assert.equal(result.failed, 1)
  assert.equal(result.unavailable, 0)
  assert.equal(result.videos?.[0]?.status, 'failed')
  const manifest = JSON.parse(await fs.readFile(
    path.join(assignmentPath, 'output', 'youtube-manifest.json'),
    'utf8',
  ))
  assert.equal(manifest.videos[0].error.code, 'timeout')
  assert.equal(manifest.videos[0].error.retryable, true)
})

test('authenticated capture processes only auth-required items in a mixed manifest', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-auth-eligible-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  await writePendingManifest(assignmentPath, [{
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    status: 'no_transcript',
    attempts: 1,
    error: {
      code: 'transcript_unavailable',
      message: 'No transcript is available.',
      retryable: false,
    },
  }, {
    videoId: '9bZkp7q19f0',
    url: 'https://www.youtube.com/watch?v=9bZkp7q19f0',
    status: 'failed',
    attempts: 2,
    error: {
      code: 'proxy_unavailable',
      message: 'Public capture failed.',
      retryable: true,
    },
  }, {
    videoId: 'M7lc1UVf-VE',
    url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
    status: 'auth_required',
    attempts: 1,
    error: {
      code: 'authentication_required',
      message: 'Authentication required.',
      retryable: false,
    },
  }, {
    videoId: 'Cc0_nyxROBA',
    url: 'https://www.youtube.com/watch?v=Cc0_nyxROBA',
    status: 'premiere_pending',
    availableAt: '2026-08-14T16:00:00.000Z',
    attempts: 1,
    error: {
      code: 'premiere_pending',
      message: 'This premiere is scheduled but not yet available.',
      retryable: true,
    },
  }])
  const browserCalls: string[] = []
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserManager: {
      youtubeCookieHeader: async () => undefined,
      captureYoutubeTranscript: async (videoId) => {
        browserCalls.push(videoId)
        return {
          title: 'Authenticated transcript',
          language: 'en',
          segments: [{ startMs: 0, durationMs: 1_000, text: 'Complete text.' }],
        }
      },
    },
  })

  const result = await runtime.captureAuthenticated({ action: 'capture_authenticated' })

  assert.deepEqual(browserCalls, ['M7lc1UVf-VE'])
  assert.equal(result.completed, 1)
  assert.equal(result.failed, 1)
  assert.equal(result.unavailable, 1)
  const manifest = JSON.parse(await fs.readFile(
    path.join(assignmentPath, 'output', 'youtube-manifest.json'),
    'utf8',
  ))
  assert.deepEqual(
    manifest.videos.map((video: YoutubeManifestVideo) => [video.status, video.attempts]),
    [['no_transcript', 1], ['failed', 2], ['success', 2], ['premiere_pending', 1]],
  )
})

const SIGNED_IN_PROFILE_COOKIE_HEADER = 'SID=k1TvA-signed-in-session-value'

/**
 * The application browser with its profile stopped, which is what a manual
 * build finds when nothing has opened Chrome yet. A caller that forbids a
 * launch therefore reads no sign-in; one that allows it starts the profile
 * first, and `launchRequests` records who asked for that start.
 */
function stoppedProfileBrowser(options: {
  readonly cookieHeader: string
  readonly launchFails?: boolean
}) {
  const state = { launchRequests: 0, running: false }
  return {
    state,
    manager: {
      youtubeCookieHeader: async (request: { readonly launch?: boolean } = {}) => {
        if (request.launch === false) return state.running ? options.cookieHeader : undefined
        state.launchRequests += 1
        if (options.launchFails) {
          throw new BrowserRuntimeError('browser_unavailable', 'Chrome could not be started.', true)
        }
        state.running = true
        return options.cookieHeader
      },
      captureYoutubeTranscript: async () => { throw new Error('must not run') },
      captureYoutubeFrames: async () => {
        throw new Error('The application browser stopped responding.')
      },
    },
  }
}

/** A browser frame fallback that writes one real screenshot per visual cue. */
async function captureOneBrowserFrame(input: {
  readonly videoId: string
  readonly outputDirectory: string
  readonly cues: readonly {
    readonly stepId: string
    readonly timestampSeconds: number
    readonly importance: 'required' | 'supporting'
    readonly caption: string
    readonly altText: string
  }[]
  readonly signal?: AbortSignal
}) {
  await fs.mkdir(input.outputDirectory, { recursive: true })
  return await Promise.all(input.cues.map(async (cue) => {
    const fileName = `browser-${cue.stepId}.png`
    await fs.writeFile(path.join(input.outputDirectory, fileName), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    ))
    return {
      stepId: cue.stepId,
      importance: cue.importance,
      requestedTimestampSeconds: cue.timestampSeconds,
      actualTimestampSeconds: cue.timestampSeconds,
      relativePath: `frames/${fileName}`,
      caption: cue.caption,
      altText: cue.altText,
      selectionReason: 'browser_fallback',
      sha256: 'browser-frame-hash',
    }
  }))
}

/** A transcript-mode manual plan whose analysis block the caller supplies. */
function makeManualPlan(analysis: Record<string, unknown>): Record<string, unknown> {
  return {
    manualPlanSchemaVersion: 1,
    video: {
      videoId: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      title: 'Build a workflow',
      durationSeconds: 600,
    },
    templateId: 'quick-guide',
    outputLanguage: 'en',
    analysis,
    summary: 'A transcript-derived summary.',
    chapters: [{ id: 'instructions', order: 1, title: 'Instructions', stepIds: ['first-step'] }],
    steps: [{
      id: 'first-step',
      order: 1,
      title: 'First step',
      explanation: 'Complete it.',
      startSeconds: 1,
      endSeconds: 2,
      visualCues: [{
        timestampSeconds: 1.5,
        importance: 'required',
        reason: 'Visible state.',
        caption: 'Visible state',
        altText: 'Visible state in the application',
      }],
    }],
  }
}

async function writePendingManifest(
  assignmentPath: string,
  videos: readonly YoutubeManifestVideo[] = [{
    videoId: 'dQw4w9WgXcQ',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    status: 'auth_required',
    attempts: 1,
    error: {
      code: 'authentication_required',
      message: 'Authentication required.',
      retryable: false,
    },
  }],
): Promise<void> {
  const outputPath = path.join(assignmentPath, 'output')
  await fs.mkdir(outputPath, { recursive: true })
  await fs.writeFile(path.join(outputPath, 'youtube-manifest.json'), JSON.stringify({
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
    videos,
  }))
}
