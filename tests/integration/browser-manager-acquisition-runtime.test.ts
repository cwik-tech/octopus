import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  BrowserManager,
  BrowserRuntimeError,
  type BrowserExecutionScope,
} from '../../domains/browser/browser-manager.js'

/**
 * What recording the browser build must not cost.
 *
 * The runtime metadata added for the countermeasure bake-off only annotates a
 * result, so it may not change how many times an acquisition tries to start
 * Chrome. A stand-in executable that records each invocation and exits makes the
 * launch count directly observable without a seam in production code.
 */

test('one acquisition attempts one browser launch even when Chrome cannot start', async (context) => {
  const root = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'browser-launch-count-')),
  )
  context.after(() => fs.rm(root, { recursive: true, force: true }))
  const launchLog = path.join(root, 'launches.log')
  const executablePath = path.join(root, 'unstartable-chrome.sh')
  await fs.writeFile(
    executablePath,
    `#!/bin/sh\necho launch >> ${JSON.stringify(launchLog)}\nexit 3\n`,
    { mode: 0o755 },
  )

  const manager = new BrowserManager({
    profilePath: path.join(root, 'profile'),
    executablePath,
    mode: 'headless',
    allowHttpLocalhost: true,
  })
  context.after(() => manager.close())

  const failure = await manager
    .acquireEvidence(makeScope(root), 'http://127.0.0.1:1/report')
    .then(() => null, (error: unknown) => error)

  assert.ok(failure instanceof BrowserRuntimeError, String(failure))
  assert.equal(failure.code, 'browser_unavailable')
  assert.equal(
    failure.browserRuntime,
    undefined,
    'a browser that never started cannot describe itself',
  )
  assert.deepEqual(
    (await fs.readFile(launchLog, 'utf8')).trim().split('\n'),
    ['launch'],
    'recording the browser build must not buy a second launch attempt',
  )
})

function makeScope(root: string): BrowserExecutionScope {
  return {
    sessionId: 'session-launch-count',
    runId: 'run-launch-count',
    assignmentId: 'assignment-launch-count',
    activityScopeId: 'lane-launch-count',
    assignmentPath: root,
    policy: { enabled: true, restrictDomains: false, domains: [] },
  }
}
