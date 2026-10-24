/**
 * Which model named a delegated job.
 *
 * When one team routes work to another, the routing stage asks a model for a
 * short title for the job it is handing over. That helper owns no Agent, so it
 * runs on the one application default — `resolveTitleSummarizerConfig` reads
 * exactly that and returns nothing when there is none
 * (`job-title-summarizer.ts:83-91`) — and it said nothing about it. This is the
 * fifth and last caller in the same family.
 *
 * Driven against the real helper and an owned loopback provider, because what
 * is being proved is which model is actually asked and when the account of it
 * is written.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { createSpawnTeamTool } from '../../engines/spawn-tools.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import {
  buildSessionRunAssignmentLocation,
  writeRunAssignmentLocator,
} from '../../domains/run/run-location.js'
import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import {
  getRuntimeDefaultModelState,
  setRuntimeDefaultModelState,
} from '../../domains/provider/default-model-selection.js'
import {
  resolveTitleSummarizerConfig,
  summarizeJobTitle,
} from '../../domains/job-title/job-title-summarizer.js'
import type { ExtensionToolContext } from '@earendil-works/pi-coding-agent'
import type { ModelSelectionRecord } from '../../contracts/agent-model-selection.js'

initProviders()

const DEFAULT_MODEL = 'app-default-job-title-model'
const BRIEF = 'Review the warehouse automation proposal and recommend rollout priorities.'
/** What the model answers when it is asked at all. */
const GENERATED_TITLE = 'Warehouse Automation Rollout'
/**
 * What `BRIEF` is named when no model is asked.
 *
 * A literal, deliberately. The mechanical fallback is the implementation's own,
 * so a test that recomputed it would agree with whatever it produced — and the
 * point of pinning it is that a cancelled naming keeps the outcome it already
 * had. The odd tail is what this brief actually yields today, not a typo.
 */
const MECHANICAL_TITLE =
  'Warehouse Automation Proposal And Recommend Rollout Priorities Overvie'

interface RecordingProvider {
  readonly url: string
  models(): string[]
  close(): Promise<void>
}

async function startRecordingProvider(
  onRequest?: () => void,
): Promise<RecordingProvider> {
  const models: string[] = []
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.once('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      let model = ''
      try {
        model = String((JSON.parse(body) as { model?: unknown }).model ?? '')
      } catch {
        model = ''
      }
      models.push(model)
      onRequest?.()
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({
        model,
        choices: [{ message: { role: 'assistant', content: GENERATED_TITLE } }],
        usage: { prompt_tokens: 8, completion_tokens: 4, total_tokens: 12 },
      }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  return {
    url: `http://127.0.0.1:${address.port}`,
    models: () => [...models],
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
      server.closeAllConnections()
    }),
  }
}

async function withOwnedDefault<T>(
  provider: RecordingProvider,
  run: (providerName: string) => Promise<T>,
): Promise<T> {
  const connectionId = randomUUID()
  const providerName = `connection:${connectionId}`
  const previousDefault = getRuntimeDefaultModelState()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Job title provider',
      baseUrl: `${provider.url}/v1`,
      apiKey: 'job-title-key',
    },
  ])
  setRuntimeDefaultModelState({
    status: 'available',
    provider: providerName,
    model: DEFAULT_MODEL,
  })
  try {
    return await run(providerName)
  } finally {
    setRuntimeDefaultModelState(previousDefault)
    setConfiguredProviderConnections([])
  }
}

/** A child team the registry can resolve, so routing gets as far as naming. */
function writeChildTeamConfig(dir: string): void {
  fs.writeFileSync(
    path.join(dir, 'team.yaml'),
    [
      'team:',
      '  name: child-team',
      '  description: child team fixture',
      "  version: '0.1.0'",
      '',
      'workspace:',
      '  path: ./workspace',
      '  watch: false',
      '',
      'workflow:',
      '  entry_level: build',
      '  invocation_modes:',
      '    - team',
      '  input_contract:',
      '    artifacts:',
      '      - path: incoming-brief.md',
      '        required: true',
      '  output_contract:',
      '    artifacts:',
      '      - path: output/research.md',
      '        required: true',
      '    completion_artifact: output/research.md',
      '',
      'agents:',
      '  - name: worker',
      '    type: agent',
      '    role: worker',
      '    tier: execution',
      '    agent_file: ./worker.md',
      '    produces:',
      '      - path: output/research.md',
      '',
      'levels:',
      '  - id: build',
      '    name: Build',
      '    order: 0',
      '    stage:',
      '      type: chain',
      '      sequence:',
      '        - worker',
      '',
      'gates: []',
      '',
    ].join('\n'),
  )
  fs.writeFileSync(path.join(dir, 'worker.md'), '# worker')
}

/** The tool interface needs an extension context; no engine tool reads it. */
const UNUSED_EXTENSION_CONTEXT: ExtensionToolContext = Object.create(null)

/**
 * Runs the tool the way its host does.
 *
 * The signal, update callback and extension context come from the runtime and
 * `spawn_team` reads none of them (`engines/spawn-tools.ts:459`). Supplied once
 * here rather than at every call site.
 */
function executeSpawn(
  tool: ReturnType<typeof createSpawnTeamTool>,
  params: { team: string; brief: string },
): Promise<unknown> {
  return tool.execute(
    'call-1',
    params,
    undefined,
    undefined,
    UNUSED_EXTENSION_CONTEXT,
  )
}

test('a delegated job title records the model that named it, before that model is used', async () => {
  const recorded: ModelSelectionRecord[] = []
  let recordedAtSend = 0
  const provider = await startRecordingProvider(() => {
    recordedAtSend = recorded.length
  })
  try {
    await withOwnedDefault(provider, async (providerName) => {
      const config = resolveTitleSummarizerConfig()
      assert.ok(config, 'the application default is what this helper runs on')

      const title = await summarizeJobTitle({
        brief: BRIEF,
        config,
        onSelected: async (selection) => {
          recorded.push(selection)
          return true
        },
      })

      assert.equal(title, GENERATED_TITLE)
      assert.deepEqual(provider.models(), [DEFAULT_MODEL])
      // The account existed when the request went out, not merely afterwards.
      assert.equal(recordedAtSend, 1)
      assert.deepEqual(recorded, [{
        provider: providerName,
        model: DEFAULT_MODEL,
        source: 'app-default',
        reason: 'agent-default',
        caller: 'title',
      }])
    })
  } finally {
    await provider.close()
  }
})

test('a delegated job title whose selection cannot be recorded is never dispatched', async () => {
  // The same rule the other four callers keep: an owner that cannot take the
  // record declines, no model is asked anything, and the deterministic title
  // derived from the brief is what the delegation carries. Nothing new is
  // invented to fill the gap.
  const provider = await startRecordingProvider()
  try {
    await withOwnedDefault(provider, async () => {
      const config = resolveTitleSummarizerConfig()
      assert.ok(config)

      const title = await summarizeJobTitle({
        brief: BRIEF,
        config,
        onSelected: async () => false,
      })

      assert.deepEqual(provider.models(), [])
      assert.ok(title, 'the delegation still gets a title')
      assert.notEqual(title, GENERATED_TITLE)
    })
  } finally {
    await provider.close()
  }
})

test('a delegated job title cancelled before it starts records nothing', async () => {
  // The same rule the session title already keeps. A record written for a call
  // that is never made is a durable notice naming a model that was asked for
  // nothing — the same false account as an unrecorded call, told the other way
  // round. Checked before the record rather than only inside the provider,
  // because by then the account already exists.
  const recorded: ModelSelectionRecord[] = []
  const provider = await startRecordingProvider()
  const cancelled = new AbortController()
  cancelled.abort()
  try {
    await withOwnedDefault(provider, async () => {
      const config = resolveTitleSummarizerConfig()
      assert.ok(config)

      const title = await summarizeJobTitle({
        brief: BRIEF,
        config,
        signal: cancelled.signal,
        onSelected: async (selection) => {
          recorded.push(selection)
          return true
        },
      })

      assert.deepEqual(recorded, [])
      assert.deepEqual(provider.models(), [])
      // Stated as a literal rather than recomputed with `deriveTitleFromBrief`:
      // that is the implementation's own fallback, so asking it what to expect
      // would agree with any answer it gave. This is the title this brief
      // produced before the guard existed, so the outcome is preserved rather
      // than merely consistent.
      assert.equal(title, MECHANICAL_TITLE)
    })
  } finally {
    await provider.close()
  }
})

/**
 * The same rule at the boundary that owns it.
 *
 * The two cases above prove the helper's contract. This one proves that a real
 * routing delegation keeps it: the account is written to the delegation's own
 * journal, under the delegation's own identity, before the model is asked.
 *
 * The child run is left to the ordinary boundary rather than replaced, and made
 * to fail before it can start: `TEAM_RUNTIME_PI_CLI_PATH` points at a file that
 * does not exist inside this test's own directory, so the launcher refuses.
 * Without that the runner falls back to the repository extension and inherits
 * the ambient environment (`agent-runner.ts:790-795`), which would spawn a real
 * child this test never asked for.
 *
 * So this is a pre-spawn refusal, not a running child. Naming happens before
 * any of it, which is the point: the account has to be there either way, and
 * what a child returns is a different contract with its own coverage.
 */
test('a routing delegation records the model that named its job, before asking it', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-job-title-')),
  )
  const childDir = path.join(directory, 'child-team')
  fs.mkdirSync(childDir, { recursive: true })
  writeChildTeamConfig(childDir)

  const delegationsLogPath = getAssignmentLogPath(directory, 'delegations.jsonl')
  const readEvents = (): Record<string, unknown>[] => {
    if (!fs.existsSync(delegationsLogPath)) return []
    return fs
      .readFileSync(delegationsLogPath, 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line): Record<string, unknown> => JSON.parse(line) as Record<string, unknown>)
  }

  // Read at the moment the naming request reaches the provider. Reading only
  // afterwards could not tell an account written first from one written after.
  let eventsAtSend: Record<string, unknown>[] = []
  const provider = await startRecordingProvider(() => {
    eventsAtSend = readEvents()
  })

  const absentCliPath = path.join(directory, 'no-such-runtime-cli')
  const previousCliPath = process.env.TEAM_RUNTIME_PI_CLI_PATH
  process.env.TEAM_RUNTIME_PI_CLI_PATH = absentCliPath

  try {
    await withOwnedDefault(provider, async (providerName) => {
      const tool = createSpawnTeamTool({
        teamName: 'reception-desk',
        teamConfig: {
          team: { name: 'reception-desk', description: 'test', version: '0.1.0' },
          workspace: { path: path.join(directory, 'workspace'), watch: false },
          agents: [
            {
              name: 'research-team',
              type: 'team',
              role: 'Research specialists',
              tier: 'strategic',
              agent_file: './unused.md',
              color: 141,
              team_path: './child-team',
            },
          ],
          levels: [],
          gates: [],
          composition: {
            spawn_limits: { maxDepth: 3, maxConcurrent: 1, maxTotalBudgetUsd: 50 },
          },
        },
        teamRegistry: new Map([[
          'research-team',
          {
            name: 'research-team',
            type: 'team' as const,
            team_path: childDir,
            input_artifact: 'incoming-brief.md',
            output_artifact: 'output/research.md',
          },
        ]]),
        permissions: { spawn_teams: true },
        levelId: 'intake',
        // Only a routing stage names the job it hands over.
        stageType: 'routing',
        outputPath: directory,
        state: {
          sessionId: 'parent-session',
          currentLevelIndex: 0,
          levelStates: new Map(),
          totalCost: 0,
          startTime: 0,
          timerStarted: false,
          endTime: null,
          spawnDepth: 0,
          rootSessionId: 'root-session',
        },
        activeSpawnCountRef: { count: 0 },
      })

      // The refusal is the expected outcome, and it is asserted rather than
      // swallowed: a run that failed for some other reason would otherwise look
      // the same as this one.
      const spawnFailure = await executeSpawn(tool, {
        team: 'research-team',
        brief: BRIEF,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      assert.ok(spawnFailure, 'the child was expected to be refused before it started')
      // The refusal names the path this test owns, so it is this fixture's
      // doing rather than some other launcher fault.
      assert.equal(
        spawnFailure instanceof Error ? spawnFailure.message : String(spawnFailure),
        `Bundled Pi CLI is missing: ${absentCliPath}`,
      )
      // And nothing was spawned: the path the launcher was pointed at is still
      // absent, so no child could have come from it.
      assert.equal(fs.existsSync(absentCliPath), false)

      assert.deepEqual(provider.models(), [DEFAULT_MODEL])

      const naming = eventsAtSend.filter((event) => event.model_selection !== undefined)
      assert.equal(naming.length, 1, JSON.stringify(eventsAtSend))
      const recorded = naming[0]
      assert.ok(recorded)
      assert.deepEqual(recorded.model_selection, {
        provider: providerName,
        model: DEFAULT_MODEL,
        source: 'app-default',
        reason: 'agent-default',
        caller: 'title',
      }, JSON.stringify(recorded))

      // Tied to the identity the delegation persists for itself, not merely to
      // the other rows this same write produced.
      const statePath = getAssignmentLogPath(directory, 'delegation-state.json')
      assert.ok(fs.existsSync(statePath), 'the delegation persisted no state')
      const persisted: unknown = JSON.parse(fs.readFileSync(statePath, 'utf8'))
      assert.ok(persisted && typeof persisted === 'object')
      const persistedIds = Object.keys(persisted)
      assert.equal(persistedIds.length, 1, JSON.stringify(persistedIds))
      assert.equal(recorded.delegation_id, persistedIds[0])
    })
  } finally {
    if (previousCliPath === undefined) delete process.env.TEAM_RUNTIME_PI_CLI_PATH
    else process.env.TEAM_RUNTIME_PI_CLI_PATH = previousCliPath
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

/**
 * The naming has to reach the conversation that caused it.
 *
 * A routing Team runs in its own assignment, and the root conversation reads
 * its children's events only where they say which root they belong to:
 * `FileSystemRunStore.readAggregatedRunEvents` keeps a child assignment's event
 * when `root_run_id` matches, and `logDelegationEvent` derives that from
 * `root_session_id`. An account written without it is recorded correctly and
 * seen by nobody.
 */
test('a nested delegation’s naming reaches the root conversation', async () => {
  const directory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-lineage-')),
  )
  const childDir = path.join(directory, 'child-team')
  fs.mkdirSync(childDir, { recursive: true })
  writeChildTeamConfig(childDir)

  const provider = await startRecordingProvider()
  const absentCliPath = path.join(directory, 'no-such-runtime-cli')
  const previousCliPath = process.env.TEAM_RUNTIME_PI_CLI_PATH
  process.env.TEAM_RUNTIME_PI_CLI_PATH = absentCliPath

  // A workspace laid out the way a real run is: this delegation happens inside
  // a child assignment of a root run, which is the case the aggregation exists
  // for and the only one where the omission shows.
  const workspacePath = path.join(directory, 'workspace')
  const rootRunId = 'root-run'
  const childRunId = 'child-run'
  const rootLocation = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'product-session',
    runId: rootRunId,
    assignmentId: rootRunId,
  })
  const childLocation = buildSessionRunAssignmentLocation(workspacePath, {
    sessionId: 'product-session',
    runId: rootRunId,
    assignmentId: childRunId,
  })
  assert.ok(rootLocation && childLocation)
  // Registered, not merely created. `resolveRunAssignmentLocation` reads an
  // index (`run-location.ts:85`), so a directory the workspace does not know
  // about is invisible to the store — and a fixture that skipped this would
  // fail for that reason while looking like the failure under test.
  fs.mkdirSync(rootLocation.assignmentPath, { recursive: true })
  fs.mkdirSync(childLocation.assignmentPath, { recursive: true })
  await writeRunAssignmentLocator(workspacePath, rootLocation)
  await writeRunAssignmentLocator(workspacePath, childLocation)

  try {
    await withOwnedDefault(provider, async () => {
      const tool = createSpawnTeamTool({
        teamName: 'writing-desk',
        teamConfig: {
          team: { name: 'writing-desk', description: 'test', version: '0.1.0' },
          workspace: { path: workspacePath, watch: false },
          agents: [
            {
              name: 'research-team',
              type: 'team',
              role: 'Research specialists',
              tier: 'strategic',
              agent_file: './unused.md',
              color: 141,
              team_path: './child-team',
            },
          ],
          levels: [],
          gates: [],
          composition: {
            spawn_limits: { maxDepth: 3, maxConcurrent: 1, maxTotalBudgetUsd: 50 },
          },
        },
        teamRegistry: new Map([[
          'research-team',
          {
            name: 'research-team',
            type: 'team' as const,
            team_path: childDir,
            input_artifact: 'incoming-brief.md',
            output_artifact: 'output/research.md',
          },
        ]]),
        permissions: { spawn_teams: true },
        levelId: 'intake',
        stageType: 'routing',
        // The delegation is written into the child assignment, as a nested
        // routing Team's would be.
        outputPath: childLocation.assignmentPath,
        state: {
          sessionId: childRunId,
          currentLevelIndex: 0,
          levelStates: new Map(),
          totalCost: 0,
          startTime: 0,
          timerStarted: false,
          endTime: null,
          spawnDepth: 1,
          rootSessionId: rootRunId,
          // A real nested runtime has a parent that is not itself.
          parentSessionId: rootRunId,
        },
        activeSpawnCountRef: { count: 0 },
      })

      // The same bounded pre-spawn refusal the case above uses, asserted rather
      // than swallowed: an earlier unrelated failure would otherwise pass for
      // the missing-root record this exists to catch.
      const spawnFailure = await executeSpawn(tool, {
        team: 'research-team',
        brief: BRIEF,
      }).then(
        () => null,
        (error: unknown) => error,
      )
      assert.equal(
        spawnFailure instanceof Error ? spawnFailure.message : String(spawnFailure),
        `Bundled Pi CLI is missing: ${absentCliPath}`,
      )

      const runStore = new FileSystemRunStore(workspacePath)
      const namingsIn = async (runId: string): Promise<number> =>
        (await runStore.listRunEvents(runId)).filter(
          (event) =>
            (event.payload as Record<string, unknown> | undefined)?.model_selection !==
            undefined,
        ).length

      // Recorded where it happened…
      assert.equal(await namingsIn(childRunId), 1, 'the child assignment has no naming')
      // …and visible from the conversation that caused it, which is the whole
      // point of disclosing it.
      assert.equal(await namingsIn(rootRunId), 1, 'the root conversation cannot see it')

      // And the lineage it carries is the real one. A self-parent edge would
      // describe a runtime that spawned itself.
      const naming = (await runStore.listRunEvents(childRunId)).find(
        (event) =>
          (event.payload as Record<string, unknown> | undefined)?.model_selection !==
          undefined,
      )
      assert.ok(naming)
      // Stated as values, not as inequalities: `notEqual` against the runtime's
      // own id also passes when the field is simply missing, which is the very
      // thing this exists to catch.
      assert.equal(naming.run_id, childRunId)
      assert.equal(naming.root_run_id, rootRunId)
      assert.equal(naming.parent_run_id, rootRunId)
      const payload = naming.payload as Record<string, unknown>
      assert.match(String(payload.delegation_id), new RegExp(`^${childRunId}:`))
    })
  } finally {
    if (previousCliPath === undefined) delete process.env.TEAM_RUNTIME_PI_CLI_PATH
    else process.env.TEAM_RUNTIME_PI_CLI_PATH = previousCliPath
    await provider.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
