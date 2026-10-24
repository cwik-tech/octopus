import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { test, type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { PI_CLI_PATH_ENV, PI_NODE_PATH_ENV } from '../../core/pi-runtime.js'
import {
  CONFIGURED_PROVIDER_BROKER_URL_ENV,
  CONFIGURED_PROVIDERS_ENV,
} from '../../domains/provider/provider-settings.js'
import { fixtureDesktopEnvironment } from '../support/desktop-journey-environment.js'
import {
  defaultVoiceControlDir,
  VOICE_CONTROL_DIR_ENV,
} from '../../domains/voice-control/discovery-files.js'

// A desktop journey launches the real app with a fake provider. These tests
// check the environment it launches with at the boundaries the app itself
// uses: a real child process, the real CLI search path, and the real provider
// modules spawning their CLIs. The host is simulated in a temporary directory:
// its home, config and temporary folders are empty, its provider CLIs are
// sentinel scripts that record being run, and its credentials and runtime
// routes are made-up values. No real CLI, key, account or credential file is
// reachable, read or printed.

const PROVIDER_CLIS = ['claude', 'codex', 'gemini', 'kimi', 'qwen', 'pi'] as const

/** Made-up values standing in for a developer's own keys and runtime routes. */
const SENTINEL_HOST_VALUES: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: 'sentinel-anthropic-key',
  CLAUDE_API_KEY: 'sentinel-claude-key',
  OPENAI_API_KEY: 'sentinel-openai-key',
  OPENAI_BASE_URL: 'http://sentinel-openai.invalid/v1',
  OPENROUTER_API_KEY: 'sentinel-openrouter-key',
  XAI_API_KEY: 'sentinel-xai-key',
  DEEPSEEK_API_KEY: 'sentinel-deepseek-key',
  MOONSHOT_API_KEY: 'sentinel-moonshot-key',
  KIMI_API_KEY: 'sentinel-kimi-key',
  [PI_CLI_PATH_ENV]: '/sentinel/pi-cli',
  [PI_NODE_PATH_ENV]: '/sentinel/pi-node',
  [CONFIGURED_PROVIDERS_ENV]: 'sentinel-configured-providers',
  [CONFIGURED_PROVIDER_BROKER_URL_ENV]: 'http://sentinel-broker.invalid',
}

/** A child that has not finished in this long is killed with its process group. */
const CHILD_BOUND_MS = 30_000

interface SimulatedHost {
  readonly environment: NodeJS.ProcessEnv
  readonly home: string
  readonly temporary: string
  /** Sentinels for every provider CLI, first on the host PATH. */
  readonly sentinelBin: string
  /** A directory with an ordinary tool and no provider CLI. */
  readonly toolBin: string
  /** An ordinary tool beside a provider CLI, as `/opt/homebrew/bin` often is. */
  readonly mixedBin: string
  readonly launchedLog: string
  readonly root: string
}

async function writeExecutable(file: string, body: string): Promise<void> {
  await fs.writeFile(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
}

/**
 * A host with no `PIPELINE_CLI_PATH_FALLBACK` set, as on a developer's machine,
 * whose PATH starts with a directory of sentinel provider CLIs.
 */
async function simulatedHost(t: TestContext): Promise<SimulatedHost> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'desktop-journey-env-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const home = path.join(root, 'home')
  const temporary = path.join(root, 'tmp')
  const sentinelBin = path.join(root, 'sentinel-bin')
  const toolBin = path.join(root, 'tool-bin')
  const mixedBin = path.join(root, 'mixed-bin')
  const launchedLog = path.join(root, 'launched.log')
  for (const directory of [home, temporary, sentinelBin, toolBin, mixedBin]) {
    await fs.mkdir(directory, { recursive: true })
  }
  for (const command of PROVIDER_CLIS) {
    await writeExecutable(path.join(sentinelBin, command), `echo ${command} >> '${launchedLog}'\nexit 97`)
  }
  await writeExecutable(path.join(toolBin, 'fixture-tool'), 'exit 0')
  await writeExecutable(path.join(mixedBin, 'fixture-tool-too'), 'exit 0')
  await writeExecutable(path.join(mixedBin, 'codex'), `echo codex-in-mixed >> '${launchedLog}'\nexit 97`)
  return {
    root,
    home,
    temporary,
    sentinelBin,
    toolBin,
    mixedBin,
    launchedLog,
    environment: {
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, '.config'),
      XDG_DATA_HOME: path.join(home, '.local', 'share'),
      TMPDIR: temporary,
      PATH: [sentinelBin, toolBin, mixedBin].join(path.delimiter),
      PIPELINE_DESKTOP_E2E_HEADLESS: '1',
      ...SENTINEL_HOST_VALUES,
    },
  }
}

const moduleUrl = (relative: string): string => new URL(relative, import.meta.url).href

/**
 * Runs `probe` as an ES module in a child Node process with `environment`, and
 * returns what it printed as JSON.
 *
 * The child loads the same build of the app's modules this test runs from:
 * compiled `.tests-dist` modules, or the TypeScript sources through tsx. It
 * leads its own process group, so if it outlives its bound the whole group it
 * started is killed, and nothing else.
 */
async function inChild(
  host: SimulatedHost,
  name: string,
  environment: Record<string, string>,
  probe: string,
): Promise<unknown> {
  const script = path.join(host.root, `${name}.mjs`)
  await fs.writeFile(script, probe)
  const fromSource = fileURLToPath(import.meta.url).endsWith('.ts')
  const child = spawn(process.execPath, [...(fromSource ? ['--import', 'tsx'] : []), script], {
    cwd: fileURLToPath(new URL('../..', moduleUrl('./'))),
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  let timer: NodeJS.Timeout | undefined
  const code = await new Promise<number | null>((resolve, reject) => {
    timer = setTimeout(() => {
      if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL')
      reject(new Error(`probe ${name} did not finish within ${CHILD_BOUND_MS} ms: ${stderr}`))
    }, CHILD_BOUND_MS)
    child.once('error', reject)
    child.once('close', resolve)
  }).finally(() => clearTimeout(timer))
  assert.equal(code, 0, `probe ${name} exited ${String(code)}: ${stderr}`)
  const parsed: unknown = JSON.parse(stdout)
  return parsed
}

/** The directories the child's own CLI lookup would search, in order. */
async function childCliSearchPath(
  host: SimulatedHost,
  name: string,
  environment: Record<string, string>,
): Promise<string[]> {
  const entries = await inChild(host, name, environment, `
    const { cliPathEntries } = await import(${JSON.stringify(moduleUrl('../../core/cli-path.js'))})
    process.stdout.write(JSON.stringify(cliPathEntries()))
  `)
  assert.ok(Array.isArray(entries) && entries.every((entry) => typeof entry === 'string'))
  return entries
}

async function readLaunched(launchedLog: string): Promise<string[]> {
  try {
    return (await fs.readFile(launchedLog, 'utf8')).split('\n').filter(Boolean)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
    throw error
  }
}

test('a desktop journey is launched with exactly its operational values, a CLI-free PATH and no fallback', async (t) => {
  const host = await simulatedHost(t)

  assert.deepEqual(fixtureDesktopEnvironment(host.environment), {
    HOME: host.home,
    TMPDIR: host.temporary,
    PATH: host.toolBin,
    PIPELINE_CLI_PATH_FALLBACK: '0',
    PIPELINE_DESKTOP_E2E_HEADLESS: '1',
    [VOICE_CONTROL_DIR_ENV]: path.join(host.temporary, 'octopus-desktop-journeys', 'voice-control'),
  })
})

test('a desktop journey searches only its own PATH for CLIs, with no fallback directories', async (t) => {
  const host = await simulatedHost(t)
  const journey = fixtureDesktopEnvironment(host.environment)

  // The real resolver, in a process with the journey's environment. Nothing
  // is spawned, so a helper that left the fallback on fails here and cannot
  // run a CLI installed in one of those directories.
  const entries = await childCliSearchPath(host, 'search-path', journey)

  assert.deepEqual(entries, [host.toolBin])
})

test('a desktop journey cannot launch a provider CLI that sits on the host PATH', async (t) => {
  const host = await simulatedHost(t)
  // The fallback is pinned off here, independently of the helper, and the
  // search path is checked before anything is spawned, so this test can only
  // ever run the simulated host's own sentinels, never an installed CLI.
  const journey = { ...fixtureDesktopEnvironment(host.environment), PIPELINE_CLI_PATH_FALLBACK: '0' }
  for (const directory of await childCliSearchPath(host, 'spawn-safety', journey)) {
    assert.ok(
      directory.startsWith(`${host.root}${path.sep}`),
      `refusing to run providers: ${directory} is outside the simulated host`,
    )
  }

  const outcomes = await inChild(host, 'spawn-providers', journey, `
    const factories = {
      claude: (await import(${JSON.stringify(moduleUrl('../../providers/claude.js'))})).createClaudeProvider,
      codex: (await import(${JSON.stringify(moduleUrl('../../providers/codex.js'))})).createCodexProvider,
      gemini: (await import(${JSON.stringify(moduleUrl('../../providers/gemini.js'))})).createGeminiProvider,
      kimi: (await import(${JSON.stringify(moduleUrl('../../providers/kimi-cli.js'))})).createKimiCliProvider,
      qwen: (await import(${JSON.stringify(moduleUrl('../../providers/qwen.js'))})).createQwenProvider,
    }
    const outcomes = {}
    for (const [name, create] of Object.entries(factories)) {
      try {
        await create().execute({ systemPrompt: 'Reply OK.', userMessage: 'OK', model: 'default', thinking: 'low' })
        outcomes[name] = { answered: true }
      } catch (error) {
        outcomes[name] = {
          name: error?.name ?? null,
          kind: error?.kind ?? null,
          code: error?.code ?? null,
          dispatched: error?.dispatched ?? null,
        }
      }
    }
    process.stdout.write(JSON.stringify(outcomes))
  `)

  // No sentinel ran, which would mean a real CLI in its place would have run.
  assert.deepEqual(await readLaunched(host.launchedLog), [])
  // And each provider stopped at its own missing-executable boundary: a
  // configuration error for a CLI it could not find, with nothing sent. Any
  // other failure is not evidence that the CLI was absent.
  const missing = { name: 'ProviderError', kind: 'configuration', code: 'executable_unavailable', dispatched: false }
  assert.deepEqual(outcomes, {
    claude: missing,
    codex: missing,
    // Gemini's own spawn reports the missing binary without a code.
    gemini: { ...missing, code: null },
    kimi: missing,
    qwen: missing,
  })
})

test('a desktop journey carries none of the host provider credentials or runtime routes', async (t) => {
  const host = await simulatedHost(t)
  const journey = fixtureDesktopEnvironment(host.environment)

  const carried = await inChild(host, 'credentials', journey, `
    const sentinels = new Set(${JSON.stringify(Object.values(SENTINEL_HOST_VALUES))})
    process.stdout.write(JSON.stringify(Object.keys(process.env).filter((key) => sentinels.has(process.env[key])).sort()))
  `)

  assert.deepEqual(carried, [])
})

test('a journey adds its own fixture key and endpoint on top of the base environment', async (t) => {
  const host = await simulatedHost(t)
  const journey = {
    ...fixtureDesktopEnvironment(host.environment),
    OPENAI_API_KEY: 'fixture-key',
    OPENAI_BASE_URL: 'http://127.0.0.1:1/v1',
  }

  const seen = await inChild(host, 'fixture-overrides', journey, `
    process.stdout.write(JSON.stringify([process.env.OPENAI_API_KEY, process.env.OPENAI_BASE_URL]))
  `)

  assert.deepEqual(seen, ['fixture-key', 'http://127.0.0.1:1/v1'])
})

test('a desktop journey advertises voice control only in its temporary folder', () => {
  // The smoke journey starts the desktop as a shipped app would, without the
  // test-run flag, so the desktop's own test-run default does not apply there.
  const home = '/Users/someone'
  const environment = fixtureDesktopEnvironment({
    HOME: home,
    PATH: '/usr/bin:/bin',
    OCTOPUS_VOICE_CONTROL_DIR: path.join(home, 'Library', 'Application Support', 'voice-control'),
  })

  const folder = environment[VOICE_CONTROL_DIR_ENV]
  assert.ok(folder, 'the journey names its own discovery folder')
  assert.notEqual(folder, defaultVoiceControlDir({ HOME: home }, 'darwin'))
  assert.ok(!folder.startsWith(home), `${folder} is outside the person's home`)
  assert.ok(folder.startsWith(os.tmpdir()), `${folder} is a temporary folder`)
})
