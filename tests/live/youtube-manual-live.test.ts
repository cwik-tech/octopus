import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { resolveYoutubeBinaries } from '../../domains/youtube/youtube-binary-resolver.js'
import { YoutubeManualCoordinator } from '../../services/youtube-manual-coordinator.js'

const enabled = process.env.PIPELINE_LIVE_YOUTUBE === '1' && Boolean(process.env.GEMINI_API_KEY)

test('live Gemini analyzes a public YouTube video into a validated manual plan', {
  skip: enabled ? false : 'Set PIPELINE_LIVE_YOUTUBE=1 and GEMINI_API_KEY to run.',
  timeout: 4 * 60_000,
}, async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-live-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    settings: {
      runtimeGemini: async () => ({
        apiKey: process.env.GEMINI_API_KEY!,
        model: 'gemini-3.6-flash',
        source: 'environment',
      }),
      snapshot: async () => ({
        geminiDailyVideoMinutesLimit: 120,
        geminiConfirmationThresholdMinutes: 30,
      }),
    },
  })

  const result = await coordinator.prepare({
    video: {
      videoId: 'M7lc1UVf-VE',
      url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
      title: 'YouTube Developers Live: Embedded Web Player Customization',
      channelName: 'Google for Developers',
      durationSeconds: 135,
    },
    templateId: 'quick-guide',
  })

  assert.equal(result.ok, true)
  assert.equal(result.analysisMode, 'gemini')
  assert.ok(result.manualPlanPath)
})

const fullEnabled = enabled && process.env.PIPELINE_LIVE_YOUTUBE_FULL === '1'

test('live YouTube manual lane analyzes, downloads, extracts, and publishes Markdown plus DOCX', {
  skip: fullEnabled ? false : 'Set PIPELINE_LIVE_YOUTUBE=1, PIPELINE_LIVE_YOUTUBE_FULL=1, GEMINI_API_KEY, and stage pinned tools.',
  timeout: 8 * 60_000,
}, async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-manual-full-live-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const binaries = await resolveYoutubeBinaries({
    developmentDirectory: path.resolve(process.env.YOUTUBE_TOOLS_OUTPUT_ROOT ?? 'build/youtube-tools'),
  })
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath,
    binaries: {
      ytDlpPath: binaries.ytDlp.path,
      ffmpegPath: binaries.ffmpeg.path,
      ffprobePath: binaries.ffprobe.path,
      ytDlpVersion: binaries.ytDlp.version,
      ytDlpSha256: binaries.ytDlp.sha256,
      ffmpegVersion: binaries.ffmpeg.version,
      ffmpegSha256: binaries.ffmpeg.sha256,
      ffprobeVersion: binaries.ffprobe.version,
      ffprobeSha256: binaries.ffprobe.sha256,
    },
    settings: {
      runtimeGemini: async () => ({ apiKey: process.env.GEMINI_API_KEY!,
        model: 'gemini-3.6-flash', source: 'environment' }),
      snapshot: async () => ({ geminiDailyVideoMinutesLimit: 120,
        geminiConfirmationThresholdMinutes: 30 }),
    },
  })
  const prepared = await coordinator.prepare({
    video: { videoId: 'M7lc1UVf-VE',
      url: 'https://www.youtube.com/watch?v=M7lc1UVf-VE',
      title: 'YouTube Developers Live: Embedded Web Player Customization',
      channelName: 'Google for Developers', durationSeconds: 135 },
    templateId: 'quick-guide',
  })
  assert.ok(prepared.manualRunId)
  const built = await coordinator.build({ videoId: 'M7lc1UVf-VE', manualRunId: prepared.manualRunId! })
  assert.equal(built.ok, true)
  assert.ok(built.manualMarkdownPath)
  assert.ok(built.manualDocxPath)
  assert.ok((built.frameCount ?? 0) > 0)
  await fs.access(path.join(assignmentPath, built.manualMarkdownPath!))
  await fs.access(path.join(assignmentPath, built.manualDocxPath!))
})
