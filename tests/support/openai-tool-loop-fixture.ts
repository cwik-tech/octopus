import { spawn, type ChildProcess } from 'node:child_process'
import * as path from 'node:path'

const startupTimeoutMs = 5_000

export interface OpenAiToolLoopFixture {
  readonly url: string
  readonly models: readonly string[]
  readonly pid: number
  close(): Promise<void>
}

export async function startOpenAiToolLoopFixture(
  repoRoot = process.cwd(),
  fixtureName = 'openai-tool-loop-server.mjs',
  options: {
    readonly env?: NodeJS.ProcessEnv
  } = {},
): Promise<OpenAiToolLoopFixture> {
  const child = spawn(
    process.execPath,
    [path.join(
      repoRoot,
      'tests',
      'fixtures',
      'providers',
      fixtureName,
    )],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stderr = ''
  child.stderr?.on('data', (chunk) => {
    stderr += String(chunk)
  })
  const ready = await waitForReady(child, () => stderr)
  if (!child.pid) {
    await stopChild(child)
    throw new Error('Provider fixture PID is unavailable')
  }
  return {
    ...ready,
    pid: child.pid,
    close: () => stopChild(child),
  }
}

async function waitForReady(
  child: ChildProcess,
  readStderr: () => string,
): Promise<{ url: string; models: string[] }> {
  if (!child.stdout) throw new Error('Provider fixture stdout is unavailable')
  const stdout = child.stdout
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error(`Provider fixture startup timed out: ${readStderr()}`))
    }, startupTimeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      stdout.off('data', onData)
      child.off('exit', onExit)
    }
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup()
      reject(new Error(
        `Provider fixture exited before readiness (code=${code}, signal=${signal}): ${readStderr()}`,
      ))
    }
    const onData = (chunk: Buffer | string) => {
      buffer += String(chunk)
      let newlineIndex = buffer.indexOf('\n')
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim()
        buffer = buffer.slice(newlineIndex + 1)
        if (line) {
          try {
            const message = JSON.parse(line) as {
              type?: string
              url?: string
              models?: unknown
            }
            if (
              message.type === 'ready' &&
              typeof message.url === 'string' &&
              Array.isArray(message.models) &&
              message.models.every((model) => typeof model === 'string')
            ) {
              cleanup()
              resolve({ url: message.url, models: message.models })
              return
            }
          } catch (error) {
            cleanup()
            reject(new Error(`Invalid provider fixture output: ${String(error)}`))
            return
          }
        }
        newlineIndex = buffer.indexOf('\n')
      }
    }
    stdout.on('data', onData)
    child.once('exit', onExit)
  })
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  try {
    await waitForExit(child)
  } catch {
    child.kill('SIGKILL')
    await waitForExit(child).catch(() => undefined)
  }
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup()
      reject(new Error('Provider fixture shutdown timed out'))
    }, startupTimeoutMs)
    const cleanup = () => {
      clearTimeout(timeout)
      child.off('exit', onExit)
    }
    const onExit = () => {
      cleanup()
      resolve()
    }
    child.once('exit', onExit)
  })
}
