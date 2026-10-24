import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'

import { startApiServer, type StartedApiServer } from '../../server/api-server.js'
import { FileSystemRunStore } from '../../domains/run/run-store.js'
import { FileSystemSessionStore } from '../../domains/sessions/session-store.js'
import { createSchedulerFixture } from '../helpers/scheduler-fixture.js'
import { registerProvider } from '../../providers/registry.js'
import type { Provider } from '../../providers/types.js'
import { startFakeChatCompletionsServer } from '../support/fake-chat-completions-server.js'

/**
 * The context budget, observed through the real dispatch rather than by calling
 * the fitter directly.
 *
 * Every other test of this work exercises a module in isolation, and that is
 * exactly how a whole day's wiring went missing without a single test turning
 * red: `core/context-fit.ts` and `services/agent-chat-history.ts` stayed green
 * while nothing in the product imported them, and `services/agent-chat-service.ts`
 * quietly went back to its fixed forty-message slice. A unit test cannot see
 * that. This one posts a real message to a real session and reads the prompt the
 * provider was actually handed.
 *
 * So the assertions are deliberately about the live path: that a large window
 * carries more of the conversation than a small one, and that what a small
 * window leaves out is declared rather than silently dropped.
 */

const PROMPTS: string[] = []

function registerCapturingProvider(name: string): void {
  registerProvider(
    {
      name,
      async execute(options) {
        PROMPTS.push(options.userMessage)
        return {
          text: 'Noted.',
          cost: 0,
          durationMs: 1,
          inputTokens: 0,
          outputTokens: 0,
          contextTokens: 0,
          model: options.model,
        }
      },
    } satisfies Provider,
    { source: 'context-budget-live-path', trustClass: 'unknown' },
    { replaceExisting: true },
  )
}

registerCapturingProvider('anthropic')

function writeAgent(
  repoRootPath: string,
  name: string,
  provider: string,
  model: string,
  baseUrl?: string,
): void {
  const directory = path.join(repoRootPath, 'agents', name)
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, `${name}.md`),
    [
      '---',
      `name: ${name}`,
      `description: ${name} fixture.`,
      'tier: strategic',
      `provider: ${provider}`,
      `model: ${model}`,
      'thinking: low',
      ...(baseUrl ? [`provider_options: ${JSON.stringify({ base_url: baseUrl })}`] : []),
      '---',
      '',
      `# ${name}`,
      '',
    ].join('\n'),
    'utf8',
  )
}

/**
 * Long enough that the conversation cannot fit a 32k window.
 *
 * Sized deliberately: at roughly 1,100 bytes each these 120 messages are about
 * 37,000 estimated tokens, well past what a 32k model can be offered and well
 * inside what a million-token one can. A shorter seed fits both and the
 * comparison then passes while proving nothing, which is exactly how the first
 * version of this work shipped a vacuous spill-over test.
 */
const HISTORY_MESSAGES = 120

/** Post one question to `agentName` after a long conversation; return its prompt. */
async function promptAfterLongConversation(input: {
  agentName: string
  provider: string
  model: string
}): Promise<string> {
  const fixture = createSchedulerFixture('context-budget-live-')
  // LM Studio now receives baseline tools through the HTTP tool loop. Capture
  // that external boundary instead of replacing the unused direct adapter.
  const providerFixture = await startFakeChatCompletionsServer({ script: [{ content: 'Noted.' }] })
  writeAgent(fixture.repoRootPath, input.agentName, input.provider, input.model, providerFixture.url)
  const sessionStore = new FileSystemSessionStore(fixture.workspacePath)
  const runStore = new FileSystemRunStore(fixture.workspacePath)
  let server: StartedApiServer | undefined
  try {
    server = await startApiServer({
      store: runStore,
      launcher: {
        async startRun() {
          return { launched: true as const, pid: 0, cwd: '' }
        },
      },
      sessionStore,
      workspacePath: fixture.workspacePath,
      repoRootPath: fixture.repoRootPath,
      workflowsRegistryPath: fixture.workflowsRegistryPath,
    })
    const created = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Context budget' }),
    })
    assert.equal(created.status, 201)
    const { id } = (await created.json()) as { id: string }

    for (let index = 0; index < HISTORY_MESSAGES; index += 1) {
      await sessionStore.appendChatMessage(id, {
        id: `seed-${index}`,
        role: 'user',
        text: `Message ${index}. ${'some conversational detail '.repeat(40)}`,
        createdAt: new Date(Date.UTC(2026, 8, 1, 0, 0, index)).toISOString(),
      })
    }

    PROMPTS.length = 0
    const answered = await fetch(`${server.url}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'What did we say earlier?',
        target: { kind: 'agents', agentNames: [input.agentName] },
        turnId: randomUUID(),
      }),
    })
    assert.ok(
      answered.status < 400,
      `dispatch failed: ${answered.status} ${await answered.clone().text()}`,
    )
    const prompt = providerFixture.requests[0]?.userMessage ?? PROMPTS[0]
    assert.ok(prompt, 'the provider was never called')
    return prompt
  } finally {
    if (server) await server.close()
    await providerFixture.close()
    fixture.cleanup()
  }
}

const countMessages = (prompt: string): number =>
  (prompt.match(/Message \d+\./g) ?? []).length

test('the conversation a model receives is sized to the window it actually has', async () => {
  const large = await promptAfterLongConversation({
    agentName: 'bigmodel',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
  })
  const small = await promptAfterLongConversation({
    agentName: 'smallmodel',
    provider: 'lm-studio',
    model: 'local-7b',
  })

  const largeSeen = countMessages(large)
  const smallSeen = countMessages(small)

  // The behaviour the fixed slice could not express: the same session reaches a
  // million-token model and a 32k local one differently.
  assert.ok(
    largeSeen > smallSeen,
    `large window saw ${largeSeen} messages, small window saw ${smallSeen}`,
  )
  // And the large window must beat the forty-message slice this replaced,
  // otherwise the change is a regression however principled it is.
  assert.ok(
    largeSeen > 40,
    `large window saw only ${largeSeen} messages; the old fixed slice kept 40`,
  )
  // The newest exchange survives on any window.
  assert.ok(small.includes(`Message ${HISTORY_MESSAGES - 1}.`))
  assert.ok(large.includes(`Message ${HISTORY_MESSAGES - 1}.`))
})

test('a conversation that had to be cut says so in the prompt', async () => {
  // Almost every cut in this system was silent, which is how an answer built on
  // half the material came to look exactly like one built on all of it.
  const small = await promptAfterLongConversation({
    agentName: 'smallmodel2',
    provider: 'lm-studio',
    model: 'local-7b',
  })
  assert.match(small, /earlier messages? omitted to fit the context budget/)
})

test('the question is asked once, not twice', async () => {
  // The turn persists the user message before the speaker loop re-reads the
  // transcript, so without the filter the model reads the question under its
  // own heading and again as the last line of the quoted history.
  const prompt = await promptAfterLongConversation({
    agentName: 'bigmodel2',
    provider: 'anthropic',
    model: 'claude-sonnet-5',
  })
  const occurrences = prompt.split('What did we say earlier?').length - 1
  assert.equal(occurrences, 1, `the question appears ${occurrences} times`)
})

/**
 * A turn with more than one speaker, captured per speaker.
 *
 * Returns each speaker's prompt in dispatch order.
 */
async function promptsForMultiSpeakerTurn(agents: readonly {
  name: string
  provider: string
  model: string
}[]): Promise<string[]> {
  const fixture = createSchedulerFixture('context-budget-multi-')
  for (const agent of agents) {
    writeAgent(fixture.repoRootPath, agent.name, agent.provider, agent.model)
  }
  const sessionStore = new FileSystemSessionStore(fixture.workspacePath)
  const runStore = new FileSystemRunStore(fixture.workspacePath)
  let server: StartedApiServer | undefined
  try {
    server = await startApiServer({
      store: runStore,
      launcher: {
        async startRun() {
          return { launched: true as const, pid: 0, cwd: '' }
        },
      },
      sessionStore,
      workspacePath: fixture.workspacePath,
      repoRootPath: fixture.repoRootPath,
      workflowsRegistryPath: fixture.workflowsRegistryPath,
    })
    const created = await fetch(`${server.url}/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Multi speaker' }),
    })
    const { id } = (await created.json()) as { id: string }

    PROMPTS.length = 0
    const answered = await fetch(`${server.url}/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text: 'Both of you weigh in please.',
        target: { kind: 'agents', agentNames: agents.map((agent) => agent.name) },
        turnId: randomUUID(),
      }),
    })
    assert.ok(answered.status < 400, `dispatch failed: ${answered.status}`)
    return [...PROMPTS]
  } finally {
    if (server) await server.close()
    fixture.cleanup()
  }
}

test('a later speaker sees what the earlier speakers in its own turn said', async () => {
  // The trap this guards. The turn's own user message has to be kept out of the
  // quoted history, because it is already rendered under its own heading — but
  // every assistant reply in a multi-speaker turn carries the *same* turnId as
  // that user message. Filtering the turn instead of the message silently
  // deletes exactly the replies each later speaker is meant to read, and no
  // unit test can see it because the deletion happens in the dispatch loop.
  //
  // Every speakerOrdinal in the rest of the integration suite is 0, so nothing
  // else in the repo exercises a second speaker's prompt at all.
  const prompts = await promptsForMultiSpeakerTurn([
    { name: 'firstvoice', provider: 'anthropic', model: 'claude-sonnet-5' },
    { name: 'secondvoice', provider: 'anthropic', model: 'claude-sonnet-5' },
  ])

  assert.equal(prompts.length, 2, `expected two prompts, got ${prompts.length}`)
  const second = prompts[1] ?? ''
  assert.match(
    second,
    /Noted\./,
    "the second speaker's prompt does not contain the first speaker's reply",
  )
  // And the user's question is still asked exactly once, not once per speaker.
  assert.equal(second.split('Both of you weigh in please.').length - 1, 1)
})

/*
 * NOT YET COVERED: the file budget on the live path.
 *
 * `resolveChatFileBudget` is unit tested and is called from the dispatch, but
 * asserting it end to end means getting parsed text into the prompt, and
 * `buildSessionChatFileContext` reads `file.outputs.text` — a parser output —
 * rather than the uploaded bytes. Seeding that needs the file-parse pipeline or
 * a hand-built repository layout, which is a larger fixture than this returns
 * today.
 *
 * Recorded rather than approximated. A test that uploaded a file and asserted
 * something weaker would read like live coverage and provide none, which is the
 * failure mode this whole file exists to prevent.
 */
