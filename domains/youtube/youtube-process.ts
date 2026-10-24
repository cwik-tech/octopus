import { spawn } from 'node:child_process'

const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1_024 * 1_024
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1_000
const MAX_DIAGNOSTIC_CHARS = 2_000
const activePosixProcessGroups = new Set<number>()

if (process.platform !== 'win32') {
  process.once('exit', () => {
    for (const pid of activePosixProcessGroups) {
      try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ }
    }
  })
}

export async function runYoutubeProcess(
  executable: string,
  args: readonly string[],
  options: {
    readonly signal?: AbortSignal
    readonly maxOutputBytes?: number
    readonly timeoutMs?: number
  } = {},
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  if (options.signal?.aborted) throw options.signal.reason ?? abortError()
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { LANG: 'C', LC_ALL: 'C', ELECTRON_RUN_AS_NODE: '1' },
    })
    const maximum = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false
    let terminationStarted = false
    if (process.platform !== 'win32' && child.pid) activePosixProcessGroups.add(child.pid)
    const append = (current: string, chunk: string) =>
      current.length >= maximum ? current : current + chunk.slice(0, maximum - current.length)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { stdout = append(stdout, chunk) })
    child.stderr.on('data', (chunk: string) => { stderr = append(stderr, chunk) })
    const terminate = () => {
      if (terminationStarted) return
      terminationStarted = true
      terminateProcessTree(child.pid)
    }
    const abort = () => terminate()
    options.signal?.addEventListener('abort', abort, { once: true })
    const deadline = setTimeout(() => {
      timedOut = true
      terminate()
    }, timeoutMs)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (child.pid && !terminationStarted) activePosixProcessGroups.delete(child.pid)
      options.signal?.removeEventListener('abort', abort)
      reject(options.signal?.aborted ? options.signal.reason ?? abortError() : error)
    })
    // Process exit can precede the last stdout/stderr bytes. Metadata is only
    // complete once all inherited pipes have closed.
    child.once('close', (code, childSignal) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (child.pid && !terminationStarted) activePosixProcessGroups.delete(child.pid)
      options.signal?.removeEventListener('abort', abort)
      if (timedOut) reject(new Error('YouTube media process timed out.'))
      else if (options.signal?.aborted) reject(options.signal.reason ?? abortError())
      else if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(
        `YouTube media process failed (${code ?? childSignal ?? 'unknown'}): ${safeDiagnostic(stderr)}`,
      ))
    })
  })
}

function terminateProcessTree(pid: number | undefined): void {
  if (!pid) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill.exe', ['/pid', String(pid), '/t', '/f'], {
      shell: false,
      windowsHide: true,
      stdio: 'ignore',
    })
    killer.unref()
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try { process.kill(pid, 'SIGTERM') } catch { /* already exited */ }
  }
  const timer = setTimeout(() => {
    try { process.kill(-pid, 'SIGKILL') } catch { /* already exited */ }
    activePosixProcessGroups.delete(pid)
  }, 1_000)
}

function safeDiagnostic(value: string): string {
  const redacted = value
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/\b(authorization|proxy-authorization|x-goog-api-key)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .trim()
  return (redacted || 'No safe diagnostic was provided.').slice(0, MAX_DIAGNOSTIC_CHARS)
}

function abortError(): Error {
  const error = new Error('YouTube media process was cancelled.')
  error.name = 'AbortError'
  return error
}
