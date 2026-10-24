import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { test } from 'node:test'

import { YoutubeExtractionRuntime } from '../../domains/youtube/youtube-extraction.js'

const enabled = process.env.PIPELINE_LIVE_YOUTUBE === '1'
const testVideoUrl = 'https://www.youtube.com/watch?v=XLEYtv3cMlw'
const testVideoId = 'XLEYtv3cMlw'

test('captures a complete public YouTube transcript through the TypeScript runtime', {
  skip: enabled ? undefined : 'Set PIPELINE_LIVE_YOUTUBE=1 to run live YouTube extraction.',
}, async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-live-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath,
    settings: {
      runtimeProxy: async () => ({
        proxyEnabled: false,
        credentialMode: 'username-password',
        proxyHost: 'p.webshare.io',
        proxyPort: 80,
        countries: ['us'],
        username: '',
      }),
    },
  })

  const result = await runtime.capture({
    action: 'capture',
    url: testVideoUrl,
    languages: ['en'],
  })
  assert.equal(result.ok, true)
  assert.equal(result.completed, 1)
  assert.equal(result.failed, 0)
  assert.equal(result.unavailable, 0)
  assert.equal(result.authenticatedFallbackRequired, 0)
  assert.equal(result.videos?.[0]?.transcriptJson, `output/transcripts/${testVideoId}.json`)
  assert.equal(result.videos?.[0]?.transcriptMarkdown, `output/transcripts/${testVideoId}.md`)

  const transcript = JSON.parse(await fs.readFile(
    path.join(assignmentPath, 'output', 'transcripts', `${testVideoId}.json`),
    'utf8',
  )) as { segments: unknown[]; captureMethod: string; publishedAt?: string }
  assert.ok(transcript.segments.length > 10)
  assert.equal(transcript.captureMethod, 'direct')
  assert.match(transcript.publishedAt ?? '', /^\d{4}-\d{2}-\d{2}/)

  const resumed = await runtime.capture({ action: 'resume' })
  assert.equal(resumed.completed, 1)
  const manifest = JSON.parse(await fs.readFile(
    path.join(assignmentPath, 'output', 'youtube-manifest.json'),
    'utf8',
  )) as { videos: Array<{ attempts: number }> }
  assert.equal(manifest.videos[0]?.attempts, 1)
})

test('enumerates bounded playlist and channel sources through the TypeScript runtime', {
  skip: enabled ? undefined : 'Set PIPELINE_LIVE_YOUTUBE=1 to run live YouTube extraction.',
}, async (context) => {
  const assignmentPath = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-live-sources-'))
  context.after(() => fs.rm(assignmentPath, { recursive: true, force: true }))
  const runtime = new YoutubeExtractionRuntime({
    assignmentPath,
    settings: {
      runtimeProxy: async () => ({
        proxyEnabled: false,
        credentialMode: 'username-password',
        proxyHost: 'p.webshare.io',
        proxyPort: 80,
        countries: ['us'],
        username: '',
      }),
    },
  })

  const playlist = await runtime.inspect({
    action: 'inspect',
    url: 'https://www.youtube.com/playlist?list=PLMC9KNkIncKtPzgY-5rmhvj7fax8fdxoj',
    limit: 2,
  })
  assert.equal(playlist.source?.type, 'playlist')
  assert.equal(playlist.itemCount, 2)

  const channel = await runtime.inspect({
    action: 'inspect',
    url: 'https://www.youtube.com/@RickAstleyYT',
    limit: 2,
  })
  assert.equal(channel.source?.type, 'channel')
  assert.equal(channel.itemCount, 2)
})
