import { MCP_RUNTIME_CONTRACT_VERSION } from '../../contracts/mcp.js'
import { YoutubeToolService } from '../../services/youtube-tool-service.js'
import { YoutubeCapabilityDispatchGateway, YOUTUBE_BUILTIN_SOURCE } from '../../services/youtube-capability-adapter.js'
import { createCapabilityTestDispatcher } from '../support/capability-dispatcher.js'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import JSZip from 'jszip'
import { PNG } from 'pngjs'
import { parseYoutubeManualPlan } from '../../domains/youtube/youtube-manual-schema.js'
import { publishYoutubeManual } from '../../domains/youtube/youtube-manual-service.js'
import { YoutubeManualCoordinator } from '../../services/youtube-manual-coordinator.js'
import { YoutubeSettingsService } from '../../services/youtube-settings-service.js'

function requestedPlan(formats: readonly string[]) {
  return parseYoutubeManualPlan({
    manualPlanSchemaVersion: 1,
    video: { videoId: 'b2tjnxX8IHU', url: 'https://www.youtube.com/watch?v=b2tjnxX8IHU', title: 'Model comparison', durationSeconds: 393 },
    templateId: 'quick-guide', outputLanguage: 'en',
    documentRequest: { formats, purpose: 'takeaways', instructions: 'Create an MD file with screenshots and the main takeaways.' },
    analysis: { mode: 'transcript', generatedAt: '2026-10-20T12:00:00.000Z', warnings: [] },
    summary: 'The presenter compares model capabilities, costs and limitations.',
    chapters: [{ id: 'findings', order: 1, title: 'Key takeaways', stepIds: ['training'] }],
    steps: [{ id: 'training', order: 1, title: 'Training data and claims', explanation: 'The video describes training data; its benchmark claims need independent evidence.', startSeconds: 40, endSeconds: 41,
      visualCues: [{ timestampSeconds: 40, importance: 'required', reason: 'Supports the training-data discussion.', caption: 'Training-dataset slide', altText: 'A slide describing the model training dataset' }] }],
  })
}

test('an MD-only takeaway request publishes a portable illustrated Markdown document without Word', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-requested-md-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  await fs.mkdir(path.join(root, 'frames'))
  const bytes = PNG.sync.write(new PNG({ width: 2, height: 2 }))
  await fs.writeFile(path.join(root, 'frames', 'training.png'), bytes)
  const plan = requestedPlan(['markdown'])

  await publishYoutubeManual({ bundleDirectory: root, plan, frames: [{ stepId: 'training', requestedTimestampSeconds: 40, actualTimestampSeconds: 40, relativePath: 'frames/training.png', caption: 'Training-dataset slide', altText: 'A slide describing the model training dataset', selectionReason: 'browser_fallback', sha256: 'fixture' }] })

  const markdown = await fs.readFile(path.join(root, 'manual.md'), 'utf8')
  assert.match(markdown, /## Key takeaways/)
  assert.doesNotMatch(markdown, /## Instructions|## Prerequisites/)
  assert.match(markdown, /!\[A slide describing the model training dataset\]\(frames\/training.png\)/)
  await assert.rejects(fs.access(path.join(root, 'manual.docx')))
  const archive = await JSZip.loadAsync(await fs.readFile(path.join(root, 'manual.zip')))
  assert.equal(await archive.file('manual.md')?.async('string'), markdown)
  assert.deepEqual(await archive.file('frames/training.png')?.async('nodebuffer'), bytes)
  assert.equal(archive.file('manual.docx'), null)
})

test('invalid or empty requested output formats are rejected before publication', () => {
  assert.throws(() => requestedPlan([]), /invalid/)
  assert.throws(() => requestedPlan(['pdf']), /invalid/)
  assert.throws(() => requestedPlan(['markdown', 'markdown']), /invalid/)
})

async function coordinatorFixture(t: import('node:test').TestContext, review = false) {
  const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-requested-run-'))
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }))
  const root = path.join(workspaceRoot, 'sessions/session-1/runs/run-1/assignments/assignment-1')
  await fs.mkdir(root, { recursive: true })
  const plan = requestedPlan(['markdown'])
  const environment: NodeJS.ProcessEnv = {}
  const coordinator = new YoutubeManualCoordinator({
    assignmentPath: root, settings: new YoutubeSettingsService({ environment }),
    ...(review ? { analysis: { analyze: async () => { throw new Error('Unexpected initial analysis') }, reviewScreenshots: async () => ({ captions: [{ index: 0, caption: 'Pixels show training data', altText: 'Dataset slide checked against captured pixels' }] }) } } : {}),
    // Chrome is nondeterministic; replace only its screenshot boundary. The
    // coordinator, publisher, filesystem, hashes and ZIP remain real.
    browserFrames: { captureYoutubeFrames: async ({ outputDirectory, cues }) => {
      await fs.mkdir(outputDirectory, { recursive: true })
      const bytes = PNG.sync.write(new PNG({ width: 2, height: 2 }))
      await fs.writeFile(path.join(outputDirectory, 'training.png'), bytes)
      return cues.map((cue) => ({ ...cue, requestedTimestampSeconds: cue.timestampSeconds,
        actualTimestampSeconds: cue.timestampSeconds, relativePath: 'frames/training.png', selectionReason: 'browser_fallback', sha256: 'fixture' }))
    } },
  })
  assert.ok(plan.documentRequest)
  const prepareInput = { video: plan.video, templateId: plan.templateId, documentRequest: plan.documentRequest, outputLanguage: 'en' }
  const prepared = await coordinator.prepare(prepareInput)
  assert.ok(prepared.manualRunId)
  return { workspaceRoot, root, coordinator, plan, environment, runId: prepared.manualRunId }
}

test('a saved MD-only request completes and replays without a Word output or a missing-Word error', async (t) => {
  const f = await coordinatorFixture(t)
  await f.coordinator.writeManualPlan({ videoId: f.plan.video.videoId, manualRunId: f.runId, content: JSON.stringify(f.plan) })

  const output = await f.coordinator.build({ videoId: f.plan.video.videoId, manualRunId: f.runId })

  assert.equal(output.ok, true)
  assert.equal(output.manualDocxPath, undefined)
  assert.ok(output.manualMarkdownPath)
  assert.match(await fs.readFile(path.join(f.root, output.manualMarkdownPath), 'utf8'), /## Key takeaways/)
  const replay = await f.coordinator.build({ videoId: f.plan.video.videoId, manualRunId: f.runId })
  assert.equal(replay.reused, true)
  assert.equal(replay.manualDocxPath, undefined)
})

test('a transcript plan cannot replace the format or purpose saved during preparation', async (t) => {
  const f = await coordinatorFixture(t)
  const changed = { ...f.plan, documentRequest: { formats: ['docx'], purpose: 'instructions', instructions: 'Create Word instructions.' } }

  await assert.rejects(f.coordinator.writeManualPlan({ videoId: f.plan.video.videoId, manualRunId: f.runId, content: JSON.stringify(changed) }), /document request/i)
})

test('publication uses pixel-reviewed captions and records their image hashes', async (t) => {
  const f = await coordinatorFixture(t, true)
  await f.coordinator.writeManualPlan({ videoId: f.plan.video.videoId, manualRunId: f.runId, content: JSON.stringify(f.plan) })
  f.environment.GEMINI_API_KEY = 'fixture-review-key'
  const output = await f.coordinator.build({ videoId: f.plan.video.videoId, manualRunId: f.runId })
  assert.ok(output.manualMarkdownPath)
  const markdown = await fs.readFile(path.join(f.root, output.manualMarkdownPath), 'utf8')
  assert.match(markdown, /Pixels show training data/)
  const evidence = JSON.parse(await fs.readFile(path.join(f.root, output.manualBundlePath ?? '', 'screenshot-review.json'), 'utf8'))
  assert.match(evidence.captions[0].sha256, /^[a-f0-9]{64}$/)
})

test('replay refuses a completed manifest that omits its requested document record', async (t) => {
  const f = await coordinatorFixture(t)
  await f.coordinator.writeManualPlan({ videoId: f.plan.video.videoId, manualRunId: f.runId, content: JSON.stringify(f.plan) })
  const output = await f.coordinator.build({ videoId: f.plan.video.videoId, manualRunId: f.runId })
  const manifestPath = path.join(f.root, output.manualBundlePath ?? '', 'generation-manifest.json')
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'))
  manifest.outputs = manifest.outputs.filter((entry: { path: string }) => entry.path !== 'manual.md')
  await fs.writeFile(manifestPath, JSON.stringify(manifest))
  await assert.rejects(f.coordinator.build({ videoId: f.plan.video.videoId, manualRunId: f.runId }), /output records.*missing/)
})

test('analysis cached for takeaways cannot be reused as procedural instructions', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'youtube-request-cache-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const plan = requestedPlan(['markdown'])
  const coordinator = new YoutubeManualCoordinator({ assignmentPath: root,
    settings: new YoutubeSettingsService({ environment: { GEMINI_API_KEY: 'fixture' } }),
    // Paid model boundary only; request-keyed analysis persistence remains real.
    analysis: { analyze: async (request) => ({ analysis: {
      analysisSchemaVersion: 1, sourceRevisionFingerprint: request.sourceRevisionFingerprint,
      model: request.model, analysisPromptVersion: 'youtube-manual-v2', outputLanguage: 'en', generatedAt: request.generatedAt,
      summary: request.documentRequest?.purpose === 'takeaways' ? 'The main takeaway is a comparison of model capabilities.' : 'The procedure has concrete operating steps.',
      steps: [{ id: 'training', title: 'Training data', explanation: 'Source evidence.', startSeconds: 40, endSeconds: 41,
        visualCandidates: [{ timestampSeconds: 40, importance: 'required', reason: 'Dataset slide.', caption: 'Dataset slide', altText: 'A slide describing model training data' }] }],
    } }) },
  })
  assert.ok(plan.documentRequest)
  await coordinator.prepare({ video: plan.video, templateId: plan.templateId, documentRequest: plan.documentRequest, geminiConfirmed: true })
  const second = await coordinator.prepare({ video: plan.video, templateId: plan.templateId,
    documentRequest: { formats: ['markdown'], purpose: 'instructions', instructions: 'Explain the concrete operating procedure.' }, geminiConfirmed: true })
  assert.ok(second.manualPlanPath)
  const result = JSON.parse(await fs.readFile(path.join(root, second.manualPlanPath), 'utf8'))
  assert.equal(result.summary, 'The procedure has concrete operating steps.')
})

test('a completed MD-only manual and its portable ZIP cross the real tool gateway as success', async (t) => {
  const f = await coordinatorFixture(t)
  await f.coordinator.writeManualPlan({ videoId: f.plan.video.videoId, manualRunId: f.runId, content: JSON.stringify(f.plan) })
  await f.coordinator.build({ videoId: f.plan.video.videoId, manualRunId: f.runId })
  const gateway = new YoutubeCapabilityDispatchGateway({ dispatcher: createCapabilityTestDispatcher(),
    service: new YoutubeToolService({ workspacePath: f.workspaceRoot, settings: new YoutubeSettingsService({ environment: {} }) }) })
  const output = await gateway.execute({
    context: { contractVersion: MCP_RUNTIME_CONTRACT_VERSION, requestId: 'request-1', leaseId: 'lease-1', sessionId: 'session-1', runId: 'run-1', assignmentId: 'assignment-1', agentPath: 'agents/youtube-extractor' },
    authority: { kind: 'mcp-lease', leaseId: 'lease-1' }, source: YOUTUBE_BUILTIN_SOURCE, toolCallId: 'md-publication',
    input: { action: 'build_manual', videoId: f.plan.video.videoId, manualRunId: f.runId },
  })
  assert.equal(output.ok, true, output.error?.message)
  assert.match(output.manualZipPath ?? '', /manual\.zip$/)
  assert.match(output.manualMarkdownPath ?? '', /manual\.md$/)
  assert.equal(output.manualDocxPath, undefined)
})
