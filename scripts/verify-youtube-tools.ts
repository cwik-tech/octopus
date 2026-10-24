import * as path from 'node:path'

import { resolveYoutubeBinaries } from '../domains/youtube/youtube-binary-resolver.js'

const resolved = await resolveYoutubeBinaries({
  developmentDirectory: path.resolve('build', 'youtube-tools'),
  platform: (process.env.YOUTUBE_TOOLS_TARGET_PLATFORM ?? process.platform) as NodeJS.Platform,
  arch: process.env.YOUTUBE_TOOLS_TARGET_ARCH ?? process.arch,
})

process.stdout.write(
  `Verified ${resolved.source} YouTube tools: ${resolved.ytDlp.version}, ${resolved.ffmpeg.version}, ${resolved.ffprobe.version}\n`,
)
