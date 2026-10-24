import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  reduceWebEvidenceValidationEvents,
  WEB_EVIDENCE_VALIDATION_STREAM_KIND,
} from '../../domains/browser/web-evidence-validation-journal.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { resolveWebEvidenceValidationRecorder } from '../../services/web-evidence-validation-recorder.js'

/**
 * The production recorder appends the sanitized `web.evidence.validation`
 * event through the assignment's canonical execution journal — the same
 * handle family the capability dispatcher writes through — and the bytes on
 * disk stay content-free.
 */

async function findFiles(root: string, basename: string): Promise<string[]> {
  const matches: string[] = []
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name)
    if (entry.isDirectory()) matches.push(...await findFiles(target, basename))
    else if (entry.isFile() && entry.name === basename) matches.push(target)
  }
  return matches
}

test('a validation event lands on the assignment journal with no content in the bytes', async (t) => {
  const workspacePath = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'web-evidence-recorder-')),
  )
  t.after(() => fs.rm(workspacePath, { recursive: true, force: true }))
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  t.after(() => registry.close())

  const scope = {
    sessionId: 'session-validation',
    runId: 'run-validation',
    assignmentId: 'assignment-validation',
  }
  // The runtime owns assignment creation; the journal only enrolls scopes that
  // already exist.
  await fs.mkdir(
    path.join(
      workspacePath,
      'sessions',
      scope.sessionId,
      'runs',
      scope.runId,
      'assignments',
      scope.assignmentId,
    ),
    { recursive: true },
  )
  const recorder = await resolveWebEvidenceValidationRecorder({
    registry,
    scope,
    agentPath: 'agents/quick-scout',
    requestId: 'request-validation',
    processIdentity: 'web-evidence-test',
  })
  assert.ok(recorder, 'an enrolled workspace resolves a recorder')

  const question = 'What is the secret launch date?'
  const answer = 'See https://leak.example/confidential-page for the plan.'
  await recorder.recordValidation({
    turnId: 'turn-validation-1',
    stage: 'links',
    mode: 'enforce',
    providerKind: 'openai',
    providerRoute: 'mcp-native',
    observedUrlCount: 2,
    citedUrlCount: 3,
    unobservedUrlCount: 1,
    legacyDecision: 'accepted',
    decision: 'unobserved_url',
    displayedDiffersFromCandidate: true,
    persistedDiffersFromCandidate: true,
    enforcementWouldDiffer: true,
    durationMs: 2,
    // Smuggled past the type boundary: none of this may reach the journal.
    question,
    answer,
  } as never)
  await recorder.release()

  const journals = await findFiles(workspacePath, 'journal.jsonl')
  assert.equal(journals.length, 1)
  const bytes = await fs.readFile(journals[0]!, 'utf8')
  assert.match(bytes, /web\.evidence\.validation\.recorded/)
  for (const forbidden of [question, answer, 'leak.example']) {
    assert.ok(!bytes.includes(forbidden), `journal must not contain '${forbidden}'`)
  }

  const lease = await registry.acquireJournalHandle({
    context: {
      contractVersion: 1,
      requestId: 'request-validation-read',
      ...scope,
      agentPath: 'agents/quick-scout',
      authority: { kind: 'runtime-assignment', processIdentity: 'web-evidence-test' },
    },
    signal: new AbortController().signal,
    deadlineMs: Date.now() + 5_000,
  })
  assert.ok(lease)
  const stream = await lease.journal.scanStream(
    WEB_EVIDENCE_VALIDATION_STREAM_KIND,
    scope.assignmentId,
  )
  await lease.release()
  assert.deepEqual(reduceWebEvidenceValidationEvents(stream.events), {
    recordedCount: 1,
    acceptedCount: 0,
    insufficientCount: 1,
    wouldDifferCount: 1,
    invalidCount: 0,
    byDecision: { unobserved_url: 1 },
  })
})

test('a workspace with no journal registry resolves no recorder', async () => {
  const recorder = await resolveWebEvidenceValidationRecorder({
    registry: undefined,
    scope: {
      sessionId: 'session-validation',
      runId: 'run-validation',
      assignmentId: 'assignment-validation',
    },
    agentPath: 'agents/quick-scout',
    requestId: 'request-validation',
    processIdentity: 'web-evidence-test',
  })
  assert.equal(recorder, undefined)
})
