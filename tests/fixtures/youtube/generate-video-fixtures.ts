import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function generateYoutubeVideoFixture(input: {
  readonly ffmpegPath: string
  readonly outputPath: string
  readonly recipe: 'hard-cut-quality' | 'static-ui' | 'one-hour-sparse'
}): Promise<void> {
  await fs.mkdir(path.dirname(input.outputPath), { recursive: true })
  const common = ['-hide_banner', '-loglevel', 'error', '-an', '-c:v', 'mpeg4', '-y']
  const recipeArgs = input.recipe === 'hard-cut-quality'
    ? [
        '-f', 'lavfi', '-i', 'color=black:size=640x360:rate=30:duration=1',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=2',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
      ]
    : input.recipe === 'static-ui'
      ? [
          '-f', 'lavfi', '-i',
          'color=c=0x20242b:size=1280x720:rate=30:duration=3,' +
          'drawbox=x=80:y=60:w=1120:h=600:color=0xf8fafc:t=fill,' +
          'drawbox=x=120:y=110:w=420:h=36:color=0x334155:t=fill,' +
          'drawbox=x=120:y=180:w=920:h=2:color=0x94a3b8:t=fill,' +
          'drawgrid=width=32:height=24:thickness=1:color=0xcbd5e1@0.35',
        ]
      : [
          '-f', 'lavfi', '-i',
          'color=c=0x20242b:size=320x180:rate=1/60:duration=3600,' +
          'drawbox=x=20:y=20:w=280:h=140:color=0xf8fafc:t=fill',
        ]
  await execFileAsync(input.ffmpegPath, [...recipeArgs, ...common, input.outputPath], {
    timeout: input.recipe === 'one-hour-sparse' ? 120_000 : 30_000,
    maxBuffer: 4 * 1_024 * 1_024,
  })
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [ffmpegPath, outputDirectory] = process.argv.slice(2)
  if (!ffmpegPath || !outputDirectory) {
    throw new Error('Usage: tsx tests/fixtures/youtube/generate-video-fixtures.ts <ffmpeg> <output-directory>')
  }
  for (const recipe of ['hard-cut-quality', 'static-ui', 'one-hour-sparse'] as const) {
    await generateYoutubeVideoFixture({
      ffmpegPath,
      outputPath: path.join(outputDirectory, `${recipe}.mp4`),
      recipe,
    })
  }
}
