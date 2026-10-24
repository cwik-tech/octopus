import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import type { CapabilityExecutionContext } from '../../contracts/capability-dispatch.js'
import { inspectWorkspaceActivationReadiness } from '../../services/execution-journal-preflight.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'
import { reportWorkflowJournalDivergence } from '../../services/workflow-journal-divergence.js'

/**
 * AC21: before a tenant is pinned or a default is changed, an operator must be
 * able to ask what is already enrolled in a workspace and whether it is
 * consistent enough to activate — without changing anything.
 *
 * The plan's absolute claim that "no journal exists on disk anywhere today" is
 * unsupportable: the flag is an environment variable anyone can export, and the
 * live cutover test can retain its workspace. This is the check that replaces
 * the assumption.
 */

function makeWorkspace(): string {
  return fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'journal-preflight-')),
  )
}

function assignmentDir(workspacePath: string, assignmentId: string): string {
  return path.join(
    workspacePath,
    'sessions',
    'session-one',
    'runs',
    'run-one',
    'assignments',
    assignmentId,
  )
}

function makeContext(
  workspacePath: string,
  assignmentId: string,
): CapabilityExecutionContext {
  fs.mkdirSync(assignmentDir(workspacePath, assignmentId), { recursive: true })
  return {
    contractVersion: 1,
    requestId: `request-${assignmentId}`,
    sessionId: 'session-one',
    runId: 'run-one',
    assignmentId,
    agentPath: 'agents/probe',
    authority: { kind: 'runtime-assignment', processIdentity: 'probe' },
  }
}

/** Enrol one assignment under an explicit tenant, then close the registry. */
async function enroll(
  workspacePath: string,
  assignmentId: string,
  tenantId: string,
): Promise<void> {
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId,
    mode: 'authoritative',
  })
  try {
    const port = await registry.resolve({
      context: makeContext(workspacePath, assignmentId),
      signal: new AbortController().signal,
      deadlineMs: Date.now() + 5_000,
    })
    assert.ok(port, `assignment ${assignmentId} must enrol`)
  } finally {
    await registry.close()
  }
}

function manifestPath(workspacePath: string, assignmentId: string): string {
  return path.join(
    assignmentDir(workspacePath, assignmentId),
    '.runtime',
    'execution-journal',
    'manifest.json',
  )
}

/** Rewrite a sealed manifest's schema version so the reader refuses it. */
function forceUnsupportedVersion(
  workspacePath: string,
  assignmentId: string,
): void {
  const target = manifestPath(workspacePath, assignmentId)
  const manifest: unknown = JSON.parse(fs.readFileSync(target, 'utf8'))
  assert.ok(manifest && typeof manifest === 'object')
  const rewritten = { ...(manifest as Record<string, unknown>), schemaVersion: 99 }
  fs.writeFileSync(target, `${JSON.stringify(rewritten)}\n`, { mode: 0o600 })
}

/** Every path under a root, with its type, for a provisions-nothing assertion. */
function treeSnapshot(root: string): string[] {
  const entries: string[] = []
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const full = path.join(directory, entry.name)
      const relative = path.relative(root, full)
      if (entry.isDirectory()) {
        entries.push(`d ${relative}`)
        walk(full)
      } else {
        entries.push(`f ${relative} ${fs.statSync(full).size}`)
      }
    }
  }
  walk(root)
  return entries
}

test('an empty workspace is ready to activate and offers the environment tenant as the pin', async () => {
  const workspacePath = makeWorkspace()
  try {
    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })

    assert.equal(report.verdict, 'ready')
    assert.equal(report.journalCount, 0)
    assert.deepEqual(report.problems, [])
    assert.equal(report.pinnableTenantId, 'local')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a workspace whose journals all agree with the environment tenant is ready', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-a', 'local')
    await enroll(workspacePath, 'assignment-b', 'local')

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })

    assert.equal(report.verdict, 'ready')
    assert.equal(report.journalCount, 2)
    assert.deepEqual(report.tenantIds, ['local'])
    assert.deepEqual(report.problems, [])
    assert.equal(report.pinnableTenantId, 'local')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a workspace with disagreeing tenants and an unreadable version is blocked, naming both problems', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-healthy', 'local')
    await enroll(workspacePath, 'assignment-other-tenant', 'acme')
    await enroll(workspacePath, 'assignment-future', 'local')
    forceUnsupportedVersion(workspacePath, 'assignment-future')

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })

    assert.equal(report.verdict, 'blocked')
    assert.equal(report.journalCount, 3)

    const kinds = report.problems.map((problem) => problem.kind).sort()
    assert.deepEqual(kinds, ['tenant_disagreement', 'unsupported_version'])

    const disagreement = report.problems.find(
      (problem) => problem.kind === 'tenant_disagreement',
    )
    assert.ok(disagreement)
    assert.match(disagreement.detail, /acme/)
    assert.match(disagreement.detail, /local/)

    const unsupported = report.problems.find(
      (problem) => problem.kind === 'unsupported_version',
    )
    assert.ok(unsupported)
    assert.equal(unsupported.scope?.assignmentId, 'assignment-future')

    // No pin may be offered while the workspace disagrees with itself.
    assert.equal(report.pinnableTenantId, undefined)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a workspace whose journals agree with each other but not the environment is blocked, naming both values', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-a', 'acme')

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })

    assert.equal(report.verdict, 'blocked')
    assert.deepEqual(report.tenantIds, ['acme'])
    const mismatch = report.problems.find(
      (problem) => problem.kind === 'environment_tenant_mismatch',
    )
    assert.ok(mismatch, 'the environment/journal disagreement must be named')
    assert.match(mismatch.detail, /acme/)
    assert.match(mismatch.detail, /local/)
    assert.equal(report.pinnableTenantId, undefined)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('the preflight provisions nothing it reads', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-a', 'local')
    // An assignment directory that never enrolled must not gain a journal.
    fs.mkdirSync(assignmentDir(workspacePath, 'assignment-unenrolled'), {
      recursive: true,
    })

    const before = treeSnapshot(workspacePath)
    await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })
    const after = treeSnapshot(workspacePath)

    assert.deepEqual(after, before, 'the preflight must not create or grow anything')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * Fail-closed discovery.
 *
 * The first version of this preflight answered READY for a workspace holding a
 * journal directory with no manifest, because discovery counted only a regular
 * `manifest.json` and swallowed every error on the way to it. That authorizes a
 * tenant pin over durable state nobody has read. Absence of proof is not proof
 * of absence, and every one of these cases must block.
 */

function journalDir(workspacePath: string, assignmentId: string): string {
  return path.join(
    assignmentDir(workspacePath, assignmentId),
    '.runtime',
    'execution-journal',
  )
}

test('a journal directory with no manifest blocks rather than reading as absent', async () => {
  const workspacePath = makeWorkspace()
  try {
    const directory = journalDir(workspacePath, 'assignment-headless')
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    fs.writeFileSync(path.join(directory, 'journal.jsonl'), '', { mode: 0o600 })

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })

    assert.equal(report.verdict, 'blocked')
    assert.ok(
      report.problems.some((problem) => problem.kind === 'indeterminate'),
      `expected an indeterminate problem, saw ${JSON.stringify(report.problems)}`,
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a manifest that is a directory or a symlink blocks', async () => {
  for (const shape of ['directory', 'symlink'] as const) {
    const workspacePath = makeWorkspace()
    try {
      const directory = journalDir(workspacePath, `assignment-${shape}`)
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
      const manifest = path.join(directory, 'manifest.json')
      if (shape === 'directory') fs.mkdirSync(manifest)
      else fs.symlinkSync('/dev/null', manifest)

      const report = await inspectWorkspaceActivationReadiness({
        workspacePath,
        environmentTenantId: 'local',
      })

      assert.equal(report.verdict, 'blocked', shape)
      assert.ok(
        report.problems.some((problem) => problem.kind === 'indeterminate'),
        `${shape}: ${JSON.stringify(report.problems)}`,
      )
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true })
    }
  }
})

test('a traversal the preflight cannot read blocks rather than reporting an empty workspace', async () => {
  const workspacePath = makeWorkspace()
  const sealed = path.join(workspacePath, 'sessions', 'session-sealed')
  try {
    fs.mkdirSync(path.join(sealed, 'runs'), { recursive: true })
    fs.chmodSync(sealed, 0o000)

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })

    assert.equal(report.verdict, 'blocked')
    assert.ok(
      report.problems.some((problem) => problem.kind === 'discovery_incomplete'),
      `expected a discovery problem, saw ${JSON.stringify(report.problems)}`,
    )
  } finally {
    fs.chmodSync(sealed, 0o700)
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a discovered journal that cannot then be inspected blocks', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-vanishing', 'local')
    // The state a scan race leaves behind: the manifest discovery saw is still
    // there, but the journal it names is not.
    fs.rmSync(
      path.join(journalDir(workspacePath, 'assignment-vanishing'), 'journal.jsonl'),
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
    })

    assert.equal(report.verdict, 'blocked')
    assert.ok(
      report.problems.some((problem) => problem.kind === 'indeterminate'),
      JSON.stringify(report.problems),
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('discovery that hits its limit blocks instead of reporting a partial workspace as clean', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-a', 'local')
    await enroll(workspacePath, 'assignment-b', 'acme')

    // A limit below the real population: the second journal's disagreeing
    // tenant is beyond it, so a truncating scan would answer READY.
    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
      limit: 1,
    })

    assert.equal(report.verdict, 'blocked')
    assert.ok(
      report.problems.some((problem) => problem.kind === 'discovery_incomplete'),
      JSON.stringify(report.problems),
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a symlink standing in for a session, run, or assignment directory blocks', async () => {
  for (const level of ['sessions', 'runs', 'assignments'] as const) {
    const workspacePath = makeWorkspace()
    const elsewhere = makeWorkspace()
    try {
      // Traversal kept only real directories and dropped symlink entries
      // without a word, so a redirected level made everything beneath it
      // invisible rather than unaccounted for.
      const base = path.join(workspacePath, 'sessions')
      if (level === 'sessions') {
        fs.mkdirSync(base, { recursive: true })
        fs.symlinkSync(elsewhere, path.join(base, 'session-linked'))
      } else if (level === 'runs') {
        const runs = path.join(base, 'session-one', 'runs')
        fs.mkdirSync(runs, { recursive: true })
        fs.symlinkSync(elsewhere, path.join(runs, 'run-linked'))
      } else {
        const assignments = path.join(base, 'session-one', 'runs', 'run-one', 'assignments')
        fs.mkdirSync(assignments, { recursive: true })
        fs.symlinkSync(elsewhere, path.join(assignments, 'assignment-linked'))
      }

      const report = await inspectWorkspaceActivationReadiness({
        workspacePath,
        environmentTenantId: 'local',
      })

      assert.equal(report.verdict, 'blocked', level)
      assert.ok(
        report.problems.some((problem) => problem.kind === 'discovery_incomplete'),
        `${level}: ${JSON.stringify(report.problems)}`,
      )
    } finally {
      fs.rmSync(workspacePath, { recursive: true, force: true })
      fs.rmSync(elsewhere, { recursive: true, force: true })
    }
  }
})

test('a workspace holding exactly the limit is complete, not truncated', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-a', 'local')
    await enroll(workspacePath, 'assignment-b', 'local')

    // Two journals, limit two: the scan saw everything. Reporting this as
    // truncated would block a workspace that is in fact completely described.
    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'local',
      limit: 2,
    })

    assert.equal(report.verdict, 'ready', JSON.stringify(report.problems))
    assert.equal(report.journalCount, 2)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * AC5's error-handling requirement: a cancellation that could not reach the
 * journal is reported, not discarded, and the report an operator reads is
 * this one. Without it the divergence lives only in one assignment's event
 * log, which is exactly where nobody looks before activating a workspace.
 */
test('the preflight surfaces a recorded journal divergence', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-diverged', 'tenant-one')
    await reportWorkflowJournalDivergence({
      assignmentPath: assignmentDir(workspacePath, 'assignment-diverged'),
      taskId: 'task-diverged',
      site: 'task-cancellation',
      error: new Error("Execution journal for assignment 'x' is unavailable."),
    })

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'tenant-one',
    })

    assert.equal(
      report.journalDivergences.length,
      1,
      'a recorded divergence must appear on the operator report',
    )
    const divergence = report.journalDivergences[0]
    assert.equal(divergence?.scope.assignmentId, 'assignment-diverged')
    assert.equal(divergence?.site, 'task-cancellation')
    assert.equal(divergence?.taskId, 'task-diverged')
    assert.match(divergence?.detail ?? '', /unavailable/i)
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a workspace with no divergence reports none', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-clean', 'tenant-one')
    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'tenant-one',
    })
    assert.deepEqual(report.journalDivergences, [])
    assert.equal(report.verdict, 'ready')
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

/**
 * The divergence record is an external file: written by one process, read by
 * another, and reachable by anything with write access to the assignment. The
 * preflight's discovery is fail-closed everywhere else — an unreadable
 * traversal is reported, an unreadable manifest is `indeterminate`, never
 * absence — and this boundary has to hold the same line.
 */

function divergencePath(workspacePath: string, assignmentId: string): string {
  return path.join(
    assignmentDir(workspacePath, assignmentId),
    '.runtime',
    'journal-divergence.json',
  )
}

function writeDivergenceFile(
  workspacePath: string,
  assignmentId: string,
  contents: string,
): string {
  const target = divergencePath(workspacePath, assignmentId)
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 })
  fs.writeFileSync(target, contents, { mode: 0o600 })
  return target
}

test('a divergence record with an unsupported schema version is reported unreadable', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-future', 'tenant-one')
    writeDivergenceFile(
      workspacePath,
      'assignment-future',
      `${JSON.stringify({
        schemaVersion: 999,
        taskId: 'task-future',
        site: 'task-cancellation',
        detail: 'written by a build this one cannot read',
        recordedAt: new Date().toISOString(),
      })}\n`,
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'tenant-one',
    })

    assert.equal(report.journalDivergences.length, 1)
    assert.equal(
      report.journalDivergences[0]?.site,
      'unreadable',
      'a record from a schema this build does not know must not be ' +
        'reconstructed as though it were version 1',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('a symlinked divergence record is reported unreadable without reading its target', async () => {
  const workspacePath = makeWorkspace()
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'divergence-target-'))
  try {
    await enroll(workspacePath, 'assignment-linked', 'tenant-one')
    const secret = path.join(outside, 'secret.json')
    fs.writeFileSync(
      secret,
      `${JSON.stringify({
        schemaVersion: 1,
        taskId: 'CONTENT-FROM-OUTSIDE-THE-ASSIGNMENT',
        site: 'task-cancellation',
        detail: 'CONTENT-FROM-OUTSIDE-THE-ASSIGNMENT',
        recordedAt: new Date().toISOString(),
      })}\n`,
    )
    const linkPath = divergencePath(workspacePath, 'assignment-linked')
    fs.mkdirSync(path.dirname(linkPath), { recursive: true, mode: 0o700 })
    fs.symlinkSync(secret, linkPath)

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'tenant-one',
    })

    assert.equal(report.journalDivergences.length, 1)
    const divergence = report.journalDivergences[0]
    assert.equal(
      divergence?.site,
      'unreadable',
      'a record reached through a symbolic link is decided by whoever ' +
        'controls the link target, so it must be refused',
    )
    assert.equal(
      JSON.stringify(divergence).includes('CONTENT-FROM-OUTSIDE-THE-ASSIGNMENT'),
      false,
      'and its target must not be read into the report at all',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('an oversized divergence record is reported unreadable', async () => {
  const workspacePath = makeWorkspace()
  try {
    await enroll(workspacePath, 'assignment-huge', 'tenant-one')
    // Padding in an ignored field, so the *only* thing wrong with this record
    // is its size. A record whose `detail` were oversized would be refused by
    // the schema's own bound and would prove nothing about the byte cap.
    writeDivergenceFile(
      workspacePath,
      'assignment-huge',
      `${JSON.stringify({
        schemaVersion: 1,
        taskId: 'task-huge',
        site: 'task-cancellation',
        detail: 'short enough to pass the schema',
        recordedAt: new Date().toISOString(),
        padding: 'x'.repeat(2_000_000),
      })}\n`,
    )

    const report = await inspectWorkspaceActivationReadiness({
      workspacePath,
      environmentTenantId: 'tenant-one',
    })

    assert.equal(report.journalDivergences.length, 1)
    const divergence = report.journalDivergences[0]
    assert.equal(
      divergence?.site,
      'unreadable',
      'a diagnostic large enough to exhaust the reader must be bounded ' +
        'before it is read, not after',
    )
    assert.ok(
      JSON.stringify(divergence).length < 4_096,
      'and the report must not carry the oversized content it refused',
    )
  } finally {
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})
