import { beginSessionWork } from '../domains/sessions/session-work-lifecycle.js'
import { fileURLToPath } from 'node:url'
import { OfficeProcessSlots } from './office-process-slots.js'
import { spawn } from 'node:child_process'
import { OFFICE_HTML_MAX_BYTES, OFFICE_JOB_TIMEOUT_MS, OFFICE_KILL_GRACE_MS, OFFICE_STDERR_MAX_BYTES, type OfficeFailure } from '../contracts/office-documents.js'

export interface OfficeProcessInput {
  readonly executable: string
  readonly args: readonly string[]
  readonly directory: string
  readonly signal: AbortSignal
  readonly lifetime?: { readonly workspacePath: string; readonly sessionId: string }
}
export type OfficeProcessResult = { readonly ok: true; readonly stdout: Buffer; readonly stderr: Buffer } | OfficeFailure
const quarantined = new Set<string>()
export function officeJobCleanupPending(directory: string): boolean { return quarantined.has(directory) }
const slots = new OfficeProcessSlots()
export async function runOfficeProcess(input: OfficeProcessInput): Promise<OfficeProcessResult> {
  const work = input.lifetime ? beginSessionWork(input.lifetime.workspacePath, input.lifetime.sessionId, input.signal) : undefined
  if (input.lifetime && !work) return { ok: false, code: 'cancelled' }
  const slot = await slots.acquire(work?.signal ?? input.signal)
  if (!slot.ok) { work?.finish(); return slot }
  const result = await executeOfficeProcess({ ...input, signal: work?.signal ?? input.signal })
  // Unconfirmed cleanup quarantines capacity instead of admitting more work.
  if (result.ok || result.code !== 'cleanup_pending') { slot.release(); work?.finish() }
  else quarantined.add(input.directory)
  return result
}
async function executeOfficeProcess(input: OfficeProcessInput): Promise<OfficeProcessResult> {
  if (input.signal.aborted) return { ok: false, code: 'cancelled' }
  return new Promise((resolve) => {
    let failure: OfficeFailure | undefined
    let settled = false
    let reaped = false
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let outputBytes = 0
    let errorBytes = 0
    let force: ReturnType<typeof setTimeout> | undefined
    let cleanup: ReturnType<typeof setTimeout> | undefined
    const supervisor = fileURLToPath(new URL('./officecli-supervisor.cjs', import.meta.url))
    const child = spawn(process.execPath, [supervisor, input.executable, ...input.args], {
      cwd: input.directory, shell: false, detached: process.platform !== 'win32', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      env: { ELECTRON_RUN_AS_NODE: '1', HOME: input.directory, USERPROFILE: input.directory, TMPDIR: input.directory, TEMP: input.directory, TMP: input.directory, XDG_CONFIG_HOME: input.directory, XDG_CACHE_HOME: input.directory, DOTNET_CLI_HOME: input.directory, DOTNET_BUNDLE_EXTRACT_BASE_DIR: input.directory, PATH: '', LANG: 'en_US.UTF-8', OFFICECLI_SKIP_UPDATE: '1', OFFICECLI_NO_AUTO_INSTALL: '1', OFFICECLI_NO_AUTO_RESIDENT: '1', ...(process.platform === 'win32' && process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
    })
    const kill = (signal: NodeJS.Signals): void => {
      if (!child.pid) return
      try {
        if (process.platform === 'win32') child.kill(signal)
        else process.kill(-child.pid, signal)
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) failure = { ok: false, code: 'cleanup_pending' }
      }
    }
    const finish = (result: OfficeProcessResult): void => {
      if (settled) return
      settled = true
      clearTimeout(deadline); clearTimeout(force); clearTimeout(cleanup)
      input.signal.removeEventListener('abort', abort)
      resolve(result)
    }
    const stop = (code: OfficeFailure['code']): void => {
      if (failure || settled) return
      failure = { ok: false, code }
      kill('SIGTERM')
      force = setTimeout(() => kill('SIGKILL'), OFFICE_KILL_GRACE_MS)
      cleanup = setTimeout(() => {
        kill('SIGKILL'); child.stdout?.destroy(); child.stderr?.destroy()
        finish({ ok: false, code: 'cleanup_pending' })
      }, OFFICE_KILL_GRACE_MS * 2)
    }
    const abort = (): void => stop('cancelled')
    const deadline = setTimeout(() => stop('timeout'), OFFICE_JOB_TIMEOUT_MS)
    input.signal.addEventListener('abort', abort, { once: true })
    if (input.signal.aborted) abort()
    child.stdout?.on('data', (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) { stop('invalid_output'); return }
      outputBytes += chunk.byteLength
      if (outputBytes > OFFICE_HTML_MAX_BYTES) stop('output_limit')
      else stdout.push(chunk)
    })
    child.stderr?.on('data', (chunk: unknown) => {
      if (!Buffer.isBuffer(chunk)) { stop('invalid_output'); return }
      errorBytes += chunk.byteLength
      if (errorBytes > OFFICE_STDERR_MAX_BYTES) stop('output_limit')
      else stderr.push(chunk)
    })
    child.on('message', (value: unknown) => {
      if (typeof value === 'object' && value !== null && 'kind' in value && value.kind === 'office-job-reaped') reaped = true
    })
    child.on('error', () => { failure ??= { ok: false, code: 'process_failed' } })
    child.on('close', (code) => {
      kill('SIGKILL')
      if (!reaped) { finish({ ok: false, code: 'cleanup_pending' }); return }
      finish(failure ?? (code === 0 ? { ok: true, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) } : { ok: false, code: 'process_failed' }))
    })
  })
}
