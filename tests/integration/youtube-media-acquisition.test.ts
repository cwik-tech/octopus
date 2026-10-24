import { requiredValue } from '../../core/required-value.js'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

import {
  downloadYoutubeMedia,
  youtubeFrameHeadroomBytes,
} from '../../domains/youtube/youtube-media-acquisition.js'
import {
  writeCookieRecordingYtDlp,
  writeMediaProbe,
} from '../support/youtube-media-stubs.js'

const execFileAsync = promisify(execFile)

test('media acquisition uses fixed yt-dlp arguments and verifies the downloaded video', async (context) => {
  const ffmpegPath = await findCommand('ffmpeg')
  const ffprobePath = await findCommand('ffprobe')
  if (!ffmpegPath || !ffprobePath) return context.skip('FFmpeg tools are unavailable.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fixturePath = path.join(directory, 'fixture.mp4')
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=640x360:rate=30:duration=2',
    '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
    '-c:v', 'mpeg4', '-c:a', 'aac', '-shortest', '-y', fixturePath,
  ])
  const fixtureBytes = (await fs.stat(fixturePath)).size
  const argsPath = path.join(directory, 'args.json')
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--simulate')){process.stdout.write(JSON.stringify({requested_formats:[{filesize:${Math.floor(fixtureBytes / 2)}},{filesize_approx:${Math.ceil(fixtureBytes / 2)}}],duration:2}));process.exit(0)}fs.writeFileSync(${JSON.stringify(argsPath)},JSON.stringify(a));const o=a[a.indexOf('-o')+1];fs.copyFileSync(${JSON.stringify(fixturePath)},o);\n`)
  await fs.chmod(ytDlpPath, 0o700)

  const result = await downloadYoutubeMedia({
    ytDlpPath,
    ffmpegPath,
    ffprobePath,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    workingDirectory: path.join(directory, 'working', 'media'),
    maximumMediaBytes: 50 * 1_024 * 1_024,
    maximumDurationSeconds: 60,
  })

  const args = JSON.parse(await fs.readFile(argsPath, 'utf8')) as string[]
  assert.ok(args.includes('--ignore-config'))
  assert.ok(args.includes('--no-playlist'))
  assert.ok(args.includes('--no-update'))
  assert.equal(args.includes('--exec'), false)
  const selectedFormats = args[args.indexOf('-f') + 1]
  assert.match(requiredValue(selectedFormats, 'tests/integration/youtube-media-acquisition.test.ts:51'), /^best\[height<=1080\]\[ext=mp4\]\//)
  assert.match(requiredValue(selectedFormats, 'tests/integration/youtube-media-acquisition.test.ts:52'), /\/bestvideo\[height<=1080\]\[ext=mp4\]\[vcodec\^=avc1\]\+bestaudio\[ext=m4a\]\//)
  assert.equal(args[args.indexOf('--ffmpeg-location') + 1], ffmpegPath)
  assert.match(requiredValue(args[args.indexOf('-o') + 1], 'tests/integration/youtube-media-acquisition.test.ts:54'), /\.mp4$/)
  assert.equal(args.at(-1), 'https://www.youtube.com/watch?v=dQw4w9WgXcQ')
  assert.equal(result.width, 640)
  assert.equal(result.height, 360)
  assert.ok(result.durationSeconds > 1.9)
  assert.equal(result.diskPreflight.estimatedMediaBytes, fixtureBytes)
  assert.equal(result.diskPreflight.recheckedBeforeCommit, true)
  assert.equal(path.dirname(result.path), path.join(directory, 'working', 'media'))
})

test('media acquisition rejects a downloaded file without an audio stream', async (context) => {
  const ffmpegPath = await findCommand('ffmpeg')
  const ffprobePath = await findCommand('ffprobe')
  if (!ffmpegPath || !ffprobePath) return context.skip('FFmpeg tools are unavailable.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-no-audio-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fixturePath = path.join(directory, 'fixture.mp4')
  await execFileAsync(ffmpegPath, [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=64x64:rate=1:duration=2', '-an', '-c:v', 'mpeg4', '-y', fixturePath,
  ])
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  const fixtureBytes = (await fs.stat(fixturePath)).size
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--simulate'))process.stdout.write(JSON.stringify({filesize:${fixtureBytes},duration:2}));else fs.copyFileSync(${JSON.stringify(fixturePath)},a[a.indexOf('-o')+1]);\n`)
  await fs.chmod(ytDlpPath, 0o700)

  await assert.rejects(downloadYoutubeMedia({
    ytDlpPath,
    ffmpegPath,
    ffprobePath,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    workingDirectory: path.join(directory, 'working'),
    maximumMediaBytes: 10_000_000,
    maximumDurationSeconds: 60,
  }), /audio and video streams/i)
})

test('media acquisition retries a transient YouTube HTTP 403 once', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-retry-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const attemptsPath = path.join(directory, 'attempts')
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  const ffprobePath = path.join(directory, 'ffprobe.cjs')
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--simulate')){process.stdout.write(JSON.stringify({filesize:5,duration:2}));process.exit(0)}const n=fs.existsSync(${JSON.stringify(attemptsPath)})?Number(fs.readFileSync(${JSON.stringify(attemptsPath)},'utf8'))+1:1;fs.writeFileSync(${JSON.stringify(attemptsPath)},String(n));if(n===1){process.stderr.write('HTTP Error 403: Forbidden');process.exit(1)}fs.writeFileSync(a[a.indexOf('-o')+1],'video');\n`)
  await fs.writeFile(ffprobePath, `#!${process.execPath}\nprocess.stdout.write(JSON.stringify({format:{duration:'2',size:'5',format_name:'mp4'},streams:[{codec_type:'video',width:640,height:360},{codec_type:'audio'}]}));\n`)
  await Promise.all([ytDlpPath, ffprobePath].map((filePath) => fs.chmod(filePath, 0o700)))

  const result = await downloadYoutubeMedia({
    ytDlpPath,
    ffprobePath,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    workingDirectory: path.join(directory, 'working'),
    maximumMediaBytes: 1_000,
    maximumDurationSeconds: 60,
    diskSpaceBytes: async () => 1_000_000_000,
  })

  assert.equal(await fs.readFile(attemptsPath, 'utf8'), '2')
  assert.equal(result.byteLength, 5)
})

test('media acquisition rejects non-canonical URLs before executing yt-dlp', async () => {
  await assert.rejects(downloadYoutubeMedia({
    ytDlpPath: '/does/not/matter',
    ffprobePath: '/does/not/matter',
    url: 'https://youtu.be/dQw4w9WgXcQ',
    workingDirectory: '/tmp/not-used',
    maximumMediaBytes: 1,
    maximumDurationSeconds: 60,
  }), /canonical public YouTube video URL/i)
})

test('media acquisition rejects before download when declared formats exceed the media size limit', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-oversize-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  const downloadMarker = path.join(directory, 'download-started')
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--simulate')){process.stdout.write(JSON.stringify({requested_formats:[{filesize:3000000},{filesize_approx:2000000}],duration:2}));process.exit(0)}fs.writeFileSync(${JSON.stringify(downloadMarker)},'yes');\n`)
  await fs.chmod(ytDlpPath, 0o700)

  await assert.rejects(downloadYoutubeMedia({
    ytDlpPath,
    ffprobePath: '/unused/ffprobe',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    workingDirectory: path.join(directory, 'working'),
    maximumMediaBytes: 4_000_000,
    maximumDurationSeconds: 60,
    diskSpaceBytes: async () => 1_000_000_000,
  }), /exceeds the maximum media size/i)
  await assert.rejects(fs.access(downloadMarker))
})

test('media acquisition fails before download when declared bytes exceed available headroom', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-space-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  const downloadMarker = path.join(directory, 'download-started')
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--simulate'))process.stdout.write(JSON.stringify({filesize:1000000,duration:2}));else fs.writeFileSync(${JSON.stringify(downloadMarker)},'yes');\n`)
  await fs.chmod(ytDlpPath, 0o700)

  await assert.rejects(downloadYoutubeMedia({
    ytDlpPath,
    ffprobePath: '/unused/ffprobe',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    workingDirectory: path.join(directory, 'working'),
    maximumMediaBytes: 2_000_000,
    maximumDurationSeconds: 60,
    expectedFrameCount: 1,
    diskSpaceBytes: async () => 1,
  }), /not enough free disk space/i)
  await assert.rejects(fs.access(downloadMarker))
})

for (const metadataCase of [
  { name: 'approximate', metadata: { filesize_approx: 1_000_000, duration: 2 } },
  { name: 'maximum fallback', metadata: { duration: 2 } },
] as const) {
  test(`media acquisition uses the ${metadataCase.name} size estimate for disk preflight`, async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-estimate-'))
    context.after(() => fs.rm(directory, { recursive: true, force: true }))
    const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
    const downloadMarker = path.join(directory, 'download-started')
    await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--simulate'))process.stdout.write(${JSON.stringify(JSON.stringify(metadataCase.metadata))});else fs.writeFileSync(${JSON.stringify(downloadMarker)},'yes');\n`)
    await fs.chmod(ytDlpPath, 0o700)

    await assert.rejects(downloadYoutubeMedia({
      ytDlpPath,
      ffprobePath: '/unused/ffprobe',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      workingDirectory: path.join(directory, 'working'),
      maximumMediaBytes: 2_000_000,
      maximumDurationSeconds: 60,
      expectedFrameCount: 1,
      diskSpaceBytes: async () => 1,
    }), /not enough free disk space/i)
    await assert.rejects(fs.access(downloadMarker))
  })
}

test('media acquisition reports malformed yt-dlp metadata without exposing parser internals', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-metadata-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nprocess.stdout.write('warning without metadata');\n`)
  await fs.chmod(ytDlpPath, 0o700)

  await assert.rejects(downloadYoutubeMedia({
    ytDlpPath,
    ffprobePath: '/unused/ffprobe',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    workingDirectory: path.join(directory, 'working'),
    maximumMediaBytes: 2_000_000,
    maximumDurationSeconds: 60,
    diskSpaceBytes: async () => 1_000_000_000,
  }), (error: unknown) => {
    assert(error instanceof Error)
    assert.match(error.message, /metadata response was invalid/i)
    assert.notEqual(error.name, 'SyntaxError')
    return true
  })
})

test('aborting an active yt-dlp download removes partial media', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-abort-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--simulate')){process.stdout.write(JSON.stringify({filesize:10,duration:2}));process.exit(0)}const o=a[a.indexOf('-o')+1];fs.writeFileSync(o,'partial');setInterval(()=>{},1000);\n`)
  await fs.chmod(ytDlpPath, 0o700)
  const controller = new AbortController()
  const workingDirectory = path.join(directory, 'working')
  const running = downloadYoutubeMedia({
    ytDlpPath,
    ffprobePath: '/unused/ffprobe',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    workingDirectory,
    maximumMediaBytes: 2_000_000,
    maximumDurationSeconds: 60,
    diskSpaceBytes: async () => 1_000_000_000,
    signal: controller.signal,
  })
  setTimeout(() => controller.abort(), 50)

  await assert.rejects(running)
  assert.deepEqual(await fs.readdir(workingDirectory), [])
})

test('media acquisition aborts commit when free space drops after download', async (context) => {
  const ffmpegPath = await findCommand('ffmpeg')
  const ffprobePath = await findCommand('ffprobe')
  if (!ffmpegPath || !ffprobePath) return context.skip('FFmpeg tools are unavailable.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-space-drop-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fixturePath = path.join(directory, 'fixture.mp4')
  await execFileAsync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=64x64:rate=1:duration=2', '-an', '-c:v', 'mpeg4', '-y', fixturePath])
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  const fixtureBytes = (await fs.stat(fixturePath)).size
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--simulate'))process.stdout.write(JSON.stringify({filesize:${fixtureBytes},duration:2}));else fs.copyFileSync(${JSON.stringify(fixturePath)},a[a.indexOf('-o')+1]);\n`)
  await fs.chmod(ytDlpPath, 0o700)
  let checks = 0

  await assert.rejects(downloadYoutubeMedia({
    ytDlpPath,
    ffprobePath,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    workingDirectory: path.join(directory, 'working'),
    maximumMediaBytes: 10_000_000,
    maximumDurationSeconds: 60,
    expectedFrameCount: 1,
    diskSpaceBytes: async () => ++checks === 1 ? 1_000_000_000 : 0,
  }), /insufficient before the media commit/i)
  await assert.rejects(fs.access(path.join(directory, 'working', 'source-video.media')))
})

test('media acquisition reserves frame headroom when the real download exceeds its estimate', async (context) => {
  const ffmpegPath = await findCommand('ffmpeg')
  const ffprobePath = await findCommand('ffprobe')
  if (!ffmpegPath || !ffprobePath) return context.skip('FFmpeg tools are unavailable.')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-size-growth-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const fixturePath = path.join(directory, 'fixture.mp4')
  await execFileAsync(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi',
    '-i', 'testsrc2=size=64x64:rate=1:duration=2', '-an', '-c:v', 'mpeg4', '-y', fixturePath])
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--simulate'))process.stdout.write(JSON.stringify({filesize:1,duration:2}));else fs.copyFileSync(${JSON.stringify(fixturePath)},a[a.indexOf('-o')+1]);\n`)
  await fs.chmod(ytDlpPath, 0o700)
  const frameHeadroom = youtubeFrameHeadroomBytes(1)
  let checks = 0

  await assert.rejects(downloadYoutubeMedia({
    ytDlpPath,
    ffprobePath,
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    workingDirectory: path.join(directory, 'working'),
    maximumMediaBytes: 10_000_000,
    maximumDurationSeconds: 60,
    expectedFrameCount: 1,
    diskSpaceBytes: async () => ++checks === 1 ? frameHeadroom + 1 : frameHeadroom - 1,
  }), /insufficient before the media commit/i)
})

test('media acquisition cleans partial state when a video disappears after format inspection', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-deleted-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst a=process.argv.slice(2);if(a.includes('--simulate')){process.stdout.write(JSON.stringify({filesize:10,duration:2}));process.exit(0)}process.stderr.write('video unavailable');process.exit(1);\n`)
  await fs.chmod(ytDlpPath, 0o700)
  const workingDirectory = path.join(directory, 'working')

  await assert.rejects(downloadYoutubeMedia({
    ytDlpPath,
    ffprobePath: '/unused/ffprobe',
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    workingDirectory,
    maximumMediaBytes: 1_000,
    maximumDurationSeconds: 60,
    diskSpaceBytes: async () => 1_000_000_000,
  }), /video unavailable/i)
  assert.equal((await fs.readdir(workingDirectory)).length, 0)
})

const SIGNED_IN_COOKIE_HEADER =
  'SID=k1TvA-signed-in-session-value; __Secure-1PSID=k2TvB-secure-session-value'

test('media acquisition offers the exported profile cookies to the metadata and the download call', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-cookies-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  await downloadYoutubeMedia({
    ...cookieRecordingRequest(directory),
    ytDlpPath: await writeCookieRecordingYtDlp(directory),
    ffprobePath: await writeMediaProbe(directory),
    youtubeCookieHeader: async () => SIGNED_IN_COOKIE_HEADER,
  })

  assert.equal(
    await offeredCookieFile(directory, 'download'),
    await offeredCookieFile(directory, 'metadata'),
  )
})

test('the exported cookie jar is a private Netscape file outside the run bundle', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-cookie-jar-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  await downloadYoutubeMedia({
    ...cookieRecordingRequest(directory),
    ytDlpPath: await writeCookieRecordingYtDlp(directory),
    ffprobePath: await writeMediaProbe(directory),
    youtubeCookieHeader: async () => SIGNED_IN_COOKIE_HEADER,
  })

  const exportedPath = await offeredCookieFile(directory, 'download')
  const jar = JSON.parse(await fs.readFile(path.join(directory, 'download-jar.json'), 'utf8'))
  assert.equal(jar.mode, 0o600)
  assert.match(jar.contents, /^# Netscape HTTP Cookie File\n/)
  assert.match(jar.contents, /^\.youtube\.com\tTRUE\t\/\tTRUE\t\d{10}\tSID\tk1TvA-signed-in-session-value$/m)
  assert.match(jar.contents, /^\.youtube\.com\tTRUE\t\/\tTRUE\t\d{10}\t__Secure-1PSID\tk2TvB-secure-session-value$/m)
  assert.ok(path.relative(directory, exportedPath).startsWith('..'))
})

test('the exported cookie file never outlives a download that succeeds, fails, or is cancelled', async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-cookie-cleanup-'))
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const completed = await makeDirectory(root, 'completed')
  const failed = await makeDirectory(root, 'failed')
  const cancelled = await makeDirectory(root, 'cancelled')
  const controller = new AbortController()

  await downloadYoutubeMedia({
    ...cookieRecordingRequest(completed),
    ytDlpPath: await writeCookieRecordingYtDlp(completed),
    ffprobePath: await writeMediaProbe(completed),
    youtubeCookieHeader: async () => SIGNED_IN_COOKIE_HEADER,
  })
  await assert.rejects(downloadYoutubeMedia({
    ...cookieRecordingRequest(failed),
    ytDlpPath: await writeCookieRecordingYtDlp(failed, { download: 'fail' }),
    ffprobePath: await writeMediaProbe(failed),
    youtubeCookieHeader: async () => SIGNED_IN_COOKIE_HEADER,
  }))
  const cancelling = downloadYoutubeMedia({
    ...cookieRecordingRequest(cancelled),
    ytDlpPath: await writeCookieRecordingYtDlp(cancelled, { download: 'hang' }),
    ffprobePath: await writeMediaProbe(cancelled),
    youtubeCookieHeader: async () => SIGNED_IN_COOKIE_HEADER,
    signal: controller.signal,
  })
  await waitForRecordedCall(cancelled, 'download')
  controller.abort()
  await assert.rejects(cancelling)

  await assert.rejects(fs.access(await offeredCookieFile(completed, 'download')))
  await assert.rejects(fs.access(await offeredCookieFile(failed, 'download')))
  await assert.rejects(fs.access(await offeredCookieFile(cancelled, 'download')))
})

test('a failed download surfaces neither the exported cookie values nor the cookie file path', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-cookie-leak-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  let surfacedMessage = ''

  await assert.rejects(downloadYoutubeMedia({
    ...cookieRecordingRequest(directory),
    ytDlpPath: await writeCookieRecordingYtDlp(directory, { download: 'fail' }),
    ffprobePath: await writeMediaProbe(directory),
    youtubeCookieHeader: async () => SIGNED_IN_COOKIE_HEADER,
  }), (error: unknown) => {
    assert.ok(error instanceof Error)
    surfacedMessage = error.message
    return true
  })

  const exportedPath = await offeredCookieFile(directory, 'download')
  assert.match(surfacedMessage, /YouTube media process failed/)
  assert.equal(surfacedMessage.includes(exportedPath), false)
  assert.equal(surfacedMessage.includes('k1TvA-signed-in-session-value'), false)
  assert.equal(surfacedMessage.includes('k2TvB-secure-session-value'), false)
})

for (const profileCase of [
  { name: 'no profile reader is wired', read: undefined },
  { name: 'the profile holds no YouTube sign-in', read: async () => undefined },
  {
    name: 'the profile cannot be read',
    read: async () => { throw new Error('Chrome could not be started.') },
  },
] as const) {
  test(`media acquisition runs yt-dlp with no cookie argument when ${profileCase.name}`, async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-no-cookies-'))
    context.after(() => fs.rm(directory, { recursive: true, force: true }))

    await downloadYoutubeMedia({
      ...cookieRecordingRequest(directory),
      ytDlpPath: await writeCookieRecordingYtDlp(directory),
      ffprobePath: await writeMediaProbe(directory),
      ...(profileCase.read ? { youtubeCookieHeader: profileCase.read } : {}),
    })

    for (const call of ['metadata', 'download'] as const) {
      const args = JSON.parse(await fs.readFile(path.join(directory, `${call}-args.json`), 'utf8'))
      assert.equal(args.includes('--cookies'), false)
    }
    await assert.rejects(fs.access(path.join(directory, 'download-jar.json')))
  })
}

for (const sessionCase of [
  {
    name: 'the profile is signed in',
    header: SIGNED_IN_COOKIE_HEADER,
    usedProfileSession: true,
    offersJar: true,
  },
  {
    // What a profile that has only watched YouTube while signed out holds.
    // The jar is still offered, and yt-dlp still meets the bot check with it.
    name: 'the profile holds only consent and preference cookies',
    header: 'VISITOR_INFO1_LIVE=k3TvC-visitor-value; YSC=k4TvD-session-value; CONSENT=YES+1; PREF=tz.UTC',
    usedProfileSession: false,
    offersJar: true,
  },
  {
    name: 'the profile holds no YouTube cookies',
    header: undefined,
    usedProfileSession: false,
    offersJar: false,
  },
] as const) {
  test(`a download reports no profile session unless it presented a sign-in: ${sessionCase.name}`, async (context) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-session-record-'))
    context.after(() => fs.rm(directory, { recursive: true, force: true }))

    const media = await downloadYoutubeMedia({
      ...cookieRecordingRequest(directory),
      ytDlpPath: await writeCookieRecordingYtDlp(directory),
      ffprobePath: await writeMediaProbe(directory),
      youtubeCookieHeader: async () => sessionCase.header,
    })

    assert.equal(media.usedProfileSession, sessionCase.usedProfileSession)
    assert.equal(
      await fs.access(path.join(directory, 'download-jar.json')).then(() => true, () => false),
      sessionCase.offersJar,
    )
  })
}

test('a download that fails reports the profile session it presented', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-session-failed-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const reported: boolean[] = []

  await assert.rejects(downloadYoutubeMedia({
    ...cookieRecordingRequest(directory),
    ytDlpPath: await writeCookieRecordingYtDlp(directory, { download: 'fail' }),
    ffprobePath: await writeMediaProbe(directory),
    youtubeCookieHeader: async () => SIGNED_IN_COOKIE_HEADER,
    onProfileSession: (usedProfileSession) => reported.push(usedProfileSession),
  }))

  assert.deepEqual(reported, [true])
})

test('a cancelled download reads no profile cookies and exports no jar', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-cookie-cancelled-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const controller = new AbortController()
  let profileReads = 0
  controller.abort()

  await assert.rejects(downloadYoutubeMedia({
    ...cookieRecordingRequest(directory),
    ytDlpPath: await writeCookieRecordingYtDlp(directory),
    ffprobePath: await writeMediaProbe(directory),
    youtubeCookieHeader: async () => {
      profileReads += 1
      return SIGNED_IN_COOKIE_HEADER
    },
    signal: controller.signal,
  }))

  assert.equal(profileReads, 0)
})

test('a download cancelled while the profile is read hands the read the cancellation', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-cookie-cancelled-read-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const controller = new AbortController()
  let readSawCancellation: boolean | undefined

  await assert.rejects(downloadYoutubeMedia({
    ...cookieRecordingRequest(directory),
    ytDlpPath: await writeCookieRecordingYtDlp(directory),
    ffprobePath: await writeMediaProbe(directory),
    // The operator presses Stop while a stopped profile is starting, which is
    // the whole of the read now that it may launch Chrome.
    youtubeCookieHeader: async ({ signal }) => {
      controller.abort()
      readSawCancellation = signal?.aborted
      return undefined
    },
    signal: controller.signal,
  }))

  assert.equal(readSawCancellation, true)
  await assert.rejects(fs.access(path.join(directory, 'download-jar.json')))
})

test('a temporary area that cannot hold the jar leaves the download running without cookies', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-cookie-unwritable-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const temporaryRoot = await makeDirectory(directory, 'read-only-jars')
  await fs.writeFile(path.join(directory, 'download.mjs'), downloadHelperSource({
    directory,
    ytDlpPath: await writeCookieRecordingYtDlp(directory),
    ffprobePath: await writeMediaProbe(directory),
    tail: 'await download',
  }))
  await fs.chmod(temporaryRoot, 0o500)

  await execFileAsync(process.execPath, ['--import', 'tsx', path.join(directory, 'download.mjs')], {
    cwd: process.cwd(),
    // tsx caches transforms under the temporary root, which this test seals.
    env: { ...process.env, TMPDIR: temporaryRoot, TSX_DISABLE_CACHE: '1' },
  })

  for (const call of ['metadata', 'download'] as const) {
    const args = JSON.parse(await fs.readFile(path.join(directory, `${call}-args.json`), 'utf8'))
    assert.equal(args.includes('--cookies'), false)
  }
})

test('a cookie jar that cannot be wiped does not fail a download that succeeded', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-cookie-wipe-'))
  // The stub seals the jar's own directory, so the wipe in the `finally` meets
  // a rejection that `force` does not suppress.
  const ytDlpPath = await writeCookieRecordingYtDlp(directory, { sealJarDirectory: true })
  context.after(async () => {
    await releaseSealedJarDirectory(directory)
    await fs.rm(directory, { recursive: true, force: true })
  })

  const media = await downloadYoutubeMedia({
    ...cookieRecordingRequest(directory),
    ytDlpPath,
    ffprobePath: await writeMediaProbe(directory),
    youtubeCookieHeader: async () => SIGNED_IN_COOKIE_HEADER,
  })

  assert.equal(path.basename(media.path), 'source-video.mp4')
})

test('the exported cookie jar does not outlive a process that quits mid-download', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-media-cookie-exit-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const temporaryRoot = await makeDirectory(directory, 'jars')
  await fs.writeFile(path.join(directory, 'quit-during-download.mjs'), downloadHelperSource({
    directory,
    ytDlpPath: await writeCookieRecordingYtDlp(directory, { download: 'hang' }),
    ffprobePath: await writeMediaProbe(directory),
    // The hanging stub records the jar it was handed. Quitting then leaves the
    // pending promise, and the `finally` that wipes the jar, unreachable.
    //
    // The stub moves that record onto its name with rename(2), so the name
    // appearing is the record being complete rather than merely created. The
    // quit below kills the stub's process group, and a watcher that woke at
    // open(O_CREAT) — which is when Linux reports one — would take the writer
    // down before a byte landed and leave an empty file to read back.
    tail: [
      'void download.catch(() => undefined)',
      `for await (const change of fs.watch(${JSON.stringify(directory)})) {`,
      "  if (change.filename === 'download-jar.json') break",
      '}',
      'process.exit(0)',
    ].join('\n'),
  }))

  await execFileAsync(
    process.execPath,
    ['--import', 'tsx', path.join(directory, 'quit-during-download.mjs')],
    // tsx caches transforms under the temporary root, which this test reads back.
    { cwd: process.cwd(), env: { ...process.env, TMPDIR: temporaryRoot, TSX_DISABLE_CACHE: '1' } },
  )

  const jar = JSON.parse(await fs.readFile(path.join(directory, 'download-jar.json'), 'utf8'))
  await assert.rejects(fs.access(jar.path))
  assert.deepEqual(await fs.readdir(temporaryRoot), [])
})

function cookieRecordingRequest(directory: string) {
  return {
    url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    workingDirectory: path.join(directory, 'working'),
    maximumMediaBytes: 1_000,
    maximumDurationSeconds: 60,
    diskSpaceBytes: async () => 1_000_000_000,
  } as const
}

async function makeDirectory(root: string, name: string): Promise<string> {
  const directory = path.join(root, name)
  await fs.mkdir(directory, { recursive: true })
  return directory
}

/**
 * Source for a helper that runs one download in its own process, so a test can
 * hand that process a temporary area it fully owns. `tail` decides what the
 * process does with the pending download.
 */
function downloadHelperSource(input: {
  readonly directory: string
  readonly ytDlpPath: string
  readonly ffprobePath: string
  readonly tail: string
}): string {
  const moduleUrl = pathToFileURL(
    path.resolve('domains/youtube/youtube-media-acquisition.ts'),
  ).href
  return [
    "import * as fs from 'node:fs/promises'",
    `import { downloadYoutubeMedia } from ${JSON.stringify(moduleUrl)}`,
    '',
    'const download = downloadYoutubeMedia({',
    `  ...${JSON.stringify(cookieRecordingRequest(input.directory))},`,
    '  diskSpaceBytes: async () => 1_000_000_000,',
    `  ytDlpPath: ${JSON.stringify(input.ytDlpPath)},`,
    `  ffprobePath: ${JSON.stringify(input.ffprobePath)},`,
    `  youtubeCookieHeader: async () => ${JSON.stringify(SIGNED_IN_COOKIE_HEADER)},`,
    '})',
    input.tail,
    '',
  ].join('\n')
}

/** Unseals a jar directory the stub locked, so the test's own cleanup can run. */
async function releaseSealedJarDirectory(directory: string): Promise<void> {
  const jar = JSON.parse(await fs.readFile(path.join(directory, 'download-jar.json'), 'utf8'))
  const jarDirectory = path.dirname(requiredValue(
    jar.path,
    'tests/integration/youtube-media-acquisition.test.ts:sealed-jar',
  ))
  await fs.chmod(jarDirectory, 0o700)
  await fs.rm(jarDirectory, { recursive: true, force: true })
}

/** Resolves the moment the stub records `call`, so nothing waits on a clock. */
async function waitForRecordedCall(
  directory: string,
  call: 'metadata' | 'download',
): Promise<void> {
  const fileName = `${call}-args.json`
  const watching = new AbortController()
  try {
    const changes = fs.watch(directory, { signal: watching.signal })
    // The watcher starts first so a record written right now is still observed.
    if (await fs.access(path.join(directory, fileName)).then(() => true, () => false)) return
    for await (const change of changes) {
      if (change.filename === fileName) return
    }
  } finally {
    watching.abort()
  }
}

async function offeredCookieFile(
  directory: string,
  call: 'metadata' | 'download',
): Promise<string> {
  const args = JSON.parse(await fs.readFile(path.join(directory, `${call}-args.json`), 'utf8'))
  const index = args.indexOf('--cookies')
  assert.notEqual(index, -1, `yt-dlp ran the ${call} call without --cookies`)
  return requiredValue(args[index + 1], `tests/integration/youtube-media-acquisition.test.ts:${call}`)
}

async function findCommand(command: string): Promise<string | undefined> {
  try {
    return (await execFileAsync('which', [command])).stdout.trim() || undefined
  } catch {
    return undefined
  }
}

test('large unused video metadata does not prevent downloading the manual source', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-large-metadata-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  const ffprobePath = await writeMediaProbe(directory)
  // The external CLI's print mode selects fields before writing its output;
  // the full information record can exceed the process output safety bound.
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a.includes('--simulate')){const needed={filesize:5,duration:2};process.stdout.write(JSON.stringify(a.includes('--print')?needed:{...needed,automatic_captions:'x'.repeat(5*1024*1024)}))}else{fs.writeFileSync(a[a.indexOf('-o')+1],'video')}\n`)
  await fs.chmod(ytDlpPath, 0o700)

  const result = await downloadYoutubeMedia({
    ytDlpPath, ffprobePath,
    url: 'https://www.youtube.com/watch?v=OLqP8jxJ0Wc',
    workingDirectory: path.join(directory, 'media'),
    maximumMediaBytes: 1_000, maximumDurationSeconds: 60,
    diskSpaceBytes: async () => 1_000_000_000,
  })

  assert.equal(result.byteLength, 5)
})

test('media download supplies the running Node runtime for YouTube JavaScript challenges', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-javascript-runtime-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const ytDlpPath = path.join(directory, 'yt-dlp.cjs')
  const ffprobePath = await writeMediaProbe(directory)
  // A JavaScript challenge cannot yield usable download URLs without a
  // runtime. This CLI fixture refuses both metadata and download without it.
  await fs.writeFile(ytDlpPath, `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[a.indexOf('--js-runtimes')+1]!==${JSON.stringify(`node:${process.execPath}`)}){process.stderr.write('No supported JavaScript runtime');process.exit(1)}if(a.includes('--simulate'))process.stdout.write(JSON.stringify({filesize:5,duration:2}));else fs.writeFileSync(a[a.indexOf('-o')+1],'video');\n`)
  await fs.chmod(ytDlpPath, 0o700)

  const result = await downloadYoutubeMedia({
    ytDlpPath, ffprobePath,
    url: 'https://www.youtube.com/watch?v=OLqP8jxJ0Wc',
    workingDirectory: path.join(directory, 'media'),
    maximumMediaBytes: 1_000, maximumDurationSeconds: 60,
    diskSpaceBytes: async () => 1_000_000_000,
  })

  assert.equal(result.byteLength, 5)
})
