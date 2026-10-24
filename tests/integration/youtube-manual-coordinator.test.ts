import { whenDefined } from '../../core/optional-properties.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { BrowserRuntimeError } from '../../domains/browser/browser-manager.js'
import { YoutubeRuntimeError } from '../../domains/youtube/youtube-extraction.js'
import {
  cancelGenerationManifestStage,
  mergeGenerationManifest,
  YoutubeManualCoordinator,
} from '../../services/youtube-manual-coordinator.js'
import { YoutubeSettingsService } from '../../services/youtube-settings-service.js'
import { YoutubeGeminiUsageLedger } from '../../services/youtube-gemini-usage-ledger.js'

const video = {
  videoId: 'dQw4w9WgXcQ',
  url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
  title: 'Build a workflow',
  channelName: 'Example Channel',
  publishedAt: '2026-08-01',
  durationSeconds: 600,
} as const

test('missing Gemini key persists metadata and returns the exact transcript fallback notice', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-missing-key-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
  })

  const result = await coordinator.prepare({
    video,
    templateId: 'step-by-step',
    outputLanguage: 'en',
  })

  assert.equal(result.ok, true)
  assert.equal(result.analysisMode, 'transcript')
  assert.equal(result.notices?.[0]?.code, 'gemini_key_missing')
  assert.equal(result.notices?.[0]?.message, 'Gemini video analysis is not configured. Add a Google AI Studio API key in Settings -> Research & Acquisition -> YouTube video analysis. Continuing with transcript-based analysis.')
  assert.ok(result.manualRunId)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, result.manualRunId!, 'video-metadata.json',
  ), 'utf8')), video)
})

test('manual preparation stops before billable analysis when minimum frame headroom is unavailable', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-prepare-space-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  let analyses = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: {
      runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash', source: 'persisted' }),
      snapshot: async () => ({ geminiDailyVideoMinutesLimit: 120, geminiConfirmationThresholdMinutes: 30 }),
    },
    analysis: { analyze: async () => { analyses += 1; throw new Error('must not run') } },
    diskSpaceBytes: async () => 1,
  })

  const result = await coordinator.prepare({ video, templateId: 'quick-guide', manualRunId: 'no-space-run' })

  assert.equal(result.ok, false)
  assert.equal(result.error?.code, 'disk_space_insufficient')
  assert.equal(result.notices?.[0]?.code, 'disk_space_insufficient')
  assert.equal(analyses, 0)
})

test('configured Gemini produces and persists a validated template-specific plan', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-gemini-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: {
      runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash', source: 'persisted' }),
      snapshot: async () => ({
        geminiDailyVideoMinutesLimit: 120,
        geminiConfirmationThresholdMinutes: 30,
        deleteVideosAfterInfoExtraction: false,
      }),
    },
    analysis: {
      analyze: async (request) => ({
        requestId: 'interaction-1',
        usage: { inputTokens: 100, outputTokens: 20 },
        analysis: {
          analysisSchemaVersion: 1,
          sourceRevisionFingerprint: request.sourceRevisionFingerprint,
          model: request.model,
          analysisPromptVersion: 'youtube-manual-v2',
          outputLanguage: request.outputLanguage ?? 'en',
          detectedSourceLanguage: 'en',
          generatedAt: request.generatedAt,
          summary: 'A concise instructional summary.',
          steps: [{
            id: 'first-step',
            title: 'Complete the first step',
            explanation: 'Follow the controls shown on screen.',
            startSeconds: 5,
            endSeconds: 10,
            visualCandidates: [{
              timestampSeconds: 7,
              importance: 'required',
              reason: 'The control is visible.',
              caption: 'The required control',
              altText: 'Application window with the required control highlighted',
            }],
          }],
        },
      }),
    },
    now: () => new Date('2026-08-12T12:00:00.000Z'),
  })

  const result = await coordinator.prepare({
    video,
    templateId: 'quick-guide',
    outputLanguage: 'en',
  })

  assert.equal(result.ok, true)
  assert.equal(result.analysisMode, 'gemini')
  assert.equal(result.confirmationRequired, false)
  assert.ok(result.manualPlanPath)
  const plan = JSON.parse(await fs.readFile(path.join(assignmentPath, result.manualPlanPath!), 'utf8'))
  assert.equal(plan.templateId, 'quick-guide')
  assert.equal(plan.steps[0].visualCues[0].timestampSeconds, 7)
})

test('an expired pricing table says so instead of leaving the missing estimate unexplained', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-stale-pricing-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: {
      runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash', source: 'persisted' }),
      snapshot: async () => ({
        geminiDailyVideoMinutesLimit: 120,
        geminiConfirmationThresholdMinutes: 30,
        deleteVideosAfterInfoExtraction: false,
      }),
    },
    analysis: {
      analyze: async (request) => ({
        requestId: 'stale-pricing-1',
        analysis: {
          analysisSchemaVersion: 1,
          sourceRevisionFingerprint: request.sourceRevisionFingerprint,
          model: request.model,
          analysisPromptVersion: 'youtube-manual-v2',
          outputLanguage: request.outputLanguage ?? 'en',
          generatedAt: request.generatedAt,
          summary: 'A concise instructional summary.',
          steps: [{
            id: 'first-step',
            title: 'Complete the first step',
            explanation: 'Follow the controls shown on screen.',
            startSeconds: 5,
            endSeconds: 10,
            visualCandidates: [{
              timestampSeconds: 7,
              importance: 'required',
              reason: 'The control is visible.',
              caption: 'The required control',
              altText: 'Application window with the required control highlighted',
            }],
          }],
        },
      }),
    },
    // Past the pricing table's freshness window, so no cost can be quoted.
    now: () => new Date('2026-10-20T12:00:00.000Z'),
  })

  const result = await coordinator.prepare({ video, templateId: 'quick-guide', outputLanguage: 'en' })

  // The analysis still runs: the operator's limits are counted in minutes.
  assert.equal(result.analysisMode, 'gemini')
  assert.equal(result.confirmationRequired, false)
  assert.equal(result.costEstimate?.available, false)
  // And the missing estimate is explained rather than left to be discovered.
  assert.equal(result.notices?.some((notice) => notice.code === 'gemini_pricing_stale'), true)
})

test('manual manifest exposes the in-flight Gemini analysis stage', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-progress-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  let started!: () => void
  let release!: () => void
  const startedPromise = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: {
      runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash', source: 'persisted' }),
      snapshot: async () => ({ geminiDailyVideoMinutesLimit: 120, geminiConfirmationThresholdMinutes: 30 }),
    },
    analysis: { analyze: async (request) => {
      started()
      await gate
      return { analysis: { analysisSchemaVersion: 1,
        sourceRevisionFingerprint: request.sourceRevisionFingerprint, model: request.model,
        analysisPromptVersion: 'youtube-manual-v2', outputLanguage: 'en', generatedAt: request.generatedAt,
        summary: 'Progress summary.', steps: [{ id: 'progress', title: 'Progress',
          explanation: 'Complete it.', startSeconds: 1, endSeconds: 2,
          visualCandidates: [{ timestampSeconds: 1.5, importance: 'required', reason: 'Visible.',
            caption: 'Visible', altText: 'Visible application state' }] }] } }
    } },
  })
  const preparing = coordinator.prepare({
    video, templateId: 'quick-guide', outputLanguage: 'en', manualRunId: 'progress-run',
  })
  await startedPromise
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, 'progress-run', 'generation-manifest.json',
  ), 'utf8'))
  assert.equal(manifest.status, 'analyzing')
  assert.equal(manifest.stages.analysis, 'in_progress')
  release()
  await preparing
})

test('template changes reuse the validated Gemini analysis cache without another provider call', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-cache-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  let calls = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: {
      runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash', source: 'persisted' }),
      snapshot: async () => ({
        geminiDailyVideoMinutesLimit: 120,
        geminiConfirmationThresholdMinutes: 30,
      }),
    },
    analysis: {
      analyze: async (request) => {
        calls += 1
        return {
          analysis: {
            analysisSchemaVersion: 1,
            sourceRevisionFingerprint: request.sourceRevisionFingerprint,
            model: request.model,
            analysisPromptVersion: 'youtube-manual-v2',
            outputLanguage: request.outputLanguage ?? 'en',
            detectedSourceLanguage: 'en',
            generatedAt: request.generatedAt,
            summary: 'Cached instructional summary.',
            steps: [{
              id: 'cached-step',
              title: 'Cached step',
              explanation: 'Use the visible control.',
              startSeconds: 5,
              endSeconds: 10,
              visualCandidates: [{
                timestampSeconds: 7,
                importance: 'required',
                reason: 'The control is visible.',
                caption: 'The control',
                altText: 'Application window with the visible control',
              }],
            }],
          },
        }
      },
    },
    now: () => new Date('2026-08-12T12:00:00.000Z'),
  })

  await coordinator.prepare({ video, templateId: 'quick-guide', outputLanguage: 'en' })
  const cached = await coordinator.prepare({
    video,
    templateId: 'step-by-step',
    outputLanguage: 'en',
  })

  assert.equal(calls, 1)
  assert.equal(cached.analysisMode, 'gemini')
  assert.deepEqual(cached.costEstimate, { available: false })
})

test('output language and explicit fresh analysis bypass the Gemini cache', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-cache-miss-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  let calls = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: {
      runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash', source: 'persisted' }),
      snapshot: async () => ({ geminiDailyVideoMinutesLimit: 120, geminiConfirmationThresholdMinutes: 30 }),
    },
    analysis: {
      analyze: async (request) => {
        calls += 1
        return { analysis: {
          analysisSchemaVersion: 1,
          sourceRevisionFingerprint: request.sourceRevisionFingerprint,
          model: request.model,
          analysisPromptVersion: 'youtube-manual-v2',
          outputLanguage: request.outputLanguage ?? 'en',
          generatedAt: request.generatedAt,
          summary: 'Cache miss summary.',
          steps: [{
            id: 'cache-step', title: 'Cache step', explanation: 'Complete it.',
            startSeconds: 1, endSeconds: 2,
            visualCandidates: [{ timestampSeconds: 1.5, importance: 'required', reason: 'Visible.',
              caption: 'Visible', altText: 'Visible application state' }],
          }],
        } }
      },
    },
    now: () => new Date('2026-08-13T12:00:00.000Z'),
  })

  await coordinator.prepare({ video, templateId: 'quick-guide', outputLanguage: 'en' })
  await coordinator.prepare({ video, templateId: 'quick-guide', outputLanguage: 'fr' })
  await coordinator.prepare({ video, templateId: 'quick-guide', outputLanguage: 'en', freshAnalysis: true })

  assert.equal(calls, 3)
})

test('Gemini provider failure falls back to transcript while cancellation does not', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-provider-fallback-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const settings = {
    runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash' as const, source: 'persisted' as const }),
    snapshot: async () => ({ geminiDailyVideoMinutesLimit: 120, geminiConfirmationThresholdMinutes: 30 }),
  }
  const unavailable = new YoutubeManualCoordinator({
    assignmentPath,
    settings,
    analysis: { analyze: async () => { throw new Error('provider unavailable') } },
  })
  const fallback = await unavailable.prepare({ video, templateId: 'quick-guide' })
  assert.equal(fallback.analysisMode, 'transcript')
  assert.equal(fallback.notices?.[0]?.code, 'gemini_unavailable')

  const cancelled = new YoutubeManualCoordinator({
    assignmentPath,
    settings,
    analysis: { analyze: async () => {
      const error = new Error('cancelled')
      error.name = 'AbortError'
      throw error
    } },
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(cancelled.prepare({
    video, templateId: 'quick-guide', manualRunId: 'analysis-cancel-run', signal: controller.signal,
  }))
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, 'analysis-cancel-run',
    'generation-manifest.json',
  ), 'utf8'))
  assert.equal(manifest.status, 'cancelled')
  assert.equal(manifest.stages.analysis, 'cancelled')
  assert.equal(manifest.stages.cleanup, 'cancelled')
  assert.ok(manifest.cancelledAt)
})

test('rolling Gemini usage requires confirmation and confirmed analysis records completed usage', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-budget-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const now = () => new Date('2026-08-12T12:00:00.000Z')
  const usageLedger = new YoutubeGeminiUsageLedger({
    storagePath: path.join(assignmentPath, 'gemini-usage.json'),
    now,
  })
  await usageLedger.reserve({
    runId: 'existing', videoId: 'other-video', estimatedMinutes: 115, limitMinutes: 120,
  })
  await usageLedger.complete('existing', { actualMinutes: 115 })
  let calls = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    usageLedger,
    settings: {
      runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash', source: 'persisted' }),
      snapshot: async () => ({
        geminiDailyVideoMinutesLimit: 120,
        geminiConfirmationThresholdMinutes: 30,
      }),
    },
    analysis: {
      analyze: async (request) => {
        calls += 1
        return {
          usage: { inputTokens: 180_000, outputTokens: 2_000 },
          analysis: {
            analysisSchemaVersion: 1,
            sourceRevisionFingerprint: request.sourceRevisionFingerprint,
            model: request.model,
            analysisPromptVersion: 'youtube-manual-v2',
            outputLanguage: request.outputLanguage ?? 'en',
            generatedAt: request.generatedAt,
            summary: 'Budgeted analysis.',
            steps: [{
              id: 'budgeted-step', title: 'Budgeted step', explanation: 'Do the step.',
              startSeconds: 1, endSeconds: 2,
              visualCandidates: [{
                timestampSeconds: 1.5, importance: 'required', reason: 'Visible action.',
                caption: 'Visible action', altText: 'Visible action in the application',
              }],
            }],
          },
        }
      },
    },
    now,
  })

  const waiting = await coordinator.prepare({ video, templateId: 'quick-guide', outputLanguage: 'en' })
  assert.equal(waiting.confirmationRequired, true)
  assert.equal(calls, 0)

  const completed = await coordinator.prepare({
    video,
    templateId: 'quick-guide',
    outputLanguage: 'en',
    ...whenDefined(waiting.manualRunId, (manualRunId) => ({ manualRunId: manualRunId })),
    geminiConfirmed: true,
  })
  assert.equal(completed.analysisMode, 'gemini')
  assert.equal(calls, 1)
  assert.equal((await usageLedger.rollingUsage()).completedMinutes, 125)
})

test('cancelling before media acquisition records the interrupted stage for safe resume', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-cancel-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    binaries: { ytDlpPath: '/unused/yt-dlp', ffmpegPath: '/unused/ffmpeg', ffprobePath: '/unused/ffprobe' },
  })
  const prepared = await coordinator.prepare({
    video,
    templateId: 'quick-guide',
    outputLanguage: 'en',
    manualRunId: 'cancelled-run',
  })
  await coordinator.writeManualPlan({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
    content: JSON.stringify({
      manualPlanSchemaVersion: 1,
      video,
      templateId: 'quick-guide',
      sourceLanguage: 'en',
      outputLanguage: 'en',
      analysis: {
        mode: 'transcript',
        generatedAt: '2026-08-12T12:00:00.000Z',
        warnings: [],
      },
      summary: 'A transcript-derived summary.',
      chapters: [{ id: 'instructions', order: 1, title: 'Instructions', stepIds: ['first-step'] }],
      steps: [{
        id: 'first-step', order: 1, title: 'First step', explanation: 'Complete it.',
        startSeconds: 1, endSeconds: 2,
        visualCues: [{
          timestampSeconds: 1.5, importance: 'required', reason: 'Visible state.',
          caption: 'Visible state', altText: 'Visible state in the application',
        }],
      }],
    }),
  })
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    coordinator.build({
      videoId: video.videoId,
      manualRunId: prepared.manualRunId!,
      signal: controller.signal,
    }),
    (error: unknown) => error instanceof Error && error.name === 'AbortError',
  )
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
    'generation-manifest.json',
  ), 'utf8'))
  assert.equal(manifest.status, 'cancelled')
  assert.equal(manifest.stages.download, 'cancelled')
  assert.equal(manifest.stages.cleanup, 'cancelled')
})

test('media download failure uses browser frame fallback and still publishes the manual', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-browser-frames-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    binaries: { ytDlpPath: '/missing/yt-dlp', ffmpegPath: '/missing/ffmpeg', ffprobePath: '/missing/ffprobe' },
    browserFrames: {
      captureYoutubeFrames: async ({ outputDirectory, cues }) => {
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(cues.map(async (cue) => {
          const fileName = `browser-${cue.stepId}.png`
          await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            'base64',
          ))
          return {
            stepId: cue.stepId,
            requestedTimestampSeconds: cue.timestampSeconds,
            actualTimestampSeconds: cue.timestampSeconds,
            relativePath: `frames/${fileName}`,
            caption: cue.caption,
            altText: cue.altText,
            selectionReason: 'browser_fallback' as const,
            sha256: 'browser-frame-hash',
          }
        }))
      },
    },
  })
  const prepared = await coordinator.prepare({
    video, templateId: 'quick-guide', outputLanguage: 'en', manualRunId: 'browser-run',
  })
  await coordinator.writeManualPlan({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
    content: JSON.stringify({
      manualPlanSchemaVersion: 1, video, templateId: 'quick-guide', sourceLanguage: 'en',
      outputLanguage: 'en',
      analysis: { mode: 'transcript', generatedAt: '2026-08-12T12:00:00.000Z', warnings: [] },
      summary: 'Fallback summary.',
      chapters: [{ id: 'instructions', order: 1, title: 'Instructions', stepIds: ['fallback-step'] }],
      steps: [{
        id: 'fallback-step', order: 1, title: 'Fallback step', explanation: 'Complete it.',
        startSeconds: 1, endSeconds: 2,
        visualCues: [{
          timestampSeconds: 1.5, importance: 'required', reason: 'Visible state.',
          caption: 'Visible state', altText: 'Visible state in the browser video',
        }],
      }],
    }),
  })

  const result = await coordinator.build({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
  })

  assert.equal(result.ok, true)
  assert.equal(result.frameCount, 1)
  assert.equal(result.notices?.[0]?.code, 'media_download_fallback')
  assert.ok(result.manualDocxPath)
  assert.equal(result.manualBundlePath, `output/manuals/${video.videoId}/browser-run`)
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
    'generation-manifest.json',
  ), 'utf8'))
  assert.equal(manifest.status, 'complete')
  assert.equal(manifest.stages.download, 'failed')
  assert.equal(manifest.stages.frames, 'complete')
  assert.equal(manifest.stages.markdown, 'complete')
  assert.equal(manifest.stages.docx, 'complete')
  assert.equal(manifest.stages.cleanup, 'complete')
  assert.equal(manifest.manualPlanSchemaVersion, 1)
  assert.equal(manifest.analysisPromptVersion, 'youtube-manual-v2')
  assert.match(manifest.sourceRevisionFingerprint, /^sha256:[a-f0-9]{64}$/)
  assert.equal(manifest.outputLanguage, 'en')
  assert.equal(manifest.sourceLanguage, 'en')
  assert.equal(manifest.diskPreflight.status, 'failed')
  assert.equal(manifest.frames.length, 1)
  assert.equal(manifest.frames[0].captureMethod, 'browser')
  assert.equal(manifest.frames[0].requestedTimestampSeconds, 1.5)
  assert.equal(manifest.frames[0].actualTimestampSeconds, 1.5)
  assert.match(manifest.frames[0].sha256, /^[a-f0-9]{64}$/)
  assert.equal(manifest.outputs.length, 5)
  assert.deepEqual(manifest.outputs.map((output: { path: string }) => output.path), [
    'manual.md', 'manual.docx', 'manual-plan.json', 'video-metadata.json', 'frames.json',
  ])
  assert.equal(manifest.outputs.every((output: { sha256: string }) =>
    /^[a-f0-9]{64}$/.test(output.sha256)), true)
  assert.ok(manifest.resourceMeasurements.peakRssBytes > 0)
})

test('the manual build offers the media download the signed-in profile cookies', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-cookies-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  let offeredCookieHeader: string | undefined
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    binaries: { ytDlpPath: '/unused/yt-dlp', ffmpegPath: '/unused/ffmpeg', ffprobePath: '/unused/ffprobe' },
    youtubeCookieHeader: async () => 'SID=signed-in-session-value',
    downloadMedia: async (input) => {
      offeredCookieHeader = await input.youtubeCookieHeader?.({})
      throw new Error('The download stops once the cookies are offered.')
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'cookie-run')

  await assert.rejects(coordinator.build({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
  }))

  assert.equal(offeredCookieHeader, 'SID=signed-in-session-value')
})

for (const sessionCase of [
  { name: 'a signed-in', runId: 'signed-in-session-run', usedProfileSession: true },
  { name: 'an anonymous', runId: 'anonymous-session-run', usedProfileSession: false },
] as const) {
  test(`the generation manifest records ${sessionCase.name} download of the source media`, async (context) => {
    const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-session-record-'))
    context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
    const coordinator = new YoutubeManualCoordinator({
      assignmentPath,
      settings: new YoutubeSettingsService({ environment: {} }),
      binaries: { ytDlpPath: '/unused/yt-dlp', ffmpegPath: '/unused/ffmpeg', ffprobePath: '/unused/ffprobe' },
      downloadMedia: async ({ workingDirectory }) => {
        await fs.mkdir(workingDirectory, { recursive: true })
        const mediaPath = path.join(workingDirectory, 'source-video.mp4')
        await fs.writeFile(mediaPath, Buffer.from('verified-video'))
        return {
          path: mediaPath, byteLength: 14, durationSeconds: 600, width: 1280, height: 720,
          usedProfileSession: sessionCase.usedProfileSession,
          diskPreflight: { estimatedMediaBytes: 14, frameHeadroomBytes: 1, requiredBytes: 15,
            availableBytes: 1_000, estimateSource: 'declared', recheckedBeforeCommit: true },
        }
      },
      extractFrames: async ({ outputDirectory, candidates }) => {
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(candidates.map(async (candidate, index) => {
          const fileName = `frame-${index}.png`
          await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
          return { stepId: candidate.stepId,
            requestedTimestampSeconds: candidate.requestedTimestampSeconds,
            actualTimestampSeconds: candidate.timestampSeconds, relativePath: `frames/${fileName}`,
            selectionReason: candidate.selectionReason,
            ...whenDefined(candidate.requiredCueId, (requiredCueId) => ({ requiredCueId })),
            sha256: 'unused', byteLength: 5, meanLuma: 100, lumaRange: 80, blurScore: 0.1,
            valid: true }
        }))
      },
      publishManual: async ({ bundleDirectory }) => {
        await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Session\n')
        await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKsession'))
        return { markdown: '# Session\n', docx: Buffer.from('PKsession'), warnings: [] }
      },
    })
    const prepared = await prepareTranscriptPlan(coordinator, sessionCase.runId)

    const result = await coordinator.build({
      videoId: video.videoId,
      manualRunId: prepared.manualRunId!,
    })

    assert.equal(result.ok, true)
    const manifest = JSON.parse(await fs.readFile(path.join(
      assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
      'generation-manifest.json',
    ), 'utf8'))
    assert.equal(manifest.sourceMedia.usedProfileSession, sessionCase.usedProfileSession)
  })
}

test('the generation manifest records the profile session of a download that failed', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-session-failed-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    binaries: { ytDlpPath: '/unused/yt-dlp', ffmpegPath: '/unused/ffmpeg', ffprobePath: '/unused/ffprobe' },
    // The bot check tonight failed a download that had presented the sign-in,
    // which is the run an operator most needs the manifest to describe.
    downloadMedia: async ({ onProfileSession }) => {
      onProfileSession?.(true)
      throw new Error('HTTP Error 429: Too Many Requests')
    },
    browserFrames: {
      captureYoutubeFrames: async ({ outputDirectory, cues }) => {
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(cues.map(async (cue) => {
          const fileName = `browser-${cue.stepId}.png`
          await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
          return { stepId: cue.stepId, requestedTimestampSeconds: cue.timestampSeconds,
            actualTimestampSeconds: cue.timestampSeconds, relativePath: `frames/${fileName}`,
            caption: cue.caption, altText: cue.altText, selectionReason: 'browser_fallback' as const,
            sha256: 'unused' }
        }))
      },
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Session\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKsession'))
      return { markdown: '# Session\n', docx: Buffer.from('PKsession'), warnings: [] }
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'failed-session-run')

  const result = await coordinator.build({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
  })

  assert.equal(result.ok, true)
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
    'generation-manifest.json',
  ), 'utf8'))
  assert.equal(manifest.stages.download, 'failed')
  assert.equal(manifest.sourceMedia.usedProfileSession, true)
  assert.equal(manifest.sourceMedia.sha256, undefined)
})

test('a build without bundled media tools reports the missing tools and their reason', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-tools-missing-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  let downloads = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    binariesUnavailableReason: 'Bundled ffprobe checksum does not match.',
    downloadMedia: async () => { downloads += 1; throw new Error('must not run') },
    browserFrames: {
      captureYoutubeFrames: async ({ outputDirectory, cues }) => {
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(cues.map(async (cue) => {
          const fileName = `browser-${cue.stepId}.png`
          await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
          return { stepId: cue.stepId, requestedTimestampSeconds: cue.timestampSeconds,
            actualTimestampSeconds: cue.timestampSeconds, relativePath: `frames/${fileName}`,
            caption: cue.caption, altText: cue.altText, selectionReason: 'browser_fallback' as const,
            sha256: 'unused' }
        }))
      },
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Published\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKpublished'))
      return { markdown: '# Published\n', docx: Buffer.from('PKpublished'), warnings: [] }
    },
    cleanupWorkingDirectory: async () => undefined,
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'tools-missing-run')
  const manifestPath = path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
    'generation-manifest.json',
  )
  const preparedPreflight = JSON.parse(await fs.readFile(manifestPath, 'utf8')).diskPreflight

  const result = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })

  assert.equal(result.ok, true)
  assert.equal(downloads, 0)
  assert.deepEqual(result.notices?.map((notice) => notice.code), ['media_tools_unavailable'])
  assert.match(result.notices?.[0]?.message ?? '', /Bundled ffprobe checksum does not match\./)
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  const manifestCodes = manifest.notices.map((notice: { code: string }) => notice.code)
  assert.equal(manifestCodes.includes('media_tools_unavailable'), true)
  assert.equal(manifestCodes.includes('media_download_fallback'), false)
  assert.equal(manifest.stages.frames, 'complete')
  assert.equal(manifest.stages.download, 'skipped')
  assert.deepEqual(manifest.diskPreflight, preparedPreflight)
})

test('a resolver reason carrying an install path or subprocess output stays out of the notice', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-tools-raw-reason-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = manualCoordinatorWithLocalPublication(assignmentPath, {
    cleanupWorkingDirectory: async () => undefined,
    binariesUnavailableReason: [
      'Command failed: /Applications/Octopus.app/Contents/Resources/youtube-tools/darwin-arm64/yt-dlp --version',
      'ERROR: unable to read the cookie database',
    ].join('\n'),
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'tools-raw-reason-run')

  const result = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })

  const notice = result.notices?.find((entry) => entry.code === 'media_tools_unavailable')
  assert.match(notice?.message ?? '', /bundled video tools are unavailable/i)
  assert.equal(notice?.message.includes('/Applications'), false)
  assert.equal(notice?.message.includes('unable to read the cookie database'), false)
  assert.equal(/[\r\n]/.test(notice?.message ?? ''), false)
})

test('a failed browser fallback leaves the manifest failed instead of in progress', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-browser-crash-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserFrames: {
      captureYoutubeFrames: async () => {
        throw new Error('The application browser stopped responding.')
      },
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'browser-crash-run')

  await assert.rejects(
    coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! }),
    (error: unknown) => error instanceof Error &&
      error.message === 'The application browser stopped responding.',
  )

  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
    'generation-manifest.json',
  ), 'utf8'))
  assert.equal(manifest.status, 'failed')
  assert.equal(manifest.stages.frames, 'failed')
  const toolsNotice = manifest.notices.find(
    (notice: { code: string }) => notice.code === 'media_tools_unavailable',
  )
  assert.equal(toolsNotice?.message.includes('were captured'), false)
})

test('a browser fallback failure keeps the browser reason and code the agent can act on', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-browser-reason-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const seekTimeout = new BrowserRuntimeError('timeout', 'Seeking to 131 seconds timed out.', true)
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserFrames: { captureYoutubeFrames: async () => { throw seekTimeout } },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'browser-reason-run')

  await assert.rejects(
    coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! }),
    (error: unknown) => error instanceof YoutubeRuntimeError &&
      error.code === 'browser_unavailable' &&
      error.message === 'Seeking to 131 seconds timed out.' &&
      error.retryable === true &&
      error.cause === seekTimeout,
  )

  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
    'generation-manifest.json',
  ), 'utf8'))
  const failureNotice = manifest.notices.find(
    (notice: { code: string }) => notice.code === 'browser_capture_failed',
  )
  assert.match(failureNotice?.message ?? '', /Seeking to 131 seconds timed out\./)
})

test('every manual bundle file is announced once so the run view can reach it', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-artifacts-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    artifactContext: {
      sessionId: 'child-run',
      rootSessionId: 'root-run',
      parentSessionId: 'root-run',
      team: 'youtube-extraction',
      level: 'extract',
      stageType: 'chain',
    },
    settings: {
      runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash', source: 'persisted' }),
      snapshot: async () => ({
        geminiDailyVideoMinutesLimit: 120,
        geminiConfirmationThresholdMinutes: 30,
      }),
    },
    analysis: {
      analyze: async (request) => ({
        requestId: 'interaction-1',
        analysis: {
          analysisSchemaVersion: 1,
          sourceRevisionFingerprint: request.sourceRevisionFingerprint,
          model: request.model,
          analysisPromptVersion: 'youtube-manual-v2',
          outputLanguage: request.outputLanguage ?? 'en',
          detectedSourceLanguage: 'en',
          generatedAt: request.generatedAt,
          summary: 'A concise instructional summary.',
          steps: [{
            id: 'first-step',
            title: 'Complete the first step',
            explanation: 'Follow the controls shown on screen.',
            startSeconds: 5,
            endSeconds: 10,
            visualCandidates: [{
              timestampSeconds: 7,
              importance: 'required',
              reason: 'The control is visible.',
              caption: 'The required control',
              altText: 'Application window with the required control highlighted',
            }],
          }],
        },
      }),
    },
    binaries: { ytDlpPath: '/unused/yt-dlp', ffmpegPath: '/unused/ffmpeg', ffprobePath: '/unused/ffprobe' },
    downloadMedia: async ({ workingDirectory }) => {
      await fs.mkdir(workingDirectory, { recursive: true })
      const mediaPath = path.join(workingDirectory, 'source-video.mp4')
      await fs.writeFile(mediaPath, Buffer.from('verified-video'))
      return {
        path: mediaPath, byteLength: 14, durationSeconds: 600, width: 1280, height: 720,
        usedProfileSession: false,
        diskPreflight: { estimatedMediaBytes: 14, frameHeadroomBytes: 1, requiredBytes: 15,
          availableBytes: 1_000, estimateSource: 'declared', recheckedBeforeCommit: true },
      }
    },
    extractFrames: async ({ outputDirectory, candidates }) => {
      await fs.mkdir(outputDirectory, { recursive: true })
      return await Promise.all(candidates.map(async (candidate, index) => {
        const fileName = `frame-${index}.png`
        await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
          'base64',
        ))
        return {
          stepId: candidate.stepId,
          requestedTimestampSeconds: candidate.requestedTimestampSeconds,
          actualTimestampSeconds: candidate.timestampSeconds,
          relativePath: `frames/${fileName}`,
          selectionReason: candidate.selectionReason,
          ...(candidate.requiredCueId ? { requiredCueId: candidate.requiredCueId } : {}),
          sha256: `frame-${index}-hash`,
          byteLength: 68,
          meanLuma: 0.5,
          lumaRange: 0.4,
          blurScore: 0.9,
          valid: true,
        }
      }))
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Manual\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKmanual'))
      return { markdown: '# Manual\n', docx: Buffer.from('PKmanual'), warnings: [] }
    },
  })

  const prepared = await coordinator.prepare({
    video, templateId: 'quick-guide', outputLanguage: 'en', manualRunId: 'artifact-run',
  })
  const result = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })

  const announced = (await readEngineEvents(assignmentPath))
    .filter((event) => event.type === 'artifact.written')
  const bundle = `output/manuals/${video.videoId}/artifact-run`
  const announcedPaths = announced.map((event) => event.payload.path ?? '')

  // The Gemini analysis is the evidence behind the manual: it has to be
  // reachable from the run view, not only from the filesystem.
  assert.ok(announcedPaths.includes(`${bundle}/video-analysis.json`))
  assert.deepEqual([...announcedPaths].sort(), [
    `${bundle}/frames.json`,
    `${bundle}/generation-manifest.json`,
    `${bundle}/manual-plan.json`,
    `${bundle}/manual.docx`,
    `${bundle}/manual.md`,
    `${bundle}/media.json`,
    `${bundle}/source-video.mp4`,
    `${bundle}/video-analysis.json`,
    `${bundle}/video-metadata.json`,
  ])

  // The manifest is rewritten on every stage transition and frames are written
  // per cue — neither may turn into a run of repeated timeline rows.
  assert.equal(new Set(announcedPaths).size, announcedPaths.length)
  assert.equal(announcedPaths.some((value) => value.includes('/frames/')), false)
  assert.equal(announcedPaths.some((value) => value.includes('.analysis-cache')), false)

  const analysisEvent = announced.find((event) =>
    event.payload.path === `${bundle}/video-analysis.json`)
  assert.equal(analysisEvent?.run_id, 'child-run')
  assert.equal(analysisEvent?.root_run_id, 'root-run')
  assert.equal(analysisEvent?.team, 'youtube-extraction')
  assert.equal(analysisEvent?.payload.artifact_type, 'analysis')
  assert.equal(analysisEvent?.payload.title, 'Gemini video analysis')
  assert.equal(
    announced.find((event) => event.payload.path === `${bundle}/manual.docx`)
      ?.payload.artifact_role,
    'final',
  )
  assert.equal(result.sourceVideoPath, `${bundle}/source-video.mp4`)
  assert.equal(
    await fs.readFile(path.join(assignmentPath, bundle, 'source-video.mp4'), 'utf8'),
    'verified-video',
  )
  const completedManifest = JSON.parse(await fs.readFile(
    path.join(assignmentPath, bundle, 'generation-manifest.json'),
    'utf8',
  ))
  assert.equal(completedManifest.deleteVideosAfterInfoExtraction, false)
  assert.deepEqual(
    completedManifest.outputs.map((output: { path: string }) => output.path).sort(),
    [
      'frames.json',
      'manual-plan.json',
      'manual.docx',
      'manual.md',
      'media.json',
      'source-video.mp4',
      'video-analysis.json',
      'video-metadata.json',
    ],
  )
  await assert.rejects(fs.access(path.join(assignmentPath, bundle, 'working')))
})

test('a manual built without an artifact context still completes', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-no-context-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = manualCoordinatorWithLocalPublication(assignmentPath, {
    cleanupWorkingDirectory: async () => {},
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'no-context-run')

  const result = await coordinator.build({
    videoId: video.videoId, manualRunId: prepared.manualRunId!,
  })

  assert.equal(result.ok, true)
  assert.equal(await readEngineEvents(assignmentPath).then((events) => events.length), 0)
})

test('FFmpeg failure reports frame extraction fallback without misreporting the download', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-ffmpeg-fallback-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    binaries: { ytDlpPath: '/unused/yt-dlp', ffmpegPath: '/unused/ffmpeg', ffprobePath: '/unused/ffprobe' },
    downloadMedia: async ({ workingDirectory }) => {
      await fs.mkdir(workingDirectory, { recursive: true })
      const mediaPath = path.join(workingDirectory, 'source-video.mp4')
      await fs.writeFile(mediaPath, Buffer.from('verified-video'))
      return {
        path: mediaPath, byteLength: 14, durationSeconds: 600, width: 1280, height: 720,
        usedProfileSession: false,
        diskPreflight: { estimatedMediaBytes: 14, frameHeadroomBytes: 1, requiredBytes: 15,
          availableBytes: 1_000, estimateSource: 'declared', recheckedBeforeCommit: true },
      }
    },
    extractFrames: async () => { throw new Error('ffmpeg crashed with private diagnostics') },
    browserFrames: {
      captureYoutubeFrames: async ({ outputDirectory, cues }) => {
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(cues.map(async (cue) => {
          const fileName = `browser-${cue.stepId}.png`
          await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
          return { stepId: cue.stepId, importance: cue.importance,
            requestedTimestampSeconds: cue.timestampSeconds, actualTimestampSeconds: cue.timestampSeconds,
            relativePath: `frames/${fileName}`, caption: cue.caption, altText: cue.altText,
            selectionReason: 'browser_fallback' as const, sha256: 'unused' }
        }))
      },
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Manual\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKmanual'))
      return { markdown: '# Manual\n', docx: Buffer.from('PKmanual'), warnings: [] }
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'ffmpeg-fallback-run')

  const result = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!, 'generation-manifest.json',
  ), 'utf8'))

  assert.equal(result.notices?.[0]?.code, 'frame_extraction_failed')
  assert.equal(manifest.stages.download, 'complete')
  assert.equal(manifest.stages.frames, 'complete')
})

test('concurrent generation manifest updates serialize without losing stage state', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manifest-queue-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const manifestPath = path.join(directory, 'generation-manifest.json')
  await fs.writeFile(manifestPath, JSON.stringify({
    generationManifestSchemaVersion: 1,
    status: 'preparing',
    stages: {},
    notices: [],
  }))

  await Promise.all(Array.from({ length: 20 }, (_, index) => mergeGenerationManifest(
    manifestPath,
    { stages: { [`stage-${index}`]: 'complete' }, updatedAt: new Date(index).toISOString() },
  )))

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  assert.equal(Object.keys(manifest.stages).length, 20)
})

test('cancellation and progress writes share one manifest mutation queue', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manifest-cancel-queue-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const manifestPath = path.join(directory, 'generation-manifest.json')
  await fs.writeFile(manifestPath, JSON.stringify({
    generationManifestSchemaVersion: 1,
    status: 'running',
    stages: {},
    notices: [],
  }))

  await Promise.all([
    ...Array.from({ length: 20 }, (_, index) => mergeGenerationManifest(
      manifestPath,
      { stages: { [`stage-${index}`]: 'complete' }, updatedAt: new Date(index).toISOString() },
    )),
    cancelGenerationManifestStage(manifestPath, {
      stage: 'frames',
      cancelledAt: '2026-08-13T12:00:00.000Z',
    }),
  ])

  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  assert.equal(manifest.status, 'cancelled')
  assert.equal(manifest.cancelledAt, '2026-08-13T12:00:00.000Z')
  assert.equal(manifest.stages.frames, 'cancelled')
  assert.equal(manifest.stages.cleanup, 'cancelled')
  assert.equal(Object.keys(manifest.stages).filter((key) => key.startsWith('stage-')).length, 20)
})

test('successful provider usage remains charged when plan composition fails afterward', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-provider-charge-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const usageLedger = new YoutubeGeminiUsageLedger({
    storagePath: path.join(assignmentPath, 'gemini-usage.json'),
    now: () => new Date('2026-08-13T12:00:00.000Z'),
  })
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    usageLedger,
    settings: {
      runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash', source: 'persisted' }),
      snapshot: async () => ({
        geminiDailyVideoMinutesLimit: 120,
        geminiConfirmationThresholdMinutes: 30,
      }),
    },
    analysis: {
      analyze: async (request) => ({
        usage: { inputTokens: 12_000, outputTokens: 500 },
        analysis: {
          analysisSchemaVersion: 1,
          sourceRevisionFingerprint: request.sourceRevisionFingerprint,
          model: request.model,
          analysisPromptVersion: 'youtube-manual-v2',
          outputLanguage: 'en',
          generatedAt: request.generatedAt,
          summary: 'Provider completed, but composition will fail.',
          steps: Array.from({ length: 16 }, (_, index) => ({
            id: `step-${index}`,
            title: `Step ${index}`,
            explanation: 'Complete the visible action.',
            startSeconds: index,
            endSeconds: index + 1,
            visualCandidates: [{
              timestampSeconds: index + 0.5,
              importance: 'required' as const,
              reason: 'Visible action.',
              caption: 'Visible action',
              altText: 'Visible action in the application',
            }],
          })),
        },
      }),
    },
    now: () => new Date('2026-08-13T12:00:00.000Z'),
  })

  const result = await coordinator.prepare({ video, templateId: 'quick-guide', outputLanguage: 'en' })

  assert.equal(result.analysisMode, 'transcript')
  const usage = await usageLedger.rollingUsage()
  assert.equal(usage.completedMinutes, 10)
  assert.equal(usage.reservedMinutes, 0)
})

test('manual preparation rejects a symlinked output boundary', async (context) => {
  if (process.platform === 'win32') return context.skip('Symlink permissions differ on Windows.')
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-symlink-'))
  const outsidePath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-outside-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  context.after(() => fs.rm(outsidePath, { recursive: true, force: true }))
  await fs.symlink(outsidePath, path.join(assignmentPath, 'output'), 'dir')
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
  })

  await assert.rejects(coordinator.prepare({
    video, templateId: 'quick-guide', outputLanguage: 'en', manualRunId: 'unsafe-run',
  }), /safe real directory/i)
  assert.equal((await fs.readdir(outsidePath)).length, 0)
})

test('cancellation during browser frame fallback records frames as the interrupted stage', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-browser-cancel-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const controller = new AbortController()
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserFrames: {
      captureYoutubeFrames: async () => {
        controller.abort()
        throw controller.signal.reason
      },
    },
  })
  const prepared = await coordinator.prepare({
    video, templateId: 'quick-guide', outputLanguage: 'en', manualRunId: 'browser-cancel-run',
  })
  await coordinator.writeManualPlan({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
    content: JSON.stringify({
      manualPlanSchemaVersion: 1, video, templateId: 'quick-guide', sourceLanguage: 'en',
      outputLanguage: 'en',
      analysis: { mode: 'transcript', generatedAt: '2026-08-12T12:00:00.000Z', warnings: [] },
      summary: 'Cancellation summary.',
      chapters: [{ id: 'instructions', order: 1, title: 'Instructions', stepIds: ['cancel-step'] }],
      steps: [{
        id: 'cancel-step', order: 1, title: 'Cancel step', explanation: 'Complete it.',
        startSeconds: 1, endSeconds: 2,
        visualCues: [{ timestampSeconds: 1.5, importance: 'required', reason: 'Visible.',
          caption: 'Visible', altText: 'Visible application state' }],
      }],
    }),
  })

  await assert.rejects(coordinator.build({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
    signal: controller.signal,
  }))
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
    'generation-manifest.json',
  ), 'utf8'))
  assert.equal(manifest.status, 'cancelled')
  assert.equal(manifest.stages.download, 'skipped')
  assert.equal(manifest.stages.frames, 'cancelled')
  assert.equal(manifest.stages.cleanup, 'cancelled')
})

test('cancellation during publication records the active output stages and reuses captured frames on resume', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-publish-cancel-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const controller = new AbortController()
  let captures = 0
  let publications = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserFrames: {
      captureYoutubeFrames: async ({ outputDirectory, cues }) => {
        captures += 1
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(cues.map(async (cue) => {
          const fileName = `browser-${cue.stepId}.png`
          const bytes = Buffer.from('frame')
          await fs.writeFile(path.join(outputDirectory, fileName), bytes)
          return {
            stepId: cue.stepId,
            requestedTimestampSeconds: cue.timestampSeconds,
            actualTimestampSeconds: cue.timestampSeconds,
            relativePath: `frames/${fileName}`,
            caption: cue.caption,
            altText: cue.altText,
            selectionReason: 'browser_fallback' as const,
            sha256: 'frame-sha',
          }
        }))
      },
    },
    publishManual: async ({ bundleDirectory }) => {
      publications += 1
      if (publications === 1) {
        controller.abort()
        throw controller.signal.reason
      }
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Manual\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKmanual'))
      return { markdown: '# Manual\n', docx: Buffer.from('PKmanual'), warnings: [] }
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'publish-cancel-run')

  await assert.rejects(coordinator.build({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
    signal: controller.signal,
  }))
  const manifestPath = path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
    'generation-manifest.json',
  )
  const cancelled = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.stages.markdown, 'cancelled')
  assert.equal(cancelled.stages.docx, 'cancelled')
  assert.ok(cancelled.cancelledAt)

  const resumed = await coordinator.build({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
  })
  assert.equal(resumed.ok, true)
  assert.equal(captures, 1)
  assert.equal(publications, 2)
})

test('a stored frame list with a malformed frame is captured again instead of reused', async (context) => {
  // frames.json is read back from disk on resume. A frame whose path and hash
  // still verify but whose other fields are the wrong type must not flow into
  // the manual as if it were a captured frame.
  const malformations: ReadonlyArray<(frame: Record<string, unknown>) => unknown> = [
    (frame) => ({ ...frame, actualTimestampSeconds: '12' }),
    (frame) => ({ ...frame, caption: 42 }),
    (frame) => ({ ...frame, relativePath: undefined }),
    () => null,
  ]
  for (const malform of malformations) {
    const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-malformed-frames-'))
    context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
    const controller = new AbortController()
    let captures = 0
    let publications = 0
    const coordinator = new YoutubeManualCoordinator({
      assignmentPath,
      settings: new YoutubeSettingsService({ environment: {} }),
      browserFrames: {
        captureYoutubeFrames: async ({ outputDirectory, cues }) => {
          captures += 1
          await fs.mkdir(outputDirectory, { recursive: true })
          return await Promise.all(cues.map(async (cue) => {
            const fileName = `browser-${cue.stepId}.png`
            await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
            return {
              stepId: cue.stepId,
              requestedTimestampSeconds: cue.timestampSeconds,
              actualTimestampSeconds: cue.timestampSeconds,
              relativePath: `frames/${fileName}`,
              caption: cue.caption,
              altText: cue.altText,
              selectionReason: 'browser_fallback' as const,
              sha256: 'frame-sha',
            }
          }))
        },
      },
      publishManual: async ({ bundleDirectory }) => {
        publications += 1
        if (publications === 1) {
          controller.abort()
          throw controller.signal.reason
        }
        await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Manual\n')
        await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKmanual'))
        return { markdown: '# Manual\n', docx: Buffer.from('PKmanual'), warnings: [] }
      },
    })
    const prepared = await prepareTranscriptPlan(coordinator, 'malformed-frames-run')
    const manualRunId = prepared.manualRunId
    assert.ok(manualRunId)
    await assert.rejects(coordinator.build({
      videoId: video.videoId,
      manualRunId,
      signal: controller.signal,
    }))
    const framesPath = path.join(
      assignmentPath, 'output', 'manuals', video.videoId, manualRunId, 'frames.json',
    )
    const stored: unknown = JSON.parse(await fs.readFile(framesPath, 'utf8'))
    assert.ok(Array.isArray(stored) && stored.length > 0)
    const [first, ...rest] = stored
    assert.ok(first && typeof first === 'object')
    await fs.writeFile(framesPath, JSON.stringify([malform({ ...first }), ...rest]))

    const resumed = await coordinator.build({ videoId: video.videoId, manualRunId })

    assert.equal(resumed.ok, true)
    assert.equal(captures, 2)
  }
})

test('a completed manual run is immutable and a repeated build only returns existing artifacts', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-immutable-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  let captures = 0
  let publications = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserFrames: {
      captureYoutubeFrames: async ({ outputDirectory, cues }) => {
        captures += 1
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(cues.map(async (cue) => {
          const fileName = `browser-${cue.stepId}.png`
          await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
          return {
            stepId: cue.stepId,
            requestedTimestampSeconds: cue.timestampSeconds,
            actualTimestampSeconds: cue.timestampSeconds,
            relativePath: `frames/${fileName}`,
            caption: cue.caption,
            altText: cue.altText,
            selectionReason: 'browser_fallback' as const,
            sha256: 'frame-sha',
          }
        }))
      },
    },
    publishManual: async ({ bundleDirectory }) => {
      publications += 1
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Immutable\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKimmutable'))
      return { markdown: '# Immutable\n', docx: Buffer.from('PKimmutable'), warnings: [] }
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'immutable-run')
  const first = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })
  const markdownPath = path.join(assignmentPath, first.manualMarkdownPath!)
  const firstStat = await fs.stat(markdownPath)

  const second = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })
  const secondStat = await fs.stat(markdownPath)

  assert.equal(second.reused, true)
  assert.equal(captures, 1)
  assert.equal(publications, 1)
  assert.equal(secondStat.mtimeMs, firstStat.mtimeMs)
})

test('a completed run is not reused when a published artifact hash no longer matches', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-tamper-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserFrames: {
      captureYoutubeFrames: async ({ outputDirectory, cues }) => {
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(cues.map(async (cue) => {
          const fileName = `browser-${cue.stepId}.png`
          await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
          return { stepId: cue.stepId, requestedTimestampSeconds: cue.timestampSeconds,
            actualTimestampSeconds: cue.timestampSeconds, relativePath: `frames/${fileName}`,
            caption: cue.caption, altText: cue.altText, selectionReason: 'browser_fallback' as const,
            sha256: 'unused' }
        }))
      },
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Verified\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKverified'))
      return { markdown: '# Verified\n', docx: Buffer.from('PKverified'), warnings: [] }
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'tamper-run')
  const built = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })
  await fs.writeFile(path.join(assignmentPath, built.manualMarkdownPath!), '# Tampered\n')

  await assert.rejects(coordinator.build({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
  }), /completed artifact.*verification/i)
})

test('cancellation after publication reuses verified Markdown and DOCX during cleanup resume', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-cleanup-resume-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const controller = new AbortController()
  let publications = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserFrames: {
      captureYoutubeFrames: async ({ outputDirectory, cues }) => {
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(cues.map(async (cue) => {
          const fileName = `browser-${cue.stepId}.png`
          await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
          return { stepId: cue.stepId, requestedTimestampSeconds: cue.timestampSeconds,
            actualTimestampSeconds: cue.timestampSeconds, relativePath: `frames/${fileName}`,
            caption: cue.caption, altText: cue.altText, selectionReason: 'browser_fallback' as const,
            sha256: 'unused' }
        }))
      },
    },
    publishManual: async ({ bundleDirectory }) => {
      publications += 1
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Published\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKpublished'))
      controller.abort()
      return { markdown: '# Published\n', docx: Buffer.from('PKpublished'), warnings: [] }
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'cleanup-resume-run')

  await assert.rejects(coordinator.build({
    videoId: video.videoId, manualRunId: prepared.manualRunId!, signal: controller.signal,
  }))
  const resumed = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })

  assert.equal(resumed.ok, true)
  assert.equal(publications, 1)
})

test('resume preserves prior fallback notices when cleanup adds a warning', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-notice-resume-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const controller = new AbortController()
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    binaries: { ytDlpPath: '/missing/yt-dlp', ffmpegPath: '/missing/ffmpeg',
      ffprobePath: '/missing/ffprobe' },
    browserFrames: {
      captureYoutubeFrames: async ({ outputDirectory, cues }) => {
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(cues.map(async (cue) => {
          const fileName = `browser-${cue.stepId}.png`
          await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
          return { stepId: cue.stepId, requestedTimestampSeconds: cue.timestampSeconds,
            actualTimestampSeconds: cue.timestampSeconds, relativePath: `frames/${fileName}`,
            caption: cue.caption, altText: cue.altText, selectionReason: 'browser_fallback' as const,
            sha256: 'unused' }
        }))
      },
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Published\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKpublished'))
      controller.abort()
      return { markdown: '# Published\n', docx: Buffer.from('PKpublished'), warnings: [] }
    },
    cleanupWorkingDirectory: async () => { throw new Error('locked') },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'notice-resume-run')

  await assert.rejects(coordinator.build({
    videoId: video.videoId, manualRunId: prepared.manualRunId!, signal: controller.signal,
  }))
  const resumed = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })

  assert.deepEqual(resumed.notices?.map((notice) => notice.code), [
    'media_download_fallback',
    'cleanup_warning',
  ])
})

test('a preparation outcome refreshes the manifest update timestamp', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-updated-at-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  let tick = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    now: () => new Date(Date.UTC(2026, 7, 13, 12, 0, tick++)),
  })

  const prepared = await coordinator.prepare({
    video, templateId: 'quick-guide', manualRunId: 'updated-at-run',
  })
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
    'generation-manifest.json',
  ), 'utf8'))

  assert.equal(manifest.updatedAt, '2026-08-13T12:00:02.000Z')
})

test('cleanup failure preserves published outputs and records a warning terminal state', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-cleanup-warning-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = manualCoordinatorWithLocalPublication(assignmentPath, {
    cleanupWorkingDirectory: async () => { throw new Error('temporary file is locked') },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'cleanup-warning-run')

  const result = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!, 'generation-manifest.json',
  ), 'utf8'))

  assert.equal(result.ok, true)
  assert.equal(result.generationStatus, 'complete_with_warnings')
  assert.equal(result.notices?.some((notice) => notice.code === 'cleanup_warning'), true)
  assert.equal(manifest.stages.cleanup, 'warning')
})

test('generation manifest keeps the highest observed RSS sample across stages', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-peak-rss-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const samples = [100, 900, 200]
  const coordinator = manualCoordinatorWithLocalPublication(assignmentPath, {
    cleanupWorkingDirectory: async () => undefined,
    rssBytes: () => samples.shift() ?? 200,
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'peak-rss-run')

  await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!, 'generation-manifest.json',
  ), 'utf8'))

  assert.equal(manifest.resourceMeasurements.peakRssBytes, 900)
})

test('cancellation wins over a simultaneous cleanup warning', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-cleanup-cancel-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const controller = new AbortController()
  const coordinator = manualCoordinatorWithLocalPublication(assignmentPath, {
    cleanupWorkingDirectory: async () => {
      controller.abort()
      throw new Error('temporary file is locked')
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'cleanup-cancel-run')

  await assert.rejects(coordinator.build({
    videoId: video.videoId, manualRunId: prepared.manualRunId!, signal: controller.signal,
  }))
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!, 'generation-manifest.json',
  ), 'utf8'))
  assert.equal(manifest.status, 'cancelled')
  assert.equal(manifest.stages.cleanup, 'cancelled')
})

test('preparing an already completed manual run refuses to overwrite its immutable bundle', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-prepare-immutable-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    browserFrames: {
      captureYoutubeFrames: async ({ outputDirectory, cues }) => {
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(cues.map(async (cue) => {
          const fileName = `browser-${cue.stepId}.png`
          await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
          return {
            stepId: cue.stepId,
            requestedTimestampSeconds: cue.timestampSeconds,
            actualTimestampSeconds: cue.timestampSeconds,
            relativePath: `frames/${fileName}`,
            caption: cue.caption,
            altText: cue.altText,
            selectionReason: 'browser_fallback' as const,
            sha256: 'frame-sha',
          }
        }))
      },
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Immutable\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKimmutable'))
      return { markdown: '# Immutable\n', docx: Buffer.from('PKimmutable'), warnings: [] }
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'immutable-prepare-run')
  await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })
  const manifestPath = path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
    'generation-manifest.json',
  )
  const before = await fs.readFile(manifestPath)

  await assert.rejects(coordinator.prepare({
    video, templateId: 'quick-guide', outputLanguage: 'en', manualRunId: prepared.manualRunId!,
  }), /completed.*immutable/i)

  assert.deepEqual(await fs.readFile(manifestPath), before)
})

test('repeating preparation for a prepared run reuses its plan without another Gemini call', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-prepare-resume-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  let calls = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: {
      runtimeGemini: async () => ({ apiKey: 'key', model: 'gemini-3.6-flash', source: 'persisted' }),
      snapshot: async () => ({ geminiDailyVideoMinutesLimit: 120, geminiConfirmationThresholdMinutes: 30 }),
    },
    analysis: {
      analyze: async (request) => {
        calls += 1
        return { analysis: {
          analysisSchemaVersion: 1,
          sourceRevisionFingerprint: request.sourceRevisionFingerprint,
          model: request.model,
          analysisPromptVersion: 'youtube-manual-v2',
          outputLanguage: request.outputLanguage ?? 'en',
          generatedAt: request.generatedAt,
          summary: 'Reusable preparation.',
          steps: [{
            id: 'resume-step', title: 'Resume step', explanation: 'Complete it.',
            startSeconds: 1, endSeconds: 2,
            visualCandidates: [{ timestampSeconds: 1.5, importance: 'required', reason: 'Visible.',
              caption: 'Visible', altText: 'Visible application state' }],
          }],
        } }
      },
    },
  })
  const first = await coordinator.prepare({
    video, templateId: 'quick-guide', outputLanguage: 'en', manualRunId: 'prepared-resume-run',
  })
  const second = await coordinator.prepare({
    video, templateId: 'quick-guide', outputLanguage: 'en', manualRunId: 'prepared-resume-run',
  })

  assert.equal(calls, 1)
  assert.equal(second.manualPlanPath, first.manualPlanPath)
  assert.equal(second.reused, true)
})

test('resume after frame-extraction cancellation reuses the verified downloaded media', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-media-resume-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const controller = new AbortController()
  let downloads = 0
  let extractions = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    binaries: { ytDlpPath: '/unused/yt-dlp', ffmpegPath: '/unused/ffmpeg', ffprobePath: '/unused/ffprobe' },
    downloadMedia: async ({ workingDirectory }) => {
      downloads += 1
      await fs.mkdir(workingDirectory, { recursive: true })
      const mediaPath = path.join(workingDirectory, 'source-video.media')
      await fs.writeFile(mediaPath, Buffer.from('verified-video'))
      return {
        path: mediaPath,
        byteLength: 14,
        durationSeconds: video.durationSeconds,
        width: 1280,
        height: 720,
        container: 'mp4',
        usedProfileSession: false,
        diskPreflight: {
          estimatedMediaBytes: 14,
          frameHeadroomBytes: 1,
          requiredBytes: 15,
          availableBytes: 1_000,
          estimateSource: 'declared',
          recheckedBeforeCommit: true,
        },
      }
    },
    extractFrames: async ({ outputDirectory, candidates }) => {
      extractions += 1
      if (extractions === 1) {
        controller.abort()
        throw controller.signal.reason
      }
      await fs.mkdir(outputDirectory, { recursive: true })
      return await Promise.all(candidates.map(async (candidate, index) => {
        const fileName = `frame-${index}.png`
        const bytes = Buffer.from(`frame-${index}`)
        await fs.writeFile(path.join(outputDirectory, fileName), bytes)
        return {
          stepId: candidate.stepId,
          requestedTimestampSeconds: candidate.requestedTimestampSeconds,
          actualTimestampSeconds: candidate.timestampSeconds,
          relativePath: `frames/${fileName}`,
          selectionReason: candidate.selectionReason,
          ...(candidate.requiredCueId ? { requiredCueId: candidate.requiredCueId } : {}),
          sha256: 'unused',
          byteLength: bytes.byteLength,
          meanLuma: 100,
          lumaRange: 80,
          blurScore: 0.1,
          valid: true,
        }
      }))
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Resume\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKresume'))
      return { markdown: '# Resume\n', docx: Buffer.from('PKresume'), warnings: [] }
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'media-resume-run')

  await assert.rejects(coordinator.build({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
    signal: controller.signal,
  }))
  await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })

  assert.equal(downloads, 1)
  assert.equal(extractions, 2)
})

test('a resumed build whose media record predates the session field claims no session either way', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-media-legacy-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const controller = new AbortController()
  let extractions = 0
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    binaries: { ytDlpPath: '/unused/yt-dlp', ffmpegPath: '/unused/ffmpeg', ffprobePath: '/unused/ffprobe' },
    downloadMedia: async ({ workingDirectory }) => {
      await fs.mkdir(workingDirectory, { recursive: true })
      const mediaPath = path.join(workingDirectory, 'source-video.mp4')
      await fs.writeFile(mediaPath, Buffer.from('verified-video'))
      return {
        path: mediaPath, byteLength: 14, durationSeconds: 600, width: 1280, height: 720,
        usedProfileSession: true,
        diskPreflight: { estimatedMediaBytes: 14, frameHeadroomBytes: 1, requiredBytes: 15,
          availableBytes: 1_000, estimateSource: 'declared', recheckedBeforeCommit: true },
      }
    },
    extractFrames: async ({ outputDirectory, candidates }) => {
      extractions += 1
      if (extractions === 1) {
        controller.abort()
        throw controller.signal.reason
      }
      await fs.mkdir(outputDirectory, { recursive: true })
      return await Promise.all(candidates.map(async (candidate, index) => {
        const fileName = `frame-${index}.png`
        await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
        return { stepId: candidate.stepId,
          requestedTimestampSeconds: candidate.requestedTimestampSeconds,
          actualTimestampSeconds: candidate.timestampSeconds, relativePath: `frames/${fileName}`,
          selectionReason: candidate.selectionReason,
          ...whenDefined(candidate.requiredCueId, (requiredCueId) => ({ requiredCueId })),
          sha256: 'unused', byteLength: 5, meanLuma: 100, lumaRange: 80, blurScore: 0.1,
          valid: true }
      }))
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Legacy\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKlegacy'))
      return { markdown: '# Legacy\n', docx: Buffer.from('PKlegacy'), warnings: [] }
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'legacy-media-run')
  await assert.rejects(coordinator.build({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
    signal: controller.signal,
  }))
  const bundle = path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
  )
  const mediaPath = path.join(bundle, 'media.json')
  // A bundle downloaded by the version before the field existed, resumed after
  // an update: the manifest reports no session fact rather than claiming an
  // anonymous download the bundle never recorded.
  const { usedProfileSession: _absent, ...legacyRecord } =
    JSON.parse(await fs.readFile(mediaPath, 'utf8'))
  await fs.writeFile(mediaPath, JSON.stringify(legacyRecord))

  await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })

  const manifest = JSON.parse(await fs.readFile(
    path.join(bundle, 'generation-manifest.json'),
    'utf8',
  ))
  assert.ok('sourceMedia' in manifest)
  assert.equal('usedProfileSession' in manifest.sourceMedia, false)
})

test('manual build publishes downloaded-video and extracted-frame milestones', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-frame-progress-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  let started!: () => void
  let release!: () => void
  const progress: string[] = []
  const startedPromise = new Promise<void>((resolve) => { started = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: {
      runtimeGemini: async () => ({ model: 'gemini-3.6-flash', source: 'default' }),
      snapshot: async () => ({
        geminiDailyVideoMinutesLimit: 120,
        geminiConfirmationThresholdMinutes: 30,
        deleteVideosAfterInfoExtraction: true,
      }),
    },
    binaries: { ytDlpPath: '/unused/yt-dlp', ffmpegPath: '/unused/ffmpeg', ffprobePath: '/unused/ffprobe' },
    downloadMedia: async ({ workingDirectory }) => {
      await fs.mkdir(workingDirectory, { recursive: true })
      const mediaPath = path.join(workingDirectory, 'source-video.mp4')
      await fs.writeFile(mediaPath, Buffer.from('verified-video'))
      return { path: mediaPath, byteLength: 14, durationSeconds: 600, width: 1280, height: 720,
        usedProfileSession: false,
        diskPreflight: { estimatedMediaBytes: 14, frameHeadroomBytes: 1, requiredBytes: 15,
          availableBytes: 1_000, estimateSource: 'declared', recheckedBeforeCommit: true } }
    },
    extractFrames: async ({ outputDirectory, candidates }) => {
      started()
      await gate
      await fs.mkdir(outputDirectory, { recursive: true })
      return await Promise.all(candidates.map(async (candidate, index) => {
        const fileName = `frame-${index}.png`
        await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from(`frame-${index}`))
        return { stepId: candidate.stepId, requestedTimestampSeconds: candidate.requestedTimestampSeconds,
          actualTimestampSeconds: candidate.timestampSeconds, relativePath: `frames/${fileName}`,
          selectionReason: candidate.selectionReason,
          ...whenDefined(candidate.requiredCueId, (requiredCueId) => ({ requiredCueId })),
          sha256: 'unused', byteLength: 7, meanLuma: 100, lumaRange: 80, blurScore: 0.1, valid: true }
      }))
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Manual\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKmanual'))
      return { markdown: '# Manual\n', docx: Buffer.from('PKmanual'), warnings: [] }
    },
    onProgress: (event) => { progress.push(event.type) },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'frame-progress-run')
  const building = coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })
  await startedPromise
  const manifest = JSON.parse(await fs.readFile(path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!, 'generation-manifest.json',
  ), 'utf8'))
  assert.equal(manifest.stages.download, 'complete')
  assert.equal(manifest.stages.frames, 'in_progress')
  assert.match(manifest.sourceMedia.sha256, /^[a-f0-9]{64}$/)
  release()
  await building
  const bundle = path.join(
    assignmentPath, 'output', 'manuals', video.videoId, prepared.manualRunId!,
  )
  await assert.rejects(fs.access(path.join(bundle, 'source-video.mp4')))
  await assert.rejects(fs.access(path.join(bundle, 'working')))
  // Every milestone, in build order. The publication and cleanup half is what
  // closes the long silent stretch between frame extraction and completion, so
  // it has to be asserted rather than trailing off after the fourth event.
  assert.deepEqual(progress, [
    'video_download_started',
    'video_downloaded',
    'key_frames_extraction_started',
    'key_frames_extracted',
    'manual_publication_started',
    'manual_markdown_written',
    'manual_docx_written',
    'temporary_media_cleaned',
  ])
})

test('retained builds rewrite media.json with the retained source-video contract', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-retained-media-'))
  const mediaBytes = Buffer.from('retained-contract-video')
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    binaries: { ytDlpPath: '/unused/yt-dlp', ffmpegPath: '/unused/ffmpeg', ffprobePath: '/unused/ffprobe' },
    downloadMedia: async ({ workingDirectory }) => {
      await fs.mkdir(workingDirectory, { recursive: true })
      const mediaPath = path.join(workingDirectory, 'source-video.mp4')
      await fs.writeFile(mediaPath, mediaBytes)
      return {
        path: mediaPath, byteLength: mediaBytes.byteLength, durationSeconds: 600, width: 1280, height: 720,
        usedProfileSession: false,
        diskPreflight: { estimatedMediaBytes: mediaBytes.byteLength, frameHeadroomBytes: 1,
          requiredBytes: mediaBytes.byteLength + 1,
          availableBytes: 1_000, estimateSource: 'declared', recheckedBeforeCommit: true },
      }
    },
    extractFrames: async ({ outputDirectory, candidates }) => {
      await fs.mkdir(outputDirectory, { recursive: true })
      return await Promise.all(candidates.map(async (candidate, index) => {
        const fileName = `frame-${index}.png`
        await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
        return {
          stepId: candidate.stepId,
          requestedTimestampSeconds: candidate.requestedTimestampSeconds,
          actualTimestampSeconds: candidate.timestampSeconds,
          relativePath: `frames/${fileName}`,
          selectionReason: candidate.selectionReason,
          ...(candidate.requiredCueId ? { requiredCueId: candidate.requiredCueId } : {}),
          sha256: 'unused',
          byteLength: 5,
          meanLuma: 100,
          lumaRange: 80,
          blurScore: 0.1,
          valid: true,
        }
      }))
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Manual\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKmanual'))
      return { markdown: '# Manual\n', docx: Buffer.from('PKmanual'), warnings: [] }
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'retained-media-run')

  const result = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })

  assert.equal(result.sourceVideoPath, `output/manuals/${video.videoId}/retained-media-run/source-video.mp4`)
  const bundle = path.join(assignmentPath, 'output', 'manuals', video.videoId, 'retained-media-run')
  const media = JSON.parse(await fs.readFile(path.join(bundle, 'media.json'), 'utf8'))
  assert.equal(media.retention, 'retained')
  assert.equal(media.path, 'source-video.mp4')
  assert.equal(media.byteLength, mediaBytes.byteLength)
  assert.match(media.sha256, /^[a-f0-9]{64}$/)
  const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'generation-manifest.json'), 'utf8'))
  assert.equal(manifest.sourceVideoPath, 'source-video.mp4')
  assert.ok(manifest.outputs.some((output: { path: string }) => output.path === 'source-video.mp4'))
})

test('delete-enabled builds rewrite media.json with the deleted source-video contract', async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-deleted-media-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: {
      runtimeGemini: async () => ({ model: 'gemini-3.6-flash', source: 'default' }),
      snapshot: async () => ({
        geminiDailyVideoMinutesLimit: 120,
        geminiConfirmationThresholdMinutes: 30,
        deleteVideosAfterInfoExtraction: true,
      }),
    },
    binaries: { ytDlpPath: '/unused/yt-dlp', ffmpegPath: '/unused/ffmpeg', ffprobePath: '/unused/ffprobe' },
    downloadMedia: async ({ workingDirectory }) => {
      await fs.mkdir(workingDirectory, { recursive: true })
      const mediaPath = path.join(workingDirectory, 'source-video.mp4')
      await fs.writeFile(mediaPath, Buffer.from('deleted-contract-video'))
      return {
        path: mediaPath, byteLength: 23, durationSeconds: 600, width: 1280, height: 720,
        usedProfileSession: false,
        diskPreflight: { estimatedMediaBytes: 23, frameHeadroomBytes: 1, requiredBytes: 24,
          availableBytes: 1_000, estimateSource: 'declared', recheckedBeforeCommit: true },
      }
    },
    extractFrames: async ({ outputDirectory, candidates }) => {
      await fs.mkdir(outputDirectory, { recursive: true })
      return await Promise.all(candidates.map(async (candidate, index) => {
        const fileName = `frame-${index}.png`
        await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
        return {
          stepId: candidate.stepId,
          requestedTimestampSeconds: candidate.requestedTimestampSeconds,
          actualTimestampSeconds: candidate.timestampSeconds,
          relativePath: `frames/${fileName}`,
          selectionReason: candidate.selectionReason,
          ...(candidate.requiredCueId ? { requiredCueId: candidate.requiredCueId } : {}),
          sha256: 'unused',
          byteLength: 5,
          meanLuma: 100,
          lumaRange: 80,
          blurScore: 0.1,
          valid: true,
        }
      }))
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Manual\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKmanual'))
      return { markdown: '# Manual\n', docx: Buffer.from('PKmanual'), warnings: [] }
    },
  })
  const prepared = await prepareTranscriptPlan(coordinator, 'deleted-media-run')

  const result = await coordinator.build({ videoId: video.videoId, manualRunId: prepared.manualRunId! })

  assert.equal(result.sourceVideoPath, undefined)
  const bundle = path.join(assignmentPath, 'output', 'manuals', video.videoId, 'deleted-media-run')
  const media = JSON.parse(await fs.readFile(path.join(bundle, 'media.json'), 'utf8'))
  assert.equal(media.retention, 'deleted')
  assert.equal(media.path, null)
  assert.equal(media.byteLength, 23)
  assert.match(media.sha256, /^[a-f0-9]{64}$/)
  const manifest = JSON.parse(await fs.readFile(path.join(bundle, 'generation-manifest.json'), 'utf8'))
  assert.equal(manifest.sourceVideoPath, undefined)
  assert.equal(manifest.outputs.some((output: { path: string }) => output.path === 'source-video.mp4'), false)
})

interface RecordedEngineEvent {
  readonly type: string
  readonly run_id?: string
  readonly root_run_id?: string
  readonly team?: string | null
  readonly payload: Record<string, string | undefined>
}

async function readEngineEvents(assignmentPath: string): Promise<RecordedEngineEvent[]> {
  try {
    const log = await fs.readFile(
      path.join(assignmentPath, 'logs', 'engine-events.jsonl'),
      'utf8',
    )
    return log.split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

async function prepareTranscriptPlan(
  coordinator: YoutubeManualCoordinator,
  manualRunId: string,
) {
  const prepared = await coordinator.prepare({
    video, templateId: 'quick-guide', outputLanguage: 'en', manualRunId,
  })
  await coordinator.writeManualPlan({
    videoId: video.videoId,
    manualRunId: prepared.manualRunId!,
    content: JSON.stringify({
      manualPlanSchemaVersion: 1,
      video,
      templateId: 'quick-guide',
      sourceLanguage: 'en',
      outputLanguage: 'en',
      analysis: { mode: 'transcript', generatedAt: '2026-08-13T12:00:00.000Z', warnings: [] },
      summary: 'A resumable manual.',
      chapters: [{ id: 'instructions', order: 1, title: 'Instructions', stepIds: ['resume-step'] }],
      steps: [{
        id: 'resume-step', order: 1, title: 'Resume step', explanation: 'Complete it.',
        startSeconds: 1, endSeconds: 2,
        visualCues: [{ timestampSeconds: 1.5, importance: 'required', reason: 'Visible.',
          caption: 'Visible', altText: 'Visible application state' }],
      }],
    }),
  })
  return prepared
}

function manualCoordinatorWithLocalPublication(
  assignmentPath: string,
  extra: {
    readonly cleanupWorkingDirectory: (directory: string) => Promise<void>
    readonly rssBytes?: () => number
    readonly binariesUnavailableReason?: string
  },
): YoutubeManualCoordinator {
  return new YoutubeManualCoordinator({
    assignmentPath,
    settings: new YoutubeSettingsService({ environment: {} }),
    cleanupWorkingDirectory: extra.cleanupWorkingDirectory,
    ...whenDefined(extra.rssBytes, (rssBytes) => ({ rssBytes: rssBytes })),
    ...whenDefined(extra.binariesUnavailableReason, (reason) => ({
      binariesUnavailableReason: reason,
    })),
    browserFrames: {
      captureYoutubeFrames: async ({ outputDirectory, cues }) => {
        await fs.mkdir(outputDirectory, { recursive: true })
        return await Promise.all(cues.map(async (cue) => {
          const fileName = `browser-${cue.stepId}.png`
          await fs.writeFile(path.join(outputDirectory, fileName), Buffer.from('frame'))
          return { stepId: cue.stepId, requestedTimestampSeconds: cue.timestampSeconds,
            actualTimestampSeconds: cue.timestampSeconds, relativePath: `frames/${fileName}`,
            caption: cue.caption, altText: cue.altText, selectionReason: 'browser_fallback' as const,
            sha256: 'unused' }
        }))
      },
    },
    publishManual: async ({ bundleDirectory }) => {
      await fs.writeFile(path.join(bundleDirectory, 'manual.md'), '# Published\n')
      await fs.writeFile(path.join(bundleDirectory, 'manual.docx'), Buffer.from('PKpublished'))
      return { markdown: '# Published\n', docx: Buffer.from('PKpublished'), warnings: [] }
    },
  })
}
