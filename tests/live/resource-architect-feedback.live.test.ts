import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import * as z from 'zod/v4'
import { RESOURCE_ARCHITECT_TURN_TIMEOUT_MS } from '../../contracts/resource-architect.js'
import type { ResourceArchitectFeedbackDiagnostics } from '../../contracts/schemas/resource-architect-review.js'

import { initProviders } from '../../providers/index.js'
import { getRuntimeDefaultModelState, setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import { runResourceArchitectTurnService } from '../../services/resource-architect-service.js'
import { ResourceArchitectStore } from '../../server/resource-architect-store.js'
import { resolveResourceArchitectJournalRecorder } from '../../services/resource-architect-journal-recorder.js'
import { WorkspaceConversationJournalRegistry } from '../../services/workspace-conversation-journal-registry.js'
import { cliCapability, isLiveCapabilityRequired, liveTest } from './live-provider-support.js'

const CAPABILITY = 'resource-architect-feedback'
const environment = z.object({
  PIPELINE_LIVE_RESOURCE_ARCHITECT_FEEDBACK: z.enum(['0', '1']).optional(),
  PIPELINE_LIVE_RESOURCE_ARCHITECT_FEEDBACK_EVALUATE: z.enum(['0', '1']).optional(),
  PIPELINE_LIVE_RESOURCE_ARCHITECT_FEEDBACK_OUTPUT: z.string().min(1).optional(),
}).parse(process.env)
const enabled = environment.PIPELINE_LIVE_RESOURCE_ARCHITECT_FEEDBACK === '1' || isLiveCapabilityRequired(CAPABILITY)
const cli = enabled ? await Promise.all([cliCapability('claude'), cliCapability('codex')]) : []
const capability = enabled
  ? { available: cli.every((value) => value.available), reason: cli.map((value) => value.reason).join('; ') }
  : { available: false, reason: 'Set PIPELINE_LIVE_RESOURCE_ARCHITECT_FEEDBACK=1 to run authenticated Claude/Codex authoring.' }
const caseSchema = z.object({
  id: z.enum(['consulting_contract_team_shared_skills', 'single_agent', 'existing_agent_reuse', 'clarification']),
  request: z.string().min(1),
})
const baselineSchema = z.object({
  cases: z.array(caseSchema).length(4),
  prompts: z.object({ prompt_only: z.string().min(1) }),
})
const expectedResponse = {
  consulting_contract_team_shared_skills: /\|\s*Skill\s*\|\s*Purpose\s*\|\s*Agents\s*\|\s*Sharing\s*\|/iu,
  single_agent: /\|\s*Skill\s*\|\s*Purpose\s*\|\s*Agents\s*\|\s*Sharing\s*\|/iu,
  existing_agent_reuse: /\|\s*Skill\s*\|\s*Purpose\s*\|\s*Agents\s*\|\s*Sharing\s*\|/iu,
  clarification: /\?/u,
}

/** Real subscription providers; no provider, service, journal, or filesystem replacement. */
liveTest('Claude author and Codex Sol reviewer complete one private Create feedback round', CAPABILITY, capability, async (t) => {
  initProviders()
  const repositoryRoot = process.cwd()
  const baseline = baselineSchema.parse(JSON.parse(await fs.readFile(path.join(repositoryRoot,
    'docs/evidence/2026-09-19-architect-feedback/baseline-inputs.json'), 'utf8')))
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'architect-feedback-live-')))
  const projectRoot = path.join(directory, 'project')
  const workspacePath = path.join(directory, 'workspace')
  const outputPath = environment.PIPELINE_LIVE_RESOURCE_ARCHITECT_FEEDBACK_OUTPUT
    ? path.resolve(environment.PIPELINE_LIVE_RESOURCE_ARCHITECT_FEEDBACK_OUTPUT) : path.join(directory, 'evidence')
  const oldDefault = getRuntimeDefaultModelState()
  const journalRegistry = new WorkspaceConversationJournalRegistry({ workspacePath, tenantId: 'live-test', mode: 'authoritative' })
  const author = { provider: 'claude', model: 'opus' }
  const reviewer = { provider: 'codex', model: 'gpt-5.6-sol' }
  const canonical = await fs.readFile(path.join(repositoryRoot, 'agents/resource-architect/resource-architect.md'), 'utf8')
  const reviewerCanonical = await fs.readFile(path.join(repositoryRoot,
    'agents/reviewer-of-agent-architect/reviewer-of-agent-architect.md'), 'utf8')
  const configuredReviewer = reviewerCanonical.replace('system: true\n', 'system: true\nprovider: codex\nmodel: gpt-5.6-sol\n')
  const jobs = environment.PIPELINE_LIVE_RESOURCE_ARCHITECT_FEEDBACK_EVALUATE === '1'
    ? baseline.cases.flatMap((scenario) => [1, 2].map((repeat) => ({ ...scenario, repeat })))
    : baseline.cases.slice(0, 1).map((scenario) => ({ ...scenario, repeat: 1 }))
  try {
    await fs.mkdir(workspacePath, { recursive: true })
    await fs.mkdir(path.join(projectRoot, 'teams/resource-architect'), { recursive: true })
    await fs.mkdir(outputPath, { recursive: true })
    await fs.writeFile(path.join(projectRoot, 'teams.yaml'), '')
    await fs.writeFile(path.join(projectRoot, 'teams/resource-architect/team.yaml'),
      'agents:\n  - agent_file: ../../agents/resource-architect/resource-architect.md\n')
    await writePersona(projectRoot, 'resource-architect', `---\nsystem: true\nthinking: medium\n---\n${canonical}`)
    await writePersona(projectRoot, 'reviewer-of-agent-architect', configuredReviewer)
    await writeLibraryAgent(projectRoot, 'contract-reviewer', 'contract-issue-triage',
      'Review consulting services agreements for scope, deliverables, acceptance, fees, client responsibilities, and unresolved commercial terms. Prepare an issues list for a human reviewer; do not provide jurisdiction-specific legal opinions.')
    await writeLibraryAgent(projectRoot, 'plain-language-editor', 'plain-language-editing',
      'Edit professional English for clarity while preserving technical meaning and stated constraints.')
    setRuntimeDefaultModelState({ status: 'available', ...author })
    await fs.writeFile(path.join(outputPath, 'reviewed-inputs.json'), JSON.stringify({
      createdAt: new Date().toISOString(), author, reviewer, authorThinking: 'medium',
      reviewerThinking: 'high', tools: [], maximumConcurrency: 2,
      turnTimeoutMs: RESOURCE_ARCHITECT_TURN_TIMEOUT_MS,
      personaHashes: { author: hash(canonical), reviewer: hash(configuredReviewer) },
      baselinePromptHash: hash(baseline.prompts.prompt_only), cases: jobs,
      cost: null, costReason: 'The authoring service does not expose per-phase provider cost or token usage.',
    }, null, 2))

    // At most two independent synthetic requests run concurrently.
    for (let index = 0; index < jobs.length; index += 2) {
      await Promise.all(jobs.slice(index, index + 2).map((scenario) => t.test(`${scenario.id} repeat ${scenario.repeat}`, { concurrency: true }, async () => {
        const jobId = randomUUID()
        const recorder = await resolveResourceArchitectJournalRecorder({ registry: journalRegistry,
          conversationId: `live-${jobId}`, jobId })
        const began = performance.now()
        const publicText: string[] = []
        const turnSignal = AbortSignal.timeout(RESOURCE_ARCHITECT_TURN_TIMEOUT_MS)
        let latestReview: ResourceArchitectFeedbackDiagnostics | undefined
        try {
          const result = await runResourceArchitectTurnService({
            repoRootPath: projectRoot, store: new ResourceArchitectStore(workspacePath), jobId,
            operation: 'conversation', history: [{ role: 'user', text: scenario.request }], currentPlan: null,
            composerSelection: Object.freeze({ ...author, origin: 'default' }), reviewEnabled: true,
            signal: turnSignal, onTextDelta: (text) => { publicText.push(text) },
            onReviewDiagnostics: async (review) => { latestReview = review },
            onUnreviewedDraft: (review) => recorder.recordFallback(review),
          }).catch(async (caught: unknown) => {
            await fs.writeFile(path.join(outputPath, `reviewed-${scenario.id}-${scenario.repeat}.json`), JSON.stringify({
              scenario: scenario.id, repeat: scenario.repeat, request: scenario.request,
              elapsedMs: performance.now() - began, outcome: 'failed',
              failureKind: turnSignal.aborted ? 'deadline' : 'unexpected',
              errorName: caught instanceof Error ? caught.name : 'unknown',
              review: latestReview, cost: null, tokens: null,
            }, null, 2))
            await recorder.recordTerminal(turnSignal.aborted ? 'cancelled' : 'failed')
            throw caught
          })
          const elapsedMs = performance.now() - began
          await fs.writeFile(path.join(outputPath, `reviewed-${scenario.id}-${scenario.repeat}.json`), JSON.stringify({
            scenario: scenario.id, repeat: scenario.repeat, request: scenario.request,
            elapsedMs, message: result.message, warnings: result.warnings, meta: result.meta,
            publicText: publicText.join(''), cost: null, tokens: null,
          }, null, 2))
          await recorder.recordTerminal('completed')
          assert.equal(result.meta.review?.reviewStatus, 'completed', 'The live independent review must complete')
          assert.deepEqual(result.meta.review?.phases.map(({ phase, provider, model }) => ({ phase, provider, model })), [
            { phase: 'draft', ...author }, { phase: 'review', ...reviewer }, { phase: 'final', ...author },
          ])
          assert.equal(result.meta.selection?.reason, 'composer-default')
          assert.equal(result.meta.fallback, false)
          assert.ok(result.operation === 'conversation')
          assert.equal(result.proposalRequested, undefined)
          assert.match(result.message, expectedResponse[scenario.id])
          assert.equal(publicText.join(''), result.message, 'The public stream contains only the final answer')
          assert.doesNotMatch(result.message, /\[\[proposal-requested\]\]/u)
          t.diagnostic(`${scenario.id}/${scenario.repeat}: ${elapsedMs.toFixed(0)} ms; three phases completed; cost unavailable`)
        } finally {
          await recorder.release()
        }
      })))
    }
  } finally {
    setRuntimeDefaultModelState(oldDefault)
    await journalRegistry.close()
    await fs.rm(directory, { recursive: true, force: true })
  }
}, 20 * 60_000)

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

async function writePersona(root: string, name: string, text: string): Promise<void> {
  const directory = path.join(root, 'agents', name)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, `${name}.md`), text)
}

async function writeLibraryAgent(root: string, name: string, skill: string, description: string): Promise<void> {
  await writePersona(root, name, `---\nname: ${name}\ndescription: ${description}\n---\n${description}\n`)
  const directory = path.join(root, 'agents', name, 'skills', skill)
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(path.join(directory, 'SKILL.md'), `---\nname: ${skill}\ndescription: ${description}\n---\n${description}\n`)
}
