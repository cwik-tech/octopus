import { requiredValue } from '../../core/required-value.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'

import { resolveYoutubeBinaries } from '../../domains/youtube/youtube-binary-resolver.js'

const execFileAsync = promisify(execFile)

test('release staging accepts only pinned binaries and emits a resolver-compatible bundle', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-tools-stage-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const sourceDirectory = path.join(directory, 'source')
  const outputRoot = path.join(directory, 'output')
  await fs.mkdir(sourceDirectory)
  const sources: Record<string, string> = {}
  for (const [name, version] of [['yt-dlp', '2026.07.04'], ['ffmpeg', '9.0.1'], ['ffprobe', '9.0.1']]) {
    const filePath = path.join(sourceDirectory, requiredValue(name, 'tests/integration/youtube-tool-staging.test.ts:23'))
    await fs.writeFile(filePath, name === 'ffmpeg'
      ? `#!/bin/sh\nif [ "$1" = "-hide_banner" ]; then echo 'signalstats blurdetect'; else echo '${name} version ${version}'; fi\n`
      : `#!/bin/sh\necho '${name} version ${version}'\n`)
    await fs.chmod(filePath, 0o755)
    sources[requiredValue(name, 'tests/integration/youtube-tool-staging.test.ts:28')] = filePath
  }
  const sha = async (filePath: string) => createHash('sha256')
    .update(await fs.readFile(filePath)).digest('hex')

  await execFileAsync(process.execPath, ['--import', 'tsx', 'scripts/stage-youtube-tools.ts'], {
    cwd: path.resolve('.'),
    env: {
      ...process.env,
      YOUTUBE_TOOLS_ALLOW_SCRIPT_FIXTURES: '1',
      YOUTUBE_TOOLS_OUTPUT_ROOT: outputRoot,
      YOUTUBE_YT_DLP_BINARY: sources['yt-dlp'],
      YOUTUBE_YT_DLP_SHA256: await sha(sources['yt-dlp']!),
      YOUTUBE_FFMPEG_BINARY: sources.ffmpeg,
      YOUTUBE_FFMPEG_SHA256: await sha(sources.ffmpeg!),
      YOUTUBE_FFPROBE_BINARY: sources.ffprobe,
      YOUTUBE_FFPROBE_SHA256: await sha(sources.ffprobe!),
    },
  })

  const resolved = await resolveYoutubeBinaries({ developmentDirectory: outputRoot })
  assert.equal(resolved.ytDlp.version, '2026.07.04')
  assert.equal(resolved.ffmpeg.version, '9.0.1')
  assert.equal(resolved.ffprobe.version, '9.0.1')
})

test('release staging rejects an interpreter-dependent yt-dlp wrapper', async (context) => {
  if (process.platform === 'win32') return context.skip('The wrapper fixture uses a POSIX shebang.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-tools-wrapper-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const outputRoot = path.join(directory, 'output')
  const ytDlpPath = path.join(directory, 'yt-dlp')
  const ffmpegPath = path.join(directory, 'ffmpeg')
  const ffprobePath = path.join(directory, 'ffprobe')
  await Promise.all([
    fs.writeFile(ytDlpPath, '#!/usr/bin/env python3\nprint("2026.07.04")\n'),
    fs.writeFile(ffmpegPath, '#!/bin/sh\necho "ffmpeg version 9.0.1"\n'),
    fs.writeFile(ffprobePath, '#!/bin/sh\necho "ffprobe version 9.0.1"\n'),
  ])
  await Promise.all([ytDlpPath, ffmpegPath, ffprobePath].map((filePath) => fs.chmod(filePath, 0o755)))
  const sha = async (filePath: string) => createHash('sha256')
    .update(await fs.readFile(filePath)).digest('hex')

  await assert.rejects(execFileAsync(
    process.execPath,
    ['--import', 'tsx', 'scripts/stage-youtube-tools.ts'],
    {
      cwd: path.resolve('.'),
      env: {
        ...process.env,
        YOUTUBE_TOOLS_OUTPUT_ROOT: outputRoot,
        YOUTUBE_YT_DLP_BINARY: ytDlpPath,
        YOUTUBE_YT_DLP_SHA256: await sha(ytDlpPath),
        YOUTUBE_FFMPEG_BINARY: ffmpegPath,
        YOUTUBE_FFMPEG_SHA256: await sha(ffmpegPath),
        YOUTUBE_FFPROBE_BINARY: ffprobePath,
        YOUTUBE_FFPROBE_SHA256: await sha(ffprobePath),
      },
    },
  ), /yt-dlp source must be a standalone executable/i)
})

test('binary resolution rejects a bundled FFmpeg build missing required quality filters', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-tools-filters-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const target = path.join(directory, `${process.platform}-${process.arch}`)
  await fs.mkdir(target)
  const tools: Record<string, { file: string; version: string; sha256: string }> = {}
  for (const [name, script] of [
    ['yt-dlp', "#!/bin/sh\necho '2026.07.04'\n"],
    ['ffmpeg', "#!/bin/sh\nif [ \"$1\" = \"-hide_banner\" ]; then echo 'signalstats'; else echo 'ffmpeg version 9.0.1'; fi\n"],
    ['ffprobe', "#!/bin/sh\necho 'ffprobe version 9.0.1'\n"],
  ]) {
    const toolName = requiredValue(name, 'staged tool name')
    const filePath = path.join(target, toolName)
    await fs.writeFile(filePath, requiredValue(script, 'tests/integration/youtube-tool-staging.test.ts:103'))
    await fs.chmod(filePath, 0o755)
    const sha256 = createHash('sha256').update(await fs.readFile(filePath)).digest('hex')
    tools[toolName] = { file: toolName, version: toolName === 'yt-dlp' ? '2026.07.04' : '9.0.1', sha256 }
  }
  await fs.writeFile(path.join(target, 'manifest.json'), JSON.stringify({
    binaryManifestSchemaVersion: 1, platform: process.platform, arch: process.arch, tools,
  }))

  await assert.rejects(resolveYoutubeBinaries({ developmentDirectory: directory }), /blurdetect/)
})
