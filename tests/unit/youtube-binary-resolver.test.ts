import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { resolveYoutubeBinaries } from '../../domains/youtube/youtube-binary-resolver.js'

test('binary resolver verifies pinned checksums and versions from the explicit platform bundle', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-binaries-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const platformDirectory = path.join(root, `${process.platform}-${process.arch}`)
  await fs.mkdir(platformDirectory, { recursive: true })
  const tools = [
    ['yt-dlp', '2026.08.01'],
    ['ffmpeg', 'ffmpeg version 8.0'],
    ['ffprobe', 'ffprobe version 8.0'],
  ] as const
  const manifestTools: Record<string, unknown> = {}
  for (const [name, output] of tools) {
    const filePath = path.join(platformDirectory, name)
    const expression = name === 'ffmpeg'
      ? `a.includes('-filters') ? 'signalstats blurdetect' : ${JSON.stringify(output)}`
      : JSON.stringify(output)
    await fs.writeFile(filePath, `#!${process.execPath}\nconst a=process.argv.slice(2);console.log(${expression})\n`)
    await fs.chmod(filePath, 0o700)
    const bytes = await fs.readFile(filePath)
    manifestTools[name] = {
      file: name,
      version: name === 'yt-dlp' ? output : '8.0',
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  }
  await fs.writeFile(path.join(platformDirectory, 'manifest.json'), JSON.stringify({
    binaryManifestSchemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    tools: manifestTools,
  }))

  const resolved = await resolveYoutubeBinaries({ developmentDirectory: root })

  assert.equal(resolved.ytDlp.version, '2026.08.01')
  assert.equal(resolved.ffmpeg.version, '8.0')
  assert.equal(resolved.ffprobe.version, '8.0')
  assert.equal(resolved.source, 'development')
})

test('binary resolver rejects checksum mismatches without using ambient PATH', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-binaries-bad-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const platformDirectory = path.join(root, `${process.platform}-${process.arch}`)
  await fs.mkdir(platformDirectory, { recursive: true })
  await fs.writeFile(path.join(platformDirectory, 'manifest.json'), JSON.stringify({
    binaryManifestSchemaVersion: 1,
    platform: process.platform,
    arch: process.arch,
    tools: {
      'yt-dlp': { file: 'yt-dlp', version: 'x', sha256: '0'.repeat(64) },
      ffmpeg: { file: 'ffmpeg', version: 'x', sha256: '0'.repeat(64) },
      ffprobe: { file: 'ffprobe', version: 'x', sha256: '0'.repeat(64) },
    },
  }))
  for (const name of ['yt-dlp', 'ffmpeg', 'ffprobe']) {
    await fs.writeFile(path.join(platformDirectory, name), 'changed')
  }

  await assert.rejects(
    resolveYoutubeBinaries({ developmentDirectory: root }),
    /checksum/i,
  )
})
