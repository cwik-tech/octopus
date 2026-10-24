/**
 * What a host process owes the Pi agent directory it was lent.
 *
 * A Team host is sometimes given a private Pi agent directory of its own so it
 * cannot mutate the user's shared settings. Removing it is this process's job,
 * and the timing is not free to choose: Pi goes on writing settings after
 * extensions have shut down, so a directory removed at `session_shutdown` is
 * simply recreated and left behind. Process exit is the first moment nothing
 * will write to it again.
 *
 * That makes the cleanup a process-exit callback, which brings two obligations
 * the rest of this suite measures elsewhere: it must cost a bounded number of
 * listeners however many directories a host has owned, and it must act on the
 * proof it was given rather than on `process.env`, which any later session in
 * the same host is free to repoint.
 *
 * Driven in a real child process, because "at actual process exit" cannot be
 * observed from inside the process that is supposed to be exiting.
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'

import { isolatePiAgentDirectory } from '../../domains/run/pi-agent-isolation.js'

const repoRoot = process.cwd()

/** A minimal Pi surface: enough for the extension to load and shut down. */
const PI_STUB_SOURCE = [
  'const handlers = new Map()',
  'const pi = {',
  '  on: (event, handler) => handlers.set(event, handler),',
  '  registerCommand: () => {}, registerTool: () => {}, registerShortcut: () => {},',
  '  registerFlag: () => {}, getFlag: () => undefined,',
  '  registerMessageRenderer: () => {}, registerEntryRenderer: () => {},',
  '  registerMarkdownTransformer: () => {}, sendMessage: () => {},',
  '  sendUserMessage: () => {}, appendEntry: () => {}, setSessionName: () => {},',
  '  getSessionName: () => undefined, setLabel: () => {},',
  '  exec: async () => ({ stdout: "", stderr: "", code: 0 }),',
  '  getActiveTools: () => [], getAllTools: () => [], setActiveTools: () => {},',
  '  getCommands: () => [], setModel: async () => true,',
  '  getThinkingLevel: () => "medium", setThinkingLevel: () => {},',
  '  registerProvider: () => {}, unregisterProvider: () => {},',
  '  events: { on: () => {}, off: () => {}, emit: () => {} },',
  '}',
  'const extCtx = {',
  '  ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {},',
  '    confirm: async () => true, select: async () => undefined, input: async () => undefined },',
  '  mode: "headless", hasUI: false, cwd: process.cwd(),',
  '  sessionManager: { getEntries: () => [], getSessionId: () => "pi", getSessionFile: () => undefined },',
  '  modelRegistry: { getAvailable: () => [], getAll: () => [] },',
  '  model: undefined, scopedModels: [], isIdle: () => true, isProjectTrusted: () => true,',
  '  signal: undefined, abort: () => {}, hasPendingMessages: () => false,',
  '  shutdown: () => {}, getContextUsage: () => undefined, compact: () => {},',
  '  getSystemPrompt: () => "",',
  '}',
].join('\n')

/** What the child writes back, and what this test is entitled to read. */
interface ChildReport {
  readonly exitListenerDelta: number
  readonly survivedShutdown: { readonly first: boolean; readonly second: boolean }
}

function isChildReport(value: unknown): value is ChildReport {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>
  if (typeof candidate.exitListenerDelta !== 'number') return false
  const survived = candidate.survivedShutdown
  if (typeof survived !== 'object' || survived === null) return false
  const flags = survived as Record<string, unknown>
  return typeof flags.first === 'boolean' && typeof flags.second === 'boolean'
}

/**
 * Load the extension twice, each time owning a different directory, then leave.
 *
 * The environment is repointed at a decoy before exit, which is the whole
 * question: a cleanup that re-reads `process.env` when the process ends acts on
 * the decoy and abandons what it actually owned.
 */
function buildChildSource(input: {
  readonly extensionUrl: string
  readonly firstEnvironment: Readonly<Record<string, string>>
  readonly secondEnvironment: Readonly<Record<string, string>>
  readonly decoyPath: string
  readonly reportPath: string
}): string {
  return [
    'import * as fs from "node:fs"',
    `const { default: teamRuntimeExtension } = await import(${JSON.stringify(input.extensionUrl)})`,
    PI_STUB_SOURCE,
    'const exitListenersBefore = process.listenerCount("exit")',
    'const shutdowns = []',
    'async function loadOwning(environment) {',
    '  Object.assign(process.env, environment)',
    '  handlers.clear()',
    '  teamRuntimeExtension(pi)',
    '  const shutdown = handlers.get("session_shutdown")',
    '  if (shutdown) shutdowns.push(() => shutdown({}, extCtx))',
    '}',
    `await loadOwning(${JSON.stringify(input.firstEnvironment)})`,
    `await loadOwning(${JSON.stringify(input.secondEnvironment)})`,
    'for (const shutdown of shutdowns) await shutdown()',
    '// Counted after both sessions are done, so what is left is only what the',
    '// process still carries on their behalf: the ownership cleanup, and',
    '// nothing a finished session should still be holding.',
    'const exitListenerDelta = process.listenerCount("exit") - exitListenersBefore',
    'const survivedShutdown = {',
    `  first: fs.existsSync(${JSON.stringify(input.firstEnvironment.PI_CODING_AGENT_DIR)}),`,
    `  second: fs.existsSync(${JSON.stringify(input.secondEnvironment.PI_CODING_AGENT_DIR)}),`,
    '}',
    'fs.writeFileSync(',
    `  ${JSON.stringify(input.reportPath)},`,
    '  JSON.stringify({ exitListenerDelta, survivedShutdown }),',
    ')',
    '// Repointed after registration and before exit. Anything that reads the',
    '// environment at exit now sees the decoy instead of what it was given.',
    `process.env.PI_CODING_AGENT_DIR = ${JSON.stringify(input.decoyPath)}`,
    'process.exit(0)',
  ].join('\n')
}

test('an owned Pi agent directory outlives session shutdown and is removed when the process ends', {
  timeout: 180_000,
}, () => {
  const fixtureRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'owned-agent-dir-exit-')),
  )
  const sharedPath = path.join(fixtureRoot, 'shared-agent')
  fs.mkdirSync(sharedPath, { recursive: true })
  fs.writeFileSync(path.join(sharedPath, 'settings.json'), '{}')

  // Real isolated directories, made by the same function the launcher uses, so
  // the sentinel and token the cleanup checks are genuine rather than staged.
  // No containing directory is supplied on purpose: that is what makes the
  // result child-owned and gives it a token
  // (`domains/run/pi-agent-isolation.ts:227`). A parent-owned directory carries
  // none and is never the child's to delete.
  const first = isolatePiAgentDirectory({ sharedAgentDirectoryPath: sharedPath })
  const second = isolatePiAgentDirectory({ sharedAgentDirectoryPath: sharedPath })

  // A directory the child will point the environment at without ever owning.
  const decoyPath = path.join(fixtureRoot, 'not-ours')
  fs.mkdirSync(decoyPath, { recursive: true })
  fs.writeFileSync(path.join(decoyPath, 'keep.txt'), 'untouched')

  const reportPath = path.join(fixtureRoot, 'report.json')
  const childPath = path.join(fixtureRoot, 'child.mjs')
  fs.writeFileSync(
    childPath,
    buildChildSource({
      // A URL, not a path: `import()` of a bare absolute path is not portable,
      // and a Windows drive letter reads as a protocol.
      extensionUrl: pathToFileURL(
        path.join(repoRoot, '.tests-dist', 'team-runtime', 'index.js'),
      ).href,
      firstEnvironment: first.environment,
      secondEnvironment: second.environment,
      decoyPath,
      reportPath,
    }),
  )

  try {
    const child = spawnSync(process.execPath, [childPath], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        TEAM_RUNTIME_START_SERVICES: '0',
        // The compiled tree has no `.ts` sources beside it, so the launcher is
        // pointed back at the real entry rather than the one it infers.
        TEAM_RUNTIME_FILE_PARSER_ENTRY: path.join(repoRoot, 'file-parser/index.ts'),
      },
      timeout: 120_000,
    })
    assert.equal(
      child.status,
      0,
      `the child must exit cleanly; stderr was: ${child.stderr}`,
    )

    assert.ok(
      fs.existsSync(reportPath),
      `the child must have written its report; stdout: ${child.stdout} stderr: ${child.stderr}`,
    )
    const parsed: unknown = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    assert.ok(
      isChildReport(parsed),
      `the child's report must have the shape this test reads; saw ${JSON.stringify(parsed)}`,
    )
    const report = parsed

    assert.deepEqual(
      report.survivedShutdown,
      { first: true, second: true },
      'an owned directory must still be there after its session shuts down, because Pi is still writing to it',
    )
    assert.equal(
      report.exitListenerDelta,
      1,
      'two owned directories must cost one process-exit listener between them',
    )

    assert.equal(
      fs.existsSync(first.path),
      false,
      'the first owned directory must be removed when the process actually exits',
    )
    assert.equal(
      fs.existsSync(second.path),
      false,
      'and so must the second, from the proof it was registered with',
    )
    assert.equal(
      fs.existsSync(path.join(decoyPath, 'keep.txt')),
      true,
      'while the directory the environment was repointed at is left alone',
    )
  } finally {
    // These live in the temp root rather than the fixture, because that is what
    // makes them child-owned. Disposal is idempotent, so a run that already
    // removed them leaves nothing behind either way.
    first.dispose()
    second.dispose()
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
