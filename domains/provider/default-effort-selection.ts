/**
 * Runtime transport for the one application-wide default effort.
 *
 * Settings → AI Providers owns the choice, beside the default model. The API
 * server process publishes it in-process from
 * `ProviderSettingsService.hydrateRuntime`, and spawned runtimes receive the
 * same value through an environment variable, exactly as the default model
 * travels. Without that second half a turn would inherit one default where it
 * was composed and another where it ran.
 *
 * **Read at the moment it is needed, never captured.** The four readers that
 * turn an absent persona setting into a level — the Agent loader, the two
 * Architect loaders and the generic chat assistant — used a constant compiled
 * into their modules. A setting read the same way would freeze whatever the
 * value was when the module first loaded, so a change in Settings would take
 * effect only after a restart, and only for some of them.
 *
 * An installation that has never chosen one runs at `DEFAULT_THINKING`, which
 * is what every Agent naming no level has always run at.
 */

import { DEFAULT_THINKING } from '../../core/constants.js'
import { isThinkingLevel, type ThinkingLevel } from '../../core/types.js'

export const DEFAULT_EFFORT_ENV = 'PIPELINE_DEFAULT_EFFORT'

let runtimeEffort: ThinkingLevel | undefined

/**
 * Publishes the choice in-process and to child processes.
 *
 * `undefined` forgets the in-process value and re-reads the environment on the
 * next call, which is how a test returns to a clean slate.
 */
export function setRuntimeDefaultEffort(level: ThinkingLevel | undefined): void {
  runtimeEffort = level
  if (level === undefined) return
  process.env[DEFAULT_EFFORT_ENV] = level
}

/** The level an Agent that names none runs at, right now. */
export function getRuntimeDefaultEffort(): ThinkingLevel {
  if (runtimeEffort !== undefined) return runtimeEffort
  const inherited = process.env[DEFAULT_EFFORT_ENV]?.trim()
  // A value this build cannot express is not a level a person chose here; it
  // is a newer installation's word reaching an older binary. Falling back is
  // the honest answer, and it is the same one an installation that never chose
  // anything gets.
  runtimeEffort = isThinkingLevel(inherited) ? inherited : DEFAULT_THINKING
  return runtimeEffort
}

/** What a child process should be told, as the environment carries it. */
export function defaultEffortEnvironment(
  level: ThinkingLevel | undefined,
): Record<string, string> {
  return level === undefined ? {} : { [DEFAULT_EFFORT_ENV]: level }
}
