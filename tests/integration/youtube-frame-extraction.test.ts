import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { extractYoutubeFrames } from '../../domains/youtube/youtube-frame-extraction.js'
import { generateYoutubeVideoFixture } from '../fixtures/youtube/generate-video-fixtures.js'

const execFileAsync = promisify(execFile)

test('real FFmpeg extracts deterministic PNG frames without upscaling', async (context) => {
  const ffmpegPath = await findCommand('ffmpeg')
  if (!ffmpegPath) return context.skip('FFmpeg is unavailable in this environment.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-frames-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const videoPath = path.join(directory, 'fixture.mp4')
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=30:duration=3',
    '-an', '-c:v', 'mpeg4', '-y', videoPath,
  ])

  const result = await extractYoutubeFrames({
    ffmpegPath,
    mediaPath: videoPath,
    outputDirectory: path.join(directory, 'frames'),
    maximumWidthPx: 1_600,
    candidates: [{
      stepId: 'open-editor',
      timestampSeconds: 1.05,
      requestedTimestampSeconds: 1.05,
      selectionReason: 'required_bracket',
      requiredCueId: 'open-editor:1',
    }],
  })

  assert.equal(result.length, 1)
  assert.equal(result[0]?.relativePath, 'frames/step-open-editor-000001050.png')
  assert.notEqual(result[0]?.actualTimestampSeconds, 1.05)
  assert.ok(Math.abs(result[0]!.actualTimestampSeconds - 1.05) <= 0.04)
  assert.equal(result[0]?.valid, true)
  assert.ok(result[0]!.lumaRange > 0)
  const frame = await fs.readFile(path.join(directory, result[0]!.relativePath))
  assert.deepEqual([...frame.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
})

test('real FFmpeg extracts several timestamps in one process and marks black frames invalid', async (context) => {
  const ffmpegPath = await findCommand('ffmpeg')
  if (!ffmpegPath) return context.skip('FFmpeg is unavailable in this environment.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-frames-batch-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const videoPath = path.join(directory, 'fixture.mp4')
  await generateYoutubeVideoFixture({ ffmpegPath, outputPath: videoPath, recipe: 'hard-cut-quality' })

  const result = await extractYoutubeFrames({
    ffmpegPath,
    mediaPath: videoPath,
    outputDirectory: path.join(directory, 'frames'),
    maximumWidthPx: 1_600,
    candidates: [
      { stepId: 'black', timestampSeconds: 0.5, requestedTimestampSeconds: 0.5, selectionReason: 'dense_interval' },
      { stepId: 'visible-one', timestampSeconds: 1.2, requestedTimestampSeconds: 1.2, selectionReason: 'dense_interval' },
      { stepId: 'visible-two', timestampSeconds: 2.2, requestedTimestampSeconds: 2.2, selectionReason: 'dense_interval' },
    ],
  })

  assert.equal(result.length, 3)
  assert.equal(result[0]?.valid, false)
  assert.equal(result[1]?.valid, true)
  assert.equal(result[2]?.valid, true)
})

test('real FFmpeg preserves fine static UI structure in a bounded screenshot', async (context) => {
  const ffmpegPath = await findCommand('ffmpeg')
  if (!ffmpegPath) return context.skip('FFmpeg is unavailable in this environment.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-frames-ui-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const videoPath = path.join(directory, 'static-ui.mp4')
  await generateYoutubeVideoFixture({ ffmpegPath, outputPath: videoPath, recipe: 'static-ui' })

  const [frame] = await extractYoutubeFrames({
    ffmpegPath,
    mediaPath: videoPath,
    outputDirectory: path.join(directory, 'frames'),
    maximumWidthPx: 1_600,
    candidates: [{ stepId: 'ui', timestampSeconds: 1.5, requestedTimestampSeconds: 1.5,
      selectionReason: 'required_bracket' }],
  })

  assert.equal(frame?.valid, true)
  assert.ok(frame!.lumaRange > 20)
  assert.ok(frame!.byteLength > 5_000)
})

test('real FFmpeg build exposes the required screenshot quality filters', async (context) => {
  const ffmpegPath = await findCommand('ffmpeg')
  if (!ffmpegPath) return context.skip('FFmpeg is unavailable in this environment.')
  const { stdout } = await execFileAsync(ffmpegPath, ['-hide_banner', '-filters'])
  assert.match(stdout, /\bsignalstats\b/)
  assert.match(stdout, /\bblurdetect\b/)
})

test('frame extraction rejects a symlinked output directory', async (context) => {
  if (process.platform === 'win32') return context.skip('Symlink permissions differ on Windows.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-frame-symlink-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-frame-outside-'))
  context.after(() => fs.rm(outside, { recursive: true, force: true }))
  const output = path.join(directory, 'frames')
  await fs.symlink(outside, output)

  await assert.rejects(extractYoutubeFrames({
    ffmpegPath: '/does/not/matter',
    mediaPath: path.join(directory, 'fixture.mp4'),
    outputDirectory: output,
    maximumWidthPx: 1_600,
    candidates: [],
  }), /safe real directory/i)
})

test('frame extraction marks nan quality metadata invalid', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-frame-nan-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const mediaPath = path.join(directory, 'video.media')
  await fs.writeFile(mediaPath, 'video')
  const ffmpegPath = await writeFakeFfmpeg(directory, [
    qualityBlock(0, { meanLuma: 'nan', lowLuma: '0', highLuma: '100', blur: '1' }),
  ])

  const [frame] = await extractYoutubeFrames({
    ffmpegPath,
    mediaPath,
    outputDirectory: path.join(directory, 'frames'),
    maximumWidthPx: 1_600,
    candidates: [{ stepId: 'nan-frame', timestampSeconds: 1,
      requestedTimestampSeconds: 1, selectionReason: 'required_bracket' }],
  })

  assert.equal(frame?.valid, false)
})

test('frame extraction removes already-finalized outputs when a later rename fails', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-frame-rollback-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const mediaPath = path.join(directory, 'video.media')
  const outputDirectory = path.join(directory, 'frames')
  await fs.mkdir(outputDirectory)
  await fs.writeFile(mediaPath, 'video')
  const blockedFinal = path.join(outputDirectory, 'step-second-000002000.png')
  await fs.mkdir(blockedFinal)
  await fs.writeFile(path.join(blockedFinal, 'keep'), 'keep')
  const ffmpegPath = await writeFakeFfmpeg(directory, [qualityBlock(0), qualityBlock(1)])

  await assert.rejects(extractYoutubeFrames({
    ffmpegPath,
    mediaPath,
    outputDirectory,
    maximumWidthPx: 1_600,
    candidates: [
      { stepId: 'first', timestampSeconds: 1, requestedTimestampSeconds: 1,
        selectionReason: 'required_bracket' },
      { stepId: 'second', timestampSeconds: 2, requestedTimestampSeconds: 2,
        selectionReason: 'required_bracket' },
    ],
  }))

  await assert.rejects(fs.access(path.join(outputDirectory, 'step-first-000001000.png')))
  assert.equal((await fs.lstat(blockedFinal)).isDirectory(), true)
  assert.deepEqual((await fs.readdir(outputDirectory)).sort(), ['step-second-000002000.png'])
})

async function writeFakeFfmpeg(directory: string, blocks: readonly string[]): Promise<string> {
  const executable = path.join(directory, `fake-ffmpeg-${Math.random().toString(16).slice(2)}.cjs`)
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  await fs.writeFile(executable, `#!${process.execPath}\nconst fs=require('node:fs');for(const arg of process.argv.slice(2)){if(arg.endsWith('.partial.png'))fs.writeFileSync(arg,Buffer.from('${png}','base64'))}process.stdout.write(${JSON.stringify(blocks.join(''))});\n`)
  await fs.chmod(executable, 0o700)
  return executable
}

function qualityBlock(index: number, fields: {
  meanLuma?: string
  lowLuma?: string
  highLuma?: string
  blur?: string
} = {}): string {
  return `frame:${index} pts_time:${index + 1}\n` +
    `lavfi.youtube.index=${index}\n` +
    `lavfi.signalstats.YAVG=${fields.meanLuma ?? '100'}\n` +
    `lavfi.signalstats.YLOW=${fields.lowLuma ?? '10'}\n` +
    `lavfi.signalstats.YHIGH=${fields.highLuma ?? '200'}\n` +
    `lavfi.blur=${fields.blur ?? '1'}\n`
}

async function findCommand(command: string): Promise<string | undefined> {
  try {
    return (await execFileAsync('which', [command])).stdout.trim() || undefined
  } catch {
    return undefined
  }
}
