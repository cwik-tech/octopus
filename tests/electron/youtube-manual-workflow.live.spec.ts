import { parseYoutubeManualPlan } from '../../domains/youtube/youtube-manual-schema.js'
import type { YoutubeDocumentRequest } from '../../contracts/youtube-document-request.js'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { _electron as electron, expect, test, type Page } from '@playwright/test'
import JSZip from 'jszip'

import type { PostChatMessageResponse, SessionTask } from '../../contracts/sessions.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { resolveYoutubeBinaries } from '../../domains/youtube/youtube-binary-resolver.js'
import { YOUTUBE_GEMINI_MODEL } from '../../domains/youtube/youtube-settings.js'
import type { YoutubeSelectedFrame } from '../../domains/youtube/youtube-frame-types.js'
import type {
  YoutubeManualPlan,
  YoutubeVideoAnalysis,
} from '../../domains/youtube/youtube-manual-types.js'
import { seedDesktopProjectRoot } from '../../electron/project-root.js'
import { loadDotEnv } from '../../core/env-loader.js'
import { startYoutubeManualProviderFixture } from '../support/youtube-manual-provider-fixture.js'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)
const electronExecutablePath = require('electron') as string
const execFileAsync = promisify(execFile)
loadDotEnv(process.env.PIPELINE_LIVE_ENV_DIR?.trim() || repoRoot)

const capabilityId = 'youtube-manual-electron'
const videoUrl = process.env.PIPELINE_LIVE_YOUTUBE_MANUAL_URL?.trim() ||
  'https://www.youtube.com/watch?v=EPeDTRNKAVo'
const videoId = youtubeVideoId(videoUrl)
const requiredCapabilities = new Set((process.env.PIPELINE_LIVE_REQUIRE ?? '')
  .split(',').map((value) => value.trim()).filter(Boolean))
const geminiCredential = await resolveGeminiCredential()
const liveCapability = await resolveLiveCapability()

const documentRequest: YoutubeDocumentRequest = { formats: ['markdown'], purpose: 'takeaways', instructions: 'Watch this video and create an MD file with print screens and main takeaways, and explain what it is about.' }

test('an MD-only takeaway request delivers the real illustrated Gemini document in Canvas without Word', async ({}, testInfo) => {
  requireOrSkipLiveCapability()
  test.setTimeout(20 * 60_000)

  const workspacePath = testInfo.outputPath('youtube-manual-workspace')
  const projectRootPath = testInfo.outputPath('youtube-manual-project')
  const userDataPath = testInfo.outputPath('youtube-manual-user-data')
  await Promise.all([
    fs.mkdir(workspacePath, { recursive: true }),
    fs.mkdir(projectRootPath, { recursive: true }),
    fs.mkdir(userDataPath, { recursive: true }),
  ])
  await prepareDeterministicWorkerProject(projectRootPath)
  // `requireOrSkipLiveCapability` has already stopped a run with no Gemini
  // credential, so this never throws; it tells the compiler what it checked.
  if (geminiCredential.kind === 'missing') {
    throw new Error('Gemini is not configured.')
  }
  const providerFixture = await startYoutubeManualProviderFixture({ videoId, videoUrl, documentRequest,
    ...(process.env.PIPELINE_LIVE_YOUTUBE_SAVED_PLAN_PATH ? { beforePrepare: async () => {
      // Reuse only source metadata from a previous real capture when YouTube's
      // public HTTP endpoint is unavailable. Gemini analysis and browser images
      // remain fresh; the original user's completed bundle is never modified.
      const plan = parseYoutubeManualPlan(JSON.parse(await fs.readFile(process.env.PIPELINE_LIVE_YOUTUBE_SAVED_PLAN_PATH ?? '', 'utf8')))
      expect(plan.video.videoId).toBe(videoId)
      const captures = await findNamedFiles(workspacePath, 'youtube-manifest.json')
      expect(captures).toHaveLength(1)
      const capturePath = captures[0]
      if (!capturePath) throw new Error('Live capture assignment is missing.')
      const assignment = path.resolve(path.dirname(capturePath), '..')
      const manualRunId = 'live-requested-md'
      const bundle = path.join(assignment, 'output', 'manuals', videoId, manualRunId)
      await fs.mkdir(bundle, { recursive: true })
      await fs.writeFile(path.join(bundle, 'video-metadata.json'), JSON.stringify(plan.video))
      return manualRunId
    } } : {}),
  })
  const geminiApiKey = await loadGeminiApiKeyForLiveTest(geminiCredential)
  await fs.writeFile(path.join(userDataPath, 'provider-settings.json'), JSON.stringify({
    version: 3,
    connections: [],
    cliEnabled: {},
    cliModelEnabled: {},
    defaultModel: { provider: 'openai', model: 'fixture/youtube-manual' },
  }))
  const sessionStore = new FileSystemSessionStore(workspacePath)
  const session = await sessionStore.createSession({ title: 'Live YouTube manual E2E' })
  const executablePath = process.env.PIPELINE_DESKTOP_EXECUTABLE
    ? path.resolve(repoRoot, process.env.PIPELINE_DESKTOP_EXECUTABLE)
    : undefined
  const app = await electron.launch({
    args: executablePath ? [] : ['.'],
    cwd: repoRoot,
    ...(executablePath ? { executablePath } : {}),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      GEMINI_API_KEY: geminiApiKey,
      OPENAI_API_KEY: 'youtube-manual-provider-fixture',
      OPENAI_BASE_URL: providerFixture.baseUrl,
      WORKFLOW_GENERATOR_OPENAI_API_URL: providerFixture.chatCompletionsUrl,
      PIPELINE_DESKTOP_E2E: '1',
      PIPELINE_DESKTOP_PROJECT_ROOT: projectRootPath,
      PIPELINE_DESKTOP_USER_DATA: userDataPath,
      PIPELINE_DESKTOP_WORKSPACE_PATH: workspacePath,
      ...(executablePath ? {} : { PIPELINE_DESKTOP_REPO_ROOT: repoRoot }),
    },
  })
  let launchedTask: SessionTask | undefined
  let apiBaseUrl: string | undefined

  try {
    const page = await app.firstWindow()
    const pageErrors: Error[] = []
    page.on('pageerror', (error) => pageErrors.push(error))
    apiBaseUrl = await desktopApiBaseUrl(page)
    const youtubeSettingsResponse = await page.request.get(`${apiBaseUrl}/settings/youtube`)
    expect(youtubeSettingsResponse.ok()).toBe(true)
    const youtubeSettings = await youtubeSettingsResponse.json() as {
      geminiApiKeyConfigured?: boolean
      geminiSource?: string
      geminiError?: string
    }
    expect(youtubeSettings, 'The saved Gemini key must decrypt inside the isolated Electron run.').toMatchObject({
      geminiApiKeyConfigured: true,
      geminiSource: 'environment',
    })

    await page.getByRole('tab', { name: 'Run', exact: true }).click()
    await page.getByRole('button', { name: /^Live YouTube manual E2E\b/ }).first().click()
    await page.getByRole('tab', { name: 'Workflows', exact: true }).click()
    await page.getByRole('button', { name: /youtube.*manual.*generation/i }).first().click()
    const chat = page.getByRole('region', { name: 'Run chat' })
    await expect(chat.getByLabel('Run chat model')).toBeEnabled({ timeout: 30_000 })

    const requestText = [
      `Create an MD file with screenshots and the main takeaways, output-language en, from this single video: ${videoUrl}.`,
      'Attempt transcript capture and use Gemini to identify the important visual timestamps,',
      'Create Markdown only, with its portable screenshot bundle; do not create Word.',
    ].join(' ')
    await chat.getByPlaceholder('Send a message...').fill(requestText)
    await page.route(`**/sessions/${session.id}/messages`, async (route) => {
      const request = route.request()
      const body = request.postDataJSON() as Record<string, unknown>
      await route.continue({
        postData: JSON.stringify({
          ...body,
          provider: 'openai',
          model: 'fixture/youtube-manual',
        }),
        headers: { ...request.headers(), 'content-type': 'application/json' },
      })
    })
    const messageResponse = page.waitForResponse((response) =>
      response.request().method() === 'POST' &&
      new URL(response.url()).pathname.endsWith(`/sessions/${session.id}/messages`),
    { timeout: 5 * 60_000 })
    await chat.getByRole('button', { name: 'Send message' }).click()
    const response = await messageResponse
    const turn = await response.json() as PostChatMessageResponse

    expect(response.status(), JSON.stringify(turn)).toBe(201)
    expect(turn.meta?.fallback, turn.meta?.reason).toBe(false)
    expect(providerFixture.receptionistRequestCount()).toBe(1)
    expect(turn.plan).toMatchObject({
      status: 'ready',
      selectedWorkflow: { id: 'youtube-manual-generation' },
    })
    expect(turn.task).toBeUndefined()

    const confirmation = chat.getByTestId('workflow-launch-confirmation')
    await expect(confirmation).toBeVisible()
    await expect(confirmation).toContainText('youtube-manual-generation')
    let taskPostCount = 0
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        new URL(request.url()).pathname.endsWith(`/sessions/${session.id}/tasks`)
      ) {
        taskPostCount += 1
      }
    })
    const taskResponse = page.waitForResponse((candidate) =>
      candidate.request().method() === 'POST' &&
      new URL(candidate.url()).pathname.endsWith(`/sessions/${session.id}/tasks`),
    { timeout: 30_000 })
    await confirmation.getByRole('button', { name: 'Begin workflow' }).click()
    const accepted = await taskResponse
    expect(accepted.status()).toBe(202)
    launchedTask = await accepted.json() as SessionTask
    expect(launchedTask.workflowId).toBe('youtube-manual-generation')

    await waitForCompletedTask(sessionStore, session.id, launchedTask.id, 15 * 60_000)
    launchedTask = (await sessionStore.getTaskRecord(session.id, launchedTask.id))!
    expect(launchedTask.assignmentPath).toEqual(expect.any(String))
    expect(launchedTask.runPath).toEqual(expect.any(String))

    await expect(chat.locator(`#workflow-delivery-${launchedTask.id}`)).toBeVisible({
      timeout: 30_000,
    })
    expect(providerFixture.workerActions()).toEqual([
      'capture',
      'prepare_manual',
      'build_manual',
    ])
    expect(providerFixture.receptionistRequestCount()).toBe(1)
    expect(taskPostCount).toBe(1)
    await assertCompletedYoutubeManualJourney(launchedTask, videoId, videoUrl)
    const delivery = chat.locator(`#workflow-delivery-${launchedTask.id}`)
    await expect(delivery).toContainText('Screenshot-rich Markdown manual')
    await delivery.getByRole('button', { name: /Open full view/i }).first().click()
    const images = page.getByRole('region', { name: 'Canvas workspace', exact: true }).locator('img')
    await expect(images.first()).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => images.evaluateAll((nodes) => nodes.every((node) => node instanceof HTMLImageElement && node.complete && node.naturalWidth > 0)), { timeout: 30_000 }).toBe(true)
    await page.screenshot({ path: testInfo.outputPath('md-takeaways-canvas.png') })
    const downloadedPath = testInfo.outputPath('portable-manual.zip')
    const downloading = app.evaluate(({ session }, destination) => new Promise<string>((resolve, reject) => {
      session.defaultSession.once('will-download', (_event, item) => {
        item.setSavePath(destination)
        item.once('done', (_done, state) => state === 'completed' ? resolve(item.getFilename()) : reject(new Error(`ZIP download ${state}`)))
      })
    }), downloadedPath)
    await delivery.getByRole('link', { name: /Download .*manual\.zip$/ }).click()
    expect(await downloading).toBe('manual.zip')
    const portable = await JSZip.loadAsync(await fs.readFile(downloadedPath))
    expect(portable.file('manual.md')).not.toBeNull()
    expect(Object.keys(portable.files).some((name) => name.startsWith('frames/') && name.endsWith('.png'))).toBe(true)
    expect(pageErrors).toEqual([])
  } finally {
    if (apiBaseUrl && launchedTask && !['done', 'failed', 'blocked', 'cancelled'].includes(launchedTask.status)) {
      await fetch(`${apiBaseUrl}/sessions/${session.id}/tasks/${launchedTask.id}`, {
        method: 'DELETE',
      }).catch(() => undefined)
    }
    await app.close()
    await providerFixture.close()
  }
})

async function assertCompletedYoutubeManualJourney(
  task: SessionTask,
  expectedVideoId: string,
  submittedVideoUrl: string,
): Promise<void> {
  const expectedVideoUrl = `https://www.youtube.com/watch?v=${expectedVideoId}`
  const runPath = task.runPath!
  const manifests = await findNamedFiles(
    runPath,
    'generation-manifest.json',
  )
  expect(manifests).toHaveLength(1)
  const bundle = path.dirname(manifests[0]!)
  const childAssignmentPath = path.resolve(bundle, '..', '..', '..', '..')
  // This lane qualifies the requested Gemini document. Public transcript
  // retrieval may be unavailable; that separate external dependency is
  // recorded explicitly rather than claimed as a successful transcript capture.
  const capture = JSON.parse(await fs.readFile(path.join(childAssignmentPath, 'output', 'youtube-manifest.json'), 'utf8'))
  expect(capture.source.id).toBe(expectedVideoId)
  expect(['success', 'auth_required']).toContain(capture.videos[0].status)

  const manifest = JSON.parse(await fs.readFile(manifests[0]!, 'utf8')) as Record<string, unknown>
  expect(manifest).toMatchObject({
    videoId: expectedVideoId,
    templateId: 'quick-guide',
    status: 'complete',
    analysisMode: 'gemini',
    manualPlanSchemaVersion: 1,
    analysisSchemaVersion: 1,
    stages: {
      metadata: 'complete',
      analysis: 'complete',
      download: expect.stringMatching(/^(complete|failed)$/),
      frames: 'complete',
      markdown: 'complete',
      docx: 'not_requested',
      cleanup: 'complete',
    },
  })
  expect((manifest.frames as unknown[]).length).toBeGreaterThan(0)
  expect(manifest.analysisCacheKey).toMatch(/^[a-f0-9]{64}$/)
  expect(manifest.binaries).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'yt-dlp', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    expect.objectContaining({ name: 'ffmpeg', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    expect.objectContaining({ name: 'ffprobe', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
  ]))

  const analysis = JSON.parse(
    await fs.readFile(path.join(bundle, 'video-analysis.json'), 'utf8'),
  ) as YoutubeVideoAnalysis
  expect(analysis.model).toBe(YOUTUBE_GEMINI_MODEL)
  expect(analysis.steps.length).toBeGreaterThan(0)
  expect(analysis.steps.flatMap((step) => step.visualCandidates).length).toBeGreaterThan(0)

  const plan = JSON.parse(
    await fs.readFile(path.join(bundle, 'manual-plan.json'), 'utf8'),
  ) as YoutubeManualPlan
  expect(plan).toMatchObject({
    manualPlanSchemaVersion: 1,
    video: { videoId: expectedVideoId, url: expectedVideoUrl },
    templateId: 'quick-guide',
    outputLanguage: 'en',
    analysis: { mode: 'gemini', model: YOUTUBE_GEMINI_MODEL },
  })
  expect(plan.summary.length).toBeGreaterThan(0)

  const frames = JSON.parse(await fs.readFile(path.join(bundle, 'frames.json'), 'utf8')) as YoutubeSelectedFrame[]
  const requiredCues = plan.steps.flatMap((step) => step.visualCues
    .filter((cue) => cue.importance === 'required')
    .map((cue) => ({ stepId: step.id, timestampSeconds: cue.timestampSeconds })))
  expect(requiredCues.length).toBeGreaterThan(0)
  for (const cue of requiredCues) {
    const frame = frames.find((candidate) =>
      candidate.stepId === cue.stepId &&
      Math.abs(candidate.requestedTimestampSeconds - cue.timestampSeconds) < 0.001)
    expect(frame, `missing frame for ${cue.stepId} at ${cue.timestampSeconds}s`).toBeDefined()
    const framePath = path.join(bundle, ...frame!.relativePath.split('/'))
    const bytes = await fs.readFile(framePath)
    expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10])
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(frame!.sha256)
    expect(Number.isFinite(frame!.actualTimestampSeconds)).toBe(true)
  }
  // Browser recovery is a successful manual journey when the source CDN
  // refuses downloads. Required cue images and their hashes are checked above.
  expect((manifest.frames as Array<{ captureMethod?: string }>).map(
    (frame) => frame.captureMethod,
  )).toEqual(expect.arrayOf(expect.stringMatching(/^(ffmpeg|browser)$/)))

  const markdown = await fs.readFile(path.join(bundle, 'manual.md'), 'utf8')
  expect(markdown).toMatch(/^# .+/m)
  expect(markdown).toContain('## Source details')
  expect(markdown).toContain(`https://www.youtube.com/watch?v=${expectedVideoId}`)
  expect(markdown).toContain('## Summary')
  expect(markdown).toMatch(/!\[[^\]]+\]\(frames\/.+\.png\)/)
  expect(markdown).toMatch(new RegExp(`https://www\\.youtube\\.com/watch\\?v=${expectedVideoId}&t=\\d+s`))

  await expect(fs.access(path.join(bundle, 'manual.docx'))).rejects.toThrow()
  expect(plan.documentRequest).toEqual(documentRequest)
  expect(markdown).toContain('## Key takeaways')
  expect(markdown).not.toContain('## Instructions')
  const archive = await JSZip.loadAsync(await fs.readFile(path.join(bundle, 'manual.zip')))
  expect(await archive.file('manual.md')?.async('string')).toBe(markdown)
  expect(Object.keys(archive.files).filter((name) => name.startsWith('frames/') && name.endsWith('.png')).length).toBe(frames.length)
  const review = JSON.parse(await fs.readFile(path.join(bundle, 'screenshot-review.json'), 'utf8'))
  expect(review.status).toBe('pixel_reviewed')

  await verifyManifestOutputs(bundle, manifest)
  await expect(fs.access(path.join(bundle, 'working'))).rejects.toThrow()

  const report = await fs.readFile(path.join(childAssignmentPath, 'extraction-report.md'), 'utf8')
  expect(report).toContain(expectedVideoUrl)
  expect(report).toContain(new URL(submittedVideoUrl).hostname)
  expect(report).toContain('Transcript:')
  expect(report).toContain('manual.md')
  expect(report).not.toContain('manual.docx')
}

async function waitForCompletedTask(
  sessionStore: FileSystemSessionStore,
  sessionId: string,
  taskId: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await sessionStore.getTaskRecord(sessionId, taskId)
    if (current?.status === 'done') return
    if (current && ['failed', 'blocked', 'cancelled'].includes(current.status)) {
      throw new Error(
        `YouTube manual workflow ended ${current.status}: ${current.error ?? 'no error recorded'}`,
      )
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`YouTube manual workflow did not finish within ${timeoutMs}ms.`)
}

async function verifyManifestOutputs(bundle: string, manifest: Record<string, unknown>): Promise<void> {
  expect(Array.isArray(manifest.outputs)).toBe(true)
  for (const output of manifest.outputs as Array<{
    path: string
    byteLength: number
    sha256: string
  }>) {
    const filePath = path.join(bundle, ...output.path.split('/'))
    const bytes = await fs.readFile(filePath)
    expect(bytes.byteLength).toBe(output.byteLength)
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(output.sha256)
  }
}

async function resolveLiveCapability(): Promise<{ available: boolean; reason: string }> {
  const required = requiredCapabilities.has('all') || requiredCapabilities.has(capabilityId)
  if (process.env.PIPELINE_LIVE_YOUTUBE_MANUAL_E2E !== '1' && !required) {
    return { available: false, reason: 'Set PIPELINE_LIVE_YOUTUBE_MANUAL_E2E=1 to run.' }
  }
  if (geminiCredential.kind === 'missing') {
    return {
      available: false,
      reason: 'Gemini is not configured in GEMINI_API_KEY or the saved application settings.',
    }
  }
  if (!videoId) return { available: false, reason: 'The live YouTube URL is invalid.' }
  try {
    await resolveYoutubeBinaries({
      developmentDirectory: path.join(repoRoot, 'build', 'youtube-tools'),
    })
  } catch (error) {
    return {
      available: false,
      reason: `Pinned YouTube tools are unavailable: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
  return {
    available: true,
    reason: `${geminiCredential.kind === 'environment' ? 'Environment Gemini' : 'Saved-settings Gemini'}, YouTube, and pinned tools are configured.`,
  }
}

async function prepareDeterministicWorkerProject(projectRootPath: string): Promise<void> {
  await seedDesktopProjectRoot({ appRootPath: repoRoot, projectRootPath })
  const teamsPath = path.join(projectRootPath, 'teams.yaml')
  const agentPath = path.join(projectRootPath, 'agents', 'youtube-extractor', 'youtube-extractor.md')
  await Promise.all([
    replaceText(teamsPath, [
      ['host_model: gpt-5.4-mini', 'host_model: fixture/youtube-manual'],
      ['host_provider: codex', 'host_provider: openai'],
    ], /youtube-extraction:/),
    replaceText(agentPath, [
      ['provider: claude', 'provider: openai'],
      ['model: opus', 'model: fixture/youtube-manual'],
    ]),
  ])
}

async function replaceText(
  filePath: string,
  replacements: readonly (readonly [string, string])[],
  sectionStart?: RegExp,
): Promise<void> {
  const source = await fs.readFile(filePath, 'utf8')
  const start = sectionStart ? source.search(sectionStart) : 0
  if (start < 0) throw new Error(`Fixture section is unavailable in ${path.basename(filePath)}.`)
  let prefix = source.slice(0, start)
  let suffix = source.slice(start)
  for (const [from, to] of replacements) {
    const index = suffix.indexOf(from)
    if (index < 0) throw new Error(`Fixture value ${from} is unavailable in ${path.basename(filePath)}.`)
    suffix = suffix.slice(0, index) + to + suffix.slice(index + from.length)
  }
  await fs.writeFile(filePath, prefix + suffix)
}

async function resolveGeminiCredential(): Promise<
  | { readonly kind: 'environment' }
  | { readonly kind: 'saved-settings'; readonly path: string }
  | { readonly kind: 'missing' }
> {
  if (process.env.GEMINI_API_KEY?.trim()) return { kind: 'environment' }
  const explicitPath = process.env.PIPELINE_LIVE_YOUTUBE_SETTINGS_PATH?.trim()
  const candidates = explicitPath ? [path.resolve(explicitPath)] : defaultYoutubeSettingsPaths()
  for (const candidate of candidates) {
    try {
      const settings = JSON.parse(await fs.readFile(candidate, 'utf8')) as {
        settingsSchemaVersion?: unknown
        encryptedGeminiApiKey?: unknown
      }
      if (
        settings.settingsSchemaVersion === 2 &&
        typeof settings.encryptedGeminiApiKey === 'string' &&
        settings.encryptedGeminiApiKey.length > 0
      ) return { kind: 'saved-settings', path: candidate }
    } catch {
      // Try the next standard application settings location.
    }
  }
  return { kind: 'missing' }
}

function defaultYoutubeSettingsPaths(): string[] {
  if (process.platform === 'darwin') {
    return [path.join(os.homedir(), 'Library', 'Application Support', 'Octopus', 'youtube-settings.json'), path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'pipeline-template',
      'youtube-settings.json',
    )]
  }
  if (process.platform === 'win32' && process.env.APPDATA) {
    return [path.join(process.env.APPDATA, 'pipeline-template', 'youtube-settings.json')]
  }
  return [path.join(
    process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), '.config'),
    'pipeline-template',
    'youtube-settings.json',
  )]
}

async function loadGeminiApiKeyForLiveTest(
  credential: Exclude<typeof geminiCredential, { readonly kind: 'missing' }>,
): Promise<string> {
  if (credential.kind === 'environment') return process.env.GEMINI_API_KEY!.trim()
  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'pipeline-youtube-gemini-'))
  const outputPath = path.join(temporaryDirectory, 'credential')
  try {
    await execFileAsync(electronExecutablePath, [
      path.join(repoRoot, 'tests', 'support', 'decrypt-youtube-gemini-key.cjs'),
    ], {
      env: {
        ...process.env,
        PIPELINE_YOUTUBE_SETTINGS_PATH: credential.path,
        PIPELINE_YOUTUBE_KEYCHAIN_APP_NAME: path.basename(path.dirname(credential.path)) === 'Octopus' ? 'Octopus' : 'pipeline-template',
        PIPELINE_YOUTUBE_DECRYPTED_KEY_PATH: outputPath,
      },
      maxBuffer: 64 * 1_024,
    })
    const value = (await fs.readFile(outputPath, 'utf8')).trim()
    if (!value) throw new Error('The saved Gemini key decrypted to an empty value.')
    return value
  } catch (error) {
    throw new Error('The saved Gemini key could not be loaded for the live Electron test.', {
      cause: error,
    })
  } finally {
    await fs.rm(temporaryDirectory, { recursive: true, force: true })
  }
}

function requireOrSkipLiveCapability(): void {
  if (liveCapability.available) return
  if (requiredCapabilities.has('all') || requiredCapabilities.has(capabilityId)) {
    throw new Error(`Required live capability '${capabilityId}' is unavailable: ${liveCapability.reason}`)
  }
  test.skip(true, liveCapability.reason)
}

function youtubeVideoId(value: string): string {
  try {
    const url = new URL(value)
    const id = url.hostname === 'youtu.be'
      ? url.pathname.slice(1).split('/')[0]
      : url.searchParams.get('v')
    return id && /^[A-Za-z0-9_-]{11}$/.test(id) ? id : ''
  } catch {
    return ''
  }
}

async function desktopApiBaseUrl(page: Page): Promise<string> {
  await page.waitForURL((url) => url.hash.includes('pipeline-api-base-url='))
  const baseUrl = await page.evaluate(() =>
    new URLSearchParams(window.location.hash.slice(1)).get('pipeline-api-base-url'))
  if (!baseUrl) throw new Error('Desktop API URL is unavailable')
  return baseUrl
}

async function findNamedFiles(
  root: string,
  filename: string,
  predicate: (filePath: string) => boolean = () => true,
): Promise<string[]> {
  const matches: string[] = []
  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      const target = path.join(directory, entry.name)
      if (entry.isDirectory()) await visit(target)
      else if (entry.isFile() && entry.name === filename && predicate(target)) matches.push(target)
    }
  }
  await visit(root)
  return matches.sort()
}
