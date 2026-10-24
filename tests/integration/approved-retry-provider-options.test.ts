/**
 * What an approved retry actually sends.
 *
 * Provider options belong to the provider an Agent chose. An approved retry may
 * land on a different one, whose API those settings do not describe, so §4.3
 * asks for them to be re-evaluated on the switch — and carrying them across is
 * not re-evaluating them.
 *
 * Asserted on the outbound request body rather than on anything the runtime
 * says about itself. A record claiming the options were dropped while the
 * request still carries them is exactly the failure this guards.
 */
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { initProviders } from '../../providers/index.js'
import { setConfiguredProviderConnections } from '../../providers/configured-provider.js'
import {
  dispatchToAgentOrTeam,
  runAgent,
} from '../../domains/agent-execution/agent-runner.js'
import { setRuntimeApprovedModelChoice } from '../../domains/provider/approved-model-choice.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import type { LoadedAgent, RuntimeState } from '../../core/types.js'

initProviders()

interface Loopback {
  readonly url: string
  readonly bodies: readonly Record<string, unknown>[]
  close(): Promise<void>
}

/** An OpenAI-compatible endpoint that records exactly what it was sent. */
async function startRecordingProvider(): Promise<Loopback> {
  const bodies: Record<string, unknown>[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.once('end', () => {
      try {
        bodies.push(
          JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        )
      } catch {
        bodies.push({})
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
      })
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: { content: 'Answered.' }, index: 0 }],
      })}\n\n`)
      res.write(`data: ${JSON.stringify({
        choices: [{ delta: {}, index: 0, finish_reason: 'stop' }],
      })}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Loopback provider did not bind')
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    get bodies() {
      return bodies
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

test('a provider option an Agent configures reaches its request, and an absent one does not', async () => {
  const provider = await startRecordingProvider()
  const connectionId = randomUUID()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Recording loopback',
      baseUrl: `${provider.url}/v1`,
      apiKey: 'recording-key',
    },
  ])
  const providerName = `connection:${connectionId}`
  try {
    // First: the Agent's own pair, with its own option. This has to arrive, or
    // the assertion below would pass for the wrong reason.
    await runAgent({
      systemPrompt: 'Answer.',
      userMessage: 'A question.',
      model: 'pinned-model',
      thinking: 'low',
      provider: providerName,
      tools: [],
      providerConfig: { max_tokens: 512 },
    })
    assert.equal(provider.bodies.length, 1)
    assert.equal(provider.bodies[0]?.model, 'pinned-model')
    assert.equal(
      provider.bodies[0]?.max_tokens,
      512,
      'the explicit path sends the option the Agent configured',
    )

    // The control for the assertion below: with no options supplied, none
    // appear. This test says nothing about approval — it establishes that the
    // endpoint can tell the two cases apart.
    await runAgent({
      systemPrompt: 'Answer.',
      userMessage: 'A question.',
      model: 'default-model',
      thinking: 'low',
      provider: providerName,
      tools: [],
    })
    assert.equal(provider.bodies.length, 2)
    assert.equal(provider.bodies[1]?.model, 'default-model')
    assert.equal(provider.bodies[1]?.max_tokens, undefined)
  } finally {
    setConfiguredProviderConnections([])
    await provider.close()
  }
})

function dispatchState(sessionId: string): RuntimeState {
  return {
    sessionId,
    currentLevelIndex: 0,
    levelStates: new Map(),
    totalCost: 0,
    startTime: 0,
    timerStarted: false,
    endTime: null,
    spawnDepth: 0,
  }
}

test('an approved retry keeps the options its approved provider applies, and names the rest', async () => {
  const provider = await startRecordingProvider()
  const connectionId = randomUUID()
  setConfiguredProviderConnections([
    {
      id: connectionId,
      kind: 'openai-compatible',
      name: 'Recording loopback',
      baseUrl: `${provider.url}/v1`,
      apiKey: 'recording-key',
    },
  ])
  const providerName = `connection:${connectionId}`
  setRuntimeDefaultModelState({
    status: 'available',
    provider: providerName,
    model: 'default-model',
  })
  setRuntimeApprovedModelChoice({
    offerId: 'offer-1',
    agentName: 'reviewer',
    logicalInvocationId: 'invocation-1',
    failedChoice: { provider: providerName, model: 'pinned-model' },
    proposedDefault: { provider: providerName, model: 'default-model' },
  })
  const outputPath = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'approved-retry-options-')),
  )
  const agent: LoadedAgent = {
    name: 'reviewer',
    model: 'pinned-model',
    thinking: 'low',
    tools: [],
    systemPrompt: 'Answer.',
    experienceContent: '',
    experienceEnabled: false,
    skillsContent: '',
    knowledgeContent: '',
    agentDir: '',
    color: 1,
    provider: providerName,
    // One setting this provider applies and one it has no field for. Dropping
    // both was the old behaviour, and it discarded a setting that would have
    // worked; carrying both would send Anthropic's field to a connection that
    // has never heard of it.
    providerConfig: { max_tokens: 512, thinking_budget: 2_048 },
    selection: {
      provider: providerName,
      model: 'pinned-model',
      source: 'agent',
      reason: 'explicit-agent-choice',
    },
  }
  try {
    // Awaited rather than swallowed: a dispatch that threw would otherwise
    // leave every assertion below describing a turn that never happened.
    const dispatched = await dispatchToAgentOrTeam({
      agent,
      rosterEntry: { type: 'agent' },
      finalPrompt: 'Answer.',
      userMessage: 'A question.',
      state: dispatchState('approved-retry-options-session'),
      // A directory this test owns. A dispatch writes its run log wherever it
      // is pointed, and pointing it at the checkout would leave runtime
      // evidence in the repository.
      workspacePath: outputPath,
      outputPath,
      metrics: undefined,
      logicalInvocationId: 'invocation-1',
    })

    // The turn answered, so what follows is about a completed dispatch rather
    // than about a failure that happened to write a record.
    assert.match(dispatched.text, /Answered\./, JSON.stringify(dispatched))
    assert.equal(provider.bodies.length, 1)
    // The approved pair ran…
    assert.equal(provider.bodies[0]?.model, 'default-model')
    // …carrying the setting this provider applies. §4.3 asks for options to be
    // re-evaluated, and dropping one the approved provider honours perfectly
    // well is not re-evaluating it — it silently changes how the retry answers.
    assert.equal(
      provider.bodies[0]?.max_tokens,
      512,
      'a setting the approved provider applies survived the switch',
    )

    // The setting it has no field for is dropped, and the run says so. That
    // disclosure is the load-bearing assertion: this adapter serialises only
    // `max_tokens` and `temperature`, so the field's absence from the body
    // would look identical whether the option was re-evaluated or carried.
    const records = fs
      .readFileSync(path.join(outputPath, 'logs', 'agent-runs.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>)
    // Selected by the identity the dispatch itself returned, so the records
    // asserted about are the ones this exact result belongs to rather than
    // whichever happened to be written first.
    assert.ok(dispatched.dispatchId, 'the dispatch named no attempt')
    const belongsToThisAttempt = (entry: Record<string, unknown>): boolean =>
      entry.dispatch_id === dispatched.dispatchId && entry.agent_name === 'reviewer'
    const started = records.find(
      (entry) => entry.event === 'start' && belongsToThisAttempt(entry),
    )
    assert.deepEqual(
      started?.dropped_provider_options,
      ['thinking_budget'],
      'a setting that stopped applying is named on the attempt, not left to inference',
    )

    // And on the record of how the attempt *ended*, which is the one a reader
    // of a finished run reaches for. The end event does not spread the start
    // record, so a switch that dropped a setting is only there if it is written
    // there — and this route reported no further drops of its own, which is
    // exactly the case that was being left out.
    const ended = records.find(
      (entry) => entry.event === 'end' && belongsToThisAttempt(entry),
    )
    assert.ok(ended, `no end record was written: ${JSON.stringify(records)}`)
    assert.equal(ended.status, 'completed', JSON.stringify(ended))
    assert.deepEqual(
      ended.dropped_provider_options,
      ['thinking_budget'],
      `the completed attempt does not say what the switch dropped: ${JSON.stringify(ended)}`,
    )
  } finally {
    setRuntimeApprovedModelChoice(undefined)
    setRuntimeDefaultModelState(undefined)
    setConfiguredProviderConnections([])
    await provider.close()
    // Only the directory this test made. A dispatch writes its run log here,
    // and leaving it behind would accumulate runtime evidence in the temp dir.
    fs.rmSync(outputPath, { recursive: true, force: true })
  }
})
