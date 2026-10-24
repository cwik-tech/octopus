import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { parseSessionRunAssignmentLocation } from '../../core/run-assignment-location.js'
import {
  buildDeepResearchBlockerLanes,
  countDeepResearchLaneObservations,
  readDeepResearchAcquisitionDiagnostics,
  readDeepResearchLaneDiagnostics,
  renderDeepResearchBlocker,
} from '../../domains/deep-research/deep-research-blocker-report.js'

const SESSION_ID = 'session-blocker'
const RUN_ID = 'run-blocker'
const ASSIGNMENT_ID = 'assignment-blocker'

function makeRun(): { workspacePath: string; assignmentPath: string } {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'deep-research-blocker-')),
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
  fs.mkdirSync(path.join(assignmentPath, '.runtime'), { recursive: true })
  return { workspacePath, assignmentPath }
}

function writeAttemptRecord(
  assignmentPath: string,
  laneId: string,
  directoryName: string,
  outcome: Readonly<Record<string, unknown>>,
): void {
  const attemptPath = path.join(
    assignmentPath,
    '.runtime',
    'worker-logs',
    laneId,
    directoryName,
  )
  fs.mkdirSync(attemptPath, { recursive: true })
  fs.writeFileSync(
    path.join(attemptPath, 'outcome.json'),
    `${JSON.stringify(outcome, null, 2)}\n`,
  )
}

test('an assignment path recovers its owning session identity', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    const location = parseSessionRunAssignmentLocation(workspacePath, assignmentPath)
    assert.equal(location?.sessionId, SESSION_ID)
    assert.equal(location?.runId, RUN_ID)
    assert.equal(location?.assignmentId, ASSIGNMENT_ID)
    assert.equal(
      parseSessionRunAssignmentLocation(workspacePath, path.join(workspacePath, 'elsewhere')),
      null,
    )
    assert.equal(
      parseSessionRunAssignmentLocation(workspacePath, path.join(workspacePath, '..', 'outside')),
      null,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('lane diagnostics read every recorded attempt in attempt order', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeAttemptRecord(assignmentPath, 'lane-one', 'T1-attempt-2', {
      outcome: 'rejected',
      attempt: 2,
      elapsed_ms: 312_236,
      validator: {
        name: 'Error',
        message: "Claim 'c1' excerpt was not found in observation receipt '97ba097b'.",
        category: 'binding_invalid',
      },
      observations: { count: 31, time_to_first_observation_ms: 14_000 },
    })
    writeAttemptRecord(assignmentPath, 'lane-one', 'T1-attempt-1', {
      outcome: 'rejected',
      attempt: 1,
      elapsed_ms: 288_932,
      validator: {
        name: 'DeepResearchValidationError',
        field: 'source.contentSha256',
        message: 'source.contentSha256 must be a lowercase SHA-256 digest.',
        category: 'response_schema_invalid',
      },
    })

    const diagnostics = readDeepResearchLaneDiagnostics({
      assignmentPath,
      laneId: 'lane-one',
    })
    assert.deepEqual(
      diagnostics.attempts.map((attempt) => attempt.attempt),
      [1, 2],
    )
    assert.equal(diagnostics.attempts[0]?.validatorField, 'source.contentSha256')
    assert.equal(diagnostics.attempts[1]?.category, 'binding_invalid')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('lane diagnostics tolerate a missing or unreadable private runtime', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    assert.deepEqual(
      readDeepResearchLaneDiagnostics({ assignmentPath, laneId: 'absent-lane' }).attempts,
      [],
    )
    assert.deepEqual(
      readDeepResearchLaneDiagnostics({ assignmentPath, laneId: '../escape' }).attempts,
      [],
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('acquisition diagnostics join the session-scoped activity record', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    const activity = [
      'search:not_configured',
      'search:not_configured',
      'acquire:ok',
      'acquire:empty_content',
      'acquire:domain_denied',
    ].map((entry, index) => {
      const [action, code] = entry.split(':')
      return {
        activityId: `activity-${index}`,
        sessionId: SESSION_ID,
        runId: RUN_ID,
        assignmentId: ASSIGNMENT_ID,
        activityScopeId: 'lane-one',
        agentPath: 'agents/web-researcher',
        toolCallId: `call-${index}`,
        action,
        state: code === 'ok' ? 'completed' : 'failed',
        createdAt: '2026-08-16T20:46:00.000Z',
        updatedAt: '2026-08-16T20:46:01.000Z',
        attempts: [],
        ...(code === 'ok' ? {} : { error: { code, message: code } }),
      }
    })
    // One foreign run must not leak into this assignment's conditions.
    activity.push({
      ...activity[0]!,
      activityId: 'activity-foreign',
      runId: 'other-run',
    })
    fs.mkdirSync(path.join(workspacePath, 'sessions', SESSION_ID), { recursive: true })
    fs.writeFileSync(
      path.join(workspacePath, 'sessions', SESSION_ID, 'research-acquisition.json'),
      JSON.stringify(activity),
    )

    const diagnostics = readDeepResearchAcquisitionDiagnostics({
      workspacePath,
      assignmentPath,
    })
    assert.equal(diagnostics?.searchApiCalls, 2)
    assert.equal(diagnostics?.searchApiUnavailable, 2)
    assert.equal(diagnostics?.observedSources, 1)
    assert.deepEqual(diagnostics?.blockedAcquisitions, [
      { code: 'domain_denied', count: 1 },
      { code: 'empty_content', count: 1 },
    ])
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the blocker states attempts, the exact validator error, and where the evidence is', () => {
  const { workspacePath, assignmentPath } = makeRun()
  try {
    writeAttemptRecord(assignmentPath, 'dedicated-hard-scoop', 'T1-attempt-1', {
      outcome: 'rejected',
      attempt: 1,
      elapsed_ms: 288_932,
      validator: {
        name: 'DeepResearchValidationError',
        field: 'source.contentSha256',
        message: 'source.contentSha256 must be a lowercase SHA-256 digest.',
        category: 'response_schema_invalid',
      },
      observations: { count: 31, time_to_first_observation_ms: 14_000 },
    })
    const observationsPath = path.join(
      assignmentPath,
      'research',
      'observations',
      'dedicated-hard-scoop',
    )
    fs.mkdirSync(observationsPath, { recursive: true })
    fs.writeFileSync(path.join(observationsPath, 'receipt-one.json'), '{}')

    const lanes = buildDeepResearchBlockerLanes({
      assignmentPath,
      approvedPlan: {
        tasks: [{ id: 'T1', workerSpecId: 'spec-1' }],
        workerSpecs: [{
          id: 'spec-1',
          laneId: 'dedicated-hard-scoop',
          displayRole: 'Ice-cream shop evaluator',
        }],
        // Only the two collections above are read.
      } as never,
      tasks: [{
        id: 'T1',
        title: 'Assess dedicated hard-scoop ice-cream shops',
        status: 'failed',
        resultFile: 'research/evidence/wave-0/T1.json',
      }],
    })

    const blocker = renderDeepResearchBlocker({
      lanes,
      observationsByLane: {
        'dedicated-hard-scoop': countDeepResearchLaneObservations(
          assignmentPath,
          'dedicated-hard-scoop',
        ),
      },
      acquisition: {
        observedSources: 4,
        searchApiCalls: 6,
        searchApiUnavailable: 6,
        searchApiSucceeded: 0,
        truncated: false,
        searchUnavailableLaneIds: ['dedicated-hard-scoop'],
        failedSearches: [{ code: 'not_configured', count: 6 }],
        blockedAcquisitions: [{ code: 'empty_content', count: 4 }],
        discovery: {
          searchAttempts: 6,
          succeeded: false,
          successfulPaths: [],
          failureCodes: [{ code: 'not_configured', count: 6 }],
        },
      },
      deadline: {
        maxDurationMinutes: 60,
        startedAt: '2026-08-16T20:45:42.000Z',
        deadlineAt: '2026-08-16T21:45:42.000Z',
        remainingMs: -1_000,
      },
    })

    assert.match(blocker, /Ice-cream shop evaluator \(lane `dedicated-hard-scoop`\)/)
    assert.match(blocker, /Attempt 1 — `rejected` after 289s/)
    assert.match(blocker, /source\.contentSha256 must be a lowercase SHA-256 digest/)
    assert.match(blocker, /\[`source\.contentSha256`\] \(`response_schema_invalid`\)/)
    assert.match(blocker, /Sources observed by this lane: 1/)
    assert.match(blocker, /research\/evidence\/wave-0\/T1--dedicated-hard-scoop\.md/)
    assert.match(blocker, /search absent \(no search provider API key configured/)
    assert.match(blocker, /empty_content ×4/)
    assert.match(blocker, /Remaining at failure: none \(exceeded by 1s\)/)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a deadline-only blocker renders without a validator section', () => {
  const blocker = renderDeepResearchBlocker({
    lanes: [{
      taskId: 'T3',
      title: 'Assess non-specialist ice-cream offerings',
      status: 'failed',
      laneId: 'ancillary',
      displayRole: 'Tourist food-stop evaluator',
      summaryPath: 'research/evidence/wave-0/T3--ancillary.md',
      diagnostics: {
        laneId: 'ancillary',
        attempts: [{ attempt: 2, outcome: 'no_response', elapsedMs: 679_356 }],
      },
    }],
    deadline: { maxDurationMinutes: 60, remainingMs: 0 },
  })
  assert.match(blocker, /Attempt 2 — `no_response` after 679s/)
  assert.doesNotMatch(blocker, /Exact error/)
  assert.match(blocker, /Approved budget: 60 minutes/)
})

test('a lane that never dispatched says so instead of implying a rejection', () => {
  const blocker = renderDeepResearchBlocker({
    lanes: [{ taskId: 'T2', title: 'Blocked before dispatch', status: 'blocked' }],
  })
  assert.match(blocker, /No worker attempt was recorded for this lane/)
})
