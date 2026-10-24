/**
 * Team Runtime — Meeting Minutes Generator
 *
 * Two-phase approach:
 * 1. Mechanically collect raw conversation data from all engine states
 * 2. Summarize into concise meeting minutes with a single call on the one
 *    application default, falling back to the mechanical form when there is no
 *    usable default
 *
 * Triggered automatically on level completion and on-demand via /team-minutes.
 */

import { whenDefined } from '../../core/optional-properties.js'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import type {
  TeamConfig,
  RuntimeState,
  LevelConfig,
  DiscussionState,
  ChainState,
  BroadcastState,
  ReviewState,
  PipelineState,
  ReviewStageConfig,
} from '../../core/types.js'
import {
  STAGE_TYPE,
  MINUTES_THINKING,
  MINUTES_TEMPLATE_FILENAME,
  DEFAULT_AUXILIARY_LLM_TIMEOUT_MINUTES,
} from '../../core/constants.js'
import {
  recordHelperModelSelection,
  reportHelperFallback,
  resolveHelperModelSelection,
  type HelperRunIdentity,
} from '../provider/helper-model-selection.js'
import { runAgent } from './agent-runner.js'
import { formatElapsed, formatCost } from '../../core/constraints.js'
import { roundUsd } from '../../core/budget-ledger.js'
import {
  buildArtifactMetadata,
  stripArtifactFrontmatter,
  writeMarkdownArtifact,
} from '../runtime/artifacts.js'
import { getAssignmentLogPath } from '../runtime/logger.js'
import { deriveEffectiveStageContractsForTeam } from '../stage/stage-contracts.js'

// ─── Phase 1: Collect raw data from engine states ────────────────────────────

interface CollectedEntry {
  level: string
  engineType: string
  section: string
  agent: string
  rawText: string
}

function collectDiscussionData(state: DiscussionState, levelName: string): CollectedEntry[] {
  const entries: CollectedEntry[] = []
  for (const msg of state.messages) {
    const toStr = Array.isArray(msg.to) ? msg.to.join(', ') : msg.to
    entries.push({
      level: levelName,
      engineType: 'discussion',
      section: `Round ${msg.round}`,
      agent: msg.from,
      rawText: `[${msg.type}, to: ${toStr}] ${msg.message}`,
    })
  }
  return entries
}

function collectChainData(state: ChainState, levelName: string): CollectedEntry[] {
  return state.outputs.map((o, i) => ({
    level: levelName,
    engineType: 'chain',
    section: `Step ${i + 1}/${state.totalSteps}`,
    agent: o.agent,
    rawText: o.text,
  }))
}

function collectBroadcastData(state: BroadcastState, levelName: string): CollectedEntry[] {
  return state.responses.map((r) => ({
    level: levelName,
    engineType: 'broadcast',
    section: 'Broadcast',
    agent: r.agent,
    rawText: r.text,
  }))
}

function collectReviewData(
  state: ReviewState,
  config: ReviewStageConfig,
  levelName: string,
): CollectedEntry[] {
  const entries: CollectedEntry[] = []
  if (state.lastFeedback) {
    entries.push({
      level: levelName,
      engineType: 'review',
      section: `Iteration ${state.iteration}/${state.maxIterations} — verdict: ${state.lastVerdict || 'pending'}`,
      agent: config.reviewer,
      rawText: state.lastFeedback,
    })
  }
  return entries
}

function collectPipelineData(outputPath: string, levelName: string): CollectedEntry[] {
  const dispatchPath = getAssignmentLogPath(outputPath, 'agent-dispatch.jsonl')
  if (!fs.existsSync(dispatchPath)) return []

  const entries: CollectedEntry[] = []
  const lines = fs.readFileSync(dispatchPath, 'utf-8').split('\n').filter(Boolean)
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as { agent: string; task_id: string; task_title: string; timestamp: string }
      entries.push({
        level: levelName,
        engineType: 'pipeline',
        section: 'Task Dispatch',
        agent: event.agent,
        rawText: `Task ${event.task_id}: ${event.task_title}`,
      })
    } catch {
      // skip malformed lines
    }
  }
  return entries
}

function collectAllData(
  teamConfig: TeamConfig,
  runtimeState: RuntimeState,
  outputPath: string,
): CollectedEntry[] {
  const allEntries: CollectedEntry[] = []

  for (const level of teamConfig.levels) {
    const ls = runtimeState.levelStates.get(level.id)
    if (!ls?.engineState) continue

    const engineState = ls.engineState
    switch (engineState.type) {
      case STAGE_TYPE.DISCUSSION:
        allEntries.push(...collectDiscussionData(engineState, level.name))
        break
      case STAGE_TYPE.CHAIN:
        allEntries.push(...collectChainData(engineState, level.name))
        break
      case STAGE_TYPE.BROADCAST:
        allEntries.push(...collectBroadcastData(engineState, level.name))
        break
      case STAGE_TYPE.REVIEW:
        if (level.stage.type === STAGE_TYPE.REVIEW) {
          allEntries.push(...collectReviewData(engineState, level.stage, level.name))
        }
        break
      case STAGE_TYPE.PIPELINE:
        allEntries.push(...collectPipelineData(outputPath, level.name))
        break
    }
  }

  return allEntries
}

// ─── Phase 2: LLM summarization ─────────────────────────────────────────────

function loadMinutesTemplate(): string {
  const templatePath = path.resolve(
    __dirname,
    '..',
    '..',
    'examples',
    MINUTES_TEMPLATE_FILENAME,
  )
  return fs.readFileSync(templatePath, 'utf-8')
}

function buildSummaryPrompt(entries: CollectedEntry[]): string {
  const sections: string[] = []
  let currentSection = ''

  for (const entry of entries) {
    const sectionKey = `${entry.level} — ${entry.section}`
    if (sectionKey !== currentSection) {
      currentSection = sectionKey
      sections.push(`\n### ${sectionKey}`)
    }
    // Pre-truncate very long messages to stay within context limits
    const truncated = entry.rawText.length > 500
      ? entry.rawText.slice(0, 500) + '...'
      : entry.rawText
    sections.push(`**${entry.agent}:** ${truncated}`)
  }

  return sections.join('\n')
}

async function summarizeWithLLM(
  entries: CollectedEntry[],
  teamConfig: TeamConfig,
  runtimeState: RuntimeState,
  minutesContext: MinutesContext,
  stats: ParticipationStats,
  outputPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const systemPrompt = loadMinutesTemplate()
  const rawData = buildSummaryPrompt(entries)
  const contextBlock = [
    '# Session Context',
    '',
    minutesContext.overview ? `**Evaluation overview:** ${minutesContext.overview}` : '**Evaluation overview:** Not available from assignment inputs.',
    `**Active participants:** ${stats.activeAgents.join(', ') || 'none recorded'}`,
    ...(stats.inactiveAgents.length > 0 ? [`**Inactive participants:** ${stats.inactiveAgents.join(', ')}`] : []),
    '',
  ].join('\n')

  const userMessage =
    `${contextBlock}\n` +
    `# Raw Conversation Data\n\n` +
    `**Team:** ${teamConfig.team.name}\n` +
    `**Session:** ${runtimeState.sessionId}\n\n` +
    `${rawData}\n\n` +
    `---\n\n` +
    `Produce structured meeting minutes from the above conversation data. ` +
    `Follow the output structure defined in your instructions exactly. ` +
    `Output ONLY the minutes body (sections and bullets), no header or metadata.`

  // The one application default, whole. Writing minutes is the application's
  // own work and owns no Agent, so it runs on that or on nothing — a pair that
  // cannot run is not a licence to pick another one, and the mechanical minutes
  // below are a perfectly good answer.
  const selection = resolveHelperModelSelection('minutes')
  if (!selection) throw new Error('No usable application default for minutes.')
  const identity: HelperRunIdentity = {
    outputPath,
    sessionId: runtimeState.sessionId,
    ...whenDefined(runtimeState.rootSessionId, (rootSessionId) => ({ rootSessionId })),
  }
  // Nothing is asked, and nothing is recorded, for a run nobody is waiting for.
  // Checked before the record rather than only inside the provider call: by
  // then the account would already name a model that was asked for nothing.
  //
  // Immediately before it, with nothing awaited in between, so a shutdown
  // cannot land between the two and leave a durable notice about a call that
  // never went out. Compression closes the same window by putting both inside
  // the limiter's admitted call; minutes have no limiter, so adjacency is what
  // does it here.
  if (signal?.aborted) {
    throw new Error('Minutes were cancelled before they started.')
  }
  // And the account exists before the model is used, or it is not used.
  if (!recordHelperModelSelection(identity, 'minutes', selection)) {
    throw new Error('The model selected for these minutes could not be recorded.')
  }

  const result = await runAgent({
    systemPrompt,
    userMessage,
    model: selection.model,
    provider: selection.provider,
    thinking: MINUTES_THINKING,
    timeoutMinutes: DEFAULT_AUXILIARY_LLM_TIMEOUT_MINUTES,
    outputPath,
    sessionId: runtimeState.sessionId,
    ...whenDefined(runtimeState.rootSessionId, (rootSessionId) => ({ rootSessionId })),
    ...whenDefined(signal, (definedValue) => ({ signal: definedValue })),
  })

  runtimeState.totalCost = roundUsd(runtimeState.totalCost + (result.cost ?? 0))
  return result.text
}

// ─── Mechanical fallback ─────────────────────────────────────────────────────

function truncateToFirstParagraph(text: string, maxChars = 200): string {
  // Strip leading markdown headers
  const stripped = text.replace(/^#+\s+.*\n+/, '')
  // Take first paragraph
  const firstPara = stripped.split(/\n\n/)[0] || stripped
  if (firstPara.length <= maxChars) return firstPara.trim()
  // Truncate at word boundary
  const truncated = firstPara.slice(0, maxChars)
  const lastSpace = truncated.lastIndexOf(' ')
  return (lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated) + '...'
}

function buildMechanicalMinutes(
  entries: CollectedEntry[],
  minutesContext: MinutesContext,
  stats: ParticipationStats,
): string {
  const lines: string[] = []

  if (minutesContext.overview) {
    lines.push('## Evaluation Overview\n')
    lines.push(`${minutesContext.overview}\n`)
  }

  lines.push('## Participants\n')
  lines.push(`- Active: ${stats.activeAgents.join(', ') || 'none recorded'}`)
  if (stats.inactiveAgents.length > 0) {
    lines.push(`- Inactive: ${stats.inactiveAgents.join(', ')}`)
  }
  lines.push('')

  // Executive Summary (best-effort without LLM)
  const levels = [...new Set(entries.map((e) => e.level))]
  lines.push(`## Executive Summary\n`)
  lines.push(
    `Session covered ${levels.length} stage(s) with ${stats.activeAgents.length} active participant(s): ${stats.activeAgents.join(', ')}. ` +
    `See raw contributions below.\n`,
  )

  // Decisions / Action Items placeholders
  lines.push(`## Decisions\n`)
  lines.push(`LLM summarization unavailable — decisions could not be extracted automatically.\n`)
  lines.push(`## Action Items\n`)
  lines.push(`LLM summarization unavailable — action items could not be extracted automatically.\n`)

  // Raw contributions grouped by stage
  lines.push(`## Raw Contributions\n`)
  let currentSection = ''
  for (const entry of entries) {
    const sectionKey = `${entry.level} — ${entry.section}`
    if (sectionKey !== currentSection) {
      currentSection = sectionKey
      lines.push(`### ${sectionKey}\n`)
    }
    lines.push(`- **${entry.agent}:** ${truncateToFirstParagraph(entry.rawText)}`)
  }

  return lines.join('\n')
}

// ─── Participation stats ─────────────────────────────────────────────────────

interface ParticipationStats {
  activeAgents: string[]
  inactiveAgents: string[]
  roundCount: number | null
}

interface MinutesContext {
  overview: string | null
  canonicalMinutesArtifact: string | null
}

function computeParticipationStats(
  entries: CollectedEntry[],
  teamConfig: TeamConfig,
  runtimeState: RuntimeState,
): ParticipationStats {
  // Active agents in order of first appearance
  const seen = new Set<string>()
  const activeAgents: string[] = []
  for (const entry of entries) {
    if (!seen.has(entry.agent)) {
      seen.add(entry.agent)
      activeAgents.push(entry.agent)
    }
  }

  // Inactive agents in roster order
  const inactiveAgents = teamConfig.agents
    .map((a) => a.name)
    .filter((name) => !seen.has(name))

  // Round count from discussion-type level states
  let roundCount: number | null = null
  for (const level of teamConfig.levels) {
    const ls = runtimeState.levelStates.get(level.id)
    if (ls?.engineState?.type === STAGE_TYPE.DISCUSSION) {
      const maxRound = Math.max(...ls.engineState.messages.map((m) => m.round), 0)
      if (roundCount === null || maxRound > roundCount) {
        roundCount = maxRound
      }
    }
  }

  return { activeAgents, inactiveAgents, roundCount }
}

function truncateParagraph(text: string, maxChars = 360): string {
  const stripped = stripArtifactFrontmatter(text)
    .replace(/^#+\s+.*$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const firstParagraph = stripped.split(/\n\s*\n/).find((paragraph) => paragraph.trim())?.trim() ?? ''
  if (!firstParagraph) return ''
  if (firstParagraph.length <= maxChars) return firstParagraph
  const shortened = firstParagraph.slice(0, maxChars)
  const lastSpace = shortened.lastIndexOf(' ')
  return `${lastSpace > 0 ? shortened.slice(0, lastSpace) : shortened}...`
}

function findCanonicalMinutesArtifact(teamConfig: TeamConfig): string | null {
  for (const level of teamConfig.levels) {
    const stageConfig = level.stage.config as { output?: { format?: string; path?: string } }
    const format = stageConfig.output?.format
    if (!format || path.basename(format).toLowerCase() !== 'minutes.md') continue
    const artifactPath = stageConfig.output?.path ? path.join(stageConfig.output.path, format) : format
    if (artifactPath !== 'minutes.md') return artifactPath
  }
  return null
}

function deriveEvaluationOverview(
  teamConfig: TeamConfig,
  outputPath: string,
): string | null {
  const entryLevelId = teamConfig.workflow?.entry_level ?? teamConfig.levels[0]?.id
  if (!entryLevelId) return null

  const inputArtifacts = deriveEffectiveStageContractsForTeam(teamConfig, entryLevelId).input.artifacts ?? []
  for (const artifact of inputArtifacts) {
    const artifactPath = path.join(outputPath, artifact.path)
    if (!fs.existsSync(artifactPath)) continue
    const content = fs.readFileSync(artifactPath, 'utf8')
    const overview = truncateParagraph(content)
    if (overview) return overview
  }

  return null
}

function deriveMinutesContext(
  teamConfig: TeamConfig,
  outputPath: string,
): MinutesContext {
  return {
    overview: deriveEvaluationOverview(teamConfig, outputPath),
    canonicalMinutesArtifact: findCanonicalMinutesArtifact(teamConfig),
  }
}

// ─── Top-level orchestrator ──────────────────────────────────────────────────

export async function generateMinutes(
  teamConfig: TeamConfig,
  runtimeState: RuntimeState,
  outputPath: string,
  signal?: AbortSignal,
): Promise<string> {
  const entries = collectAllData(teamConfig, runtimeState, outputPath)

  if (entries.length === 0) {
    return ''
  }

  // Participation stats
  const stats = computeParticipationStats(entries, teamConfig, runtimeState)
  const minutesContext = deriveMinutesContext(teamConfig, outputPath)

  // Try LLM summarization, fall back to mechanical
  let minutesBody: string
  try {
    minutesBody = await summarizeWithLLM(
      entries,
      teamConfig,
      runtimeState,
      minutesContext,
      stats,
      outputPath,
      signal,
    )
  } catch (error) {
    if (signal?.aborted) throw error
    minutesBody = buildMechanicalMinutes(entries, minutesContext, stats)
    // Not silent. Falling back is the right answer when the summarizing model
    // cannot be used, but a run that quietly writes "LLM summarization
    // unavailable" leaves nobody able to find out what was unavailable — which
    // is how every desktop build came to ship without the prompt template this
    // helper reads, taking this path on every run, unnoticed.
    reportHelperFallback('minutes', {
      team: teamConfig.team.name,
      sessionId: runtimeState.sessionId,
      ...whenDefined(runtimeState.rootSessionId, (rootSessionId) => ({ rootSessionId })),
    })
  }

  // Build the header after summarization so its cost matches runtime state.
  const roundsLine = stats.roundCount !== null ? `**Rounds:** ${stats.roundCount}\n` : ''
  const canonicalMinutesLine = minutesContext.canonicalMinutesArtifact
    ? `**Canonical meeting record:** ${minutesContext.canonicalMinutesArtifact}\n`
    : ''

  const header =
    `# Meeting Minutes\n\n` +
    `**Team:** ${teamConfig.team.name}\n` +
    `**Session:** ${runtimeState.sessionId}\n` +
    `**Generated:** ${new Date().toISOString()}\n` +
    `**Elapsed:** ${formatElapsed(runtimeState.startTime, runtimeState.endTime)} | **Cost:** ${formatCost(runtimeState.totalCost)}\n` +
    roundsLine +
    canonicalMinutesLine +
    `\n---\n`

  const fullMinutes = header + '\n' + minutesBody + '\n'

  // Write to file
  const minutesPath = path.join(outputPath, 'minutes.md')
  writeMarkdownArtifact(
    minutesPath,
    fullMinutes,
    buildArtifactMetadata({
      filePath: minutesPath,
      rootDir: outputPath,
      artifactType: 'minutes',
      sessionId: runtimeState.sessionId,
      ...whenDefined(runtimeState.rootSessionId, (definedValue) => ({ rootSessionId: definedValue })),
      ...whenDefined(runtimeState.parentSessionId, (definedValue) => ({ parentSessionId: definedValue })),
      team: teamConfig.team.name,
      status: 'complete',
      title: 'Meeting Minutes',
    }),
  )

  return fullMinutes
}
