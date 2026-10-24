import { whenDefined } from '../core/optional-properties.js'
import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDefaultApiServer } from '../server/api-server.js'

type StartedApiServer = Awaited<ReturnType<typeof startDefaultApiServer>>

export type DevServiceState = 'already-running' | 'disabled' | 'error' | 'skipped' | 'started' | 'starting'

export interface DevServicesStartResult {
  api: DevServiceState
  apiUrl: string | null
  ui: DevServiceState
  uiUrl: string | null
  errors: string[]
}

export interface DevServicesOptions {
  env?: NodeJS.ProcessEnv
  eventPollIntervalMs?: number
  host?: string
  port?: number
  uiHost?: string
  uiPort?: number
  workspacePath: string
}

export function resolveManagedDevRepoRoot(moduleUrl: string = import.meta.url): string {
  return path.resolve(path.dirname(fileURLToPath(moduleUrl)), '..')
}

const repoRoot = resolveManagedDevRepoRoot()

function envFlagEnabled(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === '') return defaultValue
  return !['0', 'false', 'no', 'off'].includes(value.toLowerCase())
}

export function shouldStartManagedDevServices(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!envFlagEnabled(env.TEAM_RUNTIME_START_SERVICES, true)) return false
  if (env.TEAM_DELEGATED_AUTOSTART === '1') return false
  if (env.TEAM_PARENT_SESSION_ID) return false
  return true
}

export function shouldStartManagedApi(env: NodeJS.ProcessEnv = process.env): boolean {
  return shouldStartManagedDevServices(env) && envFlagEnabled(env.TEAM_RUNTIME_START_API, true)
}

export function shouldStartManagedUi(env: NodeJS.ProcessEnv = process.env): boolean {
  return shouldStartManagedDevServices(env) && envFlagEnabled(env.TEAM_RUNTIME_START_UI, true)
}

export function shouldOpenManagedUi(env: NodeJS.ProcessEnv = process.env): boolean {
  return shouldStartManagedUi(env) && envFlagEnabled(env.TEAM_RUNTIME_OPEN_UI, true)
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function buildUrl(host: string, port: number): string {
  return `http://${host}:${port}`
}

async function isHttpReachable(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 500)
  try {
    const response = await fetch(url, { signal: controller.signal })
    return response.status < 500
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

async function waitForHttpReachable(url: string, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await isHttpReachable(url)) return true
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  return false
}

async function isApiHealthy(url: string): Promise<boolean> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 500)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) return false
    const payload = await response.json() as { ok?: unknown }
    return payload.ok === true
  } catch {
    return false
  } finally {
    clearTimeout(timeout)
  }
}

function openUrl(url: string): void {
  let command: string
  let args: string[]

  if (process.platform === 'darwin') {
    command = 'open'
    args = [url]
  } else if (process.platform === 'win32') {
    command = 'cmd'
    args = ['/c', 'start', '', url]
  } else {
    command = 'xdg-open'
    args = [url]
  }

  try {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
  } catch (error) {
    console.warn(`[ui] Failed to open browser: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function logPrefixed(prefix: string, chunk: Buffer): void {
  const text = chunk.toString()
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) console.log(`[${prefix}] ${line}`)
  }
}

function killChildProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // ignore cleanup failures
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true)
      return
    }

    const timeout = setTimeout(() => {
      cleanup()
      resolve(false)
    }, timeoutMs)

    const cleanup = () => {
      clearTimeout(timeout)
      child.off('exit', onExit)
    }

    const onExit = () => {
      cleanup()
      resolve(true)
    }

    child.once('exit', onExit)
  })
}

export class ManagedDevServices {
  private apiServer: StartedApiServer | null = null
  private stopping = false
  private uiProcess: ChildProcess | null = null

  async start(options: DevServicesOptions): Promise<DevServicesStartResult> {
    const env = options.env ?? process.env
    const host = options.host ?? env.API_HOST ?? '127.0.0.1'
    const port = options.port ?? parsePort(env.API_PORT, 3001)
    const uiHost = options.uiHost ?? env.TEAM_RUNTIME_UI_HOST ?? '127.0.0.1'
    const uiPort = options.uiPort ?? parsePort(env.TEAM_RUNTIME_UI_PORT, 5173)
    const apiUrl = buildUrl(host, port)
    const uiUrl = buildUrl(uiHost, uiPort)
    const result: DevServicesStartResult = {
      api: shouldStartManagedApi(env) ? 'skipped' : 'disabled',
      apiUrl: shouldStartManagedApi(env) ? apiUrl : null,
      ui: shouldStartManagedUi(env) ? 'skipped' : 'disabled',
      uiUrl: shouldStartManagedUi(env) ? uiUrl : null,
      errors: [],
    }

    if (!shouldStartManagedDevServices(env)) return result

    await Promise.all([
      this.startApi({
        apiUrl,
        env,
        ...whenDefined(options.eventPollIntervalMs, (definedValue) => ({ eventPollIntervalMs: definedValue })),
        host,
        port,
        result,
        workspacePath: options.workspacePath,
      }),
      this.startUi({
        apiUrl,
        env,
        result,
        uiHost,
        uiPort,
        uiUrl,
      }),
    ])

    if (shouldOpenManagedUi(env) && result.ui !== 'error') {
      void this.openUiWhenReady(uiUrl)
    }

    return result
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true

    const uiProcess = this.uiProcess
    this.uiProcess = null
    if (uiProcess) {
      killChildProcessGroup(uiProcess, 'SIGTERM')
      const exited = await waitForExit(uiProcess, 2500)
      if (!exited) killChildProcessGroup(uiProcess, 'SIGKILL')
    }

    const apiServer = this.apiServer
    this.apiServer = null
    if (apiServer) {
      await apiServer.close().catch(() => {})
    }

    this.stopping = false
  }

  stopSync(): void {
    const uiProcess = this.uiProcess
    this.uiProcess = null
    if (uiProcess) killChildProcessGroup(uiProcess, 'SIGTERM')

    const apiServer = this.apiServer
    this.apiServer = null
    if (apiServer) void apiServer.close().catch(() => {})
  }

  private async startApi(args: {
    apiUrl: string
    env: NodeJS.ProcessEnv
    eventPollIntervalMs?: number
    host: string
    port: number
    result: DevServicesStartResult
    workspacePath: string
  }): Promise<void> {
    if (!shouldStartManagedApi(args.env)) return
    if (this.apiServer) {
      args.result.api = 'already-running'
      return
    }

    if (await isApiHealthy(`${args.apiUrl}/health`)) {
      args.result.api = 'already-running'
      return
    }

    try {
      this.apiServer = await startDefaultApiServer({
        workspacePath: args.workspacePath,
        host: args.host,
        port: args.port,
        ...whenDefined(args.eventPollIntervalMs, (definedValue) => ({ eventPollIntervalMs: definedValue })),
      })
      args.result.api = 'started'
      args.result.apiUrl = this.apiServer.url
      console.log(`[api] Team Runtime API listening on ${this.apiServer.url}`)
    } catch (error) {
      args.result.api = 'error'
      args.result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  private async startUi(args: {
    apiUrl: string
    env: NodeJS.ProcessEnv
    result: DevServicesStartResult
    uiHost: string
    uiPort: number
    uiUrl: string
  }): Promise<void> {
    if (!shouldStartManagedUi(args.env)) return
    if (this.uiProcess) {
      args.result.ui = 'already-running'
      return
    }

    if (await isHttpReachable(args.uiUrl)) {
      args.result.ui = 'already-running'
      return
    }

    try {
      const child = spawn('npm', [
        '--prefix',
        'ui',
        'run',
        'dev',
        '--',
        '--host',
        args.uiHost,
        '--port',
        String(args.uiPort),
        '--strictPort',
      ], {
        cwd: repoRoot,
        detached: true,
        env: {
          ...args.env,
          VITE_DEV_API_TARGET: args.apiUrl,
        },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      this.uiProcess = child
      args.result.ui = 'starting'
      child.stdout?.on('data', (chunk: Buffer) => logPrefixed('ui', chunk))
      child.stderr?.on('data', (chunk: Buffer) => logPrefixed('ui', chunk))
      child.once('error', (error) => {
        args.result.errors.push(error.message)
      })
      child.once('exit', () => {
        if (this.uiProcess === child) this.uiProcess = null
      })
    } catch (error) {
      args.result.ui = 'error'
      args.result.errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  private async openUiWhenReady(uiUrl: string): Promise<void> {
    if (await waitForHttpReachable(uiUrl, 5000)) {
      openUrl(uiUrl)
    }
  }
}

export function createManagedDevServices(): ManagedDevServices {
  return new ManagedDevServices()
}
