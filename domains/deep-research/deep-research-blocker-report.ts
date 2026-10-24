import * as fs from 'node:fs'
import * as path from 'node:path'

import { MAX_RESEARCH_ACTIVITY_PER_SESSION } from '../acquisition/acquisition-types.js'
import { MAX_BROWSER_ACTIVITY_PER_SESSION } from '../browser/browser-types.js'
import { isSafePathSegment } from '../../core/path-safety.js'
import { parseSessionRunAssignmentLocation } from '../../core/run-assignment-location.js'
import { getRunRuntimePaths } from '../runtime/runtime-paths.js'
import type { ResearchPlan } from '../../contracts/deep-research.js'
import { deepResearchWorkerSummaryPath } from './deep-research-worker-summary.js'
import {
  describeDeepResearchDiscoveryFailure,
  describeDeepResearchDiscoveryPath,
  summarizeDeepResearchDiscovery,
  type DeepResearchBrowserObservation,
  type DeepResearchDiscoverySignal,
  type DeepResearchSearchAttempt,
} from './deep-research-discovery-signal.js'

const MAX_DIAGNOSTIC_FILE_BYTES = 1_048_576

export interface DeepResearchLaneAttemptDiagnostic {
  readonly attempt?: number
  readonly outcome: string
  readonly category?: string
  readonly validatorName?: string
  readonly validatorField?: string
  readonly validatorMessage?: string
  readonly elapsedMs?: number
  readonly observationCount?: number
  readonly timeToFirstObservationMs?: number
}

export interface DeepResearchLaneDiagnostics {
  readonly laneId: string
  readonly attempts: readonly DeepResearchLaneAttemptDiagnostic[]
}

export interface DeepResearchAcquisitionDiagnostics {
  readonly observedSources: number
  readonly searchApiCalls: number
  readonly searchApiUnavailable: number
  /** Searches that returned results. One is enough to prove discovery worked. */
  readonly searchApiSucceeded: number
  /**
   * Whether either journal window — research activity or browser activity —
   * reached its retention cap, meaning older activity was dropped and these
   * counts are a tail, not the run's totals.
   */
  readonly truncated: boolean
  readonly searchProviderPriority?: readonly string[]
  readonly searchUnavailableLaneIds: readonly string[]
  /** Why searches produced nothing, by code. `no_results` is a clean empty parse. */
  readonly failedSearches: ReadonlyArray<{ readonly code: string; readonly count: number }>
  readonly blockedAcquisitions: ReadonlyArray<{ readonly code: string; readonly count: number }>
  /**
   * The authoritative answer to "did this run have a way to reach the web?",
   * spanning Exa, Brave, the managed-browser search fallback, the managed
   * browser itself and the Browser Use cloud browser.
   */
  readonly discovery: DeepResearchDiscoverySignal
}

/** A run-level blocker: search capability absence under a discovery-requiring plan. */
export interface DeepResearchSearchCapabilityBlocker {
  readonly laneIds: readonly string[]
  readonly providerPriority: readonly string[]
  /** Why every discovery attempt produced nothing, exactly as journalled. */
  readonly failureCodes: ReadonlyArray<{
    readonly code: string
    readonly count: number
  }>
}

/** Matches an absolute http(s) URL inside free-text request source requirements. */
const SUPPLIED_URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/i

/**
 * Whether the approved plan asks any researcher to discover sources itself.
 *
 * Discovery is required unless the plan **proves** otherwise. Query hints and
 * source-type requirements are the plan's explicit discovery signals, but their
 * absence proves nothing: an under-specified plan is the common case, and
 * treating it as satisfiable without search is what lets a lane guess URLs from
 * model memory instead of blocking on a missing credential.
 *
 * The only evidence that discovery is unnecessary is the brief itself naming
 * concrete URLs. `DeepResearchRequest.sourceRequirements` is free text — there
 * is no structured brief-URL field — so a supplied URL is recognised by shape.
 */
export function researchPlanRequiresDiscovery(
  approvedPlan: ResearchPlan,
): boolean {
  const declaresDiscoverySignal = approvedPlan.workerSpecs.some((workerSpec) => {
    const requirements = workerSpec.sourceRequirements
    return (
      requirements.queryHints.length > 0 ||
      requirements.preferredTypes.length > 0 ||
      requirements.requiredAuthorityTypes.length > 0
    )
  })
  if (declaresDiscoverySignal) return true
  const suppliedUrls = approvedPlan.request?.sourceRequirements ?? []
  return !suppliedUrls.some((requirement) =>
    SUPPLIED_URL_PATTERN.test(requirement),
  )
}

/**
 * Detect the absence of *any* discovery path while the plan requires discovery.
 *
 * The verdict comes from the run's one discovery signal, not from the search
 * action alone. A search that returned results proves a path existed, and so
 * does a search-results page the managed browser or the Browser Use cloud
 * browser rendered. Reading a page the lane already named does not: that is
 * acquisition, and a lane that guessed addresses from model memory still had
 * no way to find a source. When nothing worked, the recorded failure codes
 * travel with the blocker so the report can name the real cause instead of
 * assuming a missing credential.
 */
export function evaluateDeepResearchSearchCapability(input: {
  readonly approvedPlan: ResearchPlan
  readonly acquisition: DeepResearchAcquisitionDiagnostics | undefined
}): DeepResearchSearchCapabilityBlocker | undefined {
  const { acquisition } = input
  if (!acquisition) return undefined
  if (!researchPlanRequiresDiscovery(input.approvedPlan)) return undefined
  // A truncated window has lost older activity, so a successful early search
  // may simply have aged out. Blocking on it would fail a run that discovered
  // sources perfectly well.
  if (acquisition.truncated) return undefined
  // No search at all is a different fact, reported by the discovery-mode line.
  if (acquisition.searchApiCalls === 0) return undefined
  if (acquisition.discovery.succeeded) return undefined
  return {
    laneIds: acquisition.searchUnavailableLaneIds,
    providerPriority: acquisition.searchProviderPriority ?? [],
    failureCodes: acquisition.discovery.failureCodes,
  }
}

/**
 * The operator-facing body for search capability absence, shared by the
 * standalone blocker and the section embedded in the full blocker report so
 * the two can never drift apart.
 */
function searchCapabilityBody(
  blocker: DeepResearchSearchCapabilityBlocker,
): string[] {
  const priority = blocker.providerPriority.length > 0
    ? blocker.providerPriority.join(', ')
    : 'none configured'
  const lanes = blocker.laneIds.length > 0
    ? blocker.laneIds.map((laneId) => `\`${laneId}\``).join(', ')
    : 'none recorded'
  return [
    'The approved plan requires source discovery, and no discovery path',
    'returned anything: no search produced a result, and neither the managed',
    'browser nor the Browser Use cloud browser rendered a search-results page',
    `for this run. Lanes affected: ${lanes}.`,
    '',
    `- ${describeDeepResearchDiscoveryFailure(blocker.failureCodes)}`,
    `- Configured provider priority: ${priority}`,
    '',
    '**Remediation (operator action):** restore the managed browser — it is the',
    'default discovery path and needs no credential — or clear the fault named',
    'above; an Exa or Brave Search API key adds a ranked provider but only',
    'helps when the missing piece is a credential. Then re-run the research.',
    'This is not a source problem: evidence collection cannot proceed by',
    'guessing URLs.',
  ]
}

/**
 * The one-sentence operator line, shared with the pipeline so the terminal
 * report and the dispatch response can never describe the same run differently.
 */
export function describeDeepResearchSearchCapabilityBlocker(
  blocker: DeepResearchSearchCapabilityBlocker,
): string {
  const priority = blocker.providerPriority.length > 0
    ? blocker.providerPriority.join(', ')
    : 'none configured'
  return (
    'Search capability absent — the approved plan requires source discovery, ' +
    'but nothing found a source: no search returned a result and no managed ' +
    'or cloud browser rendered a search-results page. ' +
    `${describeDeepResearchDiscoveryFailure(blocker.failureCodes)} ` +
    `(provider priority: ${priority}). Restore the managed browser, which is ` +
    'the default discovery path and needs no credential, or clear the fault ' +
    'named above, then re-run the research.'
  )
}

export interface DeepResearchBlockerLane {
  readonly taskId: string
  readonly title: string
  readonly status: string
  readonly laneId?: string
  readonly displayRole?: string
  readonly summaryPath?: string
  readonly diagnostics?: DeepResearchLaneDiagnostics
}

export interface DeepResearchBlockerDeadline {
  readonly maxDurationMinutes: number
  readonly startedAt?: string
  readonly deadlineAt?: string
  readonly remainingMs?: number
}

/** Read one lane's per-attempt outcome records from the private runtime. */
export function readDeepResearchLaneDiagnostics(input: {
  readonly assignmentPath: string
  readonly laneId: string
}): DeepResearchLaneDiagnostics {
  const empty: DeepResearchLaneDiagnostics = { laneId: input.laneId, attempts: [] }
  if (!isSafePathSegment(input.laneId)) return empty
  let lanePath: string
  try {
    const { privateRuntimePath } = getRunRuntimePaths(input.assignmentPath)
    lanePath = path.join(privateRuntimePath, 'worker-logs', input.laneId)
  } catch {
    return empty
  }
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(lanePath, { withFileTypes: true })
  } catch {
    return empty
  }
  const attempts: DeepResearchLaneAttemptDiagnostic[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const outcomePath = path.join(lanePath, entry.name, 'outcome.json')
    let raw: string
    try {
      const stat = fs.statSync(outcomePath)
      if (!stat.isFile() || stat.size > MAX_DIAGNOSTIC_FILE_BYTES) continue
      raw = fs.readFileSync(outcomePath, 'utf8')
    } catch {
      continue
    }
    let parsed: Record<string, unknown>
    try {
      const value: unknown = JSON.parse(raw)
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      parsed = value as Record<string, unknown>
    } catch {
      continue
    }
    const validator = parsed.validator && typeof parsed.validator === 'object' &&
      !Array.isArray(parsed.validator)
      ? parsed.validator as Record<string, unknown>
      : undefined
    const observations = parsed.observations && typeof parsed.observations === 'object' &&
      !Array.isArray(parsed.observations)
      ? parsed.observations as Record<string, unknown>
      : undefined
    attempts.push({
      ...(typeof parsed.attempt === 'number' ? { attempt: parsed.attempt } : {}),
      outcome: typeof parsed.outcome === 'string' ? parsed.outcome : 'unknown',
      ...(typeof validator?.category === 'string' ? { category: validator.category } : {}),
      ...(typeof validator?.name === 'string' ? { validatorName: validator.name } : {}),
      ...(typeof validator?.field === 'string' ? { validatorField: validator.field } : {}),
      ...(typeof validator?.message === 'string' ? { validatorMessage: validator.message } : {}),
      ...(typeof parsed.elapsed_ms === 'number' ? { elapsedMs: parsed.elapsed_ms } : {}),
      ...(typeof observations?.count === 'number'
        ? { observationCount: observations.count }
        : {}),
      ...(typeof observations?.time_to_first_observation_ms === 'number'
        ? { timeToFirstObservationMs: observations.time_to_first_observation_ms }
        : {}),
    })
  }
  return {
    laneId: input.laneId,
    attempts: attempts.sort((a, b) => (a.attempt ?? 0) - (b.attempt ?? 0)),
  }
}

/** Read one session-scoped journal array, or nothing when it is unreadable. */
function readSessionJournal(
  workspacePath: string,
  sessionId: string,
  fileName: string,
): readonly unknown[] | undefined {
  const journalPath = path.join(
    path.resolve(workspacePath),
    'sessions',
    sessionId,
    fileName,
  )
  try {
    const stat = fs.statSync(journalPath)
    if (!stat.isFile()) return undefined
    const parsed: unknown = JSON.parse(fs.readFileSync(journalPath, 'utf8'))
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

/**
 * The page a journal entry recorded reading, when it recorded one.
 *
 * The requested and canonical URLs keep their separate roles. Only the
 * requested URL preserves the query string, so only it can be asked whether a
 * search term was actually submitted; the canonical form is the fallback for
 * an entry that recorded no requested URL.
 */
function observedPageOf(
  activity: Record<string, unknown>,
): DeepResearchBrowserObservation[] {
  const receipt = activity.observationReceipt
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return []
  }
  const record = receipt as Record<string, unknown>
  const method = record.method
  if (typeof method !== 'string') return []
  const requestedUrl = firstString([record.requestedUrl, activity.requestedUrl])
  const canonicalUrl = firstString([
    record.canonicalUrl,
    record.finalUrl,
    activity.canonicalUrl,
    activity.url,
  ])
  if (!requestedUrl && !canonicalUrl) return []
  return [{
    method,
    ...(requestedUrl ? { requestedUrl } : {}),
    ...(canonicalUrl ? { canonicalUrl } : {}),
  }]
}

function firstString(values: readonly unknown[]): string | undefined {
  return values.find(
    (value): value is string => typeof value === 'string' && value !== '',
  )
}

/**
 * Browser page observations this run actually completed.
 *
 * The `browser` tool keeps its own journal, so a worker that fell back to
 * opening a search-engine results page itself leaves no trace in the research
 * activity file. Reading only that file is what let a run whose browser was
 * plainly working be reported as having no discovery path at all.
 */
function readRunBrowserObservations(input: {
  readonly workspacePath: string
  readonly sessionId: string
  readonly runId: string
  readonly assignmentId: string
  readonly laneId?: string
}): {
  readonly observations: DeepResearchBrowserObservation[]
  /** The window reached its cap, so older observations may have aged out. */
  readonly truncated: boolean
} {
  const entries = readSessionJournal(
    input.workspacePath,
    input.sessionId,
    'browser-activity.json',
  )
  if (!entries) return { observations: [], truncated: false }
  const truncated = entries.length >= MAX_BROWSER_ACTIVITY_PER_SESSION
  const observations: DeepResearchBrowserObservation[] = []
  for (const value of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const activity = value as Record<string, unknown>
    if (activity.runId !== input.runId) continue
    if (activity.assignmentId !== input.assignmentId) continue
    if (input.laneId !== undefined && activity.activityScopeId !== input.laneId) {
      continue
    }
    if (activity.state !== 'completed') continue
    observations.push(...observedPageOf(activity))
  }
  return { observations, truncated }
}

/**
 * Summarize this lane's acquisition conditions from the session-scoped Research
 * Web activity record. The activity file is keyed by the workspace session id,
 * which an assignment path alone does not carry, so recover it first.
 */
export function readDeepResearchAcquisitionDiagnostics(input: {
  readonly workspacePath: string
  readonly assignmentPath: string
  readonly laneId?: string
}): DeepResearchAcquisitionDiagnostics | undefined {
  const location = parseSessionRunAssignmentLocation(
    input.workspacePath,
    input.assignmentPath,
  )
  if (!location) return undefined
  const entries = readSessionJournal(
    input.workspacePath,
    location.sessionId,
    'research-acquisition.json',
  )
  if (!entries) return undefined

  const searchAttempts: DeepResearchSearchAttempt[] = []
  const browserJournal = readRunBrowserObservations({
    workspacePath: input.workspacePath,
    sessionId: location.sessionId,
    runId: location.runId,
    assignmentId: location.assignmentId,
    ...(input.laneId === undefined ? {} : { laneId: input.laneId }),
  })
  const browserObservations = [...browserJournal.observations]
  let searchApiCalls = 0
  let searchApiUnavailable = 0
  let searchApiSucceeded = 0
  let observedSources = 0
  let searchProviderPriority: readonly string[] | undefined
  const unavailableLanes = new Set<string>()
  const blocked = new Map<string, number>()
  const failedSearches = new Map<string, number>()
  for (const value of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const activity = value as Record<string, unknown>
    if (activity.runId !== location.runId) continue
    if (activity.assignmentId !== location.assignmentId) continue
    if (input.laneId !== undefined && activity.activityScopeId !== input.laneId) continue
    const action = typeof activity.action === 'string' ? activity.action : ''
    const state = typeof activity.state === 'string' ? activity.state : ''
    const error = activity.error && typeof activity.error === 'object' &&
      !Array.isArray(activity.error)
      ? activity.error as Record<string, unknown>
      : undefined
    const code = typeof error?.code === 'string' ? error.code : undefined
    if (action === 'search') {
      searchApiCalls += 1
      const resultCount = typeof activity.resultCount === 'number'
        ? activity.resultCount
        : 0
      // A search proves a discovery path only when it returned something. A
      // search that completed and parsed nothing leaves the lane exactly as
      // starved as an unconfigured one, so it must not count as success and its
      // lane belongs in the same list.
      if (state === 'completed' && resultCount > 0) {
        searchApiSucceeded += 1
        searchAttempts.push({
          succeeded: true,
          ...(Array.isArray(activity.searchProviders) &&
            activity.searchProviders.every(
              (provider) => typeof provider === 'string',
            )
            ? { providers: activity.searchProviders as readonly string[] }
            : {}),
        })
      } else {
        if (typeof activity.activityScopeId === 'string' &&
            activity.activityScopeId.length > 0) {
          unavailableLanes.add(activity.activityScopeId)
        }
        const failureCode = code ?? (state === 'completed' ? 'no_results' : 'unknown')
        failedSearches.set(failureCode, (failedSearches.get(failureCode) ?? 0) + 1)
        searchAttempts.push({ succeeded: false, failureCode })
      }
      if (code === 'not_configured') {
        searchApiUnavailable += 1
        if (Array.isArray(activity.searchProviderPriority) &&
            activity.searchProviderPriority.every(
              (provider) => typeof provider === 'string',
            )) {
          searchProviderPriority = activity.searchProviderPriority as readonly string[]
        }
      }
      continue
    }
    if (action !== 'acquire') continue
    if (state === 'completed') {
      observedSources += 1
      // A browser that rendered a search-results page found something; a
      // browser that opened a URL the lane already named did not.
      browserObservations.push(...observedPageOf(activity))
      continue
    }
    if (code) blocked.set(code, (blocked.get(code) ?? 0) + 1)
  }
  return {
    observedSources,
    searchApiCalls,
    searchApiUnavailable,
    searchApiSucceeded,
    // Either window at its cap has dropped older activity, so no "nothing ever
    // happened" claim survives it.
    truncated:
      entries.length >= MAX_RESEARCH_ACTIVITY_PER_SESSION ||
      browserJournal.truncated,
    ...(searchProviderPriority ? { searchProviderPriority } : {}),
    searchUnavailableLaneIds: [...unavailableLanes].sort(),
    failedSearches: [...failedSearches.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((left, right) => left.code.localeCompare(right.code)),
    blockedAcquisitions: [...blocked.entries()]
      .map(([code, count]) => ({ code, count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    discovery: summarizeDeepResearchDiscovery({
      searches: searchAttempts,
      browserObservations,
    }),
  }
}

/** Count runtime observation receipts for one lane, whatever tool produced them. */
export function countDeepResearchLaneObservations(
  assignmentPath: string,
  laneId: string,
): number {
  if (!isSafePathSegment(laneId)) return 0
  try {
    return fs
      .readdirSync(path.join(assignmentPath, 'research', 'observations', laneId))
      .filter((name) => name.endsWith('.json')).length
  } catch {
    return 0
  }
}

/** Attach lane identity, summary link, and attempt diagnostics to each task. */
export function buildDeepResearchBlockerLanes(input: {
  readonly assignmentPath: string
  readonly approvedPlan?: ResearchPlan
  readonly tasks: ReadonlyArray<{
    readonly id: string
    readonly title: string
    readonly status: string
    readonly resultFile: string
  }>
}): DeepResearchBlockerLane[] {
  return input.tasks.map((task) => {
    const researchTask = input.approvedPlan?.tasks.find(
      (candidate) => candidate.id === task.id,
    )
    const workerSpec = researchTask
      ? input.approvedPlan?.workerSpecs.find(
        (candidate) => candidate.id === researchTask.workerSpecId,
      )
      : undefined
    if (!workerSpec) {
      return { taskId: task.id, title: task.title, status: task.status }
    }
    const wave = Number(task.resultFile.match(/wave-(\d+)/)?.[1] ?? 0)
    let summaryPath: string | undefined
    try {
      summaryPath = deepResearchWorkerSummaryPath({
        taskId: task.id,
        laneId: workerSpec.laneId,
        wave,
      })
    } catch {
      summaryPath = undefined
    }
    return {
      taskId: task.id,
      title: task.title,
      status: task.status,
      laneId: workerSpec.laneId,
      displayRole: workerSpec.displayRole,
      ...(summaryPath ? { summaryPath } : {}),
      diagnostics: readDeepResearchLaneDiagnostics({
        assignmentPath: input.assignmentPath,
        laneId: workerSpec.laneId,
      }),
    }
  })
}

function renderLaneAttempts(
  lane: DeepResearchBlockerLane,
  observedSources: number,
): string[] {
  const lines: string[] = []
  const attempts = lane.diagnostics?.attempts ?? []
  if (attempts.length === 0) {
    lines.push(
      '  - No worker attempt was recorded for this lane; it never reached dispatch.',
    )
    return lines
  }
  for (const attempt of attempts) {
    const label = attempt.attempt === undefined
      ? 'Attempt'
      : `Attempt ${attempt.attempt}`
    const elapsed = attempt.elapsedMs === undefined
      ? ''
      : ` after ${Math.round(attempt.elapsedMs / 1000)}s`
    lines.push(`  - ${label} — \`${attempt.outcome}\`${elapsed}`)
    if (attempt.validatorMessage) {
      const field = attempt.validatorField ? ` [\`${attempt.validatorField}\`]` : ''
      const category = attempt.category ? ` (\`${attempt.category}\`)` : ''
      lines.push(`    - ${attempt.validatorName ?? 'Error'}${field}${category}: ${attempt.validatorMessage}`)
    }
  }
  const last = attempts[attempts.length - 1]
  if (last?.timeToFirstObservationMs !== undefined) {
    lines.push(
      `  - First observation after ${Math.round(last.timeToFirstObservationMs / 1000)}s`,
    )
  }
  lines.push(`  - Sources observed by this lane: ${observedSources}`)
  if (lane.summaryPath) {
    lines.push(`  - Findings and observed sources: \`${lane.summaryPath}\``)
  }
  return lines
}

/**
 * The capability section embedded in the operator-facing blocker report.
 *
 * Exported so the wording an operator acts on can be asserted directly rather
 * than through the whole report.
 */
export function renderSearchCapabilitySection(
  blocker: DeepResearchSearchCapabilityBlocker,
): string[] {
  return ['## Search Capability Absent', '', ...searchCapabilityBody(blocker), '']
}

function renderAcquisitionLine(
  acquisition: DeepResearchAcquisitionDiagnostics | undefined,
): string[] {
  if (!acquisition) return []
  // Named from the discovery signal, so a run whose browser worked is never
  // described as having had no discovery path.
  const browserPaths = acquisition.discovery.successfulPaths
    .filter((discoveryPath) => discoveryPath.includes('browser'))
  const discoveryMode = acquisition.searchApiCalls === 0
    ? 'browser only (no search API calls were made)'
    : acquisition.searchApiSucceeded > 0
      ? 'search API plus managed browser'
      : browserPaths.length > 0
        ? `search failed; discovery continued through ${browserPaths
          .map(describeDeepResearchDiscoveryPath)
          .join(' and ')}`
        : acquisition.searchApiUnavailable === acquisition.searchApiCalls
          ? 'search absent (no search provider API key configured)'
          : 'search ran but returned no results'
  const failedSearchDetail = acquisition.failedSearches.length === 0
    ? ''
    : ` (${acquisition.failedSearches
      .map((entry) => `${entry.code} \u00d7${entry.count}`)
      .join(', ')})`
  const blocked = acquisition.blockedAcquisitions.length === 0
    ? 'none'
    : acquisition.blockedAcquisitions
      .map((entry) => `${entry.code} ×${entry.count}`)
      .join(', ')
  return [
    '## Run Conditions',
    '',
    `- Discovery mode: ${discoveryMode}${failedSearchDetail}`,
    `- Acquisitions blocked by the source: ${blocked}`,
    '',
  ]
}

function renderDeadline(deadline: DeepResearchBlockerDeadline | undefined): string[] {
  if (!deadline) return []
  const lines = ['## Time Budget', '', `- Approved budget: ${deadline.maxDurationMinutes} minutes`]
  if (deadline.startedAt) lines.push(`- Started at: ${deadline.startedAt}`)
  if (deadline.deadlineAt) lines.push(`- Deadline at: ${deadline.deadlineAt}`)
  if (deadline.remainingMs !== undefined) {
    lines.push(
      deadline.remainingMs <= 0
        ? `- Remaining at failure: none (exceeded by ${Math.round(Math.abs(deadline.remainingMs) / 1000)}s)`
        : `- Remaining at failure: ${Math.round(deadline.remainingMs / 1000)}s`,
    )
  }
  lines.push('')
  return lines
}

/**
 * Render the user-facing terminal blocker. It states, per failed lane, what the
 * worker was asked, how many attempts it made, the exact runtime rejection, and
 * where the observed evidence is — so a blocked run explains itself without a
 * private-runtime read.
 */
export function renderDeepResearchBlocker(input: {
  readonly lanes: readonly DeepResearchBlockerLane[]
  readonly observationsByLane?: Readonly<Record<string, number>>
  readonly acquisition?: DeepResearchAcquisitionDiagnostics
  readonly searchCapability?: DeepResearchSearchCapabilityBlocker
  readonly deadline?: DeepResearchBlockerDeadline
}): string {
  const lines = ['# Deep Research Blocked', '', '**Status:** BLOCKED', '', '## Hard Gaps', '']
  for (const lane of input.lanes) {
    const identity = lane.displayRole && lane.laneId
      ? ` — ${lane.displayRole} (lane \`${lane.laneId}\`)`
      : ''
    lines.push(`- \`${lane.taskId}\` (${lane.status}): ${lane.title}${identity}`)
    const observedSources = lane.laneId === undefined
      ? 0
      : input.observationsByLane?.[lane.laneId] ?? 0
    lines.push(...renderLaneAttempts(lane, observedSources))
  }
  lines.push('')
  if (input.searchCapability) {
    lines.push(...renderSearchCapabilitySection(input.searchCapability))
  }
  lines.push(...renderAcquisitionLine(input.acquisition))
  lines.push(...renderDeadline(input.deadline))
  lines.push(
    'The evidence collection plan reached a terminal state without all lanes succeeding. ',
    'No verified research report can be published from this run. Review the failed lanes, ',
    'source access, deadline, or task scope before retrying.',
  )
  return lines.join('\n')
}
