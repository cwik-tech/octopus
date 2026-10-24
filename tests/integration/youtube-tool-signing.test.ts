import { requiredValue } from '../../core/required-value.js'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import { resolveYoutubeBinaries } from '../../domains/youtube/youtube-binary-resolver.js'
import {
  signStagedYoutubeTools,
  type YoutubeToolCodesign,
  type YoutubeToolCodesignInvocation,
} from '../../scripts/sign-youtube-tools.js'
import { verifyPackagedYoutubeTools } from '../../scripts/verify-packaged-youtube-tools.js'

const signingIdentity = 'Developer ID Application: Test Signer (TEAMID0000)'
const otherIdentity = 'Developer ID Application: Other Signer (TEAMID9999)'
const appTeamIdentifier = 'TEAMID0000'

const fixtureTools = [
  ['yt-dlp', '2026.07.04', "#!/bin/sh\necho '2026.07.04'\n"],
  ['ffmpeg', '9.0.1', "#!/bin/sh\nif [ \"$1\" = \"-hide_banner\" ]; then echo 'signalstats blurdetect'; else echo 'ffmpeg version 9.0.1'; fi\n"],
  ['ffprobe', '9.0.1', "#!/bin/sh\necho 'ffprobe version 9.0.1'\n"],
] as const

test('signing the staged tools rewrites the manifest so the resolver accepts the signed bytes', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const { directory, target } = await stageFixtureBundle(context)
  const before = await readBundle(target)

  const result = await signStagedYoutubeTools({
    directory: target,
    environment: { YOUTUBE_TOOLS_SIGN_IDENTITY: signingIdentity },
    codesign: appendSignatureBytes,
  })

  assert.equal(result.status, 'signed')
  assert.equal(result.identity, signingIdentity)
  const after = await readBundle(target)
  assert.notEqual(sha256(after.ffprobe), sha256(before.ffprobe))
  const manifest = await readManifest(target)
  const ffprobe = requiredValue(manifest.ffprobe, 'signed ffprobe manifest entry')
  assert.equal(requiredValue(manifest['yt-dlp'], 'signed yt-dlp manifest entry').sha256, sha256(after.ytDlp))
  assert.equal(requiredValue(manifest.ffmpeg, 'signed ffmpeg manifest entry').sha256, sha256(after.ffmpeg))
  assert.equal(ffprobe.sha256, sha256(after.ffprobe))
  assert.equal(ffprobe.file, 'ffprobe')
  assert.equal(ffprobe.version, '9.0.1')
  assert.equal(ffprobe.sourceSha256, sha256(before.ffprobe))
  const resolved = await resolveYoutubeBinaries({ developmentDirectory: directory })
  assert.equal(resolved.ytDlp.version, '2026.07.04')
  assert.equal(resolved.ffmpeg.version, '9.0.1')
  assert.equal(resolved.ffprobe.version, '9.0.1')
})

test('signing applies the entitlements electron-builder gives a nested binary', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const { target } = await stageFixtureBundle(context)
  const signer = recordingSigner()

  await signStagedYoutubeTools({
    directory: target,
    environment: { YOUTUBE_TOOLS_SIGN_IDENTITY: signingIdentity },
    codesign: signer.codesign,
  })

  assert.equal(signer.invocations.length, 3)
  for (const invocation of signer.invocations) {
    const args = invocation.args
    assert.deepEqual(args.slice(0, 4), ['--force', '--options', 'runtime', '--timestamp'])
    assert.equal(args.at(-1), invocation.filePath)
    const entitlementsIndex = args.indexOf('--entitlements')
    assert.notEqual(entitlementsIndex, -1, 'codesign must receive --entitlements')
    // app-builder-lib hands every path that is not the .app itself the same
    // entitlements template, see getOptionsForFile in
    // node_modules/app-builder-lib/out/mac/MacTargetHelper.js. Hardened runtime
    // without them turns on library validation, which kills the PyInstaller
    // yt-dlp build.
    const entitlements = await fs.readFile(
      requiredValue(args[entitlementsIndex + 1], 'codesign entitlements path'),
      'utf8',
    )
    assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/)
  }
})

test('signing refuses a staged tool whose bytes changed after staging', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const { target } = await stageFixtureBundle(context)
  await fs.appendFile(path.join(target, 'ffmpeg'), "echo 'tampered'\n")
  const before = await readBundle(target)
  const signer = recordingSigner()

  await assert.rejects(
    signStagedYoutubeTools({
      directory: target,
      environment: { YOUTUBE_TOOLS_SIGN_IDENTITY: signingIdentity },
      codesign: signer.codesign,
    }),
    /Staged ffmpeg does not match the recorded checksum/,
  )

  assert.equal(signer.invocations.length, 0, 'no tool may be signed once one checksum fails')
  assert.deepEqual(await readBundle(target), before)
})

test('signing without a staged bundle reports the missing bundle instead of a skip', async (context) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-tools-sign-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))

  await assert.rejects(
    signStagedYoutubeTools({
      directory: path.join(directory, 'never-staged'),
      environment: {},
      listCodesigningIdentities: async () => [],
      codesign: appendSignatureBytes,
    }),
    /No staged YouTube tools found/,
  )
})

test('a missing signing identity leaves the staged bundle untouched', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const { target } = await stageFixtureBundle(context)
  const before = await readBundle(target)

  const result = await signStagedYoutubeTools({
    directory: target,
    environment: {},
    listCodesigningIdentities: async () => [],
    codesign: appendSignatureBytes,
  })

  assert.equal(result.status, 'skipped')
  assert.equal(result.identity, null)
  assert.match(result.message, /identity/i)
  const after = await readBundle(target)
  assert.deepEqual(after, before)
})

test('CSC_NAME supplies the identity when YOUTUBE_TOOLS_SIGN_IDENTITY is unset', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const { target } = await stageFixtureBundle(context)

  const result = await signStagedYoutubeTools({
    directory: target,
    environment: { CSC_NAME: otherIdentity },
    listCodesigningIdentities: async () => [],
    codesign: appendSignatureBytes,
  })

  assert.equal(result.status, 'signed')
  assert.equal(result.identity, otherIdentity)
})

test('one Developer ID Application identity among other certificates signs the bundle', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const { target } = await stageFixtureBundle(context)

  const result = await signStagedYoutubeTools({
    directory: target,
    environment: {},
    listCodesigningIdentities: async () => [
      'Apple Development: Test Signer (TEAMID0000)',
      signingIdentity,
      'WindowSwitcher Dev',
      signingIdentity,
    ],
    codesign: appendSignatureBytes,
  })

  assert.equal(result.status, 'signed')
  assert.equal(result.identity, signingIdentity)
})

test('two Developer ID Application identities fail loudly instead of shipping unsigned tools', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const { target } = await stageFixtureBundle(context)
  const before = await readBundle(target)

  await assert.rejects(
    signStagedYoutubeTools({
      directory: target,
      environment: {},
      listCodesigningIdentities: async () => [signingIdentity, otherIdentity],
      codesign: appendSignatureBytes,
    }),
    /YOUTUBE_TOOLS_SIGN_IDENTITY/,
  )

  assert.deepEqual(await readBundle(target), before)
})

test('a CSC_LINK certificate this process cannot see fails loudly', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const { target } = await stageFixtureBundle(context)
  const before = await readBundle(target)

  await assert.rejects(
    signStagedYoutubeTools({
      directory: target,
      environment: { CSC_LINK: 'https://example.invalid/certificate.p12' },
      listCodesigningIdentities: async () => [],
      codesign: appendSignatureBytes,
    }),
    /YOUTUBE_TOOLS_SIGN_IDENTITY/,
  )

  assert.deepEqual(await readBundle(target), before)
})

test('the packaged signIgnore pattern skips the bundled tools and not the app executable', async () => {
  const manifest: unknown = JSON.parse(await fs.readFile(path.resolve('package.json'), 'utf8'))
  const patterns = readSignIgnorePatterns(manifest)
  const toolsDirectory = readExtraResourceTarget(manifest, 'build/youtube-tools')
  const appPath = '/Users/builder/release/mac-arm64/Octopus.app'
  const bundledToolPath = `${appPath}/Contents/Resources/${toolsDirectory}/darwin-arm64/yt-dlp`
  const appExecutablePath = `${appPath}/Contents/MacOS/Octopus`

  assert.ok(patterns.length > 0, 'build.mac.signIgnore must list at least one pattern.')
  // app-builder-lib compiles every signIgnore entry with `new RegExp(entry)` and
  // skips a file whose absolute path matches, see
  // node_modules/app-builder-lib/out/mac/MacTargetHelper.js buildSignOptions.
  const skips = (filePath: string): boolean =>
    patterns.some((pattern) => new RegExp(pattern).test(filePath))
  assert.equal(skips(bundledToolPath), true)
  assert.equal(skips(appExecutablePath), false)
})

test('packaged verification accepts tools signed like the app', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const appPath = await stagePackagedFixtureApp(context, process.arch)

  const message = await verifyPackagedYoutubeTools({
    appPath,
    inspectSignature: async () => ({
      signed: true,
      teamIdentifier: appTeamIdentifier,
      hardenedRuntime: true,
    }),
  })

  assert.match(message, /2026\.07\.04, 9\.0\.1, 9\.0\.1/)
  assert.ok(message.includes(appPath))
})

test('packaged verification rejects a bundled tool the app team did not sign', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const appPath = await stagePackagedFixtureApp(context, process.arch)

  await assert.rejects(
    verifyPackagedYoutubeTools({
      appPath,
      inspectSignature: async (filePath) => filePath === appPath
        ? { signed: true, teamIdentifier: appTeamIdentifier, hardenedRuntime: true }
        : { signed: false, teamIdentifier: null, hardenedRuntime: false },
    }),
    /yt-dlp is not code signed/,
  )
})

test('packaged verification rejects a bundled tool without the hardened runtime', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const appPath = await stagePackagedFixtureApp(context, process.arch)

  await assert.rejects(
    verifyPackagedYoutubeTools({
      appPath,
      inspectSignature: async (filePath) => filePath === appPath
        ? { signed: true, teamIdentifier: appTeamIdentifier, hardenedRuntime: true }
        : { signed: true, teamIdentifier: appTeamIdentifier, hardenedRuntime: false },
    }),
    /yt-dlp is not signed with the hardened runtime/,
  )
})

test('packaged verification leaves an unsigned development build alone', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const appPath = await stagePackagedFixtureApp(context, process.arch)

  const message = await verifyPackagedYoutubeTools({
    appPath,
    inspectSignature: async () => ({ signed: false, teamIdentifier: null, hardenedRuntime: false }),
  })

  assert.match(message, /2026\.07\.04/)
})

test('packaged verification reads the architecture the rest of the chain staged', async (context) => {
  if (process.platform === 'win32') return context.skip('Fixture executables use POSIX scripts.')
  const stagedArch = process.arch === 'x64' ? 'arm64' : 'x64'
  const appPath = await stagePackagedFixtureApp(context, stagedArch)

  const message = await verifyPackagedYoutubeTools({
    appPath,
    environment: { YOUTUBE_TOOLS_TARGET_ARCH: stagedArch },
    inspectSignature: async () => ({ signed: false, teamIdentifier: null, hardenedRuntime: false }),
  })

  assert.match(message, /2026\.07\.04/)
})

async function stageFixtureBundle(
  context: TestContext,
): Promise<{ readonly directory: string; readonly target: string }> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-tools-sign-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const target = path.join(directory, `${process.platform}-${process.arch}`)
  await writeFixtureBundle(target, process.arch)
  return { directory, target }
}

async function stagePackagedFixtureApp(context: TestContext, arch: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-tools-packaged-'))
  context.after(() => fs.rm(directory, { recursive: true, force: true }))
  const appPath = path.join(directory, 'Octopus.app')
  await writeFixtureBundle(
    path.join(appPath, 'Contents', 'Resources', 'youtube-tools', `${process.platform}-${arch}`),
    arch,
  )
  return appPath
}

async function writeFixtureBundle(target: string, arch: string): Promise<void> {
  await fs.mkdir(target, { recursive: true })
  const tools: Record<string, { file: string; version: string; sha256: string }> = {}
  for (const [name, version, script] of fixtureTools) {
    const filePath = path.join(target, name)
    await fs.writeFile(filePath, script)
    await fs.chmod(filePath, 0o755)
    tools[name] = { file: name, version, sha256: sha256(await fs.readFile(filePath)) }
  }
  await fs.writeFile(path.join(target, 'manifest.json'), `${JSON.stringify({
    binaryManifestSchemaVersion: 1, platform: process.platform, arch, tools,
  }, null, 2)}\n`)
}

const appendSignatureBytes: YoutubeToolCodesign = async (invocation) => {
  await fs.appendFile(invocation.filePath, `# signed by ${invocation.identity}\n`)
}

function recordingSigner(): {
  readonly invocations: readonly YoutubeToolCodesignInvocation[]
  readonly codesign: YoutubeToolCodesign
} {
  const invocations: YoutubeToolCodesignInvocation[] = []
  return {
    invocations,
    codesign: async (invocation) => {
      invocations.push(invocation)
      await appendSignatureBytes(invocation)
    },
  }
}

async function readBundle(target: string): Promise<{
  readonly ytDlp: Buffer
  readonly ffmpeg: Buffer
  readonly ffprobe: Buffer
  readonly manifest: Buffer
}> {
  const [ytDlp, ffmpeg, ffprobe, manifest] = await Promise.all([
    fs.readFile(path.join(target, 'yt-dlp')),
    fs.readFile(path.join(target, 'ffmpeg')),
    fs.readFile(path.join(target, 'ffprobe')),
    fs.readFile(path.join(target, 'manifest.json')),
  ])
  return { ytDlp, ffmpeg, ffprobe, manifest }
}

async function readManifest(target: string): Promise<Record<string, {
  readonly file: string
  readonly version: string
  readonly sha256: string
  readonly sourceSha256: string
}>> {
  const parsed: unknown = JSON.parse(await fs.readFile(path.join(target, 'manifest.json'), 'utf8'))
  const tools = isRecord(parsed) ? parsed.tools : undefined
  if (!isRecord(tools)) throw new Error('Staged manifest has no tools.')
  const records: Record<string, {
    file: string
    version: string
    sha256: string
    sourceSha256: string
  }> = {}
  for (const [name, record] of Object.entries(tools)) {
    if (
      !isRecord(record) ||
      typeof record.file !== 'string' ||
      typeof record.version !== 'string' ||
      typeof record.sha256 !== 'string' ||
      typeof record.sourceSha256 !== 'string'
    ) throw new Error(`Staged manifest entry ${name} is invalid.`)
    records[name] = {
      file: record.file,
      version: record.version,
      sha256: record.sha256,
      sourceSha256: record.sourceSha256,
    }
  }
  return records
}

function readSignIgnorePatterns(value: unknown): readonly string[] {
  const build = isRecord(value) ? value.build : undefined
  const mac = isRecord(build) ? build.mac : undefined
  const signIgnore = isRecord(mac) ? mac.signIgnore : undefined
  if (typeof signIgnore === 'string') return [signIgnore]
  if (!Array.isArray(signIgnore)) return []
  return signIgnore.filter((entry): entry is string => typeof entry === 'string')
}

function readExtraResourceTarget(value: unknown, from: string): string {
  const build = isRecord(value) ? value.build : undefined
  const extraResources = isRecord(build) ? build.extraResources : undefined
  if (!Array.isArray(extraResources)) throw new Error('build.extraResources must be an array.')
  for (const entry of extraResources) {
    if (isRecord(entry) && entry.from === from && typeof entry.to === 'string') return entry.to
  }
  throw new Error(`build.extraResources has no entry copying ${from}.`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
