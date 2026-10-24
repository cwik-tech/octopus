/**
 * What a Team host subprocess is actually given, and what is left behind.
 *
 * The unit tests around `isolatePiAgentDirectory` describe the directory. These
 * describe the launch: a real child process receives the environment
 * `launchTeamHostRun` composed, writes its Pi settings the way a coordinator
 * handover makes Pi write them, and the user's own settings file is compared
 * byte for byte afterwards.
 *
 * The child is a plain Node process rather than Pi. It stands in for the host
 * because the thing under test is the environment handed across the process
 * boundary and the cleanup that follows — not Pi's own behaviour, which the
 * installed source already settles.
 */
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  isolatePiAgentDirectory,
  type IsolatedPiAgentDirectory,
} from '../../domains/run/pi-agent-isolation.js'
import {
  launchTeamHostRun,
  PiRunLauncher,
  toDetachedProcess,
  type SpawnDetachedProcess,
} from '../../domains/run/run-launcher.js'
import {
  PI_CLI_PATH_ENV,
  RUNTIME_EXTENSION_ENTRY_ENV,
  TEAM_HOST_RUN_PROMPT,
} from '../../core/pi-runtime.js'

const SHARED_SETTINGS = JSON.stringify({
  defaultProvider: 'anthropic-api',
  defaultModel: 'the-user-chose-this',
})

/** What Pi does to its settings file on `setModel`, and nothing else. */
const REWRITES_ITS_SETTINGS = `
const fs = require('node:fs')
const path = require('node:path')
fs.writeFileSync(
  path.join(process.env.PI_CODING_AGENT_DIR, 'settings.json'),
  JSON.stringify({ defaultProvider: 'anthropic-api', defaultModel: 'chosen-by-a-handover' }),
)
`

function sharedAgentDirectory(): string {
  const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-agent-'))
  fs.writeFileSync(path.join(shared, 'settings.json'), SHARED_SETTINGS)
  fs.writeFileSync(path.join(shared, 'auth.json'), '{"anthropic":{"apiKey":"x"}}', {
    mode: 0o600,
  })
  return shared
}

test('a Team host writes its settings inside the run, not over the user\'s', async () => {
  const shared = sharedAgentDirectory()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'))
  let isolated: IsolatedPiAgentDirectory | undefined
  let child: ChildProcess | undefined
  let closed: Promise<unknown> | undefined

  // The child is a real process receiving the real composed environment; only
  // the program it runs is substituted, so nothing about the environment or the
  // cleanup path is stubbed.
  const spawnProcess: SpawnDetachedProcess = (_command, _args, options) => {
    child = spawn(process.execPath, ['-e', REWRITES_ITS_SETTINGS], {
      ...options,
      stdio: 'ignore',
    })
    // Registered before the child is handed back: this one writes a file and
    // exits, so it can close before the caller could attach a listener. The
    // launcher's own cleanup listener is registered first and has already run
    // by the time this resolves.
    closed = once(child, 'close')
    return toDetachedProcess(child)
  }

  try {
    const result = await launchTeamHostRun({
      extensionEntryPath: path.join(cwd, 'unused-entry.ts'),
      cwd,
      environment: { PATH: process.env.PATH ?? '' },
      spawnProcess,
      isolateAgentDirectory: () => {
        isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
        return isolated
      },
    })
    assert.equal(result.launched, true)
    assert.ok(isolated, 'the launch must have prepared a directory')
    assert.ok(child, 'the launch must have started a child')

    const isolatedSettingsPath = path.join(isolated.path, 'settings.json')
    assert.ok(closed, 'the launch must have started a child')
    // After the launch, because the launcher unrefs the child on "spawn" —
    // right for a detached run, and wrong for a test waiting on it.
    child.ref()
    await closed

    assert.equal(
      fs.readFileSync(path.join(shared, 'settings.json'), 'utf8'),
      SHARED_SETTINGS,
      "a handover must leave the user's own Pi default byte-identical",
    )
    assert.equal(
      fs.existsSync(isolatedSettingsPath),
      false,
      'and the copy it wrote instead must not outlive the run',
    )
    assert.equal(fs.existsSync(isolated.path), false)
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a launch that never starts leaves no copy of the credentials', async () => {
  const shared = sharedAgentDirectory()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'))
  let isolated: IsolatedPiAgentDirectory | undefined

  const throwsOnSpawn: SpawnDetachedProcess = () => {
    throw new Error('spawn failed before the child existed')
  }

  try {
    await assert.rejects(
      launchTeamHostRun({
        extensionEntryPath: path.join(cwd, 'unused-entry.ts'),
        cwd,
        environment: { PATH: process.env.PATH ?? '' },
        spawnProcess: throwsOnSpawn,
        isolateAgentDirectory: () => {
          isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
          return isolated
        },
      }),
      /spawn failed/,
    )
    assert.ok(isolated, 'the directory was prepared before the failure')
    assert.equal(
      fs.existsSync(isolated.path),
      false,
      'a failed launch must not leave the copied credentials on disk',
    )
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('a child that reports an error instead of starting is cleaned up too', async () => {
  const shared = sharedAgentDirectory()
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'))
  let isolated: IsolatedPiAgentDirectory | undefined

  // The asynchronous failure, at the real boundary: `spawn` returns a child
  // object and Node then emits `error` on it because the executable does not
  // exist. Nothing is stood in for — the same `toDetachedProcess` wrapper the
  // launcher uses in production wraps it.
  const missingExecutable = path.join(cwd, 'no-such-executable')
  const failsAfterSpawn: SpawnDetachedProcess = (_command, _args, options) =>
    toDetachedProcess(spawn(missingExecutable, [], { ...options, stdio: 'ignore' }))

  try {
    await assert.rejects(
      launchTeamHostRun({
        extensionEntryPath: path.join(cwd, 'unused-entry.ts'),
        cwd,
        environment: { PATH: process.env.PATH ?? '' },
        spawnProcess: failsAfterSpawn,
        isolateAgentDirectory: () => {
          isolated = isolatePiAgentDirectory({ sharedAgentDirectoryPath: shared })
          return isolated
        },
      }),
      /ENOENT/,
    )
    assert.ok(isolated)
    assert.equal(
      fs.existsSync(isolated.path),
      false,
      'a child that never started must not leave the credentials behind either',
    )
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(shared, { recursive: true, force: true })
  }
})

test('PiRunLauncher gives its child an agent directory of its own', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'))
  // A stand-in for the user's agent directory, so this test never reads or
  // copies the real one. `getAgentDir()` resolves this variable, which is the
  // same seam the launcher itself goes through.
  const shared = sharedAgentDirectory()
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR
  process.env.PI_CODING_AGENT_DIR = shared

  let childEnvironment: NodeJS.ProcessEnv | undefined
  let closed: Promise<unknown> | undefined
  let started: ChildProcess | undefined

  const spawnProcess: SpawnDetachedProcess = (_command, _args, options) => {
    childEnvironment = options.env
    const child = spawn(process.execPath, ['-e', ''], { ...options, stdio: 'ignore' })
    // Registered before the child is handed back, because a process this small
    // can close before the caller has a chance to listen.
    closed = once(child, 'close')
    started = child
    return toDetachedProcess(child)
  }

  try {
    const result = await new PiRunLauncher(spawnProcess).startRun({ cwd, env: {} })
    assert.equal(result.launched, true)

    const given = childEnvironment?.PI_CODING_AGENT_DIR
    assert.ok(given, 'the child must be told which agent directory to use')
    assert.notEqual(
      given,
      shared,
      "a run must not be handed the launcher's own agent directory",
    )
    assert.ok(
      path.basename(given).startsWith('team-host-pi-agent-'),
      `expected a directory this launch created, got '${given}'`,
    )

    assert.ok(closed, 'the launch must have started a child')
    // After the launch, because the launcher unrefs the child on "spawn".
    started?.ref()
    await closed
    assert.equal(
      fs.existsSync(given),
      false,
      'and it must not outlive the run it was made for',
    )
    assert.equal(
      fs.readFileSync(path.join(shared, 'settings.json'), 'utf8'),
      SHARED_SETTINGS,
      "the stand-in for the user's own settings must be untouched",
    )
  } finally {
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory
    fs.rmSync(shared, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})

test('PiRunLauncher starts Pi with its built-in tools switched off', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'))
  const shared = sharedAgentDirectory()
  const argvPath = path.join(cwd, 'child-argv.json')
  const extensionEntry = path.join(cwd, 'runtime-entry.ts')
  const previousAgentDirectory = process.env.PI_CODING_AGENT_DIR
  const previousExtensionEntry = process.env[RUNTIME_EXTENSION_ENTRY_ENV]
  process.env.PI_CODING_AGENT_DIR = shared
  process.env[RUNTIME_EXTENSION_ENTRY_ENV] = extensionEntry

  let command: string | undefined
  let closed: Promise<unknown> | undefined
  let started: ChildProcess | undefined

  // The launcher's arguments reach a stand-in program unchanged, and the child
  // records the argv it was actually started with.
  const spawnProcess: SpawnDetachedProcess = (givenCommand, args, options) => {
    command = givenCommand
    const recordsItsArgv =
      `require('node:fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(1)))`
    const child = spawn(process.execPath, ['-e', recordsItsArgv, '--', ...args], {
      ...options,
      stdio: 'ignore',
    })
    closed = once(child, 'close')
    started = child
    return toDetachedProcess(child)
  }

  try {
    // Named empty so the Pi on PATH is chosen, whatever the parent's environment says.
    const result = await new PiRunLauncher(spawnProcess).startRun({
      cwd,
      env: { [PI_CLI_PATH_ENV]: '' },
    })
    assert.equal(result.launched, true)
    assert.ok(closed, 'the launch must have started a child')
    started?.ref()
    await closed

    assert.equal(command, process.platform === 'win32' ? 'pi.cmd' : 'pi')
    const recorded: unknown = JSON.parse(fs.readFileSync(argvPath, 'utf8'))
    assert.deepEqual(
      recorded,
      ['--no-builtin-tools', '-e', extensionEntry, TEAM_HOST_RUN_PROMPT],
      'the host must start with Pi\'s built-in tools off, ahead of its own arguments',
    )
  } finally {
    if (previousAgentDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDirectory
    if (previousExtensionEntry === undefined) delete process.env[RUNTIME_EXTENSION_ENTRY_ENV]
    else process.env[RUNTIME_EXTENSION_ENTRY_ENV] = previousExtensionEntry
    fs.rmSync(shared, { recursive: true, force: true })
    fs.rmSync(cwd, { recursive: true, force: true })
  }
})
