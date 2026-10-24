/**
 * The application default effort, from Settings to a spawned child.
 *
 * Two claims, and the second is the one that breaks quietly: the choice
 * survives a restart, and a child process running a turn inherits the same
 * answer as the process that composed it. `DesktopRunLauncher` merges
 * `ProviderSettingsService.runtimeEnvironment()` into child startup, so this
 * spawns a real child with that environment rather than asserting the map.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { ProviderSettingsService } from '../../services/provider-settings-service.js'
import { DEFAULT_EFFORT_ENV } from '../../domains/provider/default-effort-selection.js'

/**
 * The reader, addressed the way this suite is currently being run.
 *
 * `tests/run-tests.mjs` compiles to `.tests-dist` and runs the emitted
 * JavaScript, so a hard-coded `./domains/.../*.ts` path is correct under `tsx`
 * and missing under the compiled runner. Deriving the sibling module from this
 * file's own URL and extension answers for both, and the child imports it by
 * URL rather than by a path relative to a working directory.
 */
const compiled = import.meta.url.endsWith('.js')
const readerUrl = new URL(
  `../../domains/provider/default-effort-selection.${compiled ? 'js' : 'ts'}`,
  import.meta.url,
).href

/** Print what a child process believes the default is. */
function childDefaultEffort(environment: NodeJS.ProcessEnv): string {
  const script = [
    `const { getRuntimeDefaultEffort } = await import(${JSON.stringify(readerUrl)});`,
    'process.stdout.write(getRuntimeDefaultEffort());',
  ].join('\n')
  return execFileSync(
    process.execPath,
    compiled
      ? ['--input-type=module', '-e', script]
      : ['--import', 'tsx', '--input-type=module', '-e', script],
    { cwd: process.cwd(), env: environment, encoding: 'utf8' },
  ).trim()
}

function service(storagePath: string): ProviderSettingsService {
  return new ProviderSettingsService({
    storagePath,
    secretCodec: {
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    },
  })
}

function withDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'default-effort-store-'))
  return run(directory).finally(() => {
    fs.rmSync(directory, { recursive: true, force: true })
  })
}

test('the chosen default survives a restart', async () => {
  await withDirectory(async (directory) => {
    const storagePath = path.join(directory, 'provider-settings.json')
    await service(storagePath).setDefaultEffort('xhigh')

    // A second service over the same file is what a restart looks like from
    // here: nothing in memory, everything read back from disk.
    const restarted = service(storagePath)
    assert.equal((await restarted.snapshot()).defaultEffort, 'xhigh')
  })
})

test('an installation that has never chosen one reports medium', async () => {
  await withDirectory(async (directory) => {
    const snapshot = await service(path.join(directory, 'provider-settings.json')).snapshot()
    assert.equal(snapshot.defaultEffort, 'medium')
  })
})

test('a level this application cannot express is refused rather than stored', async () => {
  await withDirectory(async (directory) => {
    await assert.rejects(
      service(path.join(directory, 'provider-settings.json')).setDefaultEffort(
        'galactic' as never,
      ),
    )
  })
})

test('a real child process inherits the same default through the environment', async () => {
  await withDirectory(async (directory) => {
    const storagePath = path.join(directory, 'provider-settings.json')
    const settings = service(storagePath)
    await settings.setDefaultEffort('max')
    const environment = await settings.runtimeEnvironment()
    assert.equal(environment[DEFAULT_EFFORT_ENV], 'max')

    // The child imports the same reader a turn would, with no in-process value
    // set, so what it prints is what the environment told it.
    assert.equal(childDefaultEffort({ ...process.env, ...environment }), 'max')
  })
})

test('a child of an installation that chose nothing still runs at medium', async () => {
  await withDirectory(async (directory) => {
    const settings = service(path.join(directory, 'provider-settings.json'))
    const environment = await settings.runtimeEnvironment()
    const inherited = { ...process.env }
    delete inherited[DEFAULT_EFFORT_ENV]
    assert.equal(childDefaultEffort({ ...inherited, ...environment }), 'medium')
  })
})
