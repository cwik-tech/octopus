/**
 * A failed run has to change what the sidebars say about its provider.
 *
 * The whole point of the derived view is that it survives the run, the turn,
 * and the process, so this exercises the real path: a real workspace, a real
 * assignment journal, the real recorder, and the file a restarted server would
 * read back. Nothing here fakes an event; the observation has to come out of
 * what the journal actually accepted.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as http from 'node:http'
import * as path from 'node:path'
import test, { type TestContext } from 'node:test'

import type { AgentProviderHealth } from '../../contracts/agent-generator.js'
import type { ProviderUsageReading } from '../../domains/provider/provider-usage.js'
import type { LocalCliAgentView } from '../../domains/provider/provider-settings.js'
import { CreateJobRegistry } from '../../server/create-job-registry.js'
import { handleAgentRoutes } from '../../server/routes/agents.js'
import { listTeamBuilderTeams } from '../../domains/agent-generator/team-manager.js'
import { resolveAgentTurnJournalRecorder } from '../../services/agent-turn-journal-recorder.js'
import { ProviderFailureHealthService } from '../../services/provider-failure-health-service.js'
import { WorkspaceExecutionJournalRegistry } from '../../services/workspace-execution-journal-registry.js'

const AGENT_PATH = 'agents/market-analyst'
// A provider that needs no key, so the only thing wrong with this Team is
// the one thing the run discovered.
const PROVIDER = 'lm-studio'
const MODEL = 'local-model'

interface Fixture {
  readonly workspacePath: string
  readonly repoRoot: string
  readonly health: ProviderFailureHealthService
  recordExhaustedKey(
    kind?: 'billing' | 'usage_limit',
    resetsAt?: string,
  ): Promise<void>
  /** A second failure, stamped later than the journal's own clock would. */
  recordFailureAt(kind: 'billing' | 'usage_limit', observedAt: string): Promise<void>
  cleanup(): Promise<void>
}

async function makeFixture(
  provider: string = PROVIDER,
  model: string = MODEL,
): Promise<Fixture> {
  const workspacePath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'provider-failure-health-')),
  )
  const repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'provider-failure-repo-')),
  )
  const scope = {
    sessionId: randomUUID(),
    runId: randomUUID(),
    assignmentId: randomUUID(),
  }
  fs.mkdirSync(
    path.join(
      workspacePath,
      'sessions',
      scope.sessionId,
      'runs',
      scope.runId,
      'assignments',
      scope.assignmentId,
    ),
    { recursive: true },
  )
  const registry = new WorkspaceExecutionJournalRegistry({
    workspacePath,
    tenantId: 'local',
    mode: 'authoritative',
  })
  const health = new ProviderFailureHealthService({ workspacePath })

  writeAgent(repoRoot, 'market-analyst', provider, model)
  writeTeam(repoRoot, 'market-team', 'market-analyst', provider, model)

  return {
    workspacePath,
    repoRoot,
    health,
    recordExhaustedKey: async (
      kind: 'billing' | 'usage_limit' = 'billing',
      resetsAt?: string,
    ) => {
      const recorder = await resolveAgentTurnJournalRecorder({
        registry,
        scope,
        agentPath: AGENT_PATH,
        requestId: randomUUID(),
        processIdentity: 'provider-failure-health-test',
        observer: health,
      })
      assert.ok(recorder, 'an authoritative workspace enrolls the assignment')
      const turnId = randomUUID()
      await recorder.recordStarted({
        turnId,
        replyId: 'market-analyst:0',
        speakerOrdinal: 0,
        agentPath: AGENT_PATH,
        requestedProvider: provider,
        requestedModel: model,
      })
      await recorder.recordFailed({
        turnId,
        replyId: 'market-analyst:0',
        failure: {
          layer: 'direct-provider',
          phase: 'provider-request',
          serviceCode: kind,
          providerKind: kind,
          provider,
          model,
          httpStatus: kind === 'billing' ? 402 : 429,
          ...(resetsAt === undefined ? {} : { resetsAt }),
          retryable: false,
        },
      })
      await recorder.release()
    },
    recordFailureAt: async (kind, observedAt) => {
      await health.observe({
        schemaVersion: 1,
        eventId: randomUUID(),
        sequence: 99,
        recordedAt: observedAt,
        scopeKind: 'assignment',
        scopeId: scope.assignmentId,
        tenantId: 'local',
        streamKind: 'agent.turn',
        streamId: scope.assignmentId,
        streamRevision: 99,
        type: 'agent.turn.failed',
        payloadSchemaVersion: 1,
        appendRequestDigest: 'later-failure',
        correlationId: randomUUID(),
        previousEventHash: 'later-failure',
        eventHash: 'later-failure',
        payload: { failure: { provider, model, providerKind: kind } },
      })
    },
    cleanup: async () => {
      await registry.close()
      fs.rmSync(workspacePath, { recursive: true, force: true })
      fs.rmSync(repoRoot, { recursive: true, force: true })
    },
  }
}

test('a key a run found exhausted blocks the Teams that share it and survives a restart', async () => {
  const fixture = await makeFixture()
  try {
    // Before the run, nothing is known and both surfaces are quiet.
    assert.deepEqual(fixture.health.read(), {})

    await fixture.recordExhaustedKey()

    // 1. The failure is in the derived view, keyed by provider and model.
    const observed = fixture.health.active({ provider: PROVIDER, model: MODEL })
    assert.ok(observed, 'the run left a provider failure behind')
    assert.equal(observed.kind, 'billing')

    // 2. The Team badge, which never calls a provider, now says it is blocked.
    const [team] = listTeamBuilderTeams(fixture.repoRoot, {
      providerFailures: fixture.health.read(),
    })
    assert.ok(team)
    assert.equal(team.health.status, 'error')
    assert.ok(
      team.health.diagnostics?.some(
        (diagnostic) =>
          diagnostic.kind === 'billing' &&
          diagnostic.subject.agentName === 'market-analyst',
      ),
      'the Team names which member cannot run',
    )

    // 3. A restarted server reads the same answer off disk. What each badge
    //    does with a live ping on top of it is pinned by the unit tests; this
    //    journey is about the fact surviving the run and the process.
    const restarted = new ProviderFailureHealthService({
      workspacePath: fixture.workspacePath,
    })
    await restarted.load()
    assert.equal(
      restarted.active({ provider: PROVIDER, model: MODEL })?.kind,
      'billing',
    )

    // 4. Something that proves the key works again clears it everywhere.
    await restarted.forget({ provider: PROVIDER })
    assert.deepEqual(restarted.read(), {})
    const [clearedTeam] = listTeamBuilderTeams(fixture.repoRoot, {
      providerFailures: restarted.read(),
    })
    assert.equal(clearedTeam?.health.status, 'ok')
  } finally {
    await fixture.cleanup()
  }
})

function writeAgent(
  repoRoot: string,
  name: string,
  provider: string,
  model: string,
): void {
  const agentDir = path.join(repoRoot, 'agents', name)
  fs.mkdirSync(agentDir, { recursive: true })
  fs.writeFileSync(
    path.join(agentDir, `${name}.md`),
    `---\nname: ${name}\nprovider: ${provider}\nmodel: ${model}\n---\n\n# ${name}\n`,
  )
}

function writeTeam(
  repoRoot: string,
  teamId: string,
  memberName: string,
  provider: string,
  model: string,
): void {
  fs.appendFileSync(
    path.join(repoRoot, 'teams.yaml'),
    `${teamId}:\n  type: team\n  description: ${teamId} fixture.\n  team_path: ./teams/${teamId}\n`,
  )
  const teamRoot = path.join(repoRoot, 'teams', teamId)
  fs.mkdirSync(teamRoot, { recursive: true })
  fs.writeFileSync(
    path.join(teamRoot, 'team.yaml'),
    `team:
  name: ${teamId}
agents:
  - name: ${memberName}
    type: agent
    role: Analyst
    agent_file: ./${memberName}.md
levels:
  - id: work
    name: Work
    order: 0
    stage:
      type: chain
      sequence: [${memberName}]
gates: []
`,
  )
  fs.writeFileSync(
    path.join(teamRoot, `${memberName}.md`),
    `---\nname: ${memberName}\nprovider: ${provider}\nmodel: ${model}\n---\n\n# ${memberName}\n`,
  )
}

/**
 * Recovery has to be decided by the evidence, not by the badge it produces.
 *
 * A newer reading that shows the account strained but working disproves a
 * usage limit an older run hit — and still leaves the agent warning, because
 * an allowance at 90% is working and nearly gone at once. Forgetting only when
 * the badge came back green would leave the stored failure on disk, so the
 * Agents list would say "warning" while the Teams list, which reads the stored
 * view alone and never asks for an allowance, went on saying "error" forever.
 *
 * Driven through the real route, because the conditional that decides this
 * lives there. A test that called the domain check and then re-implemented the
 * route's rule would pass with the route left exactly as it was.
 */

/**
 * A CLI provider, because that is the case with no way out.
 *
 * Nothing pings a CLI, so a usage limit it recorded can only ever be retired
 * by a reading — which is what these tests are about.
 */
const CLI_PROVIDER = 'codex'
const CLI_MODEL = 'gpt-5.5'

const codexSettings = {
  async listCliAgents(): Promise<LocalCliAgentView[]> {
    return [
      {
        id: CLI_PROVIDER,
        name: 'Codex CLI',
        command: CLI_PROVIDER,
        available: true,
        enabled: true,
        path: '/fixture/codex',
        models: [{ id: CLI_MODEL, name: 'GPT', enabled: true }],
        mcpBridge: { supported: true },
      },
    ]
  },
}

async function askAgentHealth(
  t: TestContext,
  input: {
    readonly fixture: Fixture
    readonly reading: ProviderUsageReading
    /**
     * Runs while the check is awaiting the allowance, which is after the route
     * took its snapshot and before it decides what to forget. That is the only
     * window the cutoff exists for.
     */
    readonly whileReading?: () => Promise<void>
  },
): Promise<AgentProviderHealth[]> {
  const server = http.createServer((req, res) => {
    void handleAgentRoutes({
      req,
      res,
      url: new URL(req.url ?? '/', 'http://localhost'),
      options: {
        repoRootPath: input.fixture.repoRoot,
        createJobRegistry: new CreateJobRegistry(),
        isAbortLike: () => false,
        providerSettingsService: codexSettings,
        providerFailureHealth: input.fixture.health,
        usageSources: [
          {
            provider: input.reading.provider,
            cost: 'free',
            read: async () => {
              await input.whileReading?.()
              return input.reading
            },
          },
        ],
      },
    }).catch((error) => {
      res.statusCode = 500
      res.end(String(error))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  )
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  const response = await fetch(
    `http://127.0.0.1:${address.port}/create/agents/health`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentNames: ['market-analyst'] }),
    },
  )
  assert.equal(response.status, 200)
  const body: unknown = await response.json()
  assert.ok(
    body !== null && typeof body === 'object' && 'health' in body,
    'the route answers with a health list',
  )
  const { health } = body as { health: AgentProviderHealth[] }
  return health
}

test('a newer reading that still warns retires the stored limit everywhere', async (t) => {
  const fixture = await makeFixture(CLI_PROVIDER, CLI_MODEL)
  try {
    await fixture.recordExhaustedKey('usage_limit')
    const observed = fixture.health.active({
      provider: CLI_PROVIDER,
      model: CLI_MODEL,
    })
    assert.equal(observed?.kind, 'usage_limit')

    // Anchored to the moment the journal actually recorded, because the
    // recorder stamps events with the real clock and the whole question here
    // is which of the two facts came second.
    const failedAt = Date.parse(observed.observedAt)
    const [checked] = await askAgentHealth(t, {
      fixture,
      reading: {
        provider: CLI_PROVIDER,
        observedAt: new Date(failedAt + 60_000).toISOString(),
        windows: [
          {
            usedPercent: 90,
            windowMinutes: 10080,
            resetsAt: new Date(failedAt + 7 * 24 * 60 * 60 * 1000).toISOString(),
          },
        ],
      },
    })

    // The reading speaks, so the badge is its own warning rather than the
    // run's blocking limit — and the badge never goes green.
    assert.ok(checked)
    assert.equal(checked.status, 'warning')
    assert.match(checked.message ?? '', /90%/)

    // The route cleared the stored failure anyway, which is the point.
    assert.deepEqual(fixture.health.read(), {})

    // The Teams list, which never reads an allowance, agrees now.
    const [team] = listTeamBuilderTeams(fixture.repoRoot, {
      providerFailures: fixture.health.read(),
    })
    assert.equal(team?.health.status, 'ok')

    // And a restarted server reads the cleared view off disk.
    const restarted = new ProviderFailureHealthService({
      workspacePath: fixture.workspacePath,
    })
    await restarted.load()
    assert.deepEqual(restarted.read(), {})
  } finally {
    await fixture.cleanup()
  }
})

test('a reading never retires a failure recorded after it was taken', async (t) => {
  // The check reads a snapshot and answers some milliseconds later. A run that
  // fails in between must survive: clearing by provider and model alone would
  // throw that failure away on the strength of evidence that predates it, and
  // nothing would ever report it again.
  const fixture = await makeFixture(CLI_PROVIDER, CLI_MODEL)
  try {
    await fixture.recordExhaustedKey('usage_limit')
    const observed = fixture.health.active({
      provider: CLI_PROVIDER,
      model: CLI_MODEL,
    })
    assert.ok(observed)

    const [checked] = await askAgentHealth(t, {
      fixture,
      reading: {
        provider: CLI_PROVIDER,
        // Taken before the failure that is already stored, so it disproves
        // nothing and the limit stands.
        observedAt: new Date(Date.parse(observed.observedAt) - 60_000).toISOString(),
        windows: [{ usedPercent: 4, windowMinutes: 10080 }],
      },
    })

    assert.equal(checked?.status, 'error')
    assert.equal(checked?.disprovedRuntimeFailureAt, undefined)
    assert.equal(
      fixture.health.active({ provider: CLI_PROVIDER, model: CLI_MODEL })?.kind,
      'usage_limit',
      'the stored failure survives a reading that cannot speak to it',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('a newer reading does not retire a failure about the account itself', async (t) => {
  const fixture = await makeFixture(CLI_PROVIDER, CLI_MODEL)
  try {
    await fixture.recordExhaustedKey('billing')
    const observed = fixture.health.active({
      provider: CLI_PROVIDER,
      model: CLI_MODEL,
    })
    assert.ok(observed)

    const [checked] = await askAgentHealth(t, {
      fixture,
      reading: {
        provider: CLI_PROVIDER,
        observedAt: new Date(Date.parse(observed.observedAt) + 60_000).toISOString(),
        windows: [{ usedPercent: 3, windowMinutes: 10080 }],
      },
    })

    assert.equal(checked?.status, 'error')
    assert.equal(checked?.diagnostics?.[0]?.kind, 'billing')
    assert.equal(checked?.disprovedRuntimeFailureAt, undefined)
    assert.equal(
      fixture.health.active({ provider: CLI_PROVIDER, model: CLI_MODEL })?.kind,
      'billing',
      'an allowance reading is not evidence about the account',
    )
  } finally {
    await fixture.cleanup()
  }
})

test('a healthy reading clears the limit it saw and not one recorded after it', async (t) => {
  // The ordinary recovery: the allowance came back, so the agent reads as fine
  // and the route sees `status: "ok"` — which for a CLI means only that the
  // binary is installed. A run that fails while the check is still working
  // must survive that, and it is stored after the snapshot the check is
  // reasoning about, so only a cutoff can save it.
  const fixture = await makeFixture(CLI_PROVIDER, CLI_MODEL)
  try {
    await fixture.recordExhaustedKey('usage_limit')
    const first = fixture.health.active({
      provider: CLI_PROVIDER,
      model: CLI_MODEL,
    })
    assert.ok(first)

    const readAt = new Date(Date.parse(first.observedAt) + 60_000).toISOString()
    const secondFailureAt = new Date(Date.parse(readAt) + 60_000).toISOString()

    const [checked] = await askAgentHealth(t, {
      fixture,
      reading: {
        provider: CLI_PROVIDER,
        observedAt: readAt,
        windows: [{ usedPercent: 17, windowMinutes: 10080 }],
      },
      whileReading: () =>
        fixture.recordFailureAt('usage_limit', secondFailureAt),
    })

    assert.ok(checked)
    assert.equal(checked.status, 'ok', 'the reading the check saw showed room')
    assert.equal(checked.disprovedRuntimeFailureAt, first.observedAt)
    assert.notEqual(
      checked.answeredLivePing,
      true,
      'a CLI is never pinged, however healthy its settings look',
    )

    const surviving = fixture.health.active({
      provider: CLI_PROVIDER,
      model: CLI_MODEL,
    })
    assert.equal(
      surviving?.observedAt,
      secondFailureAt,
      'the failure recorded while the check was working survives it',
    )
  } finally {
    await fixture.cleanup()
  }
})

/**
 * A dated usage limit has to expire by itself, across a restart.
 *
 * The derived view is rebuilt from disk by a new process, and the restore path
 * validates every field through the projection rather than trusting the file.
 * A reset that did not survive that would leave the limit standing forever on
 * the one machine it matters on — the one that was restarted.
 */
test('a stated reset survives a restart and ends the failure on time', async () => {
  const fixture = await makeFixture(CLI_PROVIDER, CLI_MODEL)
  try {
    const resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString()
    await fixture.recordExhaustedKey('usage_limit', resetsAt)

    const observed = fixture.health.active({
      provider: CLI_PROVIDER,
      model: CLI_MODEL,
    })
    assert.equal(observed?.kind, 'usage_limit')
    assert.equal(observed?.resetsAt, resetsAt)

    // A new process reads the same answer, reset included.
    const restarted = new ProviderFailureHealthService({
      workspacePath: fixture.workspacePath,
    })
    await restarted.load()
    const afterRestart = restarted.active({
      provider: CLI_PROVIDER,
      model: CLI_MODEL,
    })
    assert.equal(
      afterRestart?.resetsAt,
      resetsAt,
      'the reset came back off disk, not just the kind',
    )

    // And it ends exactly when the provider said, not a moment before.
    const justBefore = new Date(Date.parse(resetsAt) - 1)
    const atReset = new Date(Date.parse(resetsAt))
    assert.equal(
      restarted.active({ provider: CLI_PROVIDER, model: CLI_MODEL }, justBefore)
        ?.kind,
      'usage_limit',
    )
    assert.equal(
      restarted.active({ provider: CLI_PROVIDER, model: CLI_MODEL }, atReset),
      undefined,
    )

    // The Teams list expires with it, having asked no provider anything.
    const [blocked] = listTeamBuilderTeams(fixture.repoRoot, {
      providerFailures: restarted.read(justBefore),
      now: justBefore,
    })
    assert.equal(blocked?.health.status, 'error')

    const [cleared] = listTeamBuilderTeams(fixture.repoRoot, {
      providerFailures: restarted.read(atReset),
      now: atReset,
    })
    assert.equal(cleared?.health.status, 'ok')
  } finally {
    await fixture.cleanup()
  }
})
