/**
 * What a nested team run leaves behind, and what its child was given.
 *
 * `runTeam` is the public entry point; everything below it — the attempt's
 * temporary directory, the isolated Pi agent directory inside it, the spawn —
 * is private. These tests drive `runTeam` and look only at what a caller can
 * see: the environment the child actually received, the user's own settings
 * file, and whether the run cleaned up after itself.
 *
 * The child is a local fake `pi`: a plain script named through the bundled-CLI
 * variables the runtime already honours, so no real Pi, provider or network is
 * involved, and nothing depends on `PATH`, an executable bit, or a shebang. It
 * reports its own `PI_CODING_AGENT_DIR` and writes its settings there, which is
 * what the installed Pi does on every coordinator handover.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { runTeam } from '../../domains/agent-execution/agent-runner.js'
import { RUN_PRIVATE_RUNTIME_DIRECTORY_NAME } from '../../core/run-assignment-location.js'
import { RUN_TEMPORARY_DIRECTORY_NAME } from '../../domains/runtime/runtime-paths.js'
import {
  PI_CLI_PATH_ENV,
  PI_NODE_PATH_ENV,
  RUNTIME_EXTENSION_ENTRY_ENV,
} from '../../core/pi-runtime.js'
import { resolveFilesystemOwnershipPolicy } from '../../domains/run/pi-agent-isolation.js'

/** What this platform can say about permissions, asked once. */
const POLICY = resolveFilesystemOwnershipPolicy(process.platform)

/** Apply an environment and give back the undo for exactly its keys. */
function withEnvironment(entries: Readonly<Record<string, string>>): () => void {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(entries)) {
    previous.set(key, process.env[key])
    process.env[key] = value
  }
  return (): void => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

const SHARED_SETTINGS = JSON.stringify({
  defaultProvider: 'anthropic-api',
  defaultModel: 'the-user-chose-this',
})

const REPORT_PATH_ENV = 'TEAM_ISOLATION_TEST_REPORT'

/**
 * A fake `pi` that behaves like the host in the one way that matters: it
 * records the agent directory it was given and writes its settings there. It
 * also records the argv it was started with.
 */
const FAKE_PI = `const fs = require('node:fs')
const path = require('node:path')
const agentDir = process.env.PI_CODING_AGENT_DIR
// Reported from inside the child, while the directories still exist: sampling
// them from the test would race the run's own cleanup.
fs.writeFileSync(
  process.env.${REPORT_PATH_ENV},
  JSON.stringify({
    agentDir: agentDir ?? '',
    pid: process.pid,
    attemptMode: agentDir
      ? (fs.statSync(path.dirname(agentDir)).mode & 0o777).toString(8)
      : '',
    argv: process.argv.slice(1),
    electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? '',
  }),
)
if (agentDir) {
  fs.writeFileSync(
    path.join(agentDir, 'settings.json'),
    JSON.stringify({ defaultProvider: 'anthropic-api', defaultModel: 'chosen-by-a-handover' }),
  )
}
fs.writeFileSync(path.join(process.cwd(), 'memo.md'), 'done')
process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
`

interface ChildReport {
  readonly agentDir: string
  readonly pid: number
  readonly attemptMode: string
}

/** How the child was started: its argv after the Node binary, and one variable. */
interface ChildLaunch {
  readonly argv: readonly string[]
  readonly electronRunAsNode: string
}

interface Fixture {
  readonly teamPath: string
  readonly binDirectory: string
  readonly workspacePath: string
  readonly sharedAgentDirectory: string
  readonly reportPath: string
  readonly fakePiPath: string
  /** What the child reported about itself, or null if none ever ran. */
  childReport(): ChildReport | null
  /** The argv the child reported, or null if none ever ran. */
  childLaunch(): ChildLaunch | null
  /** Every attempt temporary directory still on disk under this workspace. */
  attemptDirectories(): string[]
  dispose(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a process this test started is gone.
 *
 * Signal 0 asks the question without sending anything. A test that starts a
 * child must be able to say it ended, or it is one of the strays it is meant to
 * rule out.
 */
function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch {
    return true
  }
}

function fixture(fakePiSource = FAKE_PI): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'team-isolation-'))
  const binDir = path.join(root, 'bin')
  fs.mkdirSync(binDir)
  // A plain `.js` file run by this Node, named through the bundled-CLI
  // variables the runtime already honours. A shebang script on `PATH` would
  // need an executable bit and a `/usr/bin/env` that Windows does not have.
  fs.writeFileSync(path.join(binDir, 'fake-pi.js'), fakePiSource)

  const teamPath = path.join(root, 'team')
  const workerDir = path.join(teamPath, 'agents', 'worker')
  fs.mkdirSync(workerDir, { recursive: true })
  fs.writeFileSync(path.join(workerDir, 'worker.md'), '# Worker')
  fs.writeFileSync(
    path.join(teamPath, 'team.yaml'),
    `team:
  name: child-team
workspace:
  path: child-workspace
agents:
  - name: worker
    type: agent
    role: worker
    tier: strategic
    agent_file: agents/worker/worker.md
levels:
  - id: l1
    name: Child Level
    order: 0
    stage:
      type: pipeline
      coordinator: worker
      config:
        parallel: false
        gate:
          type: artifact_exists
          strictness: hard
gates: []
`,
  )

  const sharedAgentDirectory = path.join(root, 'shared-agent')
  fs.mkdirSync(sharedAgentDirectory)
  fs.writeFileSync(path.join(sharedAgentDirectory, 'settings.json'), SHARED_SETTINGS)
  fs.writeFileSync(path.join(sharedAgentDirectory, 'auth.json'), '{}', { mode: 0o600 })

  const workspacePath = path.join(teamPath, 'child-workspace')
  const reportPath = path.join(root, 'report.txt')
  fs.writeFileSync(reportPath, '')

  const fakePiPath = path.join(binDir, 'fake-pi.js')
  const restoreEnvironment = withEnvironment({
    [PI_CLI_PATH_ENV]: fakePiPath,
    [PI_NODE_PATH_ENV]: process.execPath,
    PI_CODING_AGENT_DIR: sharedAgentDirectory,
    [REPORT_PATH_ENV]: reportPath,
  })

  return {
    teamPath,
    binDirectory: binDir,
    workspacePath,
    sharedAgentDirectory,
    reportPath,
    fakePiPath,
    childLaunch(): ChildLaunch | null {
      const raw = fs.readFileSync(reportPath, 'utf8')
      if (!raw.trim()) return null
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) return null
      const { argv, electronRunAsNode } = parsed
      if (!Array.isArray(argv) || typeof electronRunAsNode !== 'string') return null
      return {
        argv: argv.filter((value): value is string => typeof value === 'string'),
        electronRunAsNode,
      }
    },
    childReport(): ChildReport | null {
      const raw = fs.readFileSync(reportPath, 'utf8')
      if (!raw.trim()) return null
      const parsed: unknown = JSON.parse(raw)
      if (!isRecord(parsed)) return null
      const { agentDir, pid, attemptMode } = parsed
      if (
        typeof agentDir !== 'string' ||
        typeof pid !== 'number' ||
        typeof attemptMode !== 'string'
      ) {
        return null
      }
      return { agentDir, pid, attemptMode }
    },
    attemptDirectories(): string[] {
      const assignments = path.join(workspacePath, 'assignments')
      if (!fs.existsSync(assignments)) return []
      const found: string[] = []
      for (const assignment of fs.readdirSync(assignments)) {
        const temporary = path.join(
          assignments,
          assignment,
          RUN_PRIVATE_RUNTIME_DIRECTORY_NAME,
          RUN_TEMPORARY_DIRECTORY_NAME,
        )
        if (!fs.existsSync(temporary)) continue
        for (const attempt of fs.readdirSync(temporary)) {
          found.push(path.join(temporary, attempt))
        }
      }
      return found
    },
    dispose(): void {
      restoreEnvironment()
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

test('a nested team run gives its child an agent directory of its own', async () => {
  const context = fixture()
  try {
    await runTeam({
      teamPath: context.teamPath,
      workspacePath: context.workspacePath,
      brief: 'Write the memo.',
      outputArtifact: 'memo.md',
      spawnDepth: 0,
    })

    const report = context.childReport()
    assert.ok(report, 'the child must have run and reported')
    assert.ok(report.agentDir, 'the child must be told which agent directory to use')
    assert.notEqual(
      report.agentDir,
      context.sharedAgentDirectory,
      "a nested run must not be handed the parent's agent directory",
    )
    // It holds a copy of the user's credentials for the life of the run, so it
    // is theirs alone. Read inside the child, before cleanup could race it —
    // and only where the platform expresses permission bits at all.
    if (POLICY.enforcesPermissionBits) {
      assert.equal(
        report.attemptMode,
        '700',
        'the directory holding the copied credentials must be private',
      )
    }
    assert.ok(processIsGone(report.pid), 'this test must not strand its child')
    assert.equal(
      fs.readFileSync(path.join(context.sharedAgentDirectory, 'settings.json'), 'utf8'),
      SHARED_SETTINGS,
      "a handover inside the run must leave the user's Pi default untouched",
    )
    assert.equal(
      fs.existsSync(report.agentDir),
      false,
      'and the copied credentials must not outlive the run',
    )
    assert.deepEqual(
      context.attemptDirectories(),
      [],
      'the attempt directory must be cleaned up on success',
    )
  } finally {
    context.dispose()
  }
})

test('a nested team run starts the bundled Pi with its built-in tools switched off', async () => {
  const context = fixture()
  const extensionEntry = path.join(context.binDirectory, 'runtime-entry.js')
  const restoreEntry = withEnvironment({ [RUNTIME_EXTENSION_ENTRY_ENV]: extensionEntry })
  try {
    await runTeam({
      teamPath: context.teamPath,
      workspacePath: context.workspacePath,
      brief: 'Write the memo.',
      outputArtifact: 'memo.md',
      spawnDepth: 0,
    })

    const launch = context.childLaunch()
    assert.ok(launch, 'the child must have run and reported')
    assert.equal(launch.argv[0], context.fakePiPath, 'the bundled CLI named in the environment must be what runs')
    assert.deepEqual(
      launch.argv.slice(1, 4),
      ['--no-builtin-tools', '-e', extensionEntry],
      "the child must start with Pi's built-in tools off, ahead of the run's own arguments",
    )
    assert.equal(launch.argv.filter((argument) => argument === '--no-builtin-tools').length, 1)
    assert.equal(launch.electronRunAsNode, '1', 'the bundled CLI must run as plain Node')
  } finally {
    restoreEntry()
    context.dispose()
  }
})

test('a spawn that never starts leaves nothing behind', async () => {
  const context = fixture()
  // An interpreter that does not exist: `spawn` reports ENOENT and no child is
  // ever created, so nothing arrives later to clean up. Restored by the
  // fixture, which captured this key when it set it.
  process.env[PI_NODE_PATH_ENV] = path.join(context.binDirectory, 'no-such-node')
  try {
    await runTeam({
      teamPath: context.teamPath,
      workspacePath: context.workspacePath,
      brief: 'Write the memo.',
      outputArtifact: 'memo.md',
      spawnDepth: 0,
    })

    assert.equal(context.childReport(), null, 'precondition: no child ran')
    assert.deepEqual(
      context.attemptDirectories(),
      [],
      'a launch that never started must not leave the copied credentials on disk',
    )
  } finally {
    context.dispose()
  }
})

test('a run whose reporting fails still cleans up', async () => {
  // `resolveChildRuntimeTerminalStatus` reads the runtime event log to decide
  // the run's status, and reads it outside any catch
  // (`domains/agent-execution/agent-runner.ts:625-628`). A directory where that
  // file belongs makes reporting throw after the child has already closed —
  // the window in which cleanup used to be skipped entirely.
  const context = fixture(`const fs = require('node:fs')
const path = require('node:path')
const agentDir = process.env.PI_CODING_AGENT_DIR
fs.writeFileSync(
  process.env.${REPORT_PATH_ENV},
  JSON.stringify({
    agentDir: agentDir ?? '',
    pid: process.pid,
    attemptMode: agentDir
      ? (fs.statSync(path.dirname(agentDir)).mode & 0o777).toString(8)
      : '',
  }),
)
fs.mkdirSync(path.join(process.cwd(), 'logs', 'runtime-events.jsonl'), { recursive: true })
process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
`)
  try {
    await assert.rejects(
      runTeam({
        teamPath: context.teamPath,
        workspacePath: context.workspacePath,
        brief: 'Write the memo.',
        outputArtifact: 'memo.md',
        spawnDepth: 0,
      }),
      'a run that cannot report its own outcome must not resolve as if it had',
    )

    const report = context.childReport()
    assert.ok(report, 'precondition: the child ran')
    assert.ok(processIsGone(report.pid), 'this test must not strand its child')
    assert.equal(
      fs.existsSync(report.agentDir),
      false,
      'a reporting failure must still release the copied credentials',
    )
    assert.deepEqual(
      context.attemptDirectories(),
      [],
      'nor leave the attempt directory behind',
    )
  } finally {
    context.dispose()
  }
})

test('a run that cannot prepare an agent directory leaves nothing behind', async () => {
  const context = fixture()
  try {
    // A directory where `auth.json` is expected: unreadable as a file at every
    // privilege level, so preparation fails closed before anything is spawned.
    fs.rmSync(path.join(context.sharedAgentDirectory, 'auth.json'))
    fs.mkdirSync(path.join(context.sharedAgentDirectory, 'auth.json'))

    // Failing closed is the point: the run must not fall back to the shared
    // directory.
    await assert.rejects(
      runTeam({
        teamPath: context.teamPath,
        workspacePath: context.workspacePath,
        brief: 'Write the memo.',
        outputArtifact: 'memo.md',
        spawnDepth: 0,
      }),
      /private Pi agent directory/i,
      'a run that cannot be isolated must not quietly proceed',
    )

    assert.equal(
      context.childReport(),
      null,
      'no child may run when the run could not be given its own agent directory',
    )
    assert.deepEqual(
      context.attemptDirectories(),
      [],
      'and the attempt directory must not be left behind',
    )
  } finally {
    context.dispose()
  }
})

test('a run that fails and then fails to clean up reports both', function (t) {
  // The two failures arrive together: reporting throws after the child closed,
  // and the copied credentials cannot be removed. Choosing one would hide the
  // other, and the one that would be hidden is the one saying a copy of the
  // user's credentials is still on disk.
  //
  // The cleanup is made to fail by taking write permission off the directory
  // that contains it: still readable and traversable, so the removal reaches
  // the entries and then cannot unlink them. That is the only way to reach this
  // from outside without standing in front of the filesystem.
  if (!POLICY.enforcesPermissionBits) {
    t.skip('this platform cannot withhold write permission this way')
    return
  }

  const context = fixture(`const fs = require('node:fs')
const path = require('node:path')
const agentDir = process.env.PI_CODING_AGENT_DIR
fs.writeFileSync(
  process.env.${REPORT_PATH_ENV},
  JSON.stringify({ agentDir: agentDir ?? '', pid: process.pid, attemptMode: '' }),
)
// Reporting reads this to decide the run's status, and reads it outside any
// catch (\`domains/agent-execution/agent-runner.ts:625-628\`).
fs.mkdirSync(path.join(process.cwd(), 'logs', 'runtime-events.jsonl'), { recursive: true })
// And the attempt directory loses write permission — still readable and
// traversable, so the removal reaches its entries and then cannot unlink them.
fs.chmodSync(path.dirname(agentDir), 0o500)
process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
`)
  return (async () => {
    try {
      const failure = await runTeam({
        teamPath: context.teamPath,
        workspacePath: context.workspacePath,
        brief: 'Write the memo.',
        outputArtifact: 'memo.md',
        spawnDepth: 0,
      }).then(
        () => null,
        (error: unknown) => error,
      )

      assert.ok(failure instanceof Error, 'the run must report a failure')
      assert.ok(
        failure instanceof AggregateError,
        `both failures must survive; got a single ${failure.constructor.name}: ${failure.message}`,
      )
      assert.equal(failure.errors.length, 2, 'the reporting failure and the cleanup failure')

      // Which two, not merely how many. A count alone would pass on any pair.
      const [reportingFailure, cleanupFailure] = failure.errors
      assert.ok(reportingFailure instanceof Error && cleanupFailure instanceof Error)
      // Node's read error does not carry the path, so the reporting failure is
      // identified by what it is: reading a directory as a file, which is what
      // the run's status lookup did to `logs/runtime-events.jsonl`.
      assert.match(
        reportingFailure.message,
        /EISDIR|illegal operation on a directory/i,
        'the first must be the reporting failure the caller was waiting on',
      )
      // Matched on the exact directory still on disk, not on an errno string
      // that differs between platforms and not on a guess about which nested
      // removal threw first. Whichever it was, its path lies inside this one.
      const remaining = context.attemptDirectories()
      assert.equal(
        remaining.length,
        1,
        'the attempt directory must still be there, since removing it is what failed',
      )
      const remainingAttempt = remaining[0]
      assert.ok(remainingAttempt)
      assert.ok(
        cleanupFailure.message.includes(remainingAttempt),
        `the second must name the directory whose removal failed; expected '${remainingAttempt}' in '${cleanupFailure.message}'`,
      )
      assert.match(
        failure.message,
        /private Pi agent directory/i,
        'and the message must say the credentials may still be on disk',
      )
    } finally {
      // Restore traversal before the fixture tries to remove any of it.
      for (const attempt of context.attemptDirectories()) {
        try { fs.chmodSync(attempt, 0o700) } catch { /* Already gone. */ }
      }
      context.dispose()
    }
  })()
})
