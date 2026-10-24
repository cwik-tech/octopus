import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

import { extractYoutubeFrames } from '../domains/youtube/youtube-frame-extraction.js'
import { generateYoutubeVideoFixture } from '../tests/fixtures/youtube/generate-video-fixtures.js'

const execFileAsync = promisify(execFile)
const ffmpegPath = process.env.YOUTUBE_BENCHMARK_FFMPEG ?? await locateFfmpeg()
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-frame-benchmark-'))
try {
  const mediaPath = path.join(directory, 'fixture.mp4')
  await generateYoutubeVideoFixture({ ffmpegPath, outputPath: mediaPath, recipe: 'static-ui' })
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    stepId: `step-${index}`,
    timestampSeconds: 0.05 + index * 0.09,
    requestedTimestampSeconds: 0.05 + index * 0.09,
    selectionReason: 'dense_interval' as const,
  }))
  const groupedStart = performance.now()
  await extractYoutubeFrames({ ffmpegPath, mediaPath,
    outputDirectory: path.join(directory, 'grouped'), maximumWidthPx: 1_280, candidates })
  const groupedMs = performance.now() - groupedStart

  const individualStart = performance.now()
  for (const [index, candidate] of candidates.entries()) {
    await extractYoutubeFrames({ ffmpegPath, mediaPath,
      outputDirectory: path.join(directory, `individual-${index}`), maximumWidthPx: 1_280,
      candidates: [candidate] })
  }
  const individualMs = performance.now() - individualStart
  process.stdout.write(`${JSON.stringify({
    benchmarkSchemaVersion: 1,
    candidateCount: candidates.length,
    groupedMs: Math.round(groupedMs),
    individualMs: Math.round(individualMs),
    speedup: Number((individualMs / groupedMs).toFixed(2)),
  }, null, 2)}\n`)
} finally {
  await fs.rm(directory, { recursive: true, force: true })
}

async function locateFfmpeg(): Promise<string> {
  const { stdout } = await execFileAsync(process.platform === 'win32' ? 'where.exe' : 'which', ['ffmpeg'])
  const [firstLine] = stdout.split(/\r?\n/)
  if (firstLine === undefined) throw new Error('ffmpeg lookup printed no output')
  return firstLine.trim()
}
