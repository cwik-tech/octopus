/**
 * The desktop app's Team host launch, tested without the desktop app.
 *
 * `DesktopRunLauncher` used to live inside `electron/main.ts`, which imports
 * Electron and cannot be loaded here at all. Extracted, it is an ordinary
 * module that takes the one capability it needs — somewhere to ask for the
 * provider environment — so its launch can be driven against a real child
 * process.
 *
 * Nothing is stubbed except the program the child runs and the provider
 * settings it reads: no Electron, no Pi, no provider, no network.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  DesktopRunLauncher,
  type RuntimeEnvironmentSource,
} from '../../domains/run/desktop-run-launcher.js'
import {
  toDetachedProcess,
  type SpawnDetachedProcess,
} from '../../domains/run/run-launcher.js'
import {
  PI_CLI_PATH_ENV,
  PI_NODE_PATH_ENV,
  RUNTIME_EXTENSION_ENTRY_ENV,
  TEAM_HOST_RUN_PROMPT,
} from '../../core/pi-runtime.js'

const SHARED_SETTINGS = JSON.stringify({
  defaultProvider: 'anthropic-api',
  defaultModel: 'the-user-chose-this',
})

/** What Pi does to its settings on `setModel`, and what the child reports. */
const REPORTS_AND_REWRITES_SETTINGS = `
const fs = require('node:fs')
const path = require('node:path')
const agentDir = process.env.PI_CODING_AGENT_DIR
fs.writeFileSync(
  process.env.DESKTOP_LAUNCH_REPORT,
  JSON.stringify({
    agentDir: agentDir ?? '',
    providerKey: process.env.PROVIDER_ONLY_KEY ?? '',
    contested: process.env.CONTESTED_KEY ?? '',
    startServices: process.env.TEAM_RUNTIME_START_SERVICES ?? '',
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
`

interface LaunchReport {
  readonly agentDir: string
  readonly providerKey: string
  readonly contested: string
  readonly startServices: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readReport(reportPath: string): LaunchReport {
  const parsed: unknown = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.ok(isRecord(parsed), 'the child must have reported its environment')
  const { agentDir, providerKey, contested, startServices } = parsed
  assert.ok(
    typeof agentDir === 'string' &&
      typeof providerKey === 'string' &&
      typeof contested === 'string' &&
      typeof startServices === 'string',
    'the report must be complete',
  )
  return { agentDir, providerKey, contested, startServices }
}

interface LaunchedArgv {
  readonly argv: readonly string[]
  readonly electronRunAsNode: string
}

function readLaunchedArgv(reportPath: string): LaunchedArgv {
  const parsed: unknown = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
  assert.ok(isRecord(parsed), 'the child must have reported its argv')
  const { argv, electronRunAsNode } = parsed
  assert.ok(Array.isArray(argv) && typeof electronRunAsNode === 'string', 'the report must be complete')
  return {
    argv: argv.filter((value): value is string => typeof value === 'string'),
    electronRunAsNode,
  }
}

interface Harness {
  readonly launcher: DesktopRunLauncher
  readonly sharedAgentDirectory: string
  readonly cwd: string
  readonly reportPath: string
  /** Resolves once the child has closed and the launcher has released. */
  closed(): Promise<unknown>
  child(): ChildProcess | undefined
  /** The command the launcher asked to start. */
  command(): string | undefined
  dispose(): void
}

function harness(
  childSource = REPORTS_AND_REWRITES_SETTINGS,
  /**
   * An agent directory the provider environment tries to impose.
   *
   * Left out by default: with it set, "the child did not get the shared
   * directory" would hold whether or not anything was isolated.
   */
  providerAgentDirectory: NodeJS.ProcessEnv = {},
): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-launch-'))
  const sharedAgentDirectory = path.join(root, 'shared-agent')
  fs.mkdirSync(sharedAgentDirectory)
  fs.writeFileSync(path.join(sharedAgentDirectory, 'settings.json'), SHARED_SETTINGS)
  fs.writeFileSync(path.join(sharedAgentDirectory, 'auth.json'), '{}', { mode: 0o600 })

  const cwd = path.join(root, 'run-cwd')
  fs.mkdirSync(cwd)
  const reportPath = path.join(root, 'report.json')

  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR
  // The stand-in for the user's own agent directory: `getAgentDir()` resolves
  // this variable, so the real one is never read or copied.
  process.env.PI_CODING_AGENT_DIR = sharedAgentDirectory

  let started: ChildProcess | undefined
  let startedCommand: string | undefined
  let closedPromise: Promise<unknown> | undefined
  const spawnProcess: SpawnDetachedProcess = (command, args, options) => {
    startedCommand = command
    // The launcher's arguments are passed through, so the child sees the argv
    // it was actually launched with.
    started = spawn(process.execPath, ['-e', childSource, '--', ...args], {
      ...options,
      stdio: 'ignore',
    })
    // Registered before the child is handed back: it exits quickly, and the
    // launcher's own release listener is registered first, so awaiting this
    // means the release has already run.
    closedPromise = once(started, 'close')
    return toDetachedProcess(started)
  }

  const providerSettings: RuntimeEnvironmentSource = {
    async runtimeEnvironment(): Promise<NodeJS.ProcessEnv> {
      return {
        PROVIDER_ONLY_KEY: 'from-provider-settings',
        CONTESTED_KEY: 'provider-wins',
        DESKTOP_LAUNCH_REPORT: reportPath,
        ...providerAgentDirectory,
      }
    },
  }

  return {
    launcher: new DesktopRunLauncher(root, providerSettings, spawnProcess),
    sharedAgentDirectory,
    cwd,
    reportPath,
    closed(): Promise<unknown> {
      assert.ok(closedPromise, 'the launch must have started a child')
      return closedPromise
    },
    child: () => started,
    command: () => startedCommand,
    dispose(): void {
      if (previousAgentDirectory === undefined) {
        delete process.env.PI_CODING_AGENT_DIR
      } else {
        process.env.PI_CODING_AGENT_DIR = previousAgentDirectory
      }
      if (started && started.exitCode === null && started.signalCode === null) {
        try { started.kill('SIGKILL') } catch { /* Already gone. */ }
      }
      fs.rmSync(root, { recursive: true, force: true })
    },
  }
}

test('the desktop launch gives its child an agent directory of its own', async () => {
  const context = harness()
  try {
    const result = await context.launcher.startRun({
      cwd: context.cwd,
      env: { CONTESTED_KEY: 'request-set-this' },
    })
    assert.equal(result.launched, true)

    const child = context.child()
    assert.ok(child, 'the launch must have started a child')
    // After the launch: the launcher unrefs a detached child, which is right
    // for a run and wrong for a test waiting on it.
    child.ref()
    await context.closed()

    const report = readReport(context.reportPath)
    assert.ok(report.agentDir, 'the child must be told which agent directory to use')
    assert.notEqual(
      report.agentDir,
      context.sharedAgentDirectory,
      "a desktop run must not be handed the user's own agent directory",
    )
    // What it *is*, not only what it is not: a directory this launch created.
    assert.ok(
      path.basename(report.agentDir).startsWith('team-host-pi-agent-'),
      `expected an isolated agent directory, got '${report.agentDir}'`,
    )
    assert.equal(
      fs.readFileSync(path.join(context.sharedAgentDirectory, 'settings.json'), 'utf8'),
      SHARED_SETTINGS,
      "a handover inside the run must leave the user's Pi default byte-identical",
    )
    assert.equal(
      fs.existsSync(report.agentDir),
      false,
      'and the copied credentials must not outlive the run',
    )
  } finally {
    context.dispose()
  }
})

test('the desktop launch keeps its environment precedence', async () => {
  const context = harness()
  try {
    await context.launcher.startRun({
      cwd: context.cwd,
      env: { CONTESTED_KEY: 'request-set-this' },
    })
    const child = context.child()
    assert.ok(child)
    child.ref()
    await context.closed()

    const report = readReport(context.reportPath)
    assert.equal(
      report.providerKey,
      'from-provider-settings',
      'the provider environment must reach the run',
    )
    assert.equal(
      report.contested,
      'provider-wins',
      'provider settings are composed after the request, and still are',
    )
    assert.equal(
      report.startServices,
      '0',
      'the desktop host does not start the runtime services',
    )
  } finally {
    context.dispose()
  }
})

test('isolation outranks an agent directory the provider environment names', async () => {
  // The desktop composes provider settings after the request, so a provider
  // environment naming an agent directory would win on ordering alone. It must
  // not: the isolation is applied last, and it exists precisely so no earlier
  // layer can point the host at a directory whose settings outlive the run.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-agent-dir-'))
  fs.writeFileSync(path.join(root, 'settings.json'), SHARED_SETTINGS)
  const context = harness(REPORTS_AND_REWRITES_SETTINGS, {
    PI_CODING_AGENT_DIR: root,
  })
  try {
    await context.launcher.startRun({ cwd: context.cwd, env: {} })
    const child = context.child()
    assert.ok(child)
    child.ref()
    await context.closed()

    const report = readReport(context.reportPath)
    assert.notEqual(
      report.agentDir,
      root,
      'the isolation must be applied after the provider environment',
    )
    assert.equal(
      fs.readFileSync(path.join(root, 'settings.json'), 'utf8'),
      SHARED_SETTINGS,
      'a directory the provider named must not be written through either',
    )
  } finally {
    context.dispose()
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the desktop launch runs the bundled Pi with its built-in tools switched off', async () => {
  const context = harness()
  const previousExtensionEntry = process.env[RUNTIME_EXTENSION_ENTRY_ENV]
  const extensionEntry = path.join(context.cwd, 'runtime-entry.js')
  process.env[RUNTIME_EXTENSION_ENTRY_ENV] = extensionEntry
  // Only has to exist: the launch refuses a bundled CLI path that names nothing.
  const bundledCli = path.join(context.cwd, 'bundled-pi-cli.js')
  fs.writeFileSync(bundledCli, '')
  // Differs from process.execPath, which is also the launcher's fallback, so the
  // assertion below can only pass if the configured value is used.
  const configuredNode = path.join(context.cwd, 'configured-node')
  try {
    await context.launcher.startRun({
      cwd: context.cwd,
      env: {
        [PI_CLI_PATH_ENV]: bundledCli,
        [PI_NODE_PATH_ENV]: configuredNode,
      },
    })
    const child = context.child()
    assert.ok(child, 'the launch must have started a child')
    child.ref()
    await context.closed()

    assert.equal(context.command(), configuredNode, 'the bundled CLI runs under the configured Node')
    const launched = readLaunchedArgv(context.reportPath)
    assert.deepEqual(
      launched.argv,
      [bundledCli, '--no-builtin-tools', '-e', extensionEntry, TEAM_HOST_RUN_PROMPT],
      "the host must start with Pi's built-in tools off, ahead of its own arguments",
    )
    assert.equal(launched.electronRunAsNode, '1', 'the bundled CLI must run as plain Node')
  } finally {
    if (previousExtensionEntry === undefined) delete process.env[RUNTIME_EXTENSION_ENTRY_ENV]
    else process.env[RUNTIME_EXTENSION_ENTRY_ENV] = previousExtensionEntry
    context.dispose()
  }
})
