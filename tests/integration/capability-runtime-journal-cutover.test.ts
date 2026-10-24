import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const WORKER_PATH = fileURLToPath(
  new URL('./capability-runtime-journal-cutover-worker.js', import.meta.url),
)

const JOURNAL_RELATIVE_PATH = path.join(
  'sessions',
  'session-1',
  'runs',
  'run-1',
  'assignments',
  'assignment-1',
  '.runtime',
  'execution-journal',
)

/**
 * Phase 2 acceptance: the production runtime, its flag, real assignment
 * resolution, and a real restart.
 *
 * The contract asserted is the ADR's own: unsafe effects are not
 * automatically duplicated after a crash. Pipeline explicitly does not claim
 * universal exactly-once external execution.
 */
test('a crash after an external effect does not automatically duplicate it on restart', async () => {
  const workspacePath = makeWorkspace()
  const counter = await startCounterServer()
  try {
    const crashOutcome = path.join(workspacePath, 'outcome-crash.json')
    const crashExit = await runWorker(
      [workspacePath, 'crash', counter.url, crashOutcome],
      { PIPELINE_DURABLE_JOURNAL: 'authoritative' },
    )
    assert.equal(crashExit, 9, 'the worker must die after its effect')
    assert.equal(counter.count(), 1, 'the effect happened once')

    // Restart: the same tool call is dispatched again by the production runtime.
    const resumeOutcome = path.join(workspacePath, 'outcome-resume.json')
    const resumeExit = await runWorker(
      [workspacePath, 'resume', counter.url, resumeOutcome],
      { PIPELINE_DURABLE_JOURNAL: 'authoritative' },
    )
    assert.equal(resumeExit, 0, readText(resumeOutcome))

    const resumed = JSON.parse(readText(resumeOutcome)) as {
      status: string
      code?: string
    }
    // The outcome could not be proven, so it is neither retried nor invented.
    assert.equal(resumed.status, 'indeterminate')
    assert.equal(
      counter.count(),
      1,
      'the unsafe effect must not be automatically duplicated',
    )
  } finally {
    await counter.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('with the flag disabled the runtime enrolls no assignment', async () => {
  const workspacePath = makeWorkspace()
  const counter = await startCounterServer()
  try {
    const outcome = path.join(workspacePath, 'outcome.json')
    // Stated, not omitted: since A-14 an absent flag means `authoritative`, so
    // an empty override would enrol and this would assert the opposite of what
    // it means to.
    const exit = await runWorker([workspacePath, 'complete', counter.url, outcome], {
      PIPELINE_DURABLE_JOURNAL: 'disabled',
    })
    assert.equal(exit, 0, readText(outcome))
    assert.equal(counter.count(), 1)
    assert.equal(
      fs.existsSync(path.join(workspacePath, JOURNAL_RELATIVE_PATH)),
      false,
      'no journal may be created while the cutover flag says disabled',
    )
  } finally {
    await counter.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

test('an enrolled assignment stays journal-authoritative after enrolment is turned off', async () => {
  const workspacePath = makeWorkspace()
  const counter = await startCounterServer()
  try {
    const crashOutcome = path.join(workspacePath, 'outcome-crash.json')
    const crashExit = await runWorker(
      [workspacePath, 'crash', counter.url, crashOutcome],
      { PIPELINE_DURABLE_JOURNAL: 'authoritative' },
    )
    assert.equal(crashExit, 9)
    assert.equal(counter.count(), 1)

    // Enrolment turned off. Authority is sticky: the enrolled assignment must
    // still consult its journal, or the crash evidence would be discarded and
    // the effect repeated (ADR §16). Stated explicitly rather than by removing
    // the flag, because since A-14 an absent flag means `authoritative` and
    // would prove nothing about stickiness.
    const resumeOutcome = path.join(workspacePath, 'outcome-resume.json')
    const resumeExit = await runWorker(
      [workspacePath, 'resume', counter.url, resumeOutcome],
      { PIPELINE_DURABLE_JOURNAL: 'disabled' },
    )
    assert.equal(resumeExit, 0, readText(resumeOutcome))
    const resumed = JSON.parse(readText(resumeOutcome)) as { status: string }
    assert.equal(resumed.status, 'indeterminate')
    assert.equal(counter.count(), 1)
  } finally {
    await counter.close()
    fs.rmSync(workspacePath, { recursive: true, force: true })
  }
})

const DURABLE_JOURNAL_FLAG = 'PIPELINE_DURABLE_JOURNAL'

function makeWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'capability-runtime-cutover-'))
}

async function runWorker(
  args: readonly string[],
  env: Record<string, string>,
): Promise<number | null> {
  // Every case in this file states the flag it wants, so the ambient value is
  // cleared first. Inheriting it made the disabled case pass only when the
  // developer's environment happened not to set it — the test claimed to
  // control the flag while actually depending on it. Clearing is no longer
  // enough on its own: since A-14 an absent flag resolves to `authoritative`,
  // so every case supplies its own value in `env`.
  const baseEnv = { ...process.env }
  delete baseEnv[DURABLE_JOURNAL_FLAG]
  const child = spawn(process.execPath, [WORKER_PATH, ...args], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...baseEnv, ...env },
  })
  child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
  const [code] = (await once(child, 'exit')) as [number | null]
  return code
}

function readText(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return 'worker produced no outcome file'
  }
}

async function startCounterServer(): Promise<{
  readonly url: string
  count(): number
  close(): Promise<void>
}> {
  let counter = 0
  const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/mutate') {
      counter += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ counter }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    count: () => counter,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
