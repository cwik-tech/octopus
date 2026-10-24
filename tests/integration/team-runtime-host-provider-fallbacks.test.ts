/**
 * The API-key host fallbacks reach Pi as references to an environment
 * variable, never as the key.
 *
 * Pi resolves an `apiKey` that starts with `$` from its own environment when it
 * sends a request. A config holding the literal key would put the secret into
 * every place Pi keeps or reports provider configs.
 *
 * When each fallback is registered:
 *  - Anthropic (`anthropic-api`): for any host pair, when ANTHROPIC_API_KEY is
 *    set and Pi's registry already lists built-in `anthropic` models.
 *  - OpenAI Responses (`openai-responses-api`): only for an `openai` host,
 *    when OPENAI_API_KEY is set.
 *
 * The Codex subscription (`openai-codex`) is registered only for a `codex`
 * host, and it is the one registration that carries a credential itself: the
 * ChatGPT login token read from `$CODEX_HOME/auth.json`.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  ASSIGNMENT_LOG,
  bootFixtureRuntime,
  findFilesContaining,
  FIXTURE_HOST_MODEL_ID,
  FIXTURE_HOST_PROVIDER,
  type ProviderRegistration,
} from '../support/team-runtime-fixture-boot.js'

const ANTHROPIC_SECRET = 'sk-ant-fixture-secret-must-not-reach-pi'
const OPENAI_SECRET = 'sk-openai-fixture-secret-must-not-reach-pi'
const OPENAI_FIXTURE_BASE_URL = 'https://openai.fixture.invalid/v1'

const BUILT_IN_ANTHROPIC_MODEL = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  provider: 'anthropic',
  api: 'anthropic-messages',
  reasoning: true,
  input: ['text'],
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  contextWindow: 200_000,
  maxTokens: 64_000,
}

function pick(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return {}
  return Object.fromEntries(keys.map((key) => [key, Reflect.get(value, key)]))
}

function modelIds(config: unknown): unknown[] {
  const models = pick(config, ['models']).models
  return Array.isArray(models) ? models.map((model: unknown) => pick(model, ['id']).id) : []
}

function assertNoSecret(registrations: readonly ProviderRegistration[]): void {
  const serialized = JSON.stringify(registrations)
  for (const secret of [ANTHROPIC_SECRET, OPENAI_SECRET]) {
    assert.equal(
      serialized.includes(secret),
      false,
      'a key value must never reach a provider registration',
    )
  }
}

test('the Anthropic API fallback is registered with a reference to ANTHROPIC_API_KEY, never the key', {
  timeout: 60_000,
}, async () => {
  const runtime = await bootFixtureRuntime({
    label: 'anthropic-fallback',
    team: { coordinator: { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] } },
    env: { ANTHROPIC_API_KEY: ANTHROPIC_SECRET, OPENAI_API_KEY: OPENAI_SECRET },
    hostModels: [BUILT_IN_ANTHROPIC_MODEL],
  })
  try {
    const registrations = runtime.host.providerRegistrations
    // The host is on lm-studio, so the OpenAI fallback has no reason to exist.
    assert.deepEqual(registrations.map((registration) => registration.name), ['anthropic-api'])
    const config = registrations[0]?.config
    assert.deepEqual(pick(config, ['baseUrl', 'apiKey', 'api']), {
      baseUrl: 'https://api.anthropic.com',
      apiKey: '$ANTHROPIC_API_KEY',
      api: 'anthropic-messages',
    })
    assert.deepEqual(modelIds(config), [BUILT_IN_ANTHROPIC_MODEL.id])
    assertNoSecret(registrations)

    // Registering the fallback does not move the host off its own pair.
    assert.deepEqual(
      runtime.host.hostModelSwitches.map((model) => `${model.provider}:${model.id}`),
      [`${FIXTURE_HOST_PROVIDER}:${FIXTURE_HOST_MODEL_ID}`],
    )
  } finally {
    await runtime.close()
  }
})

test('an openai host registers the OpenAI Responses fallback with a reference to OPENAI_API_KEY, never the key', {
  timeout: 60_000,
}, async () => {
  const runtime = await bootFixtureRuntime({
    label: 'openai-fallback',
    team: {
      coordinator: {
        name: 'intake-agent',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        tools: ['spawn_team', 'inspect-task-state'],
      },
    },
    // No built-in anthropic models are listed, so the Anthropic fallback is
    // not registered even with its key set.
    env: {
      ANTHROPIC_API_KEY: ANTHROPIC_SECRET,
      OPENAI_API_KEY: OPENAI_SECRET,
      OPENAI_BASE_URL: OPENAI_FIXTURE_BASE_URL,
    },
  })
  try {
    const registrations = runtime.host.providerRegistrations
    assert.deepEqual(
      registrations.map((registration) => registration.name),
      ['openai-responses-api'],
      `notices: ${JSON.stringify(runtime.host.notifications)}`,
    )
    const config = registrations[0]?.config
    assert.deepEqual(pick(config, ['baseUrl', 'apiKey', 'api']), {
      baseUrl: OPENAI_FIXTURE_BASE_URL,
      apiKey: '$OPENAI_API_KEY',
      api: 'openai-responses',
    })
    assert.deepEqual(modelIds(config), ['gpt-5.4-mini'])
    assertNoSecret(registrations)

    // The host lands on the model the fallback made available.
    assert.deepEqual(
      runtime.host.hostModelSwitches.map((model) => `${model.provider}:${model.id}`),
      ['openai-responses-api:gpt-5.4-mini'],
    )
  } finally {
    await runtime.close()
  }
})

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

/** A second built-in with a `compat` block and a field the fallback does not copy. */
const BUILT_IN_ANTHROPIC_HAIKU = {
  id: 'claude-haiku-4-5',
  name: 'Claude Haiku 4.5',
  provider: 'anthropic',
  api: 'anthropic-messages',
  baseUrl: 'https://api.anthropic.com',
  reasoning: false,
  input: ['text', 'image'],
  cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  contextWindow: 200_000,
  maxTokens: 32_000,
  compat: { supportsEagerToolInputStreaming: false },
}

test('an anthropic host lands on the Anthropic API fallback, which copies each built-in anthropic model and sends the anthropic-version header', {
  timeout: 60_000,
}, async () => {
  const runtime = await bootFixtureRuntime({
    label: 'anthropic-host',
    team: {
      coordinator: {
        name: 'intake-agent',
        provider: 'anthropic',
        model: BUILT_IN_ANTHROPIC_MODEL.id,
        tools: ['spawn_team', 'inspect-task-state'],
      },
    },
    env: { ANTHROPIC_API_KEY: ANTHROPIC_SECRET },
    hostModels: [BUILT_IN_ANTHROPIC_MODEL, BUILT_IN_ANTHROPIC_HAIKU],
  })
  try {
    const registrations = runtime.host.providerRegistrations
    assert.deepEqual(
      registrations.map((registration) => registration.name),
      ['anthropic-api'],
      `notices: ${JSON.stringify(runtime.host.notifications)}`,
    )
    // Only the built-in `anthropic` models, copied field by field. No
    // `provider`, no `baseUrl`, and `compat` only where the built-in has one.
    assert.deepEqual(registrations[0]?.config, {
      baseUrl: 'https://api.anthropic.com',
      apiKey: '$ANTHROPIC_API_KEY',
      api: 'anthropic-messages',
      headers: { 'anthropic-version': '2023-06-01' },
      models: [
        {
          id: 'claude-sonnet-4-6',
          name: 'Claude Sonnet 4.6',
          api: 'anthropic-messages',
          reasoning: true,
          input: ['text'],
          cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          contextWindow: 200_000,
          maxTokens: 64_000,
        },
        {
          id: 'claude-haiku-4-5',
          name: 'Claude Haiku 4.5',
          api: 'anthropic-messages',
          reasoning: false,
          input: ['text', 'image'],
          cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
          contextWindow: 200_000,
          maxTokens: 32_000,
          compat: { supportsEagerToolInputStreaming: false },
        },
      ],
    })
    assertNoSecret(registrations)

    // The declared `anthropic` pair is found under the fallback's provider name.
    assert.deepEqual(
      runtime.host.hostModelSwitches.map((model) => `${model.provider}:${model.id}`),
      ['anthropic-api:claude-sonnet-4-6'],
    )
  } finally {
    await runtime.close()
  }
})

test('an openai host outside the gpt-5 and o-series families registers without reasoning effort, against api.openai.com when OPENAI_BASE_URL is blank', {
  timeout: 60_000,
}, async () => {
  const runtime = await bootFixtureRuntime({
    label: 'openai-default-base-url',
    team: {
      coordinator: {
        name: 'intake-agent',
        provider: 'openai',
        model: 'gpt-4.1-mini',
        tools: ['spawn_team', 'inspect-task-state'],
      },
    },
    env: { OPENAI_API_KEY: OPENAI_SECRET, OPENAI_BASE_URL: '   ' },
  })
  try {
    const registrations = runtime.host.providerRegistrations
    assert.deepEqual(
      registrations.map((registration) => registration.name),
      ['openai-responses-api'],
      `notices: ${JSON.stringify(runtime.host.notifications)}`,
    )
    assert.deepEqual(registrations[0]?.config, {
      baseUrl: 'https://api.openai.com/v1',
      apiKey: '$OPENAI_API_KEY',
      api: 'openai-responses',
      models: [
        {
          id: 'gpt-4.1-mini',
          name: 'gpt-4.1-mini',
          api: 'openai-responses',
          reasoning: false,
          input: ['text'],
          cost: ZERO_COST,
          contextWindow: 400_000,
          maxTokens: 32_768,
          compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
        },
      ],
    })
    assert.deepEqual(
      runtime.host.hostModelSwitches.map((model) => `${model.provider}:${model.id}`),
      ['openai-responses-api:gpt-4.1-mini'],
    )
  } finally {
    await runtime.close()
  }
})

test('an o-series openai host registers with reasoning effort, against OPENAI_BASE_URL with its surrounding whitespace removed', {
  timeout: 60_000,
}, async () => {
  const runtime = await bootFixtureRuntime({
    label: 'openai-o-series',
    team: {
      coordinator: {
        name: 'intake-agent',
        provider: 'openai',
        model: 'o4-mini',
        tools: ['spawn_team', 'inspect-task-state'],
      },
    },
    env: { OPENAI_API_KEY: OPENAI_SECRET, OPENAI_BASE_URL: `  ${OPENAI_FIXTURE_BASE_URL}\n` },
  })
  try {
    const registrations = runtime.host.providerRegistrations
    assert.deepEqual(
      registrations.map((registration) => registration.name),
      ['openai-responses-api'],
      `notices: ${JSON.stringify(runtime.host.notifications)}`,
    )
    assert.deepEqual(registrations[0]?.config, {
      baseUrl: OPENAI_FIXTURE_BASE_URL,
      apiKey: '$OPENAI_API_KEY',
      api: 'openai-responses',
      models: [
        {
          id: 'o4-mini',
          name: 'o4-mini',
          api: 'openai-responses',
          reasoning: true,
          input: ['text'],
          cost: ZERO_COST,
          contextWindow: 400_000,
          maxTokens: 32_768,
          compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
        },
      ],
    })
    assert.deepEqual(
      runtime.host.hostModelSwitches.map((model) => `${model.provider}:${model.id}`),
      ['openai-responses-api:o4-mini'],
    )
  } finally {
    await runtime.close()
  }
})

const CODEX_ACCESS_TOKEN = 'fixture-chatgpt-subscription-token'

/** Models Pi lists under its own `openai-codex` provider. */
const CODEX_SUBSCRIPTION_MODELS = [
  {
    id: 'gpt-5.4-mini',
    name: 'GPT-5.4 mini',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  },
  {
    id: 'gpt-5.5',
    name: 'GPT-5.5',
    provider: 'openai-codex',
    api: 'openai-codex-responses',
    baseUrl: 'https://chatgpt.com/backend-api',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 },
    contextWindow: 272_000,
    maxTokens: 128_000,
  },
]

interface CodexLogin {
  /** PATH holding only the fake CLI, and CODEX_HOME holding the login. */
  readonly env: Readonly<Record<string, string>>
  dispose(): void
}

/**
 * A `codex` executable and a ChatGPT subscription login, both fakes.
 *
 * Host readiness looks for an executable named `codex` on PATH and reads
 * `auth.json` from CODEX_HOME. Nothing in these boots runs the executable; it
 * exits 1 if anything does. `loggedIn: false` leaves CODEX_HOME empty.
 */
function fakeCodexLogin(options: { readonly loggedIn?: boolean } = {}): CodexLogin {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-login-'))
  const bin = path.join(root, 'bin')
  const home = path.join(root, 'home')
  fs.mkdirSync(bin)
  fs.mkdirSync(home)
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  if (options.loggedIn !== false) {
    fs.writeFileSync(
      path.join(home, 'auth.json'),
      JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: CODEX_ACCESS_TOKEN } }),
    )
  }
  return {
    env: { PATH: bin, PIPELINE_CLI_PATH_FALLBACK: '0', CODEX_HOME: home },
    dispose: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

const CODEX_COORDINATOR = {
  name: 'intake-agent',
  provider: 'codex',
  model: 'gpt-5.4-mini',
  tools: ['spawn_team', 'inspect-task-state'],
}

test('a codex host registers the ChatGPT subscription with the login token and zero-cost subscription models, and switches to it', {
  timeout: 60_000,
}, async () => {
  const login = fakeCodexLogin()
  try {
    const runtime = await bootFixtureRuntime({
      label: 'codex-subscription',
      team: { coordinator: CODEX_COORDINATOR },
      env: login.env,
      hostModels: CODEX_SUBSCRIPTION_MODELS,
    })
    try {
      const registrations = runtime.host.providerRegistrations
      assert.deepEqual(
        registrations.map((registration) => registration.name),
        ['openai-codex'],
        `notices: ${JSON.stringify(runtime.host.notifications)}`,
      )
      // Every `openai-codex` model Pi lists, whole, with its cost set to zero.
      // The fixture's own lm-studio model is not among them.
      assert.deepEqual(registrations[0]?.config, {
        baseUrl: 'https://chatgpt.com/backend-api',
        apiKey: CODEX_ACCESS_TOKEN,
        api: 'openai-codex-responses',
        models: [
          {
            id: 'gpt-5.4-mini',
            name: 'GPT-5.4 mini',
            provider: 'openai-codex',
            api: 'openai-codex-responses',
            baseUrl: 'https://chatgpt.com/backend-api',
            reasoning: true,
            input: ['text', 'image'],
            cost: ZERO_COST,
            contextWindow: 272_000,
            maxTokens: 128_000,
          },
          {
            id: 'gpt-5.5',
            name: 'GPT-5.5',
            provider: 'openai-codex',
            api: 'openai-codex-responses',
            baseUrl: 'https://chatgpt.com/backend-api',
            reasoning: true,
            input: ['text', 'image'],
            cost: ZERO_COST,
            contextWindow: 272_000,
            maxTokens: 128_000,
          },
        ],
      })
      assert.deepEqual(
        runtime.host.hostModelSwitches.map((model) => `${model.provider}:${model.id}`),
        ['openai-codex:gpt-5.4-mini'],
      )
      // The token goes to Pi and nowhere else the run writes.
      assert.deepEqual(findFilesContaining(runtime.root, CODEX_ACCESS_TOKEN), [])
    } finally {
      await runtime.close()
    }
  } finally {
    login.dispose()
  }
})

test('a codex host whose Pi lists no subscription models still registers the subscription, then stops on one config error', {
  timeout: 60_000,
}, async () => {
  const login = fakeCodexLogin()
  try {
    const runtime = await bootFixtureRuntime({
      label: 'codex-no-subscription-models',
      team: { coordinator: CODEX_COORDINATOR },
      env: login.env,
    })
    try {
      assert.deepEqual(runtime.host.providerRegistrations, [
        {
          name: 'openai-codex',
          config: {
            baseUrl: 'https://chatgpt.com/backend-api',
            apiKey: CODEX_ACCESS_TOKEN,
            api: 'openai-codex-responses',
            models: [],
          },
        },
      ])
      assert.deepEqual(runtime.host.hostModelSwitches, [], 'no host model may be selected')

      const configErrors = runtime
        .readAssignmentJsonl(ASSIGNMENT_LOG.runtimeEvents)
        .filter((record) => record.event === 'runtime.config_error')
        .map((record) => record.errors)
      assert.deepEqual(configErrors, [
        [
          "Configured host model 'gpt-5.4-mini' on provider 'codex' was not found in Pi's host model registry. " +
            `Team execution is blocked. Available: ${FIXTURE_HOST_PROVIDER}:${FIXTURE_HOST_MODEL_ID}`,
        ],
      ])
      assert.equal(
        runtime.host.notifications.filter((notice) => notice.level === 'error').length,
        1,
        `told once; got ${JSON.stringify(runtime.host.notifications)}`,
      )
      assert.deepEqual(
        await runtime.host.callHandler('input', { type: 'input', text: 'Start.', source: 'interactive' }),
        { action: 'handled' },
      )
    } finally {
      await runtime.close()
    }
  } finally {
    login.dispose()
  }
})

test('a later codex level whose ChatGPT login is missing makes host selection throw at the gate: the subscription is not registered and nothing is recorded as blocked', {
  timeout: 60_000,
}, async () => {
  // The Agent check at boot needs only the CLI on PATH, and the host check at
  // boot covers the entry level alone, so this Team boots on lm-studio. The
  // login is first read when the gate advances to the codex level.
  const login = fakeCodexLogin({ loggedIn: false })
  try {
    const runtime = await bootFixtureRuntime({
      label: 'codex-login-missing-at-gate',
      team: {
        coordinator: { name: 'intake-agent', tools: ['spawn_team', 'inspect-task-state'] },
        laterLevels: [
          { id: 'review', coordinator: { name: 'review-lead', provider: 'codex', model: 'gpt-5.4-mini' } },
        ],
      },
      env: { ...login.env, ANTHROPIC_API_KEY: ANTHROPIC_SECRET },
      hostModels: [BUILT_IN_ANTHROPIC_MODEL, ...CODEX_SUBSCRIPTION_MODELS],
    })
    try {
      assert.deepEqual(
        runtime.host.providerRegistrations.map((registration) => registration.name),
        ['anthropic-api'],
        `precondition: the entry level booted; notices: ${JSON.stringify(runtime.host.notifications)}`,
      )
      const selectionRecordsAtBoot = runtime
        .readAssignmentJsonl(ASSIGNMENT_LOG.hostEvents)
        .filter((record) => String(record.event).startsWith('host.model_selection.'))

      // Satisfy the intake gate with no turn in flight.
      fs.writeFileSync(path.join(runtime.assignmentPath, 'routing-decision.md'), 'Route to review.')
      await runtime.host.callHandler('tool_execution_end', {
        toolName: 'write',
        toolCallId: 'tool-gate-1',
        isError: false,
      })

      assert.ok(
        runtime.host.notifications.some((notice) => notice.message.includes('Level advanced')),
        `precondition: the gate advanced; notices: ${JSON.stringify(runtime.host.notifications)}`,
      )
      // Host selection ran for the codex level: the Anthropic fallback is
      // registered a second time, and it stopped before the subscription.
      assert.deepEqual(
        runtime.host.providerRegistrations.map((registration) => registration.name),
        ['anthropic-api', 'anthropic-api'],
      )
      assert.deepEqual(
        runtime.host.hostModelSwitches.map((model) => `${model.provider}:${model.id}`),
        [`${FIXTURE_HOST_PROVIDER}:${FIXTURE_HOST_MODEL_ID}`],
        'only the entry level switched the host',
      )
      // The error left host selection as a throw, not as a blocked selection.
      assert.deepEqual(
        runtime
          .readAssignmentJsonl(ASSIGNMENT_LOG.hostEvents)
          .filter((record) => String(record.event).startsWith('host.model_selection.')),
        selectionRecordsAtBoot,
        'no selection record is written for the codex level',
      )
      assert.deepEqual(
        runtime
          .readAssignmentJsonl(ASSIGNMENT_LOG.runtimeEvents)
          .filter((record) => record.event === 'runtime.config_error'),
        [],
        'no config error is recorded',
      )
    } finally {
      await runtime.close()
    }
  } finally {
    login.dispose()
  }
})

test('the OpenAI Responses fallback reads OPENAI_BASE_URL at session start, not when the extension is loaded', {
  timeout: 60_000,
}, async () => {
  const runtime = await bootFixtureRuntime({
    label: 'openai-base-url-read-at-start',
    team: {
      coordinator: {
        name: 'intake-agent',
        provider: 'openai',
        model: 'gpt-5.4-mini',
        tools: ['spawn_team', 'inspect-task-state'],
      },
    },
    env: { OPENAI_API_KEY: OPENAI_SECRET, OPENAI_BASE_URL: 'https://loaded.fixture.invalid/v1' },
    startSession: false,
  })
  try {
    // The extension is loaded. The value changes before the session starts;
    // `close` restores the environment.
    process.env.OPENAI_BASE_URL = OPENAI_FIXTURE_BASE_URL
    await runtime.startSession()

    assert.deepEqual(
      runtime.host.providerRegistrations.map((registration) => [
        registration.name,
        pick(registration.config, ['baseUrl']).baseUrl,
      ]),
      [['openai-responses-api', OPENAI_FIXTURE_BASE_URL]],
      `notices: ${JSON.stringify(runtime.host.notifications)}`,
    )
  } finally {
    await runtime.close()
  }
})
