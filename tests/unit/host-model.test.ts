import test from 'node:test'
import assert from 'node:assert/strict'

import {
  getAvailableHostModels,
  hostModelSelectionRecord,
  resolveDesiredHostModel,
  selectHostModel,
} from '../../domains/provider/host-model.js'
import type { LoadedAgent, TeamRegistryEntry } from '../../core/types.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'

function makeCoordinator(overrides: Partial<LoadedAgent> = {}): LoadedAgent {
  return {
    name: 'receptionist',
    model: 'gpt-5.4-mini',
    thinking: 'high',
    systemPrompt: 'prompt',
    experienceContent: '',
    experienceEnabled: true,
    skillsContent: '',
    knowledgeContent: '',
    selection: null,
    agentDir: '/tmp',
    color: 1,
    provider: 'codex',
    providerConfig: {},
    ...overrides,
  }
}

test('a coordinator Agent that chose its own model outranks a registry host pin', () => {
  // This used to resolve the other way round. A registry host pin is a
  // Team-level model setting, and the whole point of the two-choice rule is
  // that a Team never decides a model: an Agent runs with its own pair or with
  // the one application default. With the registry winning, the host actually
  // ran on a pair that disagreed with both the Agent's choice and with the
  // provenance recorded for the coordinator.
  const bootEntry: TeamRegistryEntry = {
    name: 'reception-desk',
    type: 'team',
    team_path: '/tmp/reception-desk',
    host_model: 'gpt-5.4-mini',
    host_provider: 'codex',
  }

  assert.deepEqual(
    resolveDesiredHostModel(
      bootEntry,
      makeCoordinator({
        model: 'claude-opus-4-6',
        provider: 'anthropic',
        selection: {
          provider: 'anthropic',
          model: 'claude-opus-4-6',
          source: 'agent',
          reason: 'explicit-agent-choice',
        },
      }),
    ),
    {
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      source: 'coordinator',
    },
  )
})

test('a coordinator that chose nothing gets the application default, not a registry pin', () => {
  // Inheriting is not choosing. A coordinator whose pair came from the
  // application default has made no choice for the registry to defer to, and
  // the one pair anybody selected is that same default.
  const bootEntry: TeamRegistryEntry = {
    name: 'reception-desk',
    type: 'team',
    team_path: '/tmp/reception-desk',
    host_model: 'gpt-5.4-mini',
    host_provider: 'codex',
  }
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
  })
  try {
    assert.deepEqual(
      resolveDesiredHostModel(
        bootEntry,
        makeCoordinator({
          model: 'claude-opus-4-6',
          provider: 'anthropic',
          selection: {
            provider: 'anthropic',
            model: 'claude-opus-4-6',
            source: 'app-default',
            reason: 'agent-default',
          },
        }),
      ),
      {
        model: 'claude-opus-4-6',
        provider: 'anthropic',
        source: 'app-default',
      },
    )
  } finally {
    setRuntimeDefaultModelState(undefined)
  }
})

test('resolveDesiredHostModel uses the coordinator Agent\'s own pair', () => {
  const result = resolveDesiredHostModel(
    null,
    makeCoordinator({
      selection: {
        provider: 'codex',
        model: 'gpt-5.4-mini',
        source: 'agent',
        reason: 'explicit-agent-choice',
      },
    }),
  )
  assert.deepEqual(result, {
    model: 'gpt-5.4-mini',
    provider: 'codex',
    source: 'coordinator',
  })
})

test('an internal host with no Agent choice runs on the application default', () => {
  // The two-choice rule reaches the host process too. A coordinator that names
  // no model has made no choice, and the one thing left that anybody chose is
  // the application default. Returning nothing instead leaves the host on
  // whatever it happened to boot with, which is a model nobody selected and
  // which no record can explain.
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'anthropic',
    model: 'claude-opus-4-6',
  })
  try {
    assert.deepEqual(
      resolveDesiredHostModel(null, makeCoordinator({ model: '', provider: '' })),
      {
        model: 'claude-opus-4-6',
        provider: 'anthropic',
        source: 'app-default',
      },
    )
    // A coordinator that did choose still wins over the default.
    assert.equal(
      resolveDesiredHostModel(
        null,
        makeCoordinator({
          selection: {
            provider: 'codex',
            model: 'gpt-5.4-mini',
            source: 'agent',
            reason: 'explicit-agent-choice',
          },
        }),
      )?.source,
      'coordinator',
    )
  } finally {
    setRuntimeDefaultModelState(undefined)
  }
})

test('an internal host with no choice and no default asks for nothing', () => {
  // Nothing to fall back to. Naming a pair here would invent one.
  setRuntimeDefaultModelState({ status: 'unset' })
  try {
    assert.equal(
      resolveDesiredHostModel(null, makeCoordinator({ model: '', provider: '' })),
      null,
    )
  } finally {
    setRuntimeDefaultModelState(undefined)
  }
})

test('the host records how its own model was decided, in the same shape a worker does', () => {
  // The host process is a model use like any other, and a run has to be able to
  // say whether it ran on the application default. A pair without provenance
  // cannot answer that, and the host lifecycle events carried only the pair.
  assert.deepEqual(
    hostModelSelectionRecord({
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      source: 'coordinator',
    }),
    {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      source: 'agent',
      reason: 'explicit-agent-choice',
      caller: 'agent',
    },
  )
  assert.deepEqual(
    hostModelSelectionRecord({
      model: 'claude-opus-4-6',
      provider: 'anthropic',
      source: 'app-default',
    }),
    {
      provider: 'anthropic',
      model: 'claude-opus-4-6',
      source: 'app-default',
      reason: 'agent-default',
      caller: 'agent',
    },
  )
  // A spec with no provider names half a pair, and half a pair is not a record.
  assert.equal(
    hostModelSelectionRecord({ model: 'claude-opus-4-6', source: 'app-default' }),
    undefined,
  )
})

test('selectHostModel matches by model id when no provider is specified', () => {
  const result = selectHostModel(
    [
      { id: 'claude-opus-4-6', provider: 'anthropic' },
      { id: 'gpt-5.4-mini', provider: 'openai' },
    ],
    { model: 'gpt-5.4-mini', source: 'registry' },
  )

  assert.deepEqual(result, { id: 'gpt-5.4-mini', provider: 'openai' })
})

test('selectHostModel maps anthropic host lookups to anthropic-api', () => {
  const result = selectHostModel(
    [
      { id: 'claude-opus-4-6', provider: 'anthropic' },
      { id: 'claude-opus-4-6', provider: 'anthropic-api' },
    ],
    { model: 'claude-opus-4-6', provider: 'anthropic', source: 'registry' },
  )

  assert.deepEqual(result, { id: 'claude-opus-4-6', provider: 'anthropic-api' })
})

test('selectHostModel maps openai host lookups to the repo-local responses provider', () => {
  const result = selectHostModel(
    [
      { id: 'gpt-5.4-mini', provider: 'openai' },
      { id: 'gpt-5.4-mini', provider: 'openai-responses-api' },
    ],
    { model: 'gpt-5.4-mini', provider: 'openai', source: 'registry' },
  )

  assert.deepEqual(result, { id: 'gpt-5.4-mini', provider: 'openai-responses-api' })
})





test('getAvailableHostModels prefers getAvailable over getAll', () => {
  const result = getAvailableHostModels({
    getAvailable: () => [{ id: 'gpt-5.4-mini', provider: 'openai' }],
    getAll: () => [{ id: 'claude-opus-4-6', provider: 'anthropic' }],
  })

  assert.deepEqual(result, [{ id: 'gpt-5.4-mini', provider: 'openai' }])
})
