import * as fs from 'node:fs'
import * as path from 'node:path'

import { cliPathEntries } from '../../core/cli-path.js'

/**
 * Whether a CLI-provider binary is reachable the way the runtime reaches it.
 *
 * Deliberately resolved through `cliPathEntries`, the same module
 * `domains/provider/provider-preflight.ts` uses, rather than through `which`
 * or a bare `process.env.PATH` scan. The runtime searches `PATH` *plus* a
 * fallback list (`~/.local/bin`, `/opt/homebrew/bin`, the Node install
 * directory, ...), so a test that scanned only `PATH` could declare a binary
 * missing that the preflight then finds — or the reverse. Sharing the
 * resolution is what keeps the skip decision and the boot decision from
 * disagreeing.
 */
export function agentCliExists(command: string): boolean {
  for (const directory of cliPathEntries(process.env.PATH)) {
    if (!directory) continue
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK)
      return true
    } catch {
      // Keep scanning, exactly as the preflight does.
    }
  }
  return false
}

/**
 * Documented environmental prerequisite: booting a shipped Team whose agents
 * declare a CLI provider needs that provider's binary installed.
 *
 * `validateLoadedAgentProviders` (domains/provider/provider-preflight.ts)
 * refuses to start a Team when any roster member's provider is unready, and a
 * missing CLI is unready. The refusal happens before a single tool registers —
 * `tests/integration/team-runtime-fixture-team-boot.test.ts` pins that — so a
 * test that asserts on the booted runtime fails with a downstream symptom —
 * "inspect-task-state must be registered; got " — that says nothing about the
 * real cause. Naming the prerequisite as a skip reason reports the environment
 * instead of blaming the feature.
 *
 * Shaped after `chromeSkipReason()` in `research-web-proxy-fixture.ts`: return
 * `false` when the prerequisite holds, otherwise a sentence the runner prints,
 * and pass it straight through as `{ skip: agentCliSkipReason('codex') }`.
 */
export function agentCliSkipReason(...commands: readonly string[]): string | false {
  const missing = commands.filter((command) => !agentCliExists(command))
  if (missing.length === 0) return false
  const names = missing.map((command) => `'${command}'`).join(' and ')
  return (
    `No ${names} CLI on PATH. The Team under test declares it as an agent ` +
    'provider, and the runtime refuses to start a Team whose provider is unready.'
  )
}
