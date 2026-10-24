import * as fs from 'node:fs'
import * as path from 'node:path'

import teamRuntimeExtension from '../../team-runtime/index.js'

interface RegisteredTool {
  readonly name: string
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`Missing required environment variable: ${name}`)
  return value
}

async function main(): Promise<void> {
  const repoRoot = requiredEnv('DISCUSSION_RECOVERY_REPO_ROOT')
  const resultPath = requiredEnv('DISCUSSION_RECOVERY_RESULT_PATH')
  const handlers = new Map<string, (...args: never[]) => unknown>()
  const registered: RegisteredTool[] = []
  let lastRuntimeState: unknown
  const pi = {
    on: (event: string, handler: (...args: never[]) => unknown) => handlers.set(event, handler),
    registerTool: (tool: RegisteredTool) => registered.push(tool),
    registerCommand: () => {},
    registerShortcut: () => {},
    registerFlag: () => {},
    getFlag: () => undefined,
    registerMessageRenderer: () => {},
    registerEntryRenderer: () => {},
    registerMarkdownTransformer: () => {},
    sendMessage: () => {},
    sendUserMessage: () => {},
    appendEntry: (entryType: string, value: unknown) => {
      if (entryType === 'team-runtime') lastRuntimeState = value
    },
    setSessionName: () => {},
    getSessionName: () => undefined,
    setLabel: () => {},
    exec: async () => ({ stdout: '', stderr: '', code: 0 }),
    getActiveTools: () => registered.map((tool) => tool.name),
    getAllTools: () => registered.map((tool) => ({
      ...tool,
      sourceInfo: { path: path.join(repoRoot, 'team-runtime/index.ts') },
    })),
    setActiveTools: () => {},
    getCommands: () => [],
    setModel: async () => true,
    getThinkingLevel: () => 'medium',
    setThinkingLevel: () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    events: { on: () => {}, off: () => {}, emit: () => {} },
  }
  const extensionContext = {
    ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {} },
    mode: 'headless',
    hasUI: false,
    cwd: repoRoot,
    sessionManager: {
      getEntries: () => [],
      getSessionId: () => 'pi-discussion-recovery-session',
      getSessionFile: () => undefined,
    },
    modelRegistry: { getAvailable: () => [], getAll: () => [] },
    model: undefined,
    scopedModels: [],
    isIdle: () => true,
    isProjectTrusted: () => true,
    signal: undefined,
    abort: () => {},
    hasPendingMessages: () => false,
    shutdown: () => {},
    getContextUsage: () => undefined,
    compact: () => {},
    getSystemPrompt: () => '',
  }

  teamRuntimeExtension(pi as never)
  const sessionStart = handlers.get('session_start')
  if (!sessionStart) throw new Error('Team runtime did not register session_start')
  await (sessionStart as (event: unknown, context: unknown) => Promise<void>)(
    {},
    extensionContext,
  )

  const input = handlers.get('input')
  if (!input) throw new Error('Team runtime did not register its input interceptor')
  const inputResult = await (input as (
    event: unknown,
    context: unknown,
  ) => Promise<unknown>)(
    {
      type: 'input',
      text: 'Evaluate the teaching material.',
      source: 'interactive',
    },
    extensionContext,
  )
  const handled = inputResult as { action?: unknown }
  if (handled.action !== 'handled') {
    throw new Error('Team runtime did not own the recovery input')
  }

  const shutdown = handlers.get('session_shutdown')
  if (!shutdown) throw new Error('Team runtime did not register session_shutdown')
  await (shutdown as () => Promise<void>)()
  const totalCost = readRuntimeTotalCost(lastRuntimeState)
  fs.writeFileSync(
    resultPath,
    `${JSON.stringify({ pid: process.pid, handled: true, totalCost })}\n`,
  )
}

function readRuntimeTotalCost(value: unknown): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  const totalCost: unknown = Reflect.get(value, 'totalCost')
  return typeof totalCost === 'number' && Number.isFinite(totalCost)
    ? totalCost
    : undefined
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack : String(error))
  process.exitCode = 1
})
