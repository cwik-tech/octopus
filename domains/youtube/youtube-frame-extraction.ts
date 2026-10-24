import { whenDefined } from '../../core/optional-properties.js'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type { YoutubeFrameScheduleCandidate } from './youtube-frame-types.js'
import { YOUTUBE_SOURCE_IMAGE_MAX_WIDTH_PX } from './youtube-image-policy.js'
import { runYoutubeProcess } from './youtube-process.js'

export const YOUTUBE_FRAME_EXTRACTION_MAX_WIDTH_PX = YOUTUBE_SOURCE_IMAGE_MAX_WIDTH_PX

export async function extractYoutubeFrames(input: {
  readonly ffmpegPath: string
  readonly mediaPath: string
  readonly outputDirectory: string
  readonly maximumWidthPx: number
  readonly candidates: readonly YoutubeFrameScheduleCandidate[]
  readonly signal?: AbortSignal
}): Promise<readonly {
  readonly stepId: string
  readonly requestedTimestampSeconds: number
  readonly actualTimestampSeconds: number
  readonly relativePath: string
  readonly selectionReason: YoutubeFrameScheduleCandidate['selectionReason']
  readonly requiredCueId?: string
  readonly sha256: string
  readonly byteLength: number
  readonly meanLuma: number
  readonly lumaRange: number
  readonly blurScore: number
  readonly valid: boolean
}[]> {
  await ensureSafeOutputDirectory(input.outputDirectory)
  const media = await fs.lstat(input.mediaPath).catch(() => undefined)
  if (input.candidates.length > 0 && (!media?.isFile() || media.isSymbolicLink())) {
    throw new Error('YouTube media must be a safe real file.')
  }
  if (input.candidates.length === 0) return []
  const outputs = input.candidates.map((candidate) => outputFor(input.outputDirectory, candidate))
  const args: string[] = ['-hide_banner', '-loglevel', 'error', '-nostdin']
  for (const candidate of input.candidates) {
    args.push('-copyts', '-ss', formatTimestamp(candidate.timestampSeconds), '-i', input.mediaPath)
  }
  for (const [index, output] of outputs.entries()) {
    args.push(
      '-map', `${index}:v:0`,
      '-frames:v', '1',
      '-vf', [
        `scale=w='min(iw,${input.maximumWidthPx})':h=-2`,
        'signalstats',
        'blurdetect=block_width=32:block_height=32:block_pct=80',
        `metadata=mode=add:key=lavfi.youtube.index:value=${index}`,
        'metadata=print:file=-',
      ].join(','),
      '-compression_level', '6', '-y', output.temporaryPath,
    )
  }
  const finalizedPaths: string[] = []
  try {
    const processResult = await runYoutubeProcess(input.ffmpegPath, args, { ...whenDefined(input.signal, (definedValue) => ({ signal: definedValue })) })
    const qualities = parseQualityMetadata(processResult.stdout)
    const frames = []
    for (const [index, output] of outputs.entries()) {
      const quality = qualities.get(index)
      if (!quality) throw new Error('FFmpeg did not report frame quality metadata.')
      await fs.rename(output.temporaryPath, output.outputPath)
      finalizedPaths.push(output.outputPath)
      const stat = await fs.stat(output.outputPath)
      const candidate = input.candidates[index]
      if (!candidate) throw new Error(`No frame candidate matches FFmpeg output ${index}.`)
      frames.push({
        stepId: candidate.stepId,
        requestedTimestampSeconds: candidate.requestedTimestampSeconds,
        actualTimestampSeconds: quality.actualTimestampSeconds,
        relativePath: `${path.basename(input.outputDirectory)}/${output.fileName}`,
        selectionReason: candidate.selectionReason,
        ...(candidate.requiredCueId ? { requiredCueId: candidate.requiredCueId } : {}),
        sha256: await hashFileSha256(output.outputPath),
        byteLength: stat.size,
        meanLuma: quality.meanLuma,
        lumaRange: quality.lumaRange,
        blurScore: quality.blurScore,
        valid: Number.isFinite(quality.meanLuma) && Number.isFinite(quality.lumaRange) &&
          Number.isFinite(quality.blurScore) && quality.meanLuma >= 8 && quality.lumaRange >= 4,
      })
    }
    return frames
  } catch (error) {
    await Promise.all([
      ...outputs.map((output) => fs.rm(output.temporaryPath, { force: true })),
      ...finalizedPaths.map((outputPath) => fs.rm(outputPath, { force: true })),
    ])
    throw error
  }
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.once('end', resolve)
    stream.once('error', reject)
  })
  return hash.digest('hex')
}

function outputFor(outputDirectory: string, candidate: YoutubeFrameScheduleCandidate) {
  if (!/^[a-z0-9][a-z0-9-]{0,127}$/.test(candidate.stepId)) {
    throw new Error('YouTube frame step ID is invalid.')
  }
  const timestampMs = Math.round(candidate.timestampSeconds * 1_000)
  const fileName = `step-${candidate.stepId}-${String(timestampMs).padStart(9, '0')}.png`
  const outputPath = path.join(outputDirectory, fileName)
  return { fileName, outputPath, temporaryPath: `${outputPath}.partial.png` }
}

function parseQualityMetadata(text: string): Map<number, {
  actualTimestampSeconds: number
  meanLuma: number
  lumaRange: number
  blurScore: number
}> {
  const result = new Map<number, {
    actualTimestampSeconds: number
    meanLuma: number
    lumaRange: number
    blurScore: number
  }>()
  for (const block of text.split(/(?=frame:\d+\s)/)) {
    const index = numberField(block, 'lavfi.youtube.index')
    const actualTimestampSeconds = /pts_time:([\d.]+)/.exec(block)?.[1]
    const meanLuma = numberField(block, 'lavfi.signalstats.YAVG')
    const lowLuma = numberField(block, 'lavfi.signalstats.YLOW')
    const highLuma = numberField(block, 'lavfi.signalstats.YHIGH')
    const blurScore = numberField(block, 'lavfi.blur')
    if (
      index === undefined || actualTimestampSeconds === undefined ||
      meanLuma === undefined || lowLuma === undefined || highLuma === undefined ||
      blurScore === undefined
    ) continue
    if (result.has(index)) continue
    result.set(index, {
      actualTimestampSeconds: Number(actualTimestampSeconds),
      meanLuma,
      lumaRange: highLuma - lowLuma,
      blurScore,
    })
  }
  return result
}

function numberField(block: string, key: string): number | undefined {
  const match = new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}=([-+\\d.]+|nan)`).exec(block)
  if (!match) return undefined
  if (match[1] === 'nan') return Number.NaN
  const value = Number(match[1])
  return Number.isFinite(value) ? value : undefined
}

async function ensureSafeOutputDirectory(outputDirectory: string): Promise<void> {
  await fs.mkdir(outputDirectory, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(outputDirectory)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('YouTube frame output must be a safe real directory.')
  }
}

function formatTimestamp(seconds: number): string {
  return Math.max(0, seconds).toFixed(3)
}
