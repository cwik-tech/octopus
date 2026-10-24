/**
 * Search-capability precondition for discovery-requiring research plans.
 *
 * Contract: when the approved plan asks researchers to discover sources and
 * every recorded search call failed because no provider credential exists,
 * the run blocks with a dedicated capability blocker instead of letting
 * lanes route around a missing operator configuration. A plan satisfiable
 * from supplied URLs must never be blocked for lacking search, and the
 * managed-browser fallback must never be promoted by this check.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  evaluateDeepResearchSearchCapability,
  researchPlanRequiresDiscovery,
  readDeepResearchAcquisitionDiagnostics,
  renderDeepResearchBlocker,
  renderSearchCapabilitySection,
} from '../../domains/deep-research/deep-research-blocker-report.js'
import { describeDeepResearchDiscoveryRemediation } from '../../domains/deep-research/deep-research-discovery-signal.js'
import { MAX_RESEARCH_ACTIVITY_PER_SESSION } from '../../domains/acquisition/acquisition-types.js'
import { MAX_BROWSER_ACTIVITY_PER_SESSION } from '../../domains/browser/browser-types.js'
import { MCP_RUNTIME_CONTRACT_VERSION } from '../../domains/mcp/mcp-runtime.js'
import { AcquisitionSettingsService } from '../../services/acquisition-settings-service.js'
import { ResearchWebToolService } from '../../services/research-web-tool-service.js'
import type { ResearchPlan } from '../../contracts/deep-research.js'

const SESSION_ID = 'session-capability'
const RUN_ID = 'run-capability'
const ASSIGNMENT_ID = 'assignment-capability'

function makeRun(): { workspacePath: string; assignmentPath: string } {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-capability-')),
  )
  const assignmentPath = path.join(
    workspacePath,
    'sessions',
    SESSION_ID,
    'runs',
    RUN_ID,
    'assignments',
    ASSIGNMENT_ID,
  )
  fs.mkdirSync(assignmentPath, { recursive: true })
  return { workspacePath, assignmentPath }
}

function makePlan(input: {
  readonly queryHints?: readonly string[]
  readonly preferredTypes?: readonly string[]
  readonly requiredAuthorityTypes?: readonly string[]
  /** Free-text request source requirements, the only brief-supplied URL channel. */
  readonly requestSourceRequirements?: readonly string[]
}): ResearchPlan {
  return {
    schemaVersion: 1,
    planId: 'plan-one',
    requestId: 'request-one',
    request: {
      sourceRequirements: input.requestSourceRequirements ?? [],
    } as ResearchPlan['request'],
    sections: [],
    tasks: [{
      schemaVersion: 1,
      id: 'T1',
      sectionId: 'section-one',
      title: 'Task T1',
      question: 'Question?',
      purpose: 'evidence_acquisition',
      workerSpecId: 'worker-T1',
      dependsOn: [],
      correctionWave: 0,
    }],
    workerSpecs: [{
      schemaVersion: 1,
      id: 'worker-T1',
      laneId: 'lane-1',
      sectionId: 'section-one',
      baseAgent: 'web-researcher',
      displayRole: 'Evidence Analyst 1',
      domain: 'ice cream',
      lens: 'foundational',
      methodCardIds: ['general-research-v1'],
      specialistStance: 'Stance.',
      question: 'Question?',
      decisionUse: 'Report.',
      workingDefinitions: [],
      dependencyClaimIds: [],
      sourceRequirements: {
        preferredTypes: input.preferredTypes ?? [],
        requiredAuthorityTypes: input.requiredAuthorityTypes ?? [],
        queryHints: input.queryHints ?? [],
      },
      prohibitedAssumptions: [],
      stopRule: {
        minimumPrimarySources: 0,
        minimumIndependentSources: 1,
        maximumSources: 5,
      },
      limits: { deadlineMs: 60_000 },
    }],
    maxDurationMinutes: 20,
    maxResearcherAgents: 8,
    expectedPeakWorkers: 1,
    authenticatedDomains: [],
  } as ResearchPlan
}

function writeActivity(
  workspacePath: string,
  entries: ReadonlyArray<Record<string, unknown>>,
): void {
  fs.mkdirSync(path.join(workspacePath, 'sessions', SESSION_ID), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(workspacePath, 'sessions', SESSION_ID, 'research-acquisition.json'),
    JSON.stringify(entries),
  )
}

function activity(entry: {
  readonly index: number
  readonly action: 'search' | 'acquire'
  readonly state: 'completed' | 'failed'
  readonly code?: string
  readonly laneId?: string
  readonly providerPriority?: readonly string[]
  /** Overrides the default result count for a completed search. */
  readonly resultCount?: number
}): Record<string, unknown> {
  return {
    activityId: `activity-${entry.index}`,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    assignmentId: ASSIGNMENT_ID,
    activityScopeId: entry.laneId ?? 'lane-1',
    agentPath: 'agents/web-researcher',
    toolCallId: `call-${entry.index}`,
    action: entry.action,
    state: entry.state,
    createdAt: '2026-08-18T17:44:42.000Z',
    updatedAt: '2026-08-18T17:44:43.000Z',
    attempts: [],
    ...(entry.state === 'completed' ? { resultCount: entry.resultCount ?? 5 } : {}),
    ...(entry.code ? { error: { code: entry.code, message: entry.code } } : {}),
    ...(entry.providerPriority
      ? { searchProviderPriority: [...entry.providerPriority] }
      : {}),
  }
}

test('a plan with query hints or source-type requirements requires discovery', () => {
  assert.equal(
    researchPlanRequiresDiscovery(makePlan({ queryHints: ['ice cream detroit'] })),
    true,
    'query hints ask for search-driven discovery',
  )
  assert.equal(
    researchPlanRequiresDiscovery(
      makePlan({ requiredAuthorityTypes: ['primary'] }),
    ),
    true,
    'source-type requirements still expect discovery',
  )
  assert.equal(
    researchPlanRequiresDiscovery(makePlan({})),
    true,
    'absent an explicit signal, discovery is required',
  )
})

test('discovery is required unless the plan proves it is satisfiable from supplied URLs', () => {
  assert.equal(
    researchPlanRequiresDiscovery(
      makePlan({ requestSourceRequirements: ['Use https://example.com/annual-report'] }),
    ),
    false,
    'a brief supplying a concrete URL proves discovery is unnecessary',
  )
  assert.equal(
    researchPlanRequiresDiscovery(
      makePlan({ requestSourceRequirements: ['Prefer peer-reviewed journals'] }),
    ),
    true,
    'free-text preferences supply no URL and do not prove anything',
  )
  assert.equal(
    researchPlanRequiresDiscovery(
      makePlan({
        queryHints: ['ice cream detroit'],
        requestSourceRequirements: ['Use https://example.com/annual-report'],
      }),
    ),
    true,
    'an explicit discovery signal outranks supplied URLs',
  )
})

test('acquisition diagnostics recover the provider priority and unavailable lanes', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({
        index: 0,
        action: 'search',
        state: 'failed',
        code: 'not_configured',
        laneId: 'lane-1',
        providerPriority: ['exa', 'brave'],
      }),
      activity({
        index: 1,
        action: 'search',
        state: 'failed',
        code: 'not_configured',
        laneId: 'lane-2',
        providerPriority: ['exa', 'brave'],
      }),
    ])

    const diagnostics = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.equal(diagnostics?.searchApiCalls, 2)
    assert.equal(diagnostics?.searchApiUnavailable, 2)
    assert.deepEqual(diagnostics?.searchUnavailableLaneIds, ['lane-1', 'lane-2'])
    assert.deepEqual(diagnostics?.searchProviderPriority, ['exa', 'brave'])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('every search call unavailable under a discovery plan yields a capability blocker', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({
        index: 0,
        action: 'search',
        state: 'failed',
        code: 'not_configured',
        providerPriority: ['exa', 'brave'],
      }),
    ])

    const blocker = evaluateDeepResearchSearchCapability({
      approvedPlan: makePlan({ queryHints: ['ice cream detroit'] }),
      acquisition: readDeepResearchAcquisitionDiagnostics({
        workspacePath,
        assignmentPath,
      }),
    })
    assert.ok(blocker, 'the capability blocker fires')
    assert.deepEqual(blocker.laneIds, ['lane-1'])
    assert.deepEqual(blocker.providerPriority, ['exa', 'brave'])

    const rendered = renderSearchCapabilitySection(blocker).join('\n')
    assert.match(rendered, /search capability/i)
    assert.match(rendered, /exa, brave/)
    assert.match(rendered, /API key|credential/i)
    assert.match(
      rendered,
      /managed browser/i,
      'the keyless discovery path is named, so a key never reads as the only remedy',
    )
    assert.doesNotMatch(
      rendered,
      /add an Exa or Brave Search API key in\s*acquisition settings, then re-run/,
      'buying a key is no longer the sole prescribed remediation',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a plan satisfiable from supplied URLs is never blocked for lacking search', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({
        index: 0,
        action: 'search',
        state: 'failed',
        code: 'not_configured',
      }),
    ])

    const blocker = evaluateDeepResearchSearchCapability({
      approvedPlan: makePlan({
        requestSourceRequirements: ['Use https://example.com/annual-report'],
      }),
      acquisition: readDeepResearchAcquisitionDiagnostics({
        workspacePath,
        assignmentPath,
      }),
    })
    assert.equal(blocker, undefined)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a working search provider never triggers the capability blocker', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'completed' }),
      activity({
        index: 1,
        action: 'acquire',
        state: 'failed',
        code: 'empty_content',
      }),
    ])

    const blocker = evaluateDeepResearchSearchCapability({
      approvedPlan: makePlan({ queryHints: ['ice cream detroit'] }),
      acquisition: readDeepResearchAcquisitionDiagnostics({
        workspacePath,
        assignmentPath,
      }),
    })
    assert.equal(
      blocker,
      undefined,
      'source failures are not capability absence',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('failed acquisitions without search calls do not trigger the capability blocker', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({
        index: 0,
        action: 'acquire',
        state: 'failed',
        code: 'browser_unavailable',
      }),
    ])

    const blocker = evaluateDeepResearchSearchCapability({
      approvedPlan: makePlan({ queryHints: ['ice cream detroit'] }),
      acquisition: readDeepResearchAcquisitionDiagnostics({
        workspacePath,
        assignmentPath,
      }),
    })
    assert.equal(
      blocker,
      undefined,
      'the optional managed-browser fallback must not be promoted',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a truncated activity window cannot prove every search failed', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    // The writer keeps only the newest MAX_RESEARCH_ACTIVITY_PER_SESSION
    // entries, so a window at the cap has lost older activity: a successful
    // early search may have been dropped and no "every call failed" claim
    // can be made from what remains.
    writeActivity(
      workspacePath,
      Array.from({ length: MAX_RESEARCH_ACTIVITY_PER_SESSION }, (_unused, index) =>
        activity({
          index,
          action: 'search',
          state: 'failed',
          code: 'not_configured',
          providerPriority: ['exa', 'brave'],
        }),
      ),
    )

    const diagnostics = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.equal(diagnostics?.truncated, true, 'the truncated window is reported')
    assert.equal(
      evaluateDeepResearchSearchCapability({
        approvedPlan: makePlan({ queryHints: ['ice cream detroit'] }),
        acquisition: diagnostics,
      }),
      undefined,
      'a blocker asserting "every" must not be raised from a partial window',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an unrelated search failure never suppresses the capability blocker', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({
        index: 0,
        action: 'search',
        state: 'failed',
        code: 'not_configured',
        providerPriority: ['exa', 'brave'],
      }),
      activity({
        index: 1,
        action: 'search',
        state: 'failed',
        code: 'budget_exhausted',
      }),
    ])

    assert.ok(
      evaluateDeepResearchSearchCapability({
        approvedPlan: makePlan({ queryHints: ['ice cream detroit'] }),
        acquisition: readDeepResearchAcquisitionDiagnostics({
          workspacePath,
          assignmentPath,
        }),
      }),
      'an exhausted budget is not evidence that discovery was available',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})


test('a search that completes with no results is a discovery failure, not discovery', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    // The managed-browser fallback answers without an API key, so its searches
    // complete. When its parse yields nothing they complete with zero results,
    // which is the same outcome for the lane as having no search at all.
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'completed', resultCount: 0 }),
      activity({ index: 1, action: 'search', state: 'completed', resultCount: 0 }),
    ])

    const diagnostics = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(diagnostics)
    assert.equal(diagnostics.searchApiCalls, 2)
    assert.equal(
      diagnostics.searchApiSucceeded,
      0,
      'a search that returned nothing did not prove a discovery path',
    )

    const blocker = evaluateDeepResearchSearchCapability({
      approvedPlan: makePlan({ queryHints: ['ice cream detroit'] }),
      acquisition: diagnostics,
    })
    assert.ok(blocker, 'a discovery plan whose every search returned nothing must block')
    assert.deepEqual(blocker.laneIds, ['lane-1'])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the run conditions never claim search worked when no search returned anything', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'completed', resultCount: 0 }),
    ])
    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)

    const report = renderDeepResearchBlocker({
      lanes: [{ taskId: 'T1', status: 'failed', title: 'Find shops' }],
      acquisition,
    })
    assert.doesNotMatch(
      report,
      /Discovery mode: search API plus managed browser/,
      'telling the operator discovery worked is the opposite of what happened',
    )
    assert.match(report, /Discovery mode: search ran but returned no results/)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})


test('a search refused by a bot challenge blocks and is named in the run conditions', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    // A challenge page is neither a missing credential nor an exhausted web.
    // It leaves the lane with no discovery path, so it must block the same way
    // and say so by code rather than being folded into a generic failure.
    writeActivity(workspacePath, [
      activity({
        index: 0,
        action: 'search',
        state: 'failed',
        code: 'access_challenge',
      }),
    ])

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    assert.equal(acquisition.searchApiSucceeded, 0)
    assert.deepEqual(
      acquisition.searchUnavailableLaneIds,
      ['lane-1'],
      'the lane had no discovery path and belongs in the unavailable list',
    )
    assert.deepEqual(
      acquisition.failedSearches,
      [{ code: 'access_challenge', count: 1 }],
      'the reason a search produced nothing is recorded by code',
    )

    const blocker = evaluateDeepResearchSearchCapability({
      approvedPlan: makePlan({ queryHints: ['ice cream detroit'] }),
      acquisition,
    })
    assert.ok(blocker, 'a discovery plan whose only search was refused must block')

    const report = renderDeepResearchBlocker({
      lanes: [{ taskId: 'T1', status: 'failed', title: 'Find shops' }],
      acquisition,
    })
    assert.doesNotMatch(report, /Discovery mode: search API plus managed browser/)
    assert.match(report, /access_challenge/)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

function writeBrowserActivity(
  workspacePath: string,
  entries: ReadonlyArray<Record<string, unknown>>,
): void {
  fs.mkdirSync(path.join(workspacePath, 'sessions', SESSION_ID), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(workspacePath, 'sessions', SESSION_ID, 'browser-activity.json'),
    JSON.stringify(entries),
  )
}

/**
 * One managed-browser or cloud-browser page observation, as the tool records
 * it: `requestedUrl` keeps the query string and `url`/`canonicalUrl` do not,
 * exactly as the observed session journal did.
 */
function browserActivity(entry: {
  readonly index: number
  readonly state: 'completed' | 'failed'
  readonly method?: string
  readonly url?: string
  readonly requestedUrl?: string
  readonly laneId?: string
  readonly code?: string
}): Record<string, unknown> {
  return {
    activityId: `browser-activity-${entry.index}`,
    sessionId: SESSION_ID,
    runId: RUN_ID,
    assignmentId: ASSIGNMENT_ID,
    activityScopeId: entry.laneId ?? 'lane-1',
    agentPath: 'agents/web-researcher',
    toolCallId: `browser-call-${entry.index}`,
    action: 'open',
    argumentNames: ['action', 'url'],
    state: entry.state,
    createdAt: '2026-08-31T17:47:34.581Z',
    updatedAt: '2026-08-31T17:47:36.581Z',
    ...(entry.url ? { url: entry.url } : {}),
    ...(entry.state === 'completed'
      ? {
          observationReceipt: {
            schemaVersion: 5,
            receiptId: `receipt-${entry.index}`,
            activityId: `browser-activity-${entry.index}`,
            activityScopeId: entry.laneId ?? 'lane-1',
            relativePath: `research/observations/${entry.laneId ?? 'lane-1'}/receipt-${entry.index}.json`,
            method: entry.method ?? 'managed-browser',
            requestedUrl:
              entry.requestedUrl ?? entry.url ?? 'https://www.bing.com/search?q=sushi',
            finalUrl: entry.url ?? 'https://www.bing.com/search',
            canonicalUrl: entry.url ?? 'https://www.bing.com/search',
            observedAt: '2026-08-31T17:47:36.552Z',
          },
        }
      : {}),
    ...(entry.code ? { error: { code: entry.code, message: entry.code } } : {}),
  }
}

test('an internal search failure is never reported as a missing credential', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    // The observed regression: five searches failed because the acquisition
    // settings file could not be read. The run still had no discovery path, so
    // it blocks — but calling that `not_configured` sends the operator to buy
    // an API key for a fault a key cannot fix.
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'failed', code: 'internal' }),
      activity({ index: 1, action: 'search', state: 'failed', code: 'internal' }),
    ])

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    const blocker = evaluateDeepResearchSearchCapability({
      approvedPlan: makePlan({ queryHints: ['sushi detroit'] }),
      acquisition,
    })
    assert.ok(blocker, 'no discovery path at all still blocks')
    assert.deepEqual(blocker.failureCodes, [{ code: 'internal', count: 2 }])

    const rendered = renderSearchCapabilitySection(blocker).join('\n')
    assert.match(rendered, /`internal`/, 'the recorded cause is named')
    assert.doesNotMatch(
      rendered,
      /not_configured/,
      'a runtime fault must never be described as an unconfigured provider',
    )

    const report = renderDeepResearchBlocker({
      lanes: [{ taskId: 'T1', status: 'failed', title: 'Find sushi bars' }],
      acquisition,
      searchCapability: blocker,
    })
    assert.doesNotMatch(report, /not_configured/)
    assert.doesNotMatch(
      report,
      /Discovery mode: search absent \(no search provider API key configured\)/,
      'the run conditions must not claim a key was missing either',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a managed-browser render suppresses the blocker every search could not clear', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'failed', code: 'internal' }),
      activity({ index: 1, action: 'search', state: 'failed', code: 'internal' }),
      activity({ index: 2, action: 'acquire', state: 'completed' }),
    ])
    writeBrowserActivity(workspacePath, [
      browserActivity({
        index: 0,
        state: 'completed',
        method: 'managed-browser',
        requestedUrl: 'https://www.bing.com/search?q=downtown+detroit+sushi',
        url: 'https://www.bing.com/search',
      }),
    ])

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    assert.equal(acquisition.discovery.succeeded, true)
    assert.deepEqual(acquisition.discovery.successfulPaths, ['managed-browser'])
    assert.equal(
      evaluateDeepResearchSearchCapability({
        approvedPlan: makePlan({ queryHints: ['sushi detroit'] }),
        acquisition,
      }),
      undefined,
      'the browser reached the web, so no discovery path was absent',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a Browser Use cloud search-results page suppresses the blocker', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'failed', code: 'not_configured' }),
      {
        ...activity({ index: 1, action: 'acquire', state: 'completed' }),
        observationReceipt: {
          schemaVersion: 5,
          receiptId: 'cloud-receipt',
          activityId: 'activity-1',
          activityScopeId: 'lane-1',
          relativePath: 'research/observations/lane-1/cloud-receipt.json',
          method: 'cloud-browser',
          requestedUrl: 'https://duckduckgo.com/html?q=downtown+detroit+sushi',
          finalUrl: 'https://html.duckduckgo.com/html',
          canonicalUrl: 'https://html.duckduckgo.com/html',
          observedAt: '2026-08-31T17:47:36.552Z',
        },
      },
    ])

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    assert.deepEqual(acquisition.discovery.successfulPaths, ['cloud-browser'])
    assert.equal(
      evaluateDeepResearchSearchCapability({
        approvedPlan: makePlan({ queryHints: ['sushi detroit'] }),
        acquisition,
      }),
      undefined,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a Brave search that returned results suppresses the blocker', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'failed', code: 'internal' }),
      {
        ...activity({ index: 1, action: 'search', state: 'completed' }),
        searchProviders: ['brave'],
      },
    ])

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    assert.deepEqual(acquisition.discovery.successfulPaths, ['brave'])
    assert.equal(
      evaluateDeepResearchSearchCapability({
        approvedPlan: makePlan({ queryHints: ['sushi detroit'] }),
        acquisition,
      }),
      undefined,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('genuine absence of every discovery path still blocks with the recorded cause', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    // No provider key, no managed browser: the search action reports capability
    // absence and the browser journal has nothing but its own failures.
    writeActivity(workspacePath, [
      activity({
        index: 0,
        action: 'search',
        state: 'failed',
        code: 'not_configured',
        providerPriority: ['exa', 'brave'],
      }),
    ])
    writeBrowserActivity(workspacePath, [
      browserActivity({ index: 0, state: 'failed', code: 'browser_unavailable' }),
    ])

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    assert.equal(acquisition.discovery.succeeded, false)
    const blocker = evaluateDeepResearchSearchCapability({
      approvedPlan: makePlan({ queryHints: ['sushi detroit'] }),
      acquisition,
    })
    assert.ok(blocker, 'fail-closed behaviour is preserved')
    assert.deepEqual(blocker.failureCodes, [{ code: 'not_configured', count: 1 }])
    const rendered = renderSearchCapabilitySection(blocker).join('\n')
    assert.match(rendered, /`not_configured`/)
    assert.match(rendered, /exa, brave/)
    assert.match(rendered, /managed browser/i)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a browser render recorded for another run never suppresses this run', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'failed', code: 'not_configured' }),
    ])
    writeBrowserActivity(workspacePath, [
      {
        ...browserActivity({ index: 0, state: 'completed' }),
        runId: 'run-from-another-report',
      },
    ])

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    assert.equal(acquisition.discovery.succeeded, false)
    assert.ok(
      evaluateDeepResearchSearchCapability({
        approvedPlan: makePlan({ queryHints: ['sushi detroit'] }),
        acquisition,
      }),
      'discovery is a property of this run, not of the workspace',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a guessed source URL opened in the browser never suppresses the blocker', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    // Exactly the shape this blocker exists to catch: no discovery path, and a
    // lane that produced restaurant URLs from model memory and opened them in
    // the managed browser. Reading those pages is acquisition, not discovery.
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'failed', code: 'internal' }),
      activity({ index: 1, action: 'search', state: 'failed', code: 'internal' }),
    ])
    writeBrowserActivity(workspacePath, [
      browserActivity({
        index: 0,
        state: 'completed',
        method: 'managed-browser',
        url: 'https://www.marurestaurant.com/',
      }),
      browserActivity({
        index: 1,
        state: 'completed',
        method: 'cloud-browser',
        url: 'https://hirokisandetroit.com/',
      }),
      browserActivity({
        index: 2,
        state: 'failed',
        method: 'managed-browser',
        url: 'https://www.google.com/sorry/index',
        code: 'access_challenge',
      }),
    ])

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    assert.equal(acquisition.discovery.succeeded, false)
    assert.deepEqual(acquisition.discovery.successfulPaths, [])
    const blocker = evaluateDeepResearchSearchCapability({
      approvedPlan: makePlan({ queryHints: ['sushi detroit'] }),
      acquisition,
    })
    assert.ok(
      blocker,
      'opening a URL the lane already named is not evidence that it could find one',
    )
    assert.deepEqual(blocker.failureCodes, [{ code: 'internal', count: 2 }])

    // The lane did read pages. The report may only deny the narrower thing the
    // signal actually measured: that none of them was a search-results page.
    const rendered = renderSearchCapabilitySection(blocker).join('\n')
    assert.match(rendered, /search-results page/)
    assert.doesNotMatch(
      rendered,
      /(browser)[^.]*\bread a page\b/i,
      'the run did read pages; only discovery was absent',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a truncated browser window cannot prove no page was ever discovered', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    // The browser journal keeps only its newest entries. At the cap, an older
    // rendered search-results page may have been evicted, so "no discovery
    // path" is no longer a claim this window can support — the same retention
    // rule the research journal already follows.
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'failed', code: 'internal' }),
    ])
    writeBrowserActivity(
      workspacePath,
      Array.from({ length: MAX_BROWSER_ACTIVITY_PER_SESSION }, (_unused, index) =>
        browserActivity({
          index,
          state: 'completed',
          method: 'managed-browser',
          url: 'https://www.marurestaurant.com/',
        }),
      ),
    )

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    assert.equal(acquisition.truncated, true, 'the truncated window is reported')
    assert.equal(
      evaluateDeepResearchSearchCapability({
        approvedPlan: makePlan({ queryHints: ['sushi detroit'] }),
        acquisition,
      }),
      undefined,
      'a blocker asserting "no discovery path" must not be raised from a partial window',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('repeated searches with no discovery path never flip the recorded cause to a spent budget', async () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    // No provider key, no managed browser, no cloud rung: every call reports
    // capability absence. A call that exercised no path spent nothing, so the
    // journal must keep saying so however many times the lane tries — the
    // targeted remediation is reserved for `not_configured` alone.
    const service = await makeSearchService(workspacePath, {
      maximumSearchCalls: 2,
    })
    for (let call = 0; call < 4; call += 1) {
      const output = await service.execute(
        SEARCH_REQUEST_CONTEXT,
        `call-no-path-${call}`,
        { action: 'search', query: 'sushi detroit' },
      )
      assert.equal(output.error?.code, 'not_configured', JSON.stringify(output))
    }

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    const blocker = evaluateDeepResearchSearchCapability({
      approvedPlan: makePlan({ queryHints: ['sushi detroit'] }),
      acquisition,
    })
    assert.ok(blocker, 'no discovery path at all still blocks')
    assert.deepEqual(blocker.failureCodes, [
      { code: 'not_configured', count: 4 },
    ])
    assert.match(
      describeDeepResearchDiscoveryRemediation(blocker.failureCodes),
      /Exa or Brave Search API key/iu,
      'a budget code mixed in drops the credential the operator actually needs',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an unreadable cloud setting is journalled as a runtime fault, not a missing credential', async () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    // Browser Use is enabled, keyed and funded, so the lane has a discovery
    // path and no API key would add one. One mistyped runtime variable makes
    // that rung unbuildable, and `not_configured` in the journal is what makes
    // the report answer with the credential sentence.
    const service = await makeSearchService(workspacePath, {
      maximumSearchCalls: 2,
      maximumCloudBrowserCalls: 4,
      environment: { BROWSER_USE_PROXY_COUNTRY: 'United Kingdom' },
    })
    for (let call = 0; call < 4; call += 1) {
      await service.execute(
        SEARCH_REQUEST_CONTEXT,
        `call-settings-fault-${call}`,
        { action: 'search', query: 'sushi detroit' },
      )
    }

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    const blocker = evaluateDeepResearchSearchCapability({
      approvedPlan: makePlan({ queryHints: ['sushi detroit'] }),
      acquisition,
    })
    assert.ok(blocker, 'no usable discovery path at all still blocks')
    assert.deepEqual(blocker.failureCodes, [
      { code: 'budget_exhausted', count: 2 },
      { code: 'internal', count: 2 },
    ])
    assert.doesNotMatch(
      describeDeepResearchDiscoveryRemediation(blocker.failureCodes),
      /Exa or Brave Search API key/iu,
      'no search API key fixes an unreadable acquisition setting',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a rendered managed-browser results page is reported as discovery that continued', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'failed', code: 'internal' }),
      activity({ index: 1, action: 'search', state: 'failed', code: 'internal' }),
    ])
    writeBrowserActivity(workspacePath, [
      browserActivity({
        index: 0,
        state: 'completed',
        method: 'managed-browser',
        requestedUrl: 'https://www.bing.com/search?q=downtown+detroit+sushi',
        url: 'https://www.bing.com/search',
      }),
    ])

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    const report = renderDeepResearchBlocker({
      lanes: [{ taskId: 'T1', status: 'failed', title: 'Find sushi bars' }],
      acquisition,
    })
    assert.match(
      report,
      /search failed; discovery continued through the managed browser/u,
      'a run whose browser reached the web is never described as having had no discovery path',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a browser that only opened named sources is never reported as continued discovery', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    // The same failed searches and the same managed browser as the case above,
    // differing only in what the browser opened. Reading a source URL the lane
    // already named is acquisition, so the sentence that credits the browser
    // with discovery must not appear.
    writeActivity(workspacePath, [
      activity({ index: 0, action: 'search', state: 'failed', code: 'internal' }),
      activity({ index: 1, action: 'search', state: 'failed', code: 'internal' }),
    ])
    writeBrowserActivity(workspacePath, [
      browserActivity({
        index: 0,
        state: 'completed',
        method: 'managed-browser',
        requestedUrl: 'https://www.marurestaurant.com/menu',
        url: 'https://www.marurestaurant.com/menu',
      }),
    ])

    const acquisition = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.ok(acquisition)
    const report = renderDeepResearchBlocker({
      lanes: [{ taskId: 'T1', status: 'failed', title: 'Find sushi bars' }],
      acquisition,
    })
    assert.doesNotMatch(
      report,
      /discovery continued through/u,
      'crediting a page read as discovery hides exactly the blocker this report exists to raise',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

const SEARCH_REQUEST_CONTEXT = {
  contractVersion: MCP_RUNTIME_CONTRACT_VERSION,
  requestId: 'request-capability',
  leaseId: 'lease-capability',
  sessionId: SESSION_ID,
  runId: RUN_ID,
  assignmentId: ASSIGNMENT_ID,
  activityScopeId: 'lane-1',
  agentPath: 'agents/web-researcher',
}

/**
 * The real research tool over a workspace with no discovery path at all, so
 * the journal these assertions read is the one the runtime actually writes.
 */
async function makeSearchService(
  workspacePath: string,
  options: {
    readonly maximumSearchCalls: number
    /** Enables and keys the paid rung, funding it for this many calls. */
    readonly maximumCloudBrowserCalls?: number
    /** Runtime inputs `cloudBrowser()` parses before it builds the acquirer. */
    readonly environment?: NodeJS.ProcessEnv
  },
): Promise<ResearchWebToolService> {
  const repoRootPath = path.join(workspacePath, 'repo')
  const agentPath = SEARCH_REQUEST_CONTEXT.agentPath
  fs.mkdirSync(path.join(repoRootPath, agentPath), { recursive: true })
  fs.writeFileSync(
    path.join(repoRootPath, agentPath, 'web-researcher.md'),
    ['---', 'name: web-researcher', 'tools: read, research_web', '---', '', '# Researcher', ''].join('\n'),
  )
  const cloudCalls = options.maximumCloudBrowserCalls ?? 0
  const settings = new AcquisitionSettingsService({
    storagePath: path.join(workspacePath, 'acquisition-settings.json'),
    environment: options.environment ?? {},
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
  })
  await settings.update({
    providerPriority: ['exa', 'brave'],
    providers: {
      exa: { enabled: false },
      brave: { enabled: false },
      firecrawl: { enabled: false },
      'browser-use': {
        enabled: cloudCalls > 0,
        ...(cloudCalls > 0 ? { apiKey: 'bu_key' } : {}),
      },
    },
    budgets: {
      maximumSearchCalls: options.maximumSearchCalls,
      maximumBrowserFallbacks: 2,
      maximumManagedReaderCalls: 1,
      maximumModelExtractions: 1,
      maximumCloudBrowserCalls: cloudCalls,
      maximumCloudBrowserCostMicros: cloudCalls > 0 ? 10_000 : 0,
    },
    extractionModel: null,
  })
  return new ResearchWebToolService({ workspacePath, repoRootPath, settings })
}
