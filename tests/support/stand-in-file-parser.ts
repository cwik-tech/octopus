import * as fs from 'node:fs/promises'
import * as path from 'node:path'

import type {
  FileParseRequest,
  FileParserLauncher,
  FileParserRequestOptions,
} from '../../core/file-parser-launcher.js'

/**
 * A stand-in for the file parser process, the one boundary folder-index tests
 * replace. It "parses" a document into the document's own bytes, written in
 * the parser's output format: `_manifest.json` naming a `text` output beside it.
 *
 * `immediate` runs finish at once. `gated` runs finish only when the test calls
 * `finish`, and end the way a killed process does when their signal aborts, so
 * a test can hold a parse "running" and observe it being cancelled without
 * waiting on time. `gated-first` gates only each document's first run; a run
 * nobody expected finishes at once instead of holding the test until it times
 * out.
 */

interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
  reject(error: unknown): void
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

interface Launch {
  readonly name: string
  readonly request: FileParseRequest
  readonly signal: AbortSignal | undefined
  readonly exit: Deferred
  readonly aborted: Deferred
}

export async function writeStandInParse(request: FileParseRequest): Promise<void> {
  const name = path.basename(request.filePath)
  const text = await fs.readFile(request.filePath, 'utf8')
  await fs.mkdir(request.outputDir, { recursive: true })
  await fs.writeFile(path.join(request.outputDir, `${name}.md`), text)
  await fs.writeFile(
    path.join(request.outputDir, '_manifest.json'),
    JSON.stringify({ files: [{ source: name, status: 'success', outputs: { text: `${name}.md` }, metadata: {} }] }),
  )
}

export class StandInFileParser implements FileParserLauncher {
  readonly requests: FileParseRequest[] = []
  private readonly launched: Launch[] = []
  private readonly waiters: Array<{ readonly name: string; readonly nth: number; readonly ready: Deferred }> = []

  constructor(private readonly mode: 'gated' | 'gated-first' | 'immediate' = 'immediate') {}

  async parseDirectory(): Promise<void> {
    throw new Error('Folder indexing parses one file at a time.')
  }

  parseFile(request: FileParseRequest, options: FileParserRequestOptions = {}): Promise<void> {
    this.requests.push(request)
    const repeat = this.launches(path.basename(request.filePath)) > 0
    if (this.mode === 'immediate' || (this.mode === 'gated-first' && repeat)) return writeStandInParse(request)
    const launch: Launch = {
      name: path.basename(request.filePath),
      request,
      signal: options.signal,
      exit: deferred(),
      aborted: deferred(),
    }
    // A run nobody finishes must not fail the test when its promise is dropped.
    launch.exit.promise.catch(() => undefined)
    const onAbort = (): void => {
      launch.aborted.resolve()
      launch.exit.reject(new DOMException('The parser was stopped.', 'AbortError'))
    }
    if (options.signal?.aborted) onAbort()
    else options.signal?.addEventListener('abort', onAbort, { once: true })
    this.launched.push(launch)
    for (const waiter of this.waiters) {
      if (waiter.name === launch.name && this.launches(launch.name) === waiter.nth) waiter.ready.resolve()
    }
    return launch.exit.promise
  }

  launches(name: string): number {
    return this.launched.filter((launch) => launch.name === name).length
  }

  /** Resolves once the `nth` run of a document called `name` has been launched. */
  whenLaunched(name: string, nth = 1): Promise<void> {
    if (this.launches(name) >= nth) return Promise.resolve()
    const ready = deferred()
    this.waiters.push({ name, nth, ready })
    return ready.promise
  }

  /** Whether that run's signal has aborted by now. */
  isAborted(name: string, nth = 1): boolean {
    return this.launch(name, nth).signal?.aborted ?? false
  }

  /** Resolves once that run's signal has aborted. */
  async whenAborted(name: string, nth = 1): Promise<void> {
    await this.whenLaunched(name, nth)
    await this.launch(name, nth).aborted.promise
  }

  /** Write the run's output, then let its process exit cleanly. */
  async finish(name: string, nth = 1): Promise<void> {
    const launch = this.launch(name, nth)
    await writeStandInParse(launch.request)
    launch.exit.resolve()
  }

  private launch(name: string, nth: number): Launch {
    const launch = this.launched.filter((candidate) => candidate.name === name)[nth - 1]
    if (!launch) throw new Error(`${name} has not been launched ${nth} time(s)`)
    return launch
  }
}
