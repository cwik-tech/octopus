/**
 * What the Pi runtime this application executes will accept per model.
 *
 * Pi is the one provider where the executable is not necessarily the one on
 * `PATH`: `core/pi-runtime.ts` points the invocation at a bundled CLI whenever
 * `TEAM_RUNTIME_PI_CLI_PATH` is set, and `electron/main.ts` sets it at boot, so
 * in the desktop application the bundled copy is the normal path rather than a
 * fallback. A capability read from anywhere else would describe a different
 * program.
 *
 * Neither `--help` nor `--list-models` answers the question. The help text
 * states the levels the binary parses, and the listing says only whether a
 * model reasons at all. The runtime's own model data is the source, and the
 * rules below are the ones `getSupportedThinkingLevels` applies to it:
 *
 * - a model that does not reason supports nothing but `off`;
 * - a level whose `thinkingLevelMap` entry is `null` is not supported;
 * - `xhigh` and `max` are supported only where the map names them.
 *
 * Reading this matters more than it looks. The same runtime's
 * `clampThinkingLevel` searches *upward* from an unsupported level before it
 * searches downward, so a request for `off` against a model that cannot stop
 * thinking becomes a request for the next level up. This application refuses
 * that pair instead, which it can only do if it knows the range.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

import { THINKING_LEVELS, type EffortLevel } from '../../core/types.js'
import { PI_CLI_PATH_ENV } from '../../core/pi-runtime.js'

/** The levels Pi itself ranks, which excludes our `ultra`. */
const PI_LEVELS: readonly EffortLevel[] = THINKING_LEVELS.filter(
  (level): level is EffortLevel => level !== 'ultra',
)

const PI_AI_DATA_SEGMENTS = [
  'node_modules',
  '@earendil-works',
  'pi-ai',
  'dist',
  'providers',
  'data',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The model data directory belonging to this CLI, or nothing.
 *
 * Walks up from the executable rather than resolving the package by name, so
 * the answer describes the copy that will run. A global installation and a
 * bundled one are different trees with the same package name.
 */
function findDataDirectory(cliPath: string): string | undefined {
  let directory = path.dirname(path.resolve(cliPath))
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(directory, ...PI_AI_DATA_SEGMENTS)
    if (fs.existsSync(candidate)) return candidate
    const parent = path.dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

function supportedLevels(model: Record<string, unknown>): EffortLevel[] {
  if (model.reasoning !== true) return ['off']
  const map = isRecord(model.thinkingLevelMap) ? model.thinkingLevelMap : {}
  return PI_LEVELS.filter((level) => {
    const mapped = Object.prototype.hasOwnProperty.call(map, level)
      ? map[level]
      : undefined
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

/**
 * Every `provider/model` this runtime knows, with the levels it accepts.
 *
 * Keyed the way `parsePiModelCatalog` names a model, so the catalogue and this
 * table describe the same rows. A missing or unreadable file yields an empty
 * map, which the caller treats as "nothing published" rather than as "nothing
 * supported".
 */
export function readPiModelEffortSupport(
  cliPath: string | undefined,
): Map<string, EffortLevel[]> {
  return readPiRuntimeCapabilities(cliPath).levels
}

/**
 * What this runtime says about itself, and whether it said anything.
 *
 * The two are different answers and the caller has to be able to tell them
 * apart. A model missing from data that was read is a model this runtime does
 * not have; a runtime whose data could not be read at all has told us nothing,
 * and nothing must not be read as permission. Older installations ship their
 * model data as generated modules (`pi-ai/dist/providers/*.models.js`) rather
 * than as the JSON this reads, so `known: false` is an ordinary outcome rather
 * than a broken installation.
 */
export function readPiRuntimeCapabilities(cliPath: string | undefined): {
  readonly known: boolean
  readonly levels: Map<string, EffortLevel[]>
} {
  const support = new Map<string, EffortLevel[]>()
  if (!cliPath) return { known: false, levels: support }
  const dataDirectory = findDataDirectory(cliPath)
  if (!dataDirectory) return { known: false, levels: support }

  let entries: string[]
  try {
    entries = fs.readdirSync(dataDirectory).filter((name) => name.endsWith('.json'))
  } catch {
    return { known: false, levels: support }
  }

  for (const entry of entries) {
    let parsed: unknown
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dataDirectory, entry), 'utf-8'))
    } catch {
      continue
    }
    if (!isRecord(parsed)) continue
    for (const byApi of Object.values(parsed)) {
      if (!isRecord(byApi)) continue
      for (const value of Object.values(byApi)) {
        if (!isRecord(value)) continue
        const id = typeof value.id === 'string' ? value.id : undefined
        const provider =
          typeof value.provider === 'string' ? value.provider : undefined
        if (!id || !provider) continue
        support.set(`${provider}/${id}`, supportedLevels(value))
      }
    }
  }
  return { known: support.size > 0, levels: support }
}

/**
 * The Pi this application will actually spawn.
 *
 * `core/pi-runtime.ts` runs the bundled CLI when it has been pointed at one and
 * the bare name `pi` otherwise, so on the ordinary route the executable is
 * whatever `PATH` resolves — usually a symlink into a package tree elsewhere.
 * Following it to its real location is what makes the capability read describe
 * the program that runs rather than the directory the link sits in.
 */
export function resolveExecutedPiPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const override = env[PI_CLI_PATH_ENV]?.trim()
  if (override) return realPathOrSelf(override)
  const names = process.platform === 'win32' ? ['pi.cmd', 'pi.exe', 'pi'] : ['pi']
  for (const directory of (env.PATH ?? '').split(path.delimiter)) {
    if (!directory) continue
    for (const name of names) {
      const candidate = path.join(directory, name)
      try {
        fs.accessSync(candidate, fs.constants.X_OK)
      } catch {
        continue
      }
      return realPathOrSelf(candidate)
    }
  }
  return undefined
}

function realPathOrSelf(candidate: string): string {
  try {
    return fs.realpathSync(candidate)
  } catch {
    return candidate
  }
}

let cachedPath: string | undefined
let cachedSupport: { known: boolean; levels: Map<string, EffortLevel[]> } = {
  known: false,
  levels: new Map(),
}

/**
 * The same answer, read once per executable.
 *
 * The data is a few hundred kilobytes across a dozen files, and a turn cannot
 * afford to re-read it. Keyed by the path so a process that switches between a
 * bundled runtime and one on `PATH` does not answer for the wrong program.
 */
export function piModelEffortSupport(cliPath: string | undefined): {
  readonly known: boolean
  readonly levels: Map<string, EffortLevel[]>
} {
  const key = cliPath ?? ''
  if (cachedPath === key) return cachedSupport
  cachedSupport = readPiRuntimeCapabilities(cliPath)
  cachedPath = key
  return cachedSupport
}
