import * as fs from 'node:fs'
import * as path from 'node:path'

import { TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV } from './file-parser-launcher.js'

export const PI_CLI_PATH_ENV = 'TEAM_RUNTIME_PI_CLI_PATH'
export const PI_NODE_PATH_ENV = 'TEAM_RUNTIME_PI_NODE_PATH'
export const RUNTIME_EXTENSION_ENTRY_ENV = 'TEAM_RUNTIME_EXTENSION_ENTRY'
export const PI_NO_BUILTIN_TOOLS_ARGUMENT = '--no-builtin-tools'

/**
 * The prompt a managed Team host is launched with.
 *
 * Pi's print mode lives exactly as long as the prompts it awaits
 * (`@earendil-works/pi-coding-agent/dist/modes/print-mode.js:105`, `:134`), and
 * a Team host launched with no prompt at all disposes before its first
 * coordinator is asked anything. This is that prompt. Being a slash command, Pi
 * routes it to the runtime's own handler and never sends it to a model
 * (`dist/core/agent-session.js:803`), so the host is held open by the runtime
 * rather than by a turn nobody wanted.
 */
export const TEAM_HOST_RUN_COMMAND_NAME = 'team-host-run'
export const TEAM_HOST_RUN_PROMPT = `/${TEAM_HOST_RUN_COMMAND_NAME}`
export const PI_BUILTIN_TOOL_NAMES = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
] as const

const PI_NO_BUILTIN_TOOLS_ALIAS = '-nbt'
const PI_TOOL_ALLOWLIST_ARGUMENTS: ReadonlySet<string> = new Set(['--tools', '-t'])
const PI_BUILTIN_TOOL_NAME_SET: ReadonlySet<string> = new Set(PI_BUILTIN_TOOL_NAMES)

const PI_CLI_RELATIVE_PATH = path.join(
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'dist',
  'cli.js',
)

export interface PiInvocation {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
}

export function resolveBundledPiCliPath(appRootPath: string): string {
  return path.join(path.resolve(appRootPath), PI_CLI_RELATIVE_PATH)
}

export function resolveRuntimeExtensionEntry(appRootPath: string): string {
  return path.join(path.resolve(appRootPath), 'dist-electron', 'team-runtime', 'index.js')
}

export function resolveBundledFileParserEntry(appRootPath: string): string {
  return path.join(path.resolve(appRootPath), 'file-parser', 'dist', 'index.js')
}

export function buildBundledPiEnvironment(
  appRootPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  nodePath: string = process.execPath,
): NodeJS.ProcessEnv {
  const piCliPath = resolveBundledPiCliPath(appRootPath)
  const extensionEntry = resolveRuntimeExtensionEntry(appRootPath)
  const fileParserEntry = resolveBundledFileParserEntry(appRootPath)
  requireRuntimeFile(piCliPath, 'Bundled Pi CLI')
  requireRuntimeFile(extensionEntry, 'Team runtime extension')
  requireRuntimeFile(fileParserEntry, 'Bundled file parser')

  return {
    ...baseEnv,
    [PI_CLI_PATH_ENV]: piCliPath,
    [PI_NODE_PATH_ENV]: nodePath,
    [RUNTIME_EXTENSION_ENTRY_ENV]: extensionEntry,
    [TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV]: fileParserEntry,
  }
}

export function buildPiInvocation(
  args: readonly string[],
  baseEnv: NodeJS.ProcessEnv = process.env,
): PiInvocation {
  const lockedDownArgs = lockDownPiBuiltinTools(args)
  const bundledCliPath = baseEnv[PI_CLI_PATH_ENV]?.trim()
  if (!bundledCliPath) {
    return {
      command: process.platform === 'win32' ? 'pi.cmd' : 'pi',
      args: lockedDownArgs,
      env: { ...baseEnv },
    }
  }

  requireRuntimeFile(bundledCliPath, 'Bundled Pi CLI')
  const nodePath = baseEnv[PI_NODE_PATH_ENV]?.trim() || process.execPath
  return {
    command: nodePath,
    args: [bundledCliPath, ...lockedDownArgs],
    env: {
      ...baseEnv,
      ELECTRON_RUN_AS_NODE: '1',
    },
  }
}

function lockDownPiBuiltinTools(args: readonly string[]): string[] {
  const lockedDownArgs = [PI_NO_BUILTIN_TOOLS_ARGUMENT]

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (
      argument === PI_NO_BUILTIN_TOOLS_ARGUMENT ||
      argument === PI_NO_BUILTIN_TOOLS_ALIAS
    ) {
      continue
    }

    const allowlistValue = args[index + 1]
    if (
      PI_TOOL_ALLOWLIST_ARGUMENTS.has(argument) &&
      allowlistValue !== undefined
    ) {
      lockedDownArgs.push(argument, filterPiToolAllowlist(allowlistValue))
      index += 1
      continue
    }

    const equalsAllowlist = readEqualsFormPiToolAllowlist(argument)
    if (equalsAllowlist) {
      lockedDownArgs.push(
        `${equalsAllowlist.argument}=${filterPiToolAllowlist(equalsAllowlist.value)}`,
      )
      continue
    }

    lockedDownArgs.push(argument)
  }

  return lockedDownArgs
}

function readEqualsFormPiToolAllowlist(argument: string): {
  readonly argument: string
  readonly value: string
} | null {
  for (const allowlistArgument of PI_TOOL_ALLOWLIST_ARGUMENTS) {
    const prefix = `${allowlistArgument}=`
    if (argument.startsWith(prefix)) {
      return {
        argument: allowlistArgument,
        value: argument.slice(prefix.length),
      }
    }
  }
  return null
}

function filterPiToolAllowlist(value: string): string {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0)
    .filter((name) => !PI_BUILTIN_TOOL_NAME_SET.has(name))
    .join(',')
}

function requireRuntimeFile(filePath: string, label: string): void {
  try {
    if (fs.statSync(filePath).isFile()) return
  } catch {
    // Throw one stable preflight error below.
  }
  throw new Error(`${label} is missing: ${filePath}`)
}
