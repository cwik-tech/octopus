import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  HOST_CODEX_PROVIDER,
  HOST_OPENAI_PROVIDER,
  normalizeRepoHostProvider,
  openAiHostSupportsReasoningEffort,
  validateHostProviderReadiness,
} from '../../domains/provider/provider-preflight.js'
import { STAGE_TYPE } from '../../core/constants.js'
import type { LevelConfig } from '../../core/types.js'
import type { LoadedAgent } from '../../core/types.js'

import {
  validateDeclaredCoordinators,
  validateLoadedAgentProviders,
} from '../../domains/provider/provider-preflight.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'

function makeAgent(overrides: Partial<LoadedAgent> = {}): LoadedAgent {
  return {
    name: 'agent',
    model: 'gpt-5.4-mini',
    thinking: 'medium',
    systemPrompt: 'prompt',
    experienceContent: '',
    experienceEnabled: true,
    skillsContent: '',
    knowledgeContent: '',
    selection: null,
    agentDir: '/tmp',
    color: 1,
    provider: 'openai',
    providerConfig: {},
    ...overrides,
  }
}

function withEnv(values: Record<string, string | undefined>, run: () => void): void {
  const previous = new Map(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    run()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

/**
 * A PATH on which no agent CLI exists.
 *
 * `commandExists` walks `buildCliPath`, which appends `~/.local/bin`,
 * `/opt/homebrew/bin` and the rest unless the fallback is switched off — so a
 * machine that has `codex` installed would otherwise find it and the case
 * would assert nothing.
 */
function withoutAnyCliOnPath(run: () => void): void {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-empty-bin-'))
  try {
    withEnv(
      { PATH: emptyDir, PIPELINE_CLI_PATH_FALLBACK: '0', TEAM_RUNTIME_PI_CLI_PATH: undefined },
      run,
    )
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true })
  }
}

function withAppDefault(
  pair: { provider: string; model: string } | null,
  run: () => void,
): void {
  setRuntimeDefaultModelState(
    pair ? { status: 'available', ...pair } : { status: 'unset' },
  )
  try {
    run()
  } finally {
    setRuntimeDefaultModelState(undefined)
  }
}

test('normalizeRepoHostProvider maps openai to the repo-local responses host provider', () => {
  assert.equal(normalizeRepoHostProvider('openai'), HOST_OPENAI_PROVIDER)
})

test('normalizeRepoHostProvider maps codex to the ChatGPT subscription host provider', () => {
  assert.equal(normalizeRepoHostProvider('codex'), HOST_CODEX_PROVIDER)
})

test('openAiHostSupportsReasoningEffort is true for gpt-5 family and false for gpt-4o mini', () => {
  assert.equal(openAiHostSupportsReasoningEffort('gpt-5.4-mini'), true)
  assert.equal(openAiHostSupportsReasoningEffort('gpt-4o-mini'), false)
})

test('validateHostProviderReadiness requires OPENAI_API_KEY for repo-local openai host', () => {
  const original = process.env.OPENAI_API_KEY
  delete process.env.OPENAI_API_KEY

  try {
    assert.deepEqual(
      validateHostProviderReadiness('openai', 'gpt-5.4-mini'),
      ["Host provider 'openai' requires OPENAI_API_KEY."],
    )
  } finally {
    if (original === undefined) delete process.env.OPENAI_API_KEY
    else process.env.OPENAI_API_KEY = original
  }
})

test('validateLoadedAgentProviders rejects unknown providers', () => {
  const errors = validateLoadedAgentProviders([
    makeAgent({ name: 'alpha', provider: 'mystery-provider' }),
  ])

  assert.deepEqual(errors, [
    "Agent 'alpha' references unknown provider 'mystery-provider'. Known providers: anthropic, openai, xai, deepseek, kimi, openrouter, codex, claude, gemini, kimi-cli, qwen, pi, lm-studio",
  ])
})

test('a startup error names the selection failure, not an empty provider', () => {
  // The loader reports why no pair could be selected. Preflight is what turns
  // that into a startup error, and it has to carry the loader's reason: an
  // operator told the agent "references unknown provider ''" learns nothing
  // about the application default being unset.
  const errors = validateLoadedAgentProviders([
    makeAgent({
      name: 'reviewer',
      provider: '',
      model: '',
      selection: null,
      selectionError: {
        code: 'app-default-unset',
        message:
          'No application default model is selected. Choose one in Settings → AI Providers.',
      },
    }),
  ])

  assert.deepEqual(errors, [
    "Team cannot start: agent 'reviewer' has no model selected. " +
      'No application default model is selected. Choose one in Settings → AI Providers.',
  ])
})

test('an unavailable application default still names the broken pair', () => {
  const errors = validateLoadedAgentProviders([
    makeAgent({
      name: 'reviewer',
      provider: '',
      model: '',
      selection: null,
      selectionError: {
        code: 'app-default-unavailable',
        message: 'The application default model is unavailable: connection removed.',
        provider: 'connection:abc',
        model: 'gpt-5.4-mini',
      },
    }),
  ])

  assert.equal(errors.length, 1)
  assert.match(String(errors[0]), /connection removed/)
})

test("an agent's own invalid pair is reported as its own problem", () => {
  const errors = validateLoadedAgentProviders([
    makeAgent({
      name: 'reviewer',
      provider: '',
      model: '',
      selection: null,
      selectionError: {
        code: 'agent-model-without-provider',
        message:
          "Model 'gpt-5.4-mini' names no provider. Choose a provider and model together, or use the app default.",
        model: 'gpt-5.4-mini',
      },
    }),
  ])

  assert.deepEqual(errors, [
    "Team cannot start: agent 'reviewer' has no model selected. " +
      "Model 'gpt-5.4-mini' names no provider. Choose a provider and model together, or use the app default.",
  ])
})

test('an eligible model-readiness failure is deferred, not a startup error', () => {
  // Deferring is only worth doing when a deferred failure can actually become
  // an offer. That needs three things at once: the Agent's own explicit pair,
  // an adapter that refuses before sending anything, and a different pair to
  // be offered instead. Anthropic refuses a missing key before it builds the
  // request, so this failure reaches the user as a choice.
  withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
    withAppDefault({ provider: 'openrouter', model: 'openai/gpt-4o-mini' }, () => {
      const deferred = validateLoadedAgentProviders([
        makeAgent({
          name: 'reviewer',
          provider: 'anthropic',
          model: 'claude-sonnet-4-6',
          selection: {
            provider: 'anthropic',
            model: 'claude-sonnet-4-6',
            source: 'agent',
            reason: 'explicit-agent-choice',
          },
        }),
      ])

      assert.deepEqual(deferred, [])
    })
  })
})

test('a provider that cannot report an undispatched failure is not deferred', () => {
  // Pi's adapter rejects with a plain `Error`, so `classifyDispatchFailure`
  // records `dispatch_failed` with neither a kind nor `dispatched`. A run
  // started on its behalf produces a failure the evaluator can never turn into
  // an offer, and deferring would replace an actionable startup error with a
  // run that fails later and explains nothing. This is the rule the whole
  // deferral is bounded by, and Pi is the provider that still fails it.
  withoutAnyCliOnPath(() => {
    withAppDefault({ provider: 'openrouter', model: 'openai/gpt-4o-mini' }, () => {
      const errors = validateLoadedAgentProviders([
        makeAgent({
          name: 'reviewer',
          provider: 'pi',
          model: 'pi-default',
          selection: {
            provider: 'pi',
            model: 'pi-default',
            source: 'agent',
            reason: 'explicit-agent-choice',
          },
        }),
      ])

      assert.equal(errors.length, 1)
      assert.match(String(errors[0]), /Team cannot start/)
    })
  })
})

test('an Agent pinned to an uninstalled CLI is deferred rather than failing the Team', () => {
  // The bundled personas pin a provider on purpose — a critic on a reasoning
  // model, a router on a cheap one — and 80 of the 94 pin `codex` or `claude`.
  // Refusing the whole Team because one member's CLI is absent is the worst
  // first-run outcome the product has. The deferral is honest here for the
  // same three reasons it is honest for Anthropic: the pair is the Agent's
  // own, the adapter refuses at the spawn with `kind: 'configuration'` and
  // `dispatched: false` before anything is sent, and there is a different
  // available default to offer instead.
  withoutAnyCliOnPath(() => {
    withAppDefault({ provider: 'openrouter', model: 'openai/gpt-4o-mini' }, () => {
      for (const [provider, model] of [
        ['codex', 'gpt-5'],
        ['claude', 'sonnet'],
        ['gemini', 'gemini-2.5-pro'],
        ['kimi-cli', 'kimi-k2'],
        ['qwen', 'qwen3-coder'],
      ] as const) {
        assert.deepEqual(
          validateLoadedAgentProviders([
            makeAgent({
              name: 'critic',
              provider,
              model,
              selection: {
                provider,
                model,
                source: 'agent',
                reason: 'explicit-agent-choice',
              },
            }),
          ]),
          [],
          `${provider} should defer, not fail the Team`,
        )
      }
    })
  })
})

test('an Agent pinned to an API provider with no key is deferred too', () => {
  // Same rule, other half of the set: these refuse on the first statement of
  // `execute()`, before the request body exists.
  withEnv(
    {
      XAI_API_KEY: undefined,
      DEEPSEEK_API_KEY: undefined,
      MOONSHOT_API_KEY: undefined,
      KIMI_API_KEY: undefined,
    },
    () => {
      withAppDefault({ provider: 'openrouter', model: 'openai/gpt-4o-mini' }, () => {
        for (const [provider, model] of [
          ['xai', 'grok-4'],
          ['deepseek', 'deepseek-v4'],
          ['kimi', 'kimi-k2.6'],
        ] as const) {
          assert.deepEqual(
            validateLoadedAgentProviders([
              makeAgent({
                name: 'critic',
                provider,
                model,
                selection: {
                  provider,
                  model,
                  source: 'agent',
                  reason: 'explicit-agent-choice',
                },
              }),
            ]),
            [],
            `${provider} should defer, not fail the Team`,
          )
        }
      })
    },
  )
})

test('one Agent pinned to a missing CLI does not stop the Agents that can run', () => {
  // The defect this exists for: `initialize()` refuses on any entry in
  // `configErrors`, so a single unready pin took every other member of the
  // Team down with it.
  withoutAnyCliOnPath(() => {
    withAppDefault({ provider: 'openrouter', model: 'openai/gpt-4o-mini' }, () => {
      assert.deepEqual(
        validateLoadedAgentProviders([
          makeAgent({
            name: 'router',
            provider: 'lm-studio',
            model: 'local-model',
            selection: {
              provider: 'lm-studio',
              model: 'local-model',
              source: 'agent',
              reason: 'explicit-agent-choice',
            },
          }),
          makeAgent({
            name: 'critic',
            provider: 'codex',
            model: 'gpt-5',
            selection: {
              provider: 'codex',
              model: 'gpt-5',
              source: 'agent',
              reason: 'explicit-agent-choice',
            },
          }),
        ]),
        [],
      )
    })
  })
})

test('there is nothing to defer to without a different available default', () => {
  // Two ways the offer cannot exist. With no available application default
  // there is no second pair at all; with a default identical to the pair that
  // just failed, the offer would be to retry exactly what did not work.
  withEnv({ ANTHROPIC_API_KEY: undefined }, () => {
    const explicitAnthropic = makeAgent({
      name: 'reviewer',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      selection: {
        provider: 'anthropic',
        model: 'claude-sonnet-4-6',
        source: 'agent',
        reason: 'explicit-agent-choice',
      },
    })

    withAppDefault(null, () => {
      assert.equal(validateLoadedAgentProviders([explicitAnthropic]).length, 1)
    })
    withAppDefault({ provider: 'anthropic', model: 'claude-sonnet-4-6' }, () => {
      assert.equal(validateLoadedAgentProviders([explicitAnthropic]).length, 1)
    })
  })
})

test('an Agent inheriting an unusable default still fails at startup', () => {
  // Nothing to defer to: there is no other pair this Agent could be offered,
  // so letting the run start would only reach the same dead end later.
  const original = process.env.XAI_API_KEY
  delete process.env.XAI_API_KEY
  try {
    const errors = validateLoadedAgentProviders([
      makeAgent({
        name: 'reviewer',
        provider: 'xai',
        model: 'grok-4',
        selection: {
          provider: 'xai',
          model: 'grok-4',
          source: 'app-default',
          reason: 'agent-default',
        },
      }),
    ])

    assert.equal(errors.length, 1)
    assert.match(String(errors[0]), /Team cannot start/)
  } finally {
    if (original === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = original
  }
})

test('provider options the loader could not accept stop the run', () => {
  // The loader refuses malformed or credential-shaped provider options and
  // says why, but nothing acted on that: the Agent started with its options
  // silently dropped. A person who wrote a setting and saw it ignored has no
  // way to tell that from a setting the provider itself does not honour, and
  // an API key in an Agent file is worse than ignored — it is a credential in
  // the wrong place that nobody was told about.
  const withDiagnostic = (code: 'invalid-provider-options' | 'provider-options-credential', message: string) =>
    validateLoadedAgentProviders([
      makeAgent({
        name: 'reviewer',
        provider: 'openai',
        model: 'gpt-5.6-sol',
        selection: {
          provider: 'openai',
          model: 'gpt-5.6-sol',
          source: 'agent',
          reason: 'explicit-agent-choice',
        },
        selectionDiagnostics: [{ code, message }],
      }),
    ])

  const credential = withDiagnostic(
    'provider-options-credential',
    "'provider_options' names 'api_key'. Credentials belong in Settings, never in an agent file. All options are ignored.",
  )
  assert.equal(credential.length, 1)
  assert.match(String(credential[0]), /reviewer/)
  assert.match(String(credential[0]), /Credentials belong in Settings/)

  const malformed = withDiagnostic(
    'invalid-provider-options',
    "'provider_options' must be one JSON object of plain provider settings. It is ignored.",
  )
  assert.equal(malformed.length, 1)
  assert.match(String(malformed[0]), /plain provider settings/)
})

test('a diagnostic about the selection itself is not a provider-options refusal', () => {
  // Only the options refusals stop a run here. A note about how the model was
  // chosen is reported elsewhere and does not make the Agent unusable.
  assert.deepEqual(
    validateLoadedAgentProviders([
      makeAgent({
        name: 'reviewer',
        provider: 'openai',
        model: 'gpt-5.6-sol',
        selection: {
          provider: 'openai',
          model: 'gpt-5.6-sol',
          source: 'agent',
          reason: 'explicit-agent-choice',
        },
        selectionDiagnostics: [
          { code: 'legacy-default-sentinel', message: 'A legacy default sentinel was read.' },
        ],
      }),
    ]),
    [],
  )
})

test('configuration and ownership checks are not deferred', () => {
  // The deferral is narrow. An unknown provider, or a selection the loader
  // could not resolve at all, is not something a retry could fix.
  assert.equal(
    validateLoadedAgentProviders([
      makeAgent({ name: 'alpha', provider: 'mystery-provider' }),
    ]).length,
    1,
  )
  assert.equal(
    validateLoadedAgentProviders([
      makeAgent({
        name: 'alpha',
        provider: '',
        model: '',
        selection: null,
        selectionError: {
          code: 'app-default-unset',
          message: 'No application default model is selected.',
        },
      }),
    ]).length,
    1,
  )
})

test('validateLoadedAgentProviders requires XAI_API_KEY for xai agents', () => {
  const original = process.env.XAI_API_KEY
  delete process.env.XAI_API_KEY

  try {
    const errors = validateLoadedAgentProviders([
      makeAgent({ name: 'alpha', provider: 'xai' }),
    ])

    assert.deepEqual(errors, [
      "Team cannot start: agent 'alpha' cannot use provider 'xai': missing XAI_API_KEY",
    ])
  } finally {
    if (original === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = original
  }
})

test('validateLoadedAgentProviders requires DEEPSEEK_API_KEY for deepseek agents', () => {
  const original = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_API_KEY

  try {
    const errors = validateLoadedAgentProviders([
      makeAgent({ name: 'alpha', provider: 'deepseek' }),
    ])

    assert.deepEqual(errors, [
      "Team cannot start: agent 'alpha' cannot use provider 'deepseek': missing DEEPSEEK_API_KEY",
    ])
  } finally {
    if (original === undefined) delete process.env.DEEPSEEK_API_KEY
    else process.env.DEEPSEEK_API_KEY = original
  }
})

test('validateLoadedAgentProviders requires MOONSHOT_API_KEY or KIMI_API_KEY for kimi agents', () => {
  const originalMoonshot = process.env.MOONSHOT_API_KEY
  const originalKimi = process.env.KIMI_API_KEY
  delete process.env.MOONSHOT_API_KEY
  delete process.env.KIMI_API_KEY

  try {
    const errors = validateLoadedAgentProviders([
      makeAgent({ name: 'alpha', provider: 'kimi' }),
    ])

    assert.deepEqual(errors, [
      "Team cannot start: agent 'alpha' cannot use provider 'kimi': missing MOONSHOT_API_KEY or KIMI_API_KEY",
    ])
  } finally {
    if (originalMoonshot === undefined) delete process.env.MOONSHOT_API_KEY
    else process.env.MOONSHOT_API_KEY = originalMoonshot
    if (originalKimi === undefined) delete process.env.KIMI_API_KEY
    else process.env.KIMI_API_KEY = originalKimi
  }
})

/**
 * Why one refusal sentence is enough for a stage with no coordinator.
 *
 * `getCurrentCoordinator` returns nothing for two different stages: one that
 * names no coordinator, and one that names an agent the team does not have
 * (`team-runtime/index.ts:1172-1177`). Only the first can reach a tool call —
 * and this is the guard that makes that true. If it ever stops covering every
 * level, `runtime_owned_tool_denied` starts telling a reader with a misnamed
 * coordinator that there is "Nothing to change here", and this test is where
 * that is caught.
 */
test('a level whose declared coordinator never loaded stops the team before it starts', () => {
  const errors = validateDeclaredCoordinators({
    levels: [
      makeLevel('draft', 'writer'),
      // Not the entry level, and not the first: the guard has to read all of
      // them, because a run reaches later stages without booting again.
      makeLevel('review', 'audiotr'),
    ],
    loadedAgentNames: new Set(['writer']),
    personaPathFor: (agentName) =>
      agentName === 'audiotr' ? './agents/audiotr.md' : undefined,
  })

  assert.deepEqual(errors, [
    "Team cannot start: level 'review' declares coordinator 'audiotr', " +
    'which is not a loaded Agent. Its persona file is missing or unreadable: ' +
    './agents/audiotr.md.',
  ])
})

test('a level that names no coordinator at all is left to the runtime, not refused', () => {
  // The other half of the same distinction: a stage the runtime drives itself
  // is not a misconfiguration, so it must not be turned into one here.
  const errors = validateDeclaredCoordinators({
    levels: [makeLevel('assemble')],
    loadedAgentNames: new Set(['writer']),
  })

  assert.deepEqual(errors, [])
})

function makeLevel(id: string, coordinator?: string): LevelConfig {
  return {
    id,
    name: id,
    order: 0,
    stage: {
      type: STAGE_TYPE.CHAIN,
      ...(coordinator === undefined ? {} : { coordinator }),
      sequence: ['writer'],
      config: { output: { format: 'result.md', user_review: false } },
    },
  }
}
