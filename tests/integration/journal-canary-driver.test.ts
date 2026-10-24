import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'

import { runJournalCanary } from '../live/journal-canary-driver.js'

/**
 * The driver is the authority on attribution, not the arms.
 *
 * A journal arm that dies before recording anything is exactly when a verdict
 * matters most, so these cases drive the coordinator with an injected arm
 * runner: the coordination is what is under test, and a real provider would
 * make it neither deterministic nor cheap.
 */
const REPO_ROOT = process.cwd()

function writeOutcome(
  outcomeDir: string,
  arm: 'control' | 'journal',
  outcome: Record<string, unknown>,
): void {
  fs.writeFileSync(path.join(outcomeDir, `${arm}.json`), JSON.stringify(outcome))
}

test('both arms run in one disposable workspace and share one outcome directory', () => {
  const seen: { arm: string; workspacePath: string; outcomeDir: string }[] = []
  const report = runJournalCanary({
    repoRoot: REPO_ROOT,
    keepWorkspace: false,
    log: () => undefined,
    runArm: ({ arm, workspacePath, outcomeDir }) => {
      seen.push({ arm, workspacePath, outcomeDir })
      writeOutcome(outcomeDir, arm, { completed: true })
      return { status: 0, signal: null }
    },
  })

  assert.deepEqual(
    seen.map((entry) => entry.arm),
    ['control', 'journal'],
    'control runs first, so the transcript shows the baseline before the arm under test',
  )
  assert.equal(
    new Set(seen.map((entry) => entry.workspacePath)).size,
    1,
    'one workspace, not one per arm',
  )
  assert.equal(new Set(seen.map((entry) => entry.outcomeDir)).size, 1)
  assert.equal(report.attribution.verdict, 'both-completed')
  assert.equal(report.passed, true)
})

test('the verdict is computed by the driver even when the journal arm records nothing', () => {
  const report = runJournalCanary({
    repoRoot: REPO_ROOT,
    keepWorkspace: false,
    log: () => undefined,
    runArm: ({ arm, outcomeDir }) => {
      if (arm === 'control') {
        writeOutcome(outcomeDir, arm, { completed: true })
        return { status: 0, signal: null }
      }
      // Killed before it could write anything — the case the arms cannot
      // report on themselves.
      return { status: null, signal: 'SIGKILL' }
    },
  })

  assert.equal(
    report.attribution.verdict,
    'journal-implicated',
    'a silent journal arm against a completing control arm still yields a verdict',
  )
  const journal = report.arms.find((entry) => entry.arm === 'journal')
  assert.ok(journal)
  assert.equal(journal.signal, 'SIGKILL')
  assert.match(
    journal.outcome.failureSignature ?? '',
    /SIGKILL/,
    'the signal becomes the failure signature, so the cause is not lost',
  )
  assert.equal(report.passed, false)
})

/**
 * An arm's own record is not the last word on whether it succeeded.
 *
 * It writes its outcome and then keeps going: teardown closes the registry,
 * removes directories, restores the environment. A failure after the write
 * leaves `{"completed":true}` on disk beside a nonzero exit, and a coordinator
 * that trusts the file reports `both-completed` for a run that did not both
 * complete. The process result is the authority on termination; the file is the
 * authority on what happened before it.
 */
test('an arm that records completion but exits nonzero is not completed', () => {
  const report = runJournalCanary({
    repoRoot: REPO_ROOT,
    keepWorkspace: false,
    log: () => undefined,
    runArm: ({ arm, outcomeDir }) => {
      writeOutcome(outcomeDir, arm, { completed: true })
      // The journal arm wrote success, then died in teardown.
      return { status: arm === 'journal' ? 1 : 0, signal: null }
    },
  })

  assert.equal(report.passed, false, 'a nonzero exit cannot pass the gate')
  assert.notEqual(
    report.attribution.verdict,
    'both-completed',
    'a run where an arm exited nonzero did not both complete',
  )
  const journal = report.arms.find((entry) => entry.arm === 'journal')
  assert.ok(journal)
  assert.equal(journal.outcome.completed, false)
  assert.match(
    journal.outcome.failureSignature ?? '',
    /exited 1/,
    'the signature names the process failure that overrode the record',
  )
})

test('a recorded completion is also overridden by a killing signal', () => {
  const report = runJournalCanary({
    repoRoot: REPO_ROOT,
    keepWorkspace: false,
    log: () => undefined,
    runArm: ({ arm, outcomeDir }) => {
      writeOutcome(outcomeDir, arm, { completed: true })
      return arm === 'journal'
        ? { status: null, signal: 'SIGKILL' }
        : { status: 0, signal: null }
    },
  })

  assert.equal(report.passed, false)
  const journal = report.arms.find((entry) => entry.arm === 'journal')
  assert.ok(journal)
  assert.equal(journal.outcome.completed, false)
  assert.match(journal.outcome.failureSignature ?? '', /SIGKILL/)
})

test('an arm-authored failure survives, rather than being replaced by the exit code', () => {
  const report = runJournalCanary({
    repoRoot: REPO_ROOT,
    keepWorkspace: false,
    log: () => undefined,
    runArm: ({ arm, outcomeDir }) => {
      if (arm === 'control') {
        writeOutcome(outcomeDir, arm, { completed: true })
        return { status: 0, signal: null }
      }
      writeOutcome(outcomeDir, arm, {
        completed: false,
        failureSignature: 'blocked at discuss',
      })
      return { status: 1, signal: null }
    },
  })

  const journal = report.arms.find((entry) => entry.arm === 'journal')
  assert.ok(journal)
  assert.equal(
    journal.outcome.failureSignature,
    'blocked at discuss',
    'the arm diagnosed itself precisely; the exit code adds nothing',
  )
  assert.equal(report.attribution.verdict, 'journal-implicated')
})

test('a spawn error is diagnosed rather than read as a completed arm', () => {
  const report = runJournalCanary({
    repoRoot: REPO_ROOT,
    keepWorkspace: false,
    log: () => undefined,
    runArm: ({ arm, outcomeDir }) => {
      if (arm === 'control') {
        writeOutcome(outcomeDir, arm, { completed: true })
        return { status: 0, signal: null }
      }
      return { status: null, signal: null, error: new Error('spawn ENOENT') }
    },
  })

  const journal = report.arms.find((entry) => entry.arm === 'journal')
  assert.ok(journal)
  assert.equal(journal.spawnError, 'spawn ENOENT')
  assert.match(journal.outcome.failureSignature ?? '', /failed to run: spawn ENOENT/)
  assert.equal(report.passed, false)
})

test('a malformed outcome file is reported, not parsed into a verdict', () => {
  const report = runJournalCanary({
    repoRoot: REPO_ROOT,
    keepWorkspace: false,
    log: () => undefined,
    runArm: ({ arm, outcomeDir }) => {
      if (arm === 'control') {
        writeOutcome(outcomeDir, arm, { completed: true })
        return { status: 0, signal: null }
      }
      fs.writeFileSync(path.join(outcomeDir, 'journal.json'), '{not json')
      return { status: 1, signal: null }
    },
  })

  const journal = report.arms.find((entry) => entry.arm === 'journal')
  assert.ok(journal)
  assert.match(
    journal.outcome.failureSignature ?? '',
    /unreadable journal outcome/,
    'the driver says the file was unreadable rather than inventing an outcome',
  )
  assert.equal(report.passed, false)
})

test('the workspace is discarded unless retention is requested', () => {
  const discarded = runJournalCanary({
    repoRoot: REPO_ROOT,
    keepWorkspace: false,
    log: () => undefined,
    runArm: ({ arm, outcomeDir }) => {
      writeOutcome(outcomeDir, arm, { completed: true })
      return { status: 0, signal: null }
    },
  })
  assert.equal(fs.existsSync(discarded.workspacePath), false)
  assert.equal(discarded.retained, false)

  const retained = runJournalCanary({
    repoRoot: REPO_ROOT,
    keepWorkspace: true,
    log: () => undefined,
    runArm: ({ arm, outcomeDir }) => {
      writeOutcome(outcomeDir, arm, { completed: true })
      return { status: 0, signal: null }
    },
  })
  try {
    assert.equal(fs.existsSync(retained.workspacePath), true)
    assert.equal(retained.retained, true)
  } finally {
    fs.rmSync(path.dirname(retained.workspacePath), { recursive: true, force: true })
  }
})

test('both arms failing the same way exonerates the journal for that failure', () => {
  const report = runJournalCanary({
    repoRoot: REPO_ROOT,
    keepWorkspace: false,
    log: () => undefined,
    runArm: ({ arm, outcomeDir }) => {
      writeOutcome(outcomeDir, arm, {
        completed: false,
        failureSignature: 'blocked at discuss',
      })
      return { status: 1, signal: null }
    },
  })
  assert.equal(report.attribution.verdict, 'journal-exonerated')
  assert.equal(report.passed, false, 'exoneration is not completion')
})
