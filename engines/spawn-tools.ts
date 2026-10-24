/**
 * Team Runtime — Dynamic Spawn Tools
 *
 * Registry-backed delegation tools that let a coordinator spawn specialist
 * teams from `teams.yaml` at runtime, with policy enforcement.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { whenDefined } from '../core/optional-properties.js'
import { Type } from 'typebox'
import { Text } from '@earendil-works/pi-tui'
import { defineTool } from '@earendil-works/pi-coding-agent'
import type {
  AgentMetrics,
  DelegationStatusSnapshot,
  LevelPermissions,
  RegistryEntry,
  RuntimeState,
  TeamConfig,
  TeamRegistryEntry,
  OutputConfig,
} from '../core/types.js'
import { roundUsd, type BudgetLedger } from '../core/budget-ledger.js'
import { AGENT_STATE } from '../core/constants.js'
import {
  acquireSpawnPolicy,
  type SpawnBudgetAdmission,
} from '../core/spawn-policy.js'
import { runTeam } from '../domains/agent-execution/agent-runner.js'
import {
  buildArtifactMetadata,
  parseMarkdownArtifact,
  writeMarkdownArtifact,
} from '../domains/runtime/artifacts.js'
import {
  buildDelegationInvocationContract,
  buildDelegationResultContract,
  resolveDelegationRequest,
} from '../domains/delegation/delegation-contracts.js'
import {
  buildReceptionJobRequest,
  buildReceptionRoutingDecision,
  buildUserFacingResultEnvelope,
} from '../domains/delegation/reception-contracts.js'
import {
  resolveTitleSummarizerConfig,
  summarizeJobTitle,
} from '../domains/job-title/job-title-summarizer.js'
import { getAssignmentLogPath, logDelegationEvent, logTeamSpawn } from '../domains/runtime/logger.js'
import { recordDelegationLifecycle } from '../domains/delegation/delegation-lifecycle.js'
import { buildStageEntryFollowUp } from '../domains/stage/stage-entry.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../core/run-assignment-location.js'
import { getPreferredParsedMarkdownPaths } from '../parsers/input-files.js'
import { buildChildAssignmentLocation } from '../domains/runtime/runtime-paths.js'
import type { RunAssignmentLocation } from '../domains/run/run-location.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export interface SpawnTeamContext {
  teamName: string
  teamConfig: TeamConfig
  teamRegistry: Map<string, RegistryEntry>
  teamRootPath?: string
  inputFilesContent?: string
  agentMetrics?: Map<string, AgentMetrics>
  permissions?: LevelPermissions
  levelId: string
  stageType?: string
  routingOutput?: OutputConfig
  outputPath: string
  state: RuntimeState
  assignmentLocation?: RunAssignmentLocation
  shutdownSignal?: AbortSignal
  onDashboardUpdate?: () => void
  budgetLedger?: BudgetLedger
  adoptCapabilityBudget?: (toolCallId: string) =>
    SpawnBudgetAdmission | undefined
  activeSpawnCountRef: { count: number }
  coordinatorName?: string
  getCurrentCoordinatorRunId?: () => number
  setDelegationStatus?: (delegationId: string, snapshot: DelegationStatusSnapshot | null) => void
}

export interface SpawnTeamDependencies {
  runTeamImpl?: typeof runTeam
}

export function getSpawnableTeams(teamRegistry: Map<string, RegistryEntry>): TeamRegistryEntry[] {
  return [...teamRegistry.values()]
    .filter((entry): entry is TeamRegistryEntry => entry.type === 'team')
    .sort((a, b) => a.name.localeCompare(b.name))
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'team'
}

function requireSpawnPermission(permissions: LevelPermissions | undefined): void {
  if (!permissions?.spawn_teams) {
    throw new Error('Dynamic team spawning is not enabled for this level.')
  }
}

function requireTeamEntry(teamName: string, teamRegistry: Map<string, RegistryEntry>): TeamRegistryEntry {
  const entry = teamRegistry.get(teamName)
  if (!entry) {
    const available = getSpawnableTeams(teamRegistry).map((candidate) => candidate.name)
    throw new Error(
      available.length > 0
        ? `Unknown team '${teamName}'. Available registered teams: ${available.join(', ')}`
        : `Unknown team '${teamName}'. No registered team entries are available.`,
    )
  }
  if (entry.type !== 'team') {
    throw new Error(`Registry entry '${teamName}' is type '${entry.type}', not type 'team'.`)
  }
  return entry
}

function combineSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter(
    (signal): signal is AbortSignal => signal !== undefined,
  )
  if (activeSignals.length === 0) return undefined
  if (activeSignals.length === 1) return activeSignals[0]
  return AbortSignal.any(activeSignals)
}

const DELEGATION_SOURCE_EMBED_MAX_CHARS = 80_000
const DEICTIC_CONTINUATION_PATTERN = /\b(this|that|it|from it|from this|from that|the finished one|the last one|that result|that output)\b/i

/**
 * The local artifact paths a delegation brief refers to.
 *
 * The brief is prose a model wrote, so the pattern has to tell a path from a
 * sentence. Starting at any `/` and running to a later extension does not: it
 * reads `and/or the report.md` as `/or the report.md`, and a URL ending in
 * `.html` as a path on disk. Neither is harmless, because a single false match
 * takes the explicit-path branch and switches input bundling off for the whole
 * delegation without saying so.
 *
 * So an unquoted path must begin where a path plausibly begins — at the start of
 * a line, or after whitespace, an opening bracket, a quote or a backtick, never
 * mid-word and never after the `:` or `/` of a URL — and no segment of it may
 * contain a space, a quote or a backtick. Backticks are in that opening set and
 * excluded from the path body deliberately: a model writing a brief reaches for
 * `` `/path/to/file.md` `` more often than it writes the path bare, and a false
 * negative is no better than a false positive — either one silently switches off
 * input bundling for the whole delegation.
 *
 * A path that really does contain spaces is still reachable: quote it, which is
 * what the quoted pattern above is for.
 */
export function extractLocalArtifactPaths(text: string): string[] {
  const matches = new Set<string>()

  const quotedAbsolutePathPattern = /["'](\/[^"'\n]+)["']/g
  for (const match of text.matchAll(quotedAbsolutePathPattern)) {
    if (match[1]) matches.add(match[1].trim())
  }

  const absoluteFilePattern =
    /(?:^|[\s(\[`'"])(\/(?:[^\s/`'"]+\/)*[^\s/`'"]+\.(?:md|txt|json|ya?ml|csv|html|xml))/gm
  for (const match of text.matchAll(absoluteFilePattern)) {
    const candidate = match[1]?.trim().replace(/[.,;:]+$/, '')
    if (candidate) matches.add(candidate)
  }

  return [...matches]
}

/**
 * Whether a path named in a brief may actually be read.
 *
 * The brief is written by a model, and a model can be induced to name a path by
 * an uploaded document, a carried Team reply, or a user message. Without a root
 * to check against, "compare this with /Users/me/.aws/credentials.json" reads
 * that file and inlines up to 80,000 characters of it into a child team's
 * prompt — from where it can be echoed into a run artifact. Existence and
 * absoluteness were the only tests, and neither is a permission.
 *
 * Resolved through the filesystem, not just lexically. `path.resolve` collapses
 * `..` but knows nothing about links, so a symlink planted inside an allowed
 * root still pointed wherever it liked — and a symlinked *directory* escapes
 * with one link rather than one per file. Both sides are realpath'd, which also
 * keeps the legitimate case working where the root itself is reached through a
 * link (on macOS `/tmp` is a symlink to `/private/tmp`, so comparing a resolved
 * file against an unresolved root would refuse every real path under it).
 *
 * A path that cannot be resolved does not exist, or is not reachable, and is
 * refused. The separator is required so `/work` does not admit
 * `/workspace-secrets`.
 */
function realpathOrNull(candidate: string): string | null {
  try {
    return fs.realpathSync.native(candidate)
  } catch {
    return null
  }
}

function isReadablePath(filePath: string, allowedRoots: readonly string[]): boolean {
  if (!path.isAbsolute(filePath)) return false
  const resolved = realpathOrNull(filePath)
  if (resolved === null) return false
  // A run's private state is reserved, and every other reader in the repo
  // refuses the segment outright (`resolveOwnedRunRelativePath` throws on it).
  // Rooting at the run would otherwise hand a delegation every sibling
  // assignment's execution journal — full prompts and responses — along with
  // its checkpoints and capability results.
  return allowedRoots.some((root) => {
    const resolvedRoot = realpathOrNull(root)
    if (resolvedRoot === null) return false
    if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
      return false
    }
    // Relative to the root, not over the whole absolute path: a workspace that
    // happens to sit under a directory called `.runtime` would otherwise refuse
    // every legitimate read beneath it. This is how run-store.ts scopes the
    // same rule.
    return !hasPrivateRuntimeSegment(resolved, resolvedRoot)
  })
}

/** True when a path reaches into a run's private state, relative to its root. */
function hasPrivateRuntimeSegment(resolved: string, resolvedRoot: string): boolean {
  return path
    .relative(resolvedRoot, resolved)
    .split(path.sep)
    .some((segment) =>
      segment.toLowerCase() === RUN_PRIVATE_RUNTIME_DIRECTORY_NAME.toLowerCase())
}

export function buildDelegationSourceAppendix(
  brief: string,
  allowedRoots: readonly string[],
  /**
   * Specific files the runtime itself resolved, permitted by name.
   *
   * Not a root. These are paths the runtime chose and already knows are this
   * run's own output, which is how the legacy layout — where no run location
   * exists to root against — reaches a child's artifact without opening a
   * directory for a model-written brief to range over.
   */
  permittedPaths: readonly string[] = [],
  /**
   * What a permitted path's private-state check is measured against.
   *
   * The same anchor the root check uses, so both answer the question the same
   * way. Without it the check would run over the absolute path and refuse a
   * legitimate artifact whose workspace merely sits under a `.runtime` name.
   */
  privateStateAnchor?: string,
): { enrichedBrief: string; artifactRefs: string[] } {
  const artifactRefs: string[] = []
  const sections: string[] = []
  // Permitted paths still answer to the private-state rule. The permit exists
  // to name a file the runtime chose, not to exempt it from what the runtime
  // refuses everywhere else.
  // Measured relative to the anchor, exactly as the root check is. Scanning the
  // whole absolute path instead would silently drop the permit for a workspace
  // that happens to live under a directory named `.runtime` — the brief would
  // still say "source of truth" and the body would never arrive.
  const permitAnchor = privateStateAnchor
    ? realpathOrNull(privateStateAnchor)
    : null
  const permitted = new Set(
    permittedPaths
      .map((candidate) => realpathOrNull(candidate))
      .filter((candidate): candidate is string =>
        candidate !== null &&
        !hasPrivateRuntimeSegment(candidate, permitAnchor ?? path.parse(candidate).root)),
  )

  for (const filePath of extractLocalArtifactPaths(brief)) {
    const resolvedCandidate = realpathOrNull(filePath) ?? filePath
    if (
      !permitted.has(resolvedCandidate) &&
      !isReadablePath(filePath, allowedRoots)
    ) {
      continue
    }
    if (!fs.existsSync(filePath)) continue

    let content: string
    try {
      content = fs.readFileSync(filePath, 'utf8')
    } catch {
      continue
    }

    artifactRefs.push(filePath)
    const truncated = content.length > DELEGATION_SOURCE_EMBED_MAX_CHARS
    const embeddedContent = truncated
      ? content.slice(0, DELEGATION_SOURCE_EMBED_MAX_CHARS)
      : content

    sections.push(
      `### Source Artifact: ${filePath}`,
      '',
      truncated
        ? `Note: embedded source content was truncated to the first ${DELEGATION_SOURCE_EMBED_MAX_CHARS} characters.`
        : 'Note: embedded source content is included below so the child team can work from the actual artifact body.',
      '',
      '```md',
      embeddedContent,
      '```',
    )
  }

  if (sections.length === 0) {
    return { enrichedBrief: brief, artifactRefs: [] }
  }

  return {
    enrichedBrief: [
      brief,
      '',
      '## Embedded Source Artifacts',
      '',
      'Use the embedded source content below as the working input for the delegated task.',
      '',
      ...sections,
    ].join('\n'),
    artifactRefs,
  }
}

function materializeInputSourceBundle(params: {
  outputPath: string
  teamRootPath?: string
  inputFilesContent?: string
}): { bundlePath: string; parsedPaths: string[] } | null {
  const inputFilesContent = params.inputFilesContent?.trim()
  if (!inputFilesContent) return null

  const inputDir = params.teamRootPath ? path.join(params.teamRootPath, 'input-files') : ''
  const parsedPaths = inputDir ? getPreferredParsedMarkdownPaths(inputDir) : []
  const bundlePath = path.join(params.outputPath, 'active-input-files.md')

  const body = [
    '# Active Input Files',
    '',
    '## Preferred Parsed Source Artifacts',
    '',
    ...(parsedPaths.length > 0
      ? parsedPaths.map((filePath) => `- ${filePath}`)
      : ['- none']),
    '',
    '## Combined Content',
    '',
    inputFilesContent,
  ].join('\n')

  writeMarkdownArtifact(
    bundlePath,
    body,
    buildArtifactMetadata({
      filePath: bundlePath,
      rootDir: params.outputPath,
      artifactType: 'contract',
      status: 'completed',
      title: 'Active input source bundle',
    }),
  )

  return { bundlePath, parsedPaths }
}

function getLatestCompletedChildArtifact(outputPath: string): string | null {
  const delegationsLogPath = getAssignmentLogPath(outputPath, 'delegations.jsonl')
  if (!fs.existsSync(delegationsLogPath)) return null

  const lines = fs.readFileSync(delegationsLogPath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    try {
      const event: unknown = JSON.parse(line)
      if (!isRecord(event)) continue
      const status = typeof event.status === 'string' ? event.status : ''
      const artifactPath = typeof event.child_output_artifact === 'string' ? event.child_output_artifact : ''
      if ((status === 'completed' || status === 'completed_with_warnings') && artifactPath && fs.existsSync(artifactPath)) {
        return artifactPath
      }
    } catch {
      continue
    }
  }

  return null
}

/**
 * Exported for tests only: which permit each brief-phrasing branch passes is the
 * thing that regressed, and it cannot be seen from `buildDelegationSourceAppendix`.
 */
export function resolveDelegationSourceBriefForTest(params: {
  brief: string
  outputPath: string
  runPath?: string
  stageType?: string
  teamRootPath?: string
  inputFilesContent?: string
}): { childBrief: string; artifactRefs: string[] } {
  return resolveDelegationSourceBrief(params)
}

function resolveDelegationSourceBrief(params: {
  brief: string
  outputPath: string
  /** The run that owns this assignment and every sibling a child writes into. */
  runPath?: string
  stageType?: string
  teamRootPath?: string
  inputFilesContent?: string
}): { childBrief: string; artifactRefs: string[] } {
  // Where a delegation may read from: this run, and the team's own directory.
  //
  // The run, not the parent's assignment directory. A child writes into a
  // SIBLING assignment under the same run — `<run>/assignments/<child>` beside
  // `<run>/assignments/<parent>` — so rooting at `outputPath` refused every
  // artifact the deictic-continuation branch exists to embed, while the brief
  // still told the child to treat it as the source of truth. Nothing said so.
  const allowedRoots = [
    params.outputPath,
    ...(params.runPath ? [params.runPath] : []),
    ...(params.teamRootPath ? [params.teamRootPath] : []),
  ]
  // The legacy CLI layout has no run location, so `runPath` is absent and a
  // child's sibling assignment sits under no allowed root. Rather than widen
  // the roots to the whole workspace there, the one artifact this branch
  // resolved is permitted by name: a specific file the runtime chose, not a
  // directory a brief can range over.
  const permitPath = (candidate: string | undefined): readonly string[] =>
    candidate === undefined ? [] : [candidate]
  // The run's own most recent child result, whichever branch reaches for it.
  // A brief that names the path explicitly is asking for the same file the
  // deictic branch would have bound, so it earns the same permit — otherwise
  // the embed works or does not purely according to how the brief was phrased,
  // and in the legacy layout the explicit phrasing silently loses.
  const latestChildArtifact = getLatestCompletedChildArtifact(params.outputPath)

  const explicitArtifacts = extractLocalArtifactPaths(params.brief)
  if (explicitArtifacts.length > 0) {
    const enriched = buildDelegationSourceAppendix(
      params.brief,
      allowedRoots,
      permitPath(latestChildArtifact ?? undefined),
      path.dirname(params.outputPath),
    )
    return { childBrief: enriched.enrichedBrief, artifactRefs: enriched.artifactRefs }
  }

  const sourceBundle = materializeInputSourceBundle({
    outputPath: params.outputPath,
    ...whenDefined(params.teamRootPath, (teamRootPath) => ({ teamRootPath })),
    ...whenDefined(params.inputFilesContent, (inputFilesContent) => ({
      inputFilesContent,
    })),
  })

  if (sourceBundle && params.stageType === 'routing') {
    const enriched = buildDelegationSourceAppendix(
      `${params.brief}\n\nUse the active parsed input bundle at "${sourceBundle.bundlePath}" as the source of truth.`,
      allowedRoots,
    )
    return {
      childBrief: enriched.enrichedBrief,
      artifactRefs: [...new Set([sourceBundle.bundlePath, ...sourceBundle.parsedPaths, ...enriched.artifactRefs])],
    }
  }

  const shouldBindLatestArtifact =
    params.stageType === 'routing' &&
    DEICTIC_CONTINUATION_PATTERN.test(params.brief)

  if (!shouldBindLatestArtifact) {
    return { childBrief: params.brief, artifactRefs: [] }
  }

  if (!latestChildArtifact) {
    return { childBrief: params.brief, artifactRefs: [] }
  }

  const enriched = buildDelegationSourceAppendix(
    `${params.brief}\n\nUse the latest completed child artifact at "${latestChildArtifact}" as the source of truth.`,
    allowedRoots,
    permitPath(latestChildArtifact),
    path.dirname(params.outputPath),
  )
  return { childBrief: enriched.enrichedBrief, artifactRefs: enriched.artifactRefs }
}

function inferDelegationTerminalStatus(params: {
  result: Awaited<ReturnType<typeof runTeam>>
}): 'completed' | 'completed_with_warnings' | 'blocked' | 'failed' {
  const { result } = params
  if (result.status) return result.status

  // Compatibility fallback for injected legacy runners that have not adopted
  // the structured TeamRunResult.status field yet.
  const artifactCandidates = [result.artifactPath, result.assignmentPath ? path.join(result.assignmentPath, 'final-draft.md') : '']
    .filter(Boolean)

  for (const artifactPath of artifactCandidates) {
    if (!artifactPath || !fs.existsSync(artifactPath)) continue
    const parsed = parseMarkdownArtifact(fs.readFileSync(artifactPath, 'utf8'))
    const artifactStatus = parsed.metadata.status
    if (artifactStatus === 'approved_with_warnings') return 'completed_with_warnings'
  }

  const blockedByOutputText =
    /Child stage blocked/i.test(result.text) ||
    /Review Blocked/i.test(result.text) ||
    /Max iterations \(\d+\) reached/i.test(result.text)

  const reviewEventsPath = result.assignmentPath
    ? path.join(result.assignmentPath, 'logs', 'review-events.jsonl')
    : ''
  const blockedByReviewLoop =
    Boolean(reviewEventsPath) &&
    fs.existsSync(reviewEventsPath) &&
    /"step":"loop\.max-iterations-reached"/.test(fs.readFileSync(reviewEventsPath, 'utf8'))

  if (blockedByOutputText || blockedByReviewLoop) return 'blocked'
  return result.succeeded ? 'completed' : 'failed'
}

function ensureDelegatedTeamMetrics(ctx: SpawnTeamContext, teamEntry: TeamRegistryEntry): AgentMetrics {
  if (!ctx.agentMetrics) {
    return {
      state: AGENT_STATE.IDLE,
      rounds: 0,
      totalCost: 0,
      contextTokens: 0,
      model: teamEntry.host_model || 'team',
      color: 141,
      failureCount: 0,
    }
  }

  const existing = ctx.agentMetrics.get(teamEntry.name)
  if (existing) return existing

  const rosterEntry = ctx.teamConfig.agents.find((entry) => entry.name === teamEntry.name)
  const metrics: AgentMetrics = {
    state: AGENT_STATE.IDLE,
    rounds: 0,
    totalCost: 0,
    contextTokens: 0,
    model: rosterEntry?.host_model || teamEntry.host_model || 'team',
    color: rosterEntry?.color ?? 141,
    failureCount: 0,
  }
  ctx.agentMetrics.set(teamEntry.name, metrics)
  return metrics
}

function markDelegatedTeamActive(ctx: SpawnTeamContext, teamEntry: TeamRegistryEntry): void {
  const metrics = ensureDelegatedTeamMetrics(ctx, teamEntry)
  metrics.state = AGENT_STATE.ACTIVE
  metrics.activeStartedAt = Date.now()
  delete metrics.lastError
}

function markDelegatedTeamCompleted(ctx: SpawnTeamContext, teamEntry: TeamRegistryEntry, cost: number): void {
  const metrics = ensureDelegatedTeamMetrics(ctx, teamEntry)
  metrics.state = AGENT_STATE.DONE
  delete metrics.activeStartedAt
  metrics.totalCost = roundUsd(metrics.totalCost + cost)
  delete metrics.lastError
}

function markDelegatedTeamFailed(ctx: SpawnTeamContext, teamEntry: TeamRegistryEntry, error: unknown): void {
  const metrics = ensureDelegatedTeamMetrics(ctx, teamEntry)
  metrics.state = AGENT_STATE.ERROR
  delete metrics.activeStartedAt
  metrics.failureCount += 1
  metrics.lastError = error instanceof Error ? error.message : String(error)
}

function markDelegatedTeamBlocked(ctx: SpawnTeamContext, teamEntry: TeamRegistryEntry, reason: string): void {
  const metrics = ensureDelegatedTeamMetrics(ctx, teamEntry)
  metrics.state = AGENT_STATE.ERROR
  delete metrics.activeStartedAt
  metrics.lastError = reason
}

export function createSpawnTeamTool(
  ctx: SpawnTeamContext,
  deps: SpawnTeamDependencies = {},
) {
  const runTeamImpl = deps.runTeamImpl ?? runTeam
  let lastRoutingCoordinatorRunId: number | null = null
  let routingSpawnAttempted = false

  return defineTool({
    name: 'spawn_team',
    label: 'Spawn Specialist Team',
    description:
      'Delegate a focused brief to a registered specialist team from teams.yaml. ' +
      'Use this when the current coordinator should route work to another team rather than solve it locally.',
    promptSnippet:
      'Use `spawn_team` to delegate by registry name to a specialist team listed in teams.yaml. ' +
      'Pass a concise but complete brief.',
    promptGuidelines: [
      'Only spawn a specialist team when delegation is justified by the task.',
      'Use the exact registry name from the available teams list.',
      'Write the brief so the child team can act without another round of clarification whenever possible.',
      'Treat the tool result as authoritative. Do not claim delegation succeeded if the tool failed.',
      'For intake routing stages, after a successful delegation send at most one short acknowledgment and stop.',
    ],
    parameters: Type.Object({
      team: Type.String({
        description: 'Registry name of the specialist team to spawn',
      }),
      brief: Type.String({
        description: 'Delegated brief for the child team',
      }),
      result_type: Type.Optional(Type.String({
        description:
          'Optional requested child result type. Accepts artifact:<path> or a raw artifact path. ' +
          'When omitted, the child team default result is requested.',
      })),
      rationale: Type.Optional(Type.String({
        description: 'Optional note explaining why this team was chosen',
      })),
    }),

    async execute(_toolCallId, params, _signal, _onUpdate, _extensionCtx) {
      if (ctx.stageType === 'routing') {
        const coordinatorRunId = ctx.getCurrentCoordinatorRunId?.() ?? 0
        if (lastRoutingCoordinatorRunId !== coordinatorRunId) {
          lastRoutingCoordinatorRunId = coordinatorRunId
          routingSpawnAttempted = false
        }
        if (routingSpawnAttempted) {
          throw new Error(
            'Routing stages may call spawn_team at most once per coordinator turn. ' +
            'If delegation fails, stop and report the failure instead of retrying or switching teams.',
          )
        }
        routingSpawnAttempted = true
      }

      requireSpawnPermission(ctx.permissions)
      if (params.team === ctx.teamName) {
        throw new Error(`Refusing to spawn '${params.team}' from itself.`)
      }
      const teamEntry = requireTeamEntry(params.team, ctx.teamRegistry)
      const budgetAdmission = ctx.adoptCapabilityBudget?.(_toolCallId)
      const spawnPolicy = await acquireSpawnPolicy({
        state: ctx.state,
        teamConfig: ctx.teamConfig,
        activeSpawnCountRef: ctx.activeSpawnCountRef,
        ...whenDefined(ctx.budgetLedger, (budgetLedger) => ({ budgetLedger })),
        ...(budgetAdmission ? { budgetAdmission } : {}),
        subject: 'team',
      })
      try {
      const remainingBudget = spawnPolicy.remainingBudget

      const safeTeamName = sanitizeName(params.team)
      const delegationToken = randomUUID()
      const delegationId = `${ctx.state.sessionId}:${safeTeamName}:${delegationToken}`
      const parentJobId = ctx.state.sessionId
      const rootJobId = ctx.state.rootSessionId ?? ctx.state.sessionId
      const delegationRequest = resolveDelegationRequest({
        teamEntry,
        ...whenDefined(params.result_type, (requestedResultType) => ({
          requestedResultType,
        })),
      })
      const briefArtifactPath = path.join(
        ctx.outputPath,
        `delegation-${safeTeamName}-${delegationToken}-brief.md`,
      )
      const resultArtifactPath = path.join(
        ctx.outputPath,
        `delegation-${safeTeamName}-${delegationToken}-result.md`,
      )
      const jobRequestPath = path.join(ctx.outputPath, 'job-request.md')
      const childWorkspacePath = ctx.teamConfig.workspace.path
      const now = new Date()
      const childSessionId = `child-${safeTeamName}-${delegationToken}`
      const childAssignmentPath = buildChildAssignmentLocation(
        childWorkspacePath,
        ctx.assignmentLocation,
        childSessionId,
      )?.assignmentPath ?? path.join(
        childWorkspacePath,
        'assignments',
        childSessionId,
      )
      const enrichedDelegation = resolveDelegationSourceBrief({
        brief: params.brief,
        outputPath: ctx.outputPath,
        // Children write into sibling assignments under this same run, so the
        // run is the boundary that lets a parent read what its child produced.
        ...whenDefined(ctx.assignmentLocation, (location) => ({
          runPath: location.runPath,
        })),
        ...whenDefined(ctx.stageType, (stageType) => ({ stageType })),
        ...whenDefined(ctx.teamRootPath, (teamRootPath) => ({ teamRootPath })),
        ...whenDefined(ctx.inputFilesContent, (inputFilesContent) => ({
          inputFilesContent,
        })),
      })
      const childBrief = enrichedDelegation.childBrief
      const invocationContract = buildDelegationInvocationContract({
        jobId: delegationId,
        parentJobId,
        rootJobId,
        callerTeam: ctx.teamName,
        targetTeam: params.team,
        ...whenDefined(teamEntry.requested_capability, (requestedCapability) => ({
          requestedCapability,
        })),
        requestedResultType: delegationRequest.requestedResultType,
        inputPayload: childBrief,
        inputArtifactRefs: [briefArtifactPath, ...enrichedDelegation.artifactRefs],
        ...whenDefined(remainingBudget, (budgetUsd) => ({ budgetUsd })),
        lineageMetadata: {
          parent_level: ctx.levelId,
          parent_agent: ctx.coordinatorName ?? ctx.teamName,
        },
      })

      const routingRationale = params.rationale || 'No rationale provided.'

      writeMarkdownArtifact(
        briefArtifactPath,
        [
          `# Delegation Brief`,
          '',
          `## Target Team`,
          '',
          params.team,
          '',
          `## Rationale`,
          '',
          routingRationale,
          '',
          `## Invocation Contract`,
          '',
          '```json',
          JSON.stringify(invocationContract, null, 2),
          '```',
          '',
          `## Brief`,
          '',
          childBrief,
        ].join('\n'),
        buildArtifactMetadata({
          filePath: briefArtifactPath,
          rootDir: ctx.outputPath,
          artifactType: 'handoff',
          sessionId: ctx.state.sessionId,
          ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
          ...whenDefined(ctx.state.parentSessionId, (parentSessionId) => ({ parentSessionId })),
          from: ctx.coordinatorName ?? ctx.teamName,
          to: params.team,
          team: ctx.teamName,
          level: ctx.levelId,
          status: 'delegated',
          title: `Delegation to ${params.team}`,
        }),
      )

      const titleSummarizerConfig = ctx.stageType === 'routing'
        ? resolveTitleSummarizerConfig()
        : null
      const generatedJobTitle = titleSummarizerConfig
        ? await summarizeJobTitle({
            brief: childBrief,
            config: titleSummarizerConfig,
            ...whenDefined(ctx.shutdownSignal, (signal) => ({ signal })),
            // Recorded before the send, in this delegation's own journal and
            // under its own identity. Naming a job is the routing stage's own
            // work and owns no Agent, so it is disclosed as the job title's
            // selection — never as an Agent's, and never as a host's.
            onSelected: async (selection) => {
              try {
                logDelegationEvent(ctx.outputPath, {
                  timestamp: new Date().toISOString(),
                  // Named, so a reader can tell this one fact from every other
                  // thing a delegation records. Without it the published event
                  // is a generic `delegation.event` and anything looking for
                  // this account would have to guess from the presence of a
                  // selection.
                  event: 'delegation.job_title_selected',
                  job_id: delegationId,
                  delegation_id: delegationId,
                  // The root this account belongs to. A run reads a child
                  // assignment's events only where they say which root they
                  // are under (`run-store.ts:378`), so without this a nested
                  // routing Team names a job, records it correctly, and is
                  // seen by nobody.
                  root_session_id: ctx.state.rootSessionId,
                  // The runtime that made this call, and its real parent —
                  // not the job it named. Naming is this runtime's own work;
                  // the delegated job's identity is carried by `delegation_id`
                  // above. Recording this runtime as its own parent would
                  // publish an edge describing a runtime that spawned itself.
                  session_id: ctx.state.sessionId,
                  parent_session_id: ctx.state.parentSessionId,
                  from_team: ctx.teamName,
                  from_level: ctx.levelId,
                  to_team: params.team,
                  status: 'naming',
                  model_selection: selection,
                })
                return true
              } catch {
                // The account could not be written, so nothing may be asked.
                return false
              }
            },
          })
        : null

      const initialJobRequest = ctx.stageType === 'routing'
        ? buildReceptionJobRequest({
            targetTeam: params.team,
            requestedResultType: delegationRequest.requestedResultType,
            brief: childBrief,
            rationale: routingRationale,
            jobTitle: generatedJobTitle,
          })
        : null

      if (initialJobRequest) {
        writeMarkdownArtifact(
          jobRequestPath,
          [
            '# Job Request',
            '',
            '## Title',
            '',
            initialJobRequest.job_title,
            '',
            '## Contract',
            '',
            '```json',
            JSON.stringify(initialJobRequest, null, 2),
            '```',
            '',
            '## Intake Summary',
            '',
            initialJobRequest.input_summary,
          ].join('\n'),
          buildArtifactMetadata({
            filePath: jobRequestPath,
            rootDir: ctx.outputPath,
            artifactType: 'contract',
            sessionId: ctx.state.sessionId,
            ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
            ...whenDefined(ctx.state.parentSessionId, (parentSessionId) => ({ parentSessionId })),
            from: ctx.coordinatorName ?? ctx.teamName,
            to: params.team,
            team: ctx.teamName,
            level: ctx.levelId,
            ...whenDefined(ctx.stageType, (stageType) => ({ stageType })),
            status: 'delegated',
            title: `Job request for ${params.team}`,
          }),
        )
      }

      const routingDecisionPath = ctx.routingOutput
        ? path.join(ctx.outputPath, ctx.routingOutput.path ?? '', ctx.routingOutput.format)
        : path.join(ctx.outputPath, 'routing-decision.md')
      const buildLifecycleSnapshot = (
        status: DelegationStatusSnapshot['status'],
        extra: Partial<DelegationStatusSnapshot> = {},
      ): DelegationStatusSnapshot => ({
        jobId: delegationId,
        parentJobId,
        rootJobId,
        delegationId,
        fromTeam: ctx.teamName,
        fromLevel: ctx.levelId,
        fromAgent: ctx.coordinatorName ?? ctx.teamName,
        toTeam: params.team,
        requestedResultType: delegationRequest.requestedResultType,
        childSessionId,
        childAssignmentPath,
        briefArtifact: briefArtifactPath,
        resultArtifact: resultArtifactPath,
        startedAt: now.toISOString(),
        status,
        lastEventAt: new Date().toISOString(),
        ...extra,
      })

      recordDelegationLifecycle(ctx.outputPath, buildLifecycleSnapshot('queued'))

      logTeamSpawn(
        ctx.outputPath,
        ctx.teamName,
        ctx.levelId,
        ctx.coordinatorName ?? ctx.teamName,
        params.team,
        childBrief,
        ctx.state.spawnDepth + 1,
        childSessionId,
        childAssignmentPath,
        briefArtifactPath,
        resultArtifactPath,
        ctx.state.rootSessionId,
      )

      logDelegationEvent(ctx.outputPath, {
        timestamp: new Date().toISOString(),
        job_id: delegationId,
        parent_job_id: parentJobId,
        root_job_id: rootJobId,
        delegation_id: delegationId,
        root_session_id: ctx.state.rootSessionId,
        parent_session_id: ctx.state.sessionId,
        child_session_id: childSessionId,
        from: ctx.coordinatorName ?? ctx.teamName,
        to: params.team,
        from_team: ctx.teamName,
        from_level: ctx.levelId,
        from_agent: ctx.coordinatorName ?? ctx.teamName,
        to_team: params.team,
        brief_artifact: briefArtifactPath,
        result_artifact: resultArtifactPath,
        child_assignment_path: childAssignmentPath,
        requested_result_type: delegationRequest.requestedResultType,
        requested_artifact: delegationRequest.requestedArtifact,
        status: 'validating_contract',
      })
      recordDelegationLifecycle(ctx.outputPath, buildLifecycleSnapshot('validating_contract'))

      logDelegationEvent(ctx.outputPath, {
        timestamp: new Date().toISOString(),
        job_id: delegationId,
        parent_job_id: parentJobId,
        root_job_id: rootJobId,
        delegation_id: delegationId,
        root_session_id: ctx.state.rootSessionId,
        parent_session_id: ctx.state.sessionId,
        child_session_id: childSessionId,
        from: ctx.coordinatorName ?? ctx.teamName,
        to: params.team,
        from_team: ctx.teamName,
        from_level: ctx.levelId,
        from_agent: ctx.coordinatorName ?? ctx.teamName,
        to_team: params.team,
        brief_artifact: briefArtifactPath,
        result_artifact: resultArtifactPath,
        child_assignment_path: childAssignmentPath,
        requested_result_type: delegationRequest.requestedResultType,
        requested_artifact: delegationRequest.requestedArtifact,
        status: 'accepted',
      })
      recordDelegationLifecycle(ctx.outputPath, buildLifecycleSnapshot('accepted'))

      markDelegatedTeamActive(ctx, teamEntry)
      const runningSnapshot = buildLifecycleSnapshot('running')
      recordDelegationLifecycle(ctx.outputPath, runningSnapshot)
      ctx.setDelegationStatus?.(delegationId, runningSnapshot)
      if (ctx.onDashboardUpdate) ctx.onDashboardUpdate()
      let terminalDelegationStatus: 'blocked' | 'failed' | null = null

      try {
        const entryLevelId = delegationRequest.childContract.teamConfig.workflow?.entry_level
          ?? delegationRequest.childContract.teamConfig.levels[0]?.id
        const entryLevel = delegationRequest.childContract.teamConfig.levels.find((level) => level.id === entryLevelId)
        const result = await runTeamImpl({
          teamPath: teamEntry.team_path,
          workspacePath: childWorkspacePath,
          workspacePathOverride: ctx.teamConfig.workspace.path,
          brief: childBrief,
          childSessionId,
          bootEntry: teamEntry,
          ...whenDefined(
            entryLevel
              ? buildStageEntryFollowUp(entryLevel, delegationRequest.childContract.inputArtifact, childBrief)
              : undefined,
            (kickoffPrompt) => ({ kickoffPrompt }),
          ),
          inputArtifact: delegationRequest.childContract.inputArtifact,
          outputArtifact: delegationRequest.requestedArtifact,
          requestedResultType: delegationRequest.requestedResultType,
          spawnDepth: ctx.state.spawnDepth,
          ...whenDefined(combineSignals(ctx.shutdownSignal, _signal), (signal) => ({ signal })),
          ...whenDefined(remainingBudget, (budgetUsd) => ({ budgetUsd })),
          ...whenDefined(ctx.budgetLedger?.policy, (budgetPolicy) => ({ budgetPolicy })),
          ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
          parentSessionId: ctx.state.sessionId,
          ...whenDefined(ctx.assignmentLocation, (parentAssignmentLocation) => ({
            parentAssignmentLocation,
          })),
        })

        ctx.state.totalCost = roundUsd(ctx.state.totalCost + result.cost)
        const parsedResult = parseMarkdownArtifact(result.text)
        const resultBody = parsedResult.body.trim() || result.text.trim() || '[No result returned]'
        const finalArtifactPath = result.artifactPath || '[No child artifact path returned]'
        const delegationStatus = inferDelegationTerminalStatus({ result })
        const resultContract = buildDelegationResultContract({
          jobId: delegationId,
          parentJobId,
          rootJobId,
          team: params.team,
          resultType: result.requestedResultType ?? delegationRequest.requestedResultType,
          status: delegationStatus,
          ...whenDefined(result.artifactPath || undefined, (primaryArtifact) => ({
            primaryArtifact,
          })),
          ...(delegationStatus === 'completed' ? {} : { diagnostics: [resultBody] }),
          lineage: {
            parent_team: ctx.teamName,
            parent_level: ctx.levelId,
          },
        })

        writeMarkdownArtifact(
          resultArtifactPath,
          [
            `# Delegation Result`,
            '',
            `## Target Team`,
            '',
            params.team,
            '',
            `## Child Output Artifact`,
            '',
            finalArtifactPath,
            '',
            `## Result Contract`,
            '',
            '```json',
            JSON.stringify(resultContract, null, 2),
            '```',
            '',
            `## Result`,
            '',
            resultBody,
          ].join('\n'),
          buildArtifactMetadata({
            filePath: resultArtifactPath,
            rootDir: ctx.outputPath,
            artifactType: 'result',
            sessionId: ctx.state.sessionId,
            ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
            ...whenDefined(ctx.state.parentSessionId, (parentSessionId) => ({ parentSessionId })),
            from: params.team,
            to: ctx.coordinatorName ?? ctx.teamName,
            team: ctx.teamName,
            level: ctx.levelId,
            status: delegationStatus,
            title: `Delegation result from ${params.team}`,
          }),
        )

        logDelegationEvent(ctx.outputPath, {
          timestamp: new Date().toISOString(),
          job_id: delegationId,
          parent_job_id: parentJobId,
          root_job_id: rootJobId,
          delegation_id: delegationId,
          root_session_id: ctx.state.rootSessionId,
          parent_session_id: ctx.state.sessionId,
          child_session_id: result.childSessionId,
          from: ctx.coordinatorName ?? ctx.teamName,
          to: params.team,
          from_team: ctx.teamName,
          from_level: ctx.levelId,
          from_agent: ctx.coordinatorName ?? ctx.teamName,
          to_team: params.team,
          brief_artifact: briefArtifactPath,
          result_artifact: resultArtifactPath,
          child_assignment_path: result.assignmentPath,
          child_output_artifact: finalArtifactPath,
          requested_result_type: result.requestedResultType ?? delegationRequest.requestedResultType,
          status: delegationStatus,
        })
        const terminalSnapshot = buildLifecycleSnapshot(delegationStatus, {
          requestedResultType: result.requestedResultType ?? delegationRequest.requestedResultType,
          childSessionId: result.childSessionId,
          childAssignmentPath: result.assignmentPath,
          status: delegationStatus,
          lastArtifact: finalArtifactPath,
        })
        recordDelegationLifecycle(ctx.outputPath, terminalSnapshot)
        ctx.setDelegationStatus?.(delegationId, terminalSnapshot)
        if (delegationStatus === 'blocked') {
          markDelegatedTeamBlocked(ctx, teamEntry, resultBody)
        } else if (delegationStatus === 'failed') {
          markDelegatedTeamFailed(ctx, teamEntry, resultBody)
        } else {
          markDelegatedTeamCompleted(ctx, teamEntry, result.cost)
        }

        if (delegationStatus === 'failed' || delegationStatus === 'blocked') {
          terminalDelegationStatus = delegationStatus
          throw new Error(
            `Team run ${delegationStatus}: ${params.team}\n` +
            `Delegation brief: ${briefArtifactPath}\n` +
            `Delegation result: ${resultArtifactPath}\n\n` +
            `${resultBody}`,
          )
        }

        if (ctx.stageType === 'routing' && initialJobRequest) {
          const routingDecision = buildReceptionRoutingDecision({
            targetTeam: params.team,
            requestedResultType: delegationRequest.requestedResultType,
            rationale: routingRationale,
            jobRequestPath,
            briefArtifactPath,
            resultArtifactPath,
          })
          const userResult = buildUserFacingResultEnvelope({
            childStatus: delegationStatus,
            ...whenDefined(result.artifactPath || undefined, (primaryArtifact) => ({
              primaryArtifact,
            })),
            summarySource: resultBody,
            lineage: {
              receptionist_team: ctx.teamName,
              child_team: params.team,
            },
          })

          writeMarkdownArtifact(
            routingDecisionPath,
            [
              '# Routing Decision',
              '',
              '## Job Request',
              '',
              `- Request type: ${initialJobRequest.request_type}`,
              `- Target team: ${initialJobRequest.target_team}`,
              `- Requested result: ${initialJobRequest.requested_result_type}`,
              '',
              '```json',
              JSON.stringify(initialJobRequest, null, 2),
              '```',
              '',
              '## Request',
              '',
              childBrief,
              '',
              '## Routing Decision',
              '',
              `Delegated to: ${params.team}`,
              '',
              routingRationale,
              '',
              '```json',
              JSON.stringify(routingDecision, null, 2),
              '```',
              '',
              '## Requested Result',
              '',
              `- Result type: ${delegationRequest.requestedResultType}`,
              `- Child artifact: ${delegationRequest.requestedArtifact}`,
              '',
              '## Delegation Artifacts',
              '',
              `- Job request: ${jobRequestPath}`,
              `- Brief: ${briefArtifactPath}`,
              `- Result: ${resultArtifactPath}`,
              '',
              '## User Result Envelope',
              '',
              '```json',
              JSON.stringify(userResult, null, 2),
              '```',
            ].join('\n'),
            buildArtifactMetadata({
              filePath: routingDecisionPath,
              rootDir: ctx.outputPath,
              artifactType: 'report',
              sessionId: ctx.state.sessionId,
              ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
              ...whenDefined(ctx.state.parentSessionId, (parentSessionId) => ({ parentSessionId })),
              from: ctx.coordinatorName ?? ctx.teamName,
              to: params.team,
              team: ctx.teamName,
              level: ctx.levelId,
              ...whenDefined(ctx.stageType, (stageType) => ({ stageType })),
              status: 'delegated',
              title: `Routing decision for ${params.team}`,
            }),
          )
        } else {
          writeMarkdownArtifact(
            routingDecisionPath,
            [
              '# Routing Decision',
              '',
              '## Request',
              '',
              childBrief,
              '',
              '## Routing Decision',
              '',
              `Delegated to: ${params.team}`,
              '',
              routingRationale,
              '',
              '## Requested Result',
              '',
              `- Result type: ${delegationRequest.requestedResultType}`,
              `- Child artifact: ${delegationRequest.requestedArtifact}`,
              '',
              '## Delegation Artifacts',
              '',
              `- Brief: ${briefArtifactPath}`,
              `- Result: ${resultArtifactPath}`,
            ].join('\n'),
            buildArtifactMetadata({
              filePath: routingDecisionPath,
              rootDir: ctx.outputPath,
              artifactType: 'report',
              sessionId: ctx.state.sessionId,
              ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
              ...whenDefined(ctx.state.parentSessionId, (parentSessionId) => ({ parentSessionId })),
              from: ctx.coordinatorName ?? ctx.teamName,
              to: params.team,
              team: ctx.teamName,
              level: ctx.levelId,
              status: 'delegated',
              title: `Routing decision for ${params.team}`,
            }),
          )
        }

        return {
          content: [{
            type: 'text' as const,
            text:
              `Spawned team: ${params.team}\n` +
              `Delegation brief: ${briefArtifactPath}\n` +
              `Delegation result: ${resultArtifactPath}\n\n` +
              `${resultBody}`,
          }],
          details: undefined,
        }
      } catch (err) {
        // Keep an auditable routing artifact even when the child failed before
        // the normal success-path decision document could be written.
        if (!fs.existsSync(routingDecisionPath)) {
          const failureReason = err instanceof Error ? err.message : String(err)
          try {
            writeMarkdownArtifact(
              routingDecisionPath,
              [
                '# Routing Decision',
                '',
                `Delegated to: ${params.team}`,
                `Status: ${terminalDelegationStatus ?? 'failed'}`,
                '',
                '## Request',
                '',
                childBrief,
                '',
                '## Delegation Artifacts',
                '',
                `- Brief: ${briefArtifactPath}`,
                `- Result: ${resultArtifactPath}`,
                '',
                '## Failure',
                '',
                failureReason,
              ].join('\n'),
              buildArtifactMetadata({
                filePath: routingDecisionPath,
                rootDir: ctx.outputPath,
                artifactType: 'report',
                sessionId: ctx.state.sessionId,
                ...whenDefined(ctx.state.rootSessionId, (rootSessionId) => ({ rootSessionId })),
                ...whenDefined(ctx.state.parentSessionId, (parentSessionId) => ({ parentSessionId })),
                from: ctx.coordinatorName ?? ctx.teamName,
                to: params.team,
                team: ctx.teamName,
                level: ctx.levelId,
                ...whenDefined(ctx.stageType, (stageType) => ({ stageType })),
                status: terminalDelegationStatus ?? 'failed',
                title: `Failed routing decision for ${params.team}`,
              }),
            )
          } catch (writeError) {
            // The audit artifact is best-effort: a write failure must not
            // mask the original delegation error.
            console.error(
              `[spawn-tools] Failed to write routing decision artifact: ${
                writeError instanceof Error ? writeError.message : String(writeError)
              }`,
            )
          }
        }
        if (!terminalDelegationStatus) {
          logDelegationEvent(ctx.outputPath, {
            timestamp: new Date().toISOString(),
            job_id: delegationId,
            parent_job_id: parentJobId,
            root_job_id: rootJobId,
            delegation_id: delegationId,
            root_session_id: ctx.state.rootSessionId,
            parent_session_id: ctx.state.sessionId,
            child_session_id: childSessionId,
            from: ctx.coordinatorName ?? ctx.teamName,
            to: params.team,
            from_team: ctx.teamName,
            from_level: ctx.levelId,
            from_agent: ctx.coordinatorName ?? ctx.teamName,
            to_team: params.team,
            brief_artifact: briefArtifactPath,
            result_artifact: resultArtifactPath,
            child_assignment_path: childAssignmentPath,
            requested_result_type: delegationRequest.requestedResultType,
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          })
          const failedSnapshot = buildLifecycleSnapshot('failed', {
            failureReason: err instanceof Error ? err.message : String(err),
          })
          recordDelegationLifecycle(ctx.outputPath, failedSnapshot)
          ctx.setDelegationStatus?.(delegationId, failedSnapshot)
          markDelegatedTeamFailed(ctx, teamEntry, err)
        }
        throw err
      } finally {
        ctx.setDelegationStatus?.(delegationId, null)
        if (ctx.onDashboardUpdate) ctx.onDashboardUpdate()
      }
      } finally {
        spawnPolicy.release()
      }
    },

    renderCall(args, theme) {
      const team = (args as Record<string, unknown>).team as string ?? 'unknown-team'
      return new Text(`${theme.fg('accent', 'spawn_team')} -> ${team}`)
    },

    renderResult(result, _options, theme) {
      const text = (result.content?.[0] as { text?: string })?.text ?? ''
      const firstLine = text.split('\n')[0] || 'Spawn complete'
      return new Text(theme.fg('success', firstLine))
    },
  })
}
