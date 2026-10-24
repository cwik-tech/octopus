import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { checkAgentProviderHealth } from '../../domains/agent-generator/provider-health.js'
import { listTeamBuilderTeams } from '../../domains/agent-generator/team-manager.js'
import {
  applyProviderFailure,
  type ProviderFailureSnapshot,
} from '../../domains/provider/provider-failure-projection.js'
import { registerProvider } from '../../providers/registry.js'
import type { LocalCliAgentView } from '../../domains/provider/provider-settings.js'

/**
 * What a run discovered has to reach the badges, in both tabs.
 *
 * A key that ran out of credit during a run is invisible to the Team badge,
 * which never calls a provider, and to a CLI agent's badge, which only reads
 * local settings. Both would keep saying "fine" until somebody started another
 * run and watched it die.
 */

const EXHAUSTED_OPENAI: ProviderFailureSnapshot = applyProviderFailure(
  {},
  {
    provider: 'openai',
    model: 'gpt-5.4',
    kind: 'billing',
    observedAt: '2026-09-11T09:00:00.000Z',
  },
)
const NOW = new Date('2026-09-11T09:30:00.000Z')

test('a Team whose member uses a provider a run exhausted is reported as blocked', () => {
  withTempRepo((repoRoot) => {
    registerTeam(repoRoot, 'analysis-team')
    writePersona(repoRoot, 'analysis-team', 'worker', 'openai', 'gpt-5.4')

    const [team] = listTeamBuilderTeams(repoRoot, {
      providerFailures: EXHAUSTED_OPENAI,
      now: NOW,
    })

    assert.ok(team)
    assert.equal(team.health.status, 'error')
    const runtimeFailure = team.health.diagnostics?.find(
      (diagnostic) => diagnostic.kind === 'billing',
    )
    assert.ok(runtimeFailure, 'the Team names the exhausted account')
    assert.equal(runtimeFailure.severity, 'error')
    assert.equal(runtimeFailure.subject.agentName, 'worker')
    assert.equal(runtimeFailure.subject.teamName, 'analysis-team')
    assert.equal(runtimeFailure.subject.provider, 'openai')
    assert.match(runtimeFailure.message, /billing/i)
  })
})

test('a Team whose members use a different provider is untouched by that failure', () => {
  withTempRepo((repoRoot) => {
    registerTeam(repoRoot, 'analysis-team')
    writePersona(repoRoot, 'analysis-team', 'worker', 'lm-studio', 'local-model')

    const [team] = listTeamBuilderTeams(repoRoot, {
      providerFailures: EXHAUSTED_OPENAI,
      now: NOW,
    })

    assert.ok(team)
    assert.equal(team.health.status, 'ok')
    assert.deepEqual(team.health.diagnostics, [])
  })
})

test('a CLI agent that local settings call healthy is still reported as blocked by a run', async () => {
  // Nothing pings a CLI provider: its health comes from whether the binary is
  // installed and enabled, which says nothing about the account behind it.
  await withAgentRepo(
    { agentName: 'agent-codex', provider: 'codex', model: 'gpt-5.5' },
    async (repoRoot) => {
      const [checked] = await checkAgentProviderHealth({
        repoRoot,
        cliSettingsReader: {
          async listCliAgents() {
            return [cliAgent('codex', { models: [{ id: 'gpt-5.5', name: 'GPT', enabled: true }] })]
          },
        },
        providerFailures: applyProviderFailure(
          {},
          {
            provider: 'codex',
            model: 'gpt-5.5',
            kind: 'authentication',
            observedAt: '2026-09-11T09:00:00.000Z',
          },
        ),
        now: NOW,
      })

      assert.ok(checked)
      assert.equal(checked.status, 'error')
      assert.equal(checked.diagnostics?.[0]?.kind, 'authentication')
      assert.match(checked.diagnostics?.[0]?.message ?? '', /Reconnect/)
    },
  )
})

test('a provider that answers a live ping disproves what an earlier run found', async () => {
  const calls: string[] = []
  registerProvider(
    {
      name: 'openai',
      async execute(options) {
        calls.push('openai')
        return {
          text: 'OK',
          cost: 0,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 0,
          model: options.model,
        }
      },
    },
    { source: 'tests/unit/runtime-failure-health.test.ts', trustClass: 'test' },
    { replaceExisting: true },
  )

  await withAgentRepo(
    { agentName: 'agent-openai', provider: 'openai', model: 'gpt-5.4' },
    async (repoRoot) => {
      const [checked] = await checkAgentProviderHealth({
        repoRoot,
        providerFailures: EXHAUSTED_OPENAI,
        now: NOW,
      })

      assert.ok(checked)
      assert.deepEqual(calls, ['openai'], 'the ping actually ran')
      assert.equal(checked.status, 'ok')
      assert.deepEqual(checked.diagnostics, [])
    },
  )
})

test('a CLI whose local allowance reading is spent blocks the agent before it runs', async () => {
  await withAgentRepo(
    { agentName: 'agent-codex', provider: 'codex', model: 'gpt-5.5' },
    async (repoRoot) => {
      const [checked] = await checkAgentProviderHealth({
        repoRoot,
        cliSettingsReader: {
          async listCliAgents() {
            return [
              cliAgent('codex', {
                models: [{ id: 'gpt-5.5', name: 'GPT', enabled: true }],
              }),
            ]
          },
        },
        usageSources: [
          {
            provider: 'codex',
            cost: 'free',
            read: async () => ({
              provider: 'codex',
              observedAt: '2026-09-10T16:00:00.000Z',
              windows: [
                {
                  usedPercent: 100,
                  windowMinutes: 10080,
                  resetsAt: '2026-09-15T01:45:48.000Z',
                },
              ],
            }),
          },
        ],
        now: NOW,
      })

      assert.ok(checked)
      assert.equal(checked.status, 'error')
      assert.equal(checked.diagnostics?.[0]?.kind, 'usage_limit')
      assert.match(checked.diagnostics?.[0]?.message ?? '', /2026-09-15/)
    },
  )
})

test('a failure a run actually hit outranks a reading taken days ago', async () => {
  // Both describe the same account. One is what happened; the other is what
  // was true at some earlier moment, so it does not get to speak over it.
  await withAgentRepo(
    { agentName: 'agent-codex', provider: 'codex', model: 'gpt-5.5' },
    async (repoRoot) => {
      const [checked] = await checkAgentProviderHealth({
        repoRoot,
        cliSettingsReader: {
          async listCliAgents() {
            return [
              cliAgent('codex', {
                models: [{ id: 'gpt-5.5', name: 'GPT', enabled: true }],
              }),
            ]
          },
        },
        providerFailures: applyProviderFailure(
          {},
          {
            provider: 'codex',
            model: 'gpt-5.5',
            kind: 'authentication',
            observedAt: '2026-09-11T09:00:00.000Z',
          },
        ),
        usageSources: [
          {
            provider: 'codex',
            cost: 'free',
            read: async () => ({
              provider: 'codex',
              observedAt: '2026-09-10T16:00:00.000Z',
              windows: [
                {
                  usedPercent: 100,
                  windowMinutes: 10080,
                  resetsAt: '2026-09-15T01:45:48.000Z',
                },
              ],
            }),
          },
        ],
        now: NOW,
      })

      assert.ok(checked)
      assert.equal(checked.diagnostics?.[0]?.kind, 'authentication')
    },
  )
})

test('a newer allowance reading retires a usage limit an older run hit', async () => {
  // The one failure a reading can speak to. An allowance that a run found
  // spent is a statement about a window, and a reading taken afterwards
  // measures that same window directly — so the newer of the two wins.
  //
  // Nothing else can retire it: a CLI provider is never pinged, so a run's
  // usage limit would otherwise be reported until the file was deleted by
  // hand, long after the window it described had rolled over.
  await withAgentRepo(
    { agentName: 'agent-codex', provider: 'codex', model: 'gpt-5.5' },
    async (repoRoot) => {
      const [checked] = await checkAgentProviderHealth({
        repoRoot,
        cliSettingsReader: {
          async listCliAgents() {
            return [
              cliAgent('codex', {
                models: [{ id: 'gpt-5.5', name: 'GPT', enabled: true }],
              }),
            ]
          },
        },
        providerFailures: applyProviderFailure(
          {},
          {
            provider: 'codex',
            model: 'gpt-5.5',
            kind: 'usage_limit',
            observedAt: '2026-09-11T09:00:00.000Z',
          },
        ),
        usageSources: [
          {
            provider: 'codex',
            cost: 'free',
            read: async () => ({
              provider: 'codex',
              observedAt: '2026-09-11T09:29:00.000Z',
              windows: [
                {
                  usedPercent: 17,
                  windowMinutes: 10080,
                  resetsAt: '2026-09-18T14:36:08.000Z',
                },
              ],
            }),
          },
        ],
        now: NOW,
      })

      assert.ok(checked)
      assert.equal(checked.status, 'ok')
      assert.deepEqual(checked.diagnostics, [])
    },
  )
})

test('a newer allowance reading does not retire a failure about the account', async () => {
  // An allowance reading measures a window. It is not evidence about the key,
  // the plan, or the permission behind it, so it may not retire a failure that
  // describes one however recently it was taken.
  await withAgentRepo(
    { agentName: 'agent-codex', provider: 'codex', model: 'gpt-5.5' },
    async (repoRoot) => {
      const [checked] = await checkAgentProviderHealth({
        repoRoot,
        cliSettingsReader: {
          async listCliAgents() {
            return [
              cliAgent('codex', {
                models: [{ id: 'gpt-5.5', name: 'GPT', enabled: true }],
              }),
            ]
          },
        },
        providerFailures: applyProviderFailure(
          {},
          {
            provider: 'codex',
            model: 'gpt-5.5',
            kind: 'authentication',
            observedAt: '2026-09-11T09:00:00.000Z',
          },
        ),
        usageSources: [
          {
            provider: 'codex',
            cost: 'free',
            read: async () => ({
              provider: 'codex',
              observedAt: '2026-09-11T09:29:00.000Z',
              windows: [
                {
                  usedPercent: 17,
                  windowMinutes: 10080,
                  resetsAt: '2026-09-18T14:36:08.000Z',
                },
              ],
            }),
          },
        ],
        now: NOW,
      })

      assert.ok(checked)
      assert.equal(checked.status, 'error')
      assert.equal(checked.diagnostics?.[0]?.kind, 'authentication')
    },
  )
})

test('a provider that just answered a call is never called spent, only strained', async () => {
  // A live call proves the account works now; a reading only says how much of
  // the window was gone at some earlier moment. Both can be true, so the
  // reading still warns — but it does not get to call an account dead that
  // just answered.
  registerProvider(
    {
      name: 'openai',
      async execute(options) {
        return {
          text: 'OK',
          cost: 0,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 0,
          model: options.model,
        }
      },
    },
    { source: 'tests/unit/runtime-failure-health.test.ts', trustClass: 'test' },
    { replaceExisting: true },
  )

  await withAgentRepo(
    { agentName: 'agent-openai', provider: 'openai', model: 'gpt-5.4' },
    async (repoRoot) => {
      const [checked] = await checkAgentProviderHealth({
        repoRoot,
        usageSources: [
          {
            provider: 'openai',
            cost: 'free',
            read: async () => ({
              provider: 'openai',
              observedAt: '2026-09-10T16:00:00.000Z',
              windows: [
                {
                  usedPercent: 100,
                  windowMinutes: 10080,
                  resetsAt: '2026-09-15T01:45:48.000Z',
                },
              ],
            }),
          },
        ],
        now: NOW,
      })

      assert.ok(checked)
      assert.equal(checked.status, 'warning')
      assert.equal(checked.diagnostics?.[0]?.kind, 'usage_limit')
    },
  )
})

test('a CLI nobody can read an allowance for is left exactly as it was', async () => {
  await withAgentRepo(
    { agentName: 'agent-gemini', provider: 'gemini', model: 'gemini-3' },
    async (repoRoot) => {
      const [checked] = await checkAgentProviderHealth({
        repoRoot,
        cliSettingsReader: {
          async listCliAgents() {
            return [
              cliAgent('gemini', {
                models: [{ id: 'gemini-3', name: 'Gemini', enabled: true }],
              }),
            ]
          },
        },
        usageSources: [],
        now: NOW,
      })

      assert.ok(checked)
      assert.equal(checked.status, 'ok')
      assert.deepEqual(checked.diagnostics, [])
    },
  )
})

function withTempRepo(run: (repoRoot: string) => void): void {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-health-'))
  try {
    run(repoRoot)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
}

function registerTeam(repoRoot: string, id: string): void {
  fs.appendFileSync(
    path.join(repoRoot, 'teams.yaml'),
    `${id}:\n  type: team\n  description: ${id} fixture.\n  team_path: ./teams/${id}\n`,
  )
  const teamRoot = path.join(repoRoot, 'teams', id)
  fs.mkdirSync(teamRoot, { recursive: true })
  fs.writeFileSync(
    path.join(teamRoot, 'team.yaml'),
    `team:
  name: ${id}
agents:
  - name: worker
    type: agent
    role: Worker
    agent_file: ./worker.md
levels:
  - id: work
    name: Work
    order: 0
    stage:
      type: chain
      sequence: [worker]
gates: []
`,
  )
}

function writePersona(
  repoRoot: string,
  teamId: string,
  name: string,
  provider: string,
  model: string,
): void {
  fs.writeFileSync(
    path.join(repoRoot, 'teams', teamId, `${name}.md`),
    `---\nname: ${name}\nprovider: ${provider}\nmodel: ${model}\n---\n\n# ${name}\n`,
  )
}

function cliAgent(
  id: string,
  overrides: Partial<LocalCliAgentView> = {},
): LocalCliAgentView {
  return {
    id,
    name: id,
    command: id,
    available: true,
    enabled: true,
    path: `/fixture/${id}`,
    models: [{ id: 'fixture-model', name: 'Fixture', enabled: true }],
    mcpBridge: { supported: true },
    ...overrides,
  }
}

async function withAgentRepo<T>(
  agent: { agentName: string; provider: string; model: string },
  fn: (repoRoot: string) => Promise<T>,
): Promise<T> {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-health-agent-'))
  try {
    const agentDir = path.join(repoRoot, 'agents', agent.agentName)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(
      path.join(agentDir, `${agent.agentName}.md`),
      `---\nname: ${agent.agentName}\nprovider: ${agent.provider}\nmodel: ${agent.model}\n---\n\n# Agent\n`,
    )
    return await fn(repoRoot)
  } finally {
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
}
