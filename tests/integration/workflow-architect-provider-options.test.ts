/**
 * The Workflow Architect is an Agent, and §4.3 gives an Agent its own settings.
 *
 * Its configuration reader returned only a pair and a prompt body, so a
 * `thinking` level or a `provider_options` block in its agent file reached
 * nothing — the request went out without them, and a person who had configured
 * one had no way to tell that from a provider ignoring it. The Agent and Team
 * Architect already does this; the two Architects read the same frontmatter and
 * should not disagree about what it means.
 *
 * Asserted against the bodies the provider actually received, because that is
 * the only place the difference exists. Both attempts are checked: a repair is
 * the same turn asking again, so it runs on the same settings as the first.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { runGeneratorTurn } from '../../domains/workflow-generator/generator-llm.js'
import { initProviders } from '../../providers/index.js'
import { setRuntimeDefaultModelState } from '../../domains/provider/default-model-selection.js'
import type { WorkflowGeneratorRegistry } from '../../contracts/workflow-generator.js'

/** An empty registry: this turn is about settings, not about what it can build. */
const REGISTRY: WorkflowGeneratorRegistry = { teams: [] }

/**
 * The answer ceiling every helper request carries.
 *
 * `model-client.ts:1091-1097` always writes one, defaulting to 6000, so a test
 * that expected the field to be absent would be describing a request this code
 * never sends. Pinned to a literal here so an assertion can name it.
 */
const CEILING = '5000'

/** A valid architect reply, and one that forces the repair attempt. */
const VALID_TURN = JSON.stringify({
  message: 'Here is the plan.',
  workflow: null,
})
const NOT_JSON = 'This is prose, not an object.'

interface Harness {
  readonly repoRoot: string
  readonly bodies: Record<string, unknown>[]
  readonly requestCount: () => number
}

async function withArchitect(
  responses: readonly string[],
  frontmatter: readonly string[],
  run: (harness: Harness) => Promise<void>,
  /** Which vendor's wire format this Architect's pair speaks. */
  wire: 'chat-completions' | 'anthropic-messages' | 'deepseek-chat-completions' = 'chat-completions',
  /**
   * The operator's answer ceiling.
   *
   * `null` leaves `WORKFLOW_GENERATOR_MAX_TOKENS` unset, which is the only way
   * to see what a request carries when nobody has set one — and that is exactly
   * where a declared thinking level's own default ceiling has to come from.
   */
  environmentCeiling: string | null = CEILING,
): Promise<void> {
  const repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-architect-options-')),
  )
  fs.mkdirSync(path.join(repoRoot, 'teams', 'workflow-architect'), {
    recursive: true,
  })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'workflow-architect'), {
    recursive: true,
  })
  fs.writeFileSync(
    path.join(repoRoot, 'teams', 'workflow-architect', 'team.yaml'),
    ['agents:', '  - agent_file: ../../agents/workflow-architect/workflow-architect.md', ''].join('\n'),
  )
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'workflow-architect', 'workflow-architect.md'),
    ['---', ...frontmatter, '---', '', 'Design workflows.', ''].join('\n'),
  )

  const bodies: Record<string, unknown>[] = []
  let served = 0
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk as Buffer)
    try {
      bodies.push(
        JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
          string,
          unknown
        >,
      )
    } catch {
      // A body this test cannot read is still a request that was made.
    }
    const content = responses[Math.min(served, responses.length - 1)] ?? ''
    served += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(
      wire === 'anthropic-messages'
        ? {
            model: 'test-model',
            content: [{ type: 'text', text: content }],
            usage: { input_tokens: 1, output_tokens: 1 },
          }
        : { model: 'test-model', choices: [{ message: { content } }] },
    ))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address === 'object')

  // Each vendor's own override, so the request reaching the loopback is the one
  // that vendor's code path builds — not a shape borrowed from another.
  const urlVariable =
    wire === 'anthropic-messages'
      ? 'WORKFLOW_GENERATOR_API_URL'
      : wire === 'deepseek-chat-completions'
        ? 'WORKFLOW_GENERATOR_DEEPSEEK_API_URL'
        : 'WORKFLOW_GENERATOR_OPENAI_API_URL'
  const keyVariable =
    wire === 'anthropic-messages'
      ? 'ANTHROPIC_API_KEY'
      : wire === 'deepseek-chat-completions'
        ? 'DEEPSEEK_API_KEY'
        : 'OPENAI_API_KEY'
  const previous = {
    key: process.env[keyVariable],
    url: process.env[urlVariable],
    ceiling: process.env.WORKFLOW_GENERATOR_MAX_TOKENS,
  }
  process.env[keyVariable] = 'test-key'
  process.env[urlVariable] = `http://127.0.0.1:${address.port}/v1/messages`
  if (environmentCeiling === null) delete process.env.WORKFLOW_GENERATOR_MAX_TOKENS
  else process.env.WORKFLOW_GENERATOR_MAX_TOKENS = environmentCeiling
  try {
    await run({ repoRoot, bodies, requestCount: () => served })
  } finally {
    for (const [name, value] of [
      [keyVariable, previous.key],
      [urlVariable, previous.url],
      ['WORKFLOW_GENERATOR_MAX_TOKENS', previous.ceiling],
    ] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(repoRoot, { recursive: true, force: true })
  }
}

test('the Architect’s own settings reach the request, on the first attempt and the repair', async () => {
  // Only `provider_options` is asserted here, and deliberately.
  // `callModel` forwards `thinking` to the CLI adapter alone
  // (`domains/provider/model-client.ts:766`); neither HTTP body reads it, so an
  // assertion about a reasoning effort on this route would be describing a
  // field nothing writes. The level is still passed — it is what a CLI-hosted
  // Architect runs on — and that transport limitation is recorded in the phase
  // plan rather than papered over with a test that proves nothing.
  await withArchitect(
    [NOT_JSON, VALID_TURN],
    [
      'provider: openai',
      'model: test-model',
      'thinking: high',
      `provider_options: '${JSON.stringify({ max_tokens: 4096 })}'`,
    ],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies.length, 2, 'the repair attempt ran')
      for (const [index, body] of bodies.entries()) {
        // The exact field this endpoint uses, and the absence of the other.
        // Coalescing the two would hide a setting written into the wrong one.
        assert.equal(
          body.max_completion_tokens,
          4096,
          `attempt ${index + 1} carries the Agent's own setting`,
        )
        assert.equal(body.max_tokens, undefined)
      }
    },
  )
})

test('a successful repair still says how its model was chosen', async () => {
  // The repair is the same turn asking again, so it ran on the same pair. A
  // result that dropped the selection would leave the one attempt that
  // succeeded unable to say whether it used the application default.
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'openai',
    model: 'test-model',
  })
  try {
    await withArchitect(
      [NOT_JSON, VALID_TURN],
      ['thinking: low'],
      async ({ repoRoot }) => {
        const result = await runGeneratorTurn({
          history: [{ role: 'user', text: 'Design something.' }],
          currentDraft: null,
          repoRoot,
          registry: REGISTRY,
        })

        assert.equal(result.fallback, false, JSON.stringify(result))
        assert.deepEqual(result.selection, {
          provider: 'openai',
          model: 'test-model',
          source: 'app-default',
          reason: 'agent-default',
          caller: 'authoring',
        })
      },
    )
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
  }
})

test('thinking turned off by the Agent is not refused as an invalid budget', async () => {
  // `thinking_budget: 0` is how an Agent turns extended thinking off, and the
  // direct adapter honours it that way. The helper mapper refused it as below
  // the vendor's floor, so the same valid Agent file that runs everywhere else
  // would have stopped the Architect's turn before it sent anything.
  await withArchitect(
    [VALID_TURN],
    [
      // Anthropic's own setting, on Anthropic's own route. Accepting it for
      // OpenAI would invent a field that endpoint has no idea about.
      'provider: anthropic',
      'model: test-model',
      'thinking: medium',
      // A second setting alongside it, so a build that simply dropped every
      // option could not satisfy this test by accident: the body has to carry
      // 512 rather than the harness ceiling.
      `provider_options: '${JSON.stringify({ thinking_budget: 0, max_tokens: 512 })}'`,
    ],
    async ({ repoRoot, bodies, requestCount }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(requestCount(), 1, 'the turn ran')
      assert.equal(
        bodies[0]?.max_tokens,
        512,
        "the Agent's own ceiling reached the request",
      )
      assert.equal(
        bodies[0]?.thinking,
        undefined,
        'thinking is off, not enabled with a budget nobody asked for',
      )
    },
    'anthropic-messages',
  )
})

test('a vendor’s own setting is still refused on an endpoint that has no such field', async () => {
  // The other side of the case above. `thinking_budget` is Anthropic's, and
  // accepting it for an OpenAI request would be inventing a field rather than
  // honouring a setting.
  await withArchitect(
    [VALID_TURN],
    [
      'provider: openai',
      'model: test-model',
      'thinking: medium',
      `provider_options: '${JSON.stringify({ thinking_budget: 0 })}'`,
    ],
    async ({ repoRoot, requestCount }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, true)
      assert.match(String(result.reason), /thinking_budget/)
      assert.equal(requestCount(), 0, 'nothing was sent')
    },
  )
})

test('a setting this request cannot carry stops the turn before anything is sent', async () => {
  // Refused by name rather than dropped. A setting that silently does nothing
  // cannot be told apart from one the provider ignored, and the turn must not
  // spend a model call to find out.
  await withArchitect(
    [VALID_TURN],
    [
      'provider: openai',
      'model: test-model',
      'thinking: medium',
      `provider_options: '${JSON.stringify({ nonsense_setting: 1 })}'`,
    ],
    async ({ repoRoot, requestCount }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, true)
      assert.match(String(result.reason), /nonsense_setting/)
      assert.equal(requestCount(), 0, 'nothing was sent')
    },
  )
})

test('an ad hoc authoring choice does not inherit the Architect persona’s settings', async () => {
  // A pair the caller picked for one turn is a different choice from the
  // Architect Agent's, and the persona's vendor settings describe the pair it
  // chose. Carrying them onto someone else's pick would apply a setting nobody
  // asked for to a model nobody configured it against.
  await withArchitect(
    [VALID_TURN],
    [
      'provider: openai',
      'model: persona-model',
      'thinking: high',
      `provider_options: '${JSON.stringify({ max_tokens: 4096 })}'`,
    ],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
        provider: 'openai',
        model: 'chosen-model',
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies.length, 1)
      assert.equal(bodies[0]?.model, 'chosen-model')
      // Not absent — this endpoint always writes a ceiling — but the default
      // one rather than the persona's, which is what "does not travel" means
      // for a field that is always present.
      assert.equal(
        bodies[0]?.max_completion_tokens,
        Number(CEILING),
        "the persona's setting does not travel to a pair the caller chose",
      )
    },
  )
})

test('an agent file whose settings could not be read at all stops the turn', async () => {
  // A different boundary from the transport mapper above. `readAgentProviderOptions`
  // returns *no* options and a diagnostic for a file it cannot read as plain
  // settings, or one naming something credential-shaped — so the mapper sees an
  // empty map and approves it. Without a check on the reader's own diagnostic
  // these files would dispatch silently: the first with its settings missing,
  // the second with a credential sitting in the wrong place and nobody told.
  for (const { named, options, expected } of [
    {
      named: 'settings that are not one JSON object',
      options: 'not json at all',
      expected: /provider_options/,
    },
    {
      named: 'a credential where a setting should be',
      // Not a real key: the point is the *name*, which is what the reader
      // refuses on.
      options: JSON.stringify({ api_key: 'placeholder-not-a-secret' }),
      expected: /api_key/,
    },
  ]) {
    await withArchitect(
      [VALID_TURN],
      [
        'provider: openai',
        'model: test-model',
        'thinking: medium',
        `provider_options: '${options}'`,
      ],
      async ({ repoRoot, requestCount }) => {
        const result = await runGeneratorTurn({
          history: [{ role: 'user', text: 'Design something.' }],
          currentDraft: null,
          repoRoot,
          registry: REGISTRY,
        })

        assert.equal(result.fallback, true, named)
        assert.match(String(result.reason), expected, named)
        assert.equal(requestCount(), 0, `nothing was sent — ${named}`)
      },
    )
  }
})

/**
 * A vendor option describes one vendor's API, so it belongs to the pair that
 * named it.
 *
 * An Architect file that names no pair of its own has chosen none: it runs on
 * whichever pair Settings currently holds, which may be another vendor whose
 * API these settings do not describe. Both siblings already ask this — the
 * Agent loader at `parsers/load-agent.ts:384-385` and the Agent and Team
 * Architect at `resource-architect-llm.ts:240-242` both require the selection
 * to have come from the Agent — and this one decided ownership by the absence
 * of a caller's pair alone.
 *
 * The declared *level* is a different kind of setting and is not part of this:
 * `load-agent.ts:317,370` returns it whatever the selection source, because it
 * says how much the Agent should think rather than what one vendor's field is
 * called. Its own proof is on the Anthropic wire, where a level reaches the
 * request at all.
 */
test('an Architect that names no pair of its own sends none of its own vendor options', async () => {
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'openai',
    model: 'default-model',
  })
  try {
    await withArchitect(
      [VALID_TURN],
      // No provider and no model: this Agent inherits the application default.
      ['thinking: high', `provider_options: '${JSON.stringify({ max_tokens: 4096 })}'`],
      async ({ repoRoot, bodies }) => {
        const result = await runGeneratorTurn({
          history: [{ role: 'user', text: 'Design something.' }],
          currentDraft: null,
          repoRoot,
          registry: REGISTRY,
        })

        assert.equal(result.fallback, false, JSON.stringify(result))
        assert.equal(result.selection?.source, 'app-default', JSON.stringify(result))
        assert.equal(bodies.length, 1)
        // The turn still runs, and still carries the ceiling every helper
        // request carries — but that ceiling is the transport's, not the
        // Agent's 4096.
        assert.equal(
          bodies[0]?.max_completion_tokens,
          Number(CEILING),
          `the Agent's own vendor option travelled onto a pair it did not choose: ${JSON.stringify(bodies[0])}`,
        )
      },
    )
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
  }
})

/**
 * A file that cannot be read is broken, not merely inapplicable.
 *
 * Malformed `provider_options`, or ones naming a credential, make the Agent
 * unusable — that is §4.3's rule, and the Agent Architect applies it
 * whatever pair the caller asked for. This Architect skipped the check
 * entirely for an ad hoc pair, because the same condition served two different
 * questions: whether the persona's *settings* apply to this turn, and whether
 * the persona's *file* can be read at all. Only the first depends on which
 * pair runs.
 *
 * The isolation control above still holds: a well-formed option belonging to
 * the persona must not travel onto somebody else's pick. This case is about the
 * file being unusable, not about its settings applying.
 */
test('an ad hoc pair does not excuse an agent file whose settings cannot be read', async () => {
  for (const { named, options, expected } of [
    {
      named: 'a malformed provider_options block',
      options: 'not-json-at-all',
      expected: /provider_options/,
    },
    {
      named: 'a credential where a setting should be',
      options: JSON.stringify({ api_key: 'placeholder-not-a-secret' }),
      expected: /api_key/,
    },
  ]) {
    await withArchitect(
      [VALID_TURN],
      [
        'provider: openai',
        'model: test-model',
        'thinking: medium',
        `provider_options: '${options}'`,
      ],
      async ({ repoRoot, requestCount }) => {
        const result = await runGeneratorTurn({
          history: [{ role: 'user', text: 'Design something.' }],
          currentDraft: null,
          repoRoot,
          registry: REGISTRY,
          // Somebody picked a model for this one turn. That decides which
          // settings apply; it does not make an unreadable file readable.
          provider: 'openai',
          model: 'ad-hoc-model',
        })

        assert.equal(result.fallback, true, named)
        assert.match(String(result.reason), expected, named)
        assert.equal(requestCount(), 0, `nothing was sent — ${named}`)
      },
    )
  }
})

/**
 * A declared thinking level is a setting, and Anthropic has a field for it.
 *
 * `callModel` routes every `anthropic` turn to its helper
 * (`domains/provider/model-client.ts:696-698`), and that helper built its body
 * from `provider_options` alone — `params.thinking` was never read. So an
 * Architect declaring `thinking: high` was answered by a model doing no
 * extended thinking, with nothing to distinguish that from a provider ignoring
 * the setting. The native adapter `providers/anthropic.ts:86-117` has always
 * mapped the level; only this transport did not.
 *
 * The budget and the ceiling are one pair: a budget at or above the answer
 * ceiling leaves no room for an answer and the vendor refuses the request. So
 * the ceiling is resolved in a stated order — the Agent's own `max_tokens`,
 * then the operator's environment override, then the level's native default —
 * and an explicit one is never quietly raised to make a level fit.
 */
test('a declared thinking level reaches the Anthropic request, with its own default ceiling', async () => {
  await withArchitect(
    [VALID_TURN],
    ['provider: anthropic', 'model: test-model', 'thinking: high'],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies.length, 1)
      // The vendor's own numbers for this level, the same ones the native
      // adapter uses: 8192 of thinking under a 12288 answer ceiling.
      assert.deepEqual(
        bodies[0]?.thinking,
        { type: 'enabled', budget_tokens: 8192 },
        JSON.stringify(bodies[0]),
      )
      assert.equal(bodies[0]?.max_tokens, 12288, JSON.stringify(bodies[0]))
    },
    'anthropic-messages',
    // Nobody set a ceiling, so the level's own default is what applies.
    null,
  )
})

test('an Agent that turned thinking off keeps it off, whatever level it declares', async () => {
  // A written zero is a decision, and it outranks a level: `providers/
  // anthropic.ts` resolves the budget with `??` and omits the block for
  // anything not above zero. There is no budget for a ceiling to accommodate.
  await withArchitect(
    [VALID_TURN],
    [
      'provider: anthropic',
      'model: test-model',
      'thinking: high',
      `provider_options: '${JSON.stringify({ thinking_budget: 0 })}'`,
    ],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies[0]?.thinking, undefined, JSON.stringify(bodies[0]))
    },
    'anthropic-messages',
    null,
  )
})

test('a ceiling too small for the declared level refuses the turn rather than shrinking it', async () => {
  for (const { named, frontmatter, environmentCeiling, expected } of [
    {
      named: "the Agent's own max_tokens",
      frontmatter: [
        'provider: anthropic',
        'model: test-model',
        'thinking: high',
        `provider_options: '${JSON.stringify({ max_tokens: 4096 })}'`,
      ],
      environmentCeiling: null,
      expected: /4096/,
    },
    {
      named: 'the operator’s environment ceiling',
      frontmatter: ['provider: anthropic', 'model: test-model', 'thinking: high'],
      environmentCeiling: '5000',
      expected: /5000/,
    },
  ]) {
    await withArchitect(
      [VALID_TURN],
      frontmatter,
      async ({ repoRoot, requestCount }) => {
        const result = await runGeneratorTurn({
          history: [{ role: 'user', text: 'Design something.' }],
          currentDraft: null,
          repoRoot,
          registry: REGISTRY,
        })

        // Neither half is silently adjusted: raising the ceiling would spend
        // tokens nobody authorised, and dropping the level would answer a
        // question the Agent asked without saying so.
        assert.equal(result.fallback, true, named)
        assert.match(String(result.reason), /thinking/i, named)
        assert.match(String(result.reason), expected, named)
        assert.match(String(result.reason), /8192/, named)
        assert.equal(requestCount(), 0, `nothing was sent — ${named}`)
      },
      'anthropic-messages',
      environmentCeiling,
    )
  }
})

test('a declared level does not put Anthropic’s thinking object on an OpenAI request', async () => {
  // Only that. This endpoint genuinely does not take `thinking`, so sending it
  // would invent a field — but OpenAI does document a reasoning parameter of
  // its own, and this Architect still sends nothing for it. That omission is
  // tracked as its own gap rather than pinned here as the intended contract:
  // asserting its absence would make the next person's fix look like a
  // regression.
  await withArchitect(
    [VALID_TURN],
    ['provider: openai', 'model: test-model', 'thinking: high'],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies[0]?.thinking, undefined, JSON.stringify(bodies[0]))
    },
  )
})

/**
 * The two kinds of setting, told apart in one request.
 *
 * This Architect names no pair, so it runs on the application default. Its
 * `max_tokens` describes a pair it did not choose and must not travel — and if
 * it did, this turn would be refused outright, because 4096 leaves no room for
 * a high level's 8192 tokens of thinking. Its declared *level* is not that kind
 * of setting: `parsers/load-agent.ts:317,370` returns it whatever the selection
 * source, because it says how much this Agent should think rather than naming
 * one vendor's field.
 *
 * Only expressible on this wire, and only once a level reaches a request at
 * all, which is why it lives with the mapping rather than with the ownership
 * rule it also proves.
 */
test('an inherited pair keeps the Agent’s level and leaves its vendor options behind', async () => {
  setRuntimeDefaultModelState({
    status: 'available',
    provider: 'anthropic',
    model: 'default-model',
  })
  try {
    await withArchitect(
      [VALID_TURN],
      // No provider and no model of its own.
      ['thinking: high', `provider_options: '${JSON.stringify({ max_tokens: 4096 })}'`],
      async ({ repoRoot, bodies }) => {
        const result = await runGeneratorTurn({
          history: [{ role: 'user', text: 'Design something.' }],
          currentDraft: null,
          repoRoot,
          registry: REGISTRY,
        })

        assert.equal(result.fallback, false, JSON.stringify(result))
        assert.equal(result.selection?.source, 'app-default', JSON.stringify(result))
        assert.deepEqual(
          bodies[0]?.thinking,
          { type: 'enabled', budget_tokens: 8192 },
          `the declared level did not survive an inherited pair: ${JSON.stringify(bodies[0])}`,
        )
        assert.equal(
          bodies[0]?.max_tokens,
          12288,
          `the Agent's own ceiling travelled onto a pair it did not choose: ${JSON.stringify(bodies[0])}`,
        )
      },
      'anthropic-messages',
      null,
    )
  } finally {
    setRuntimeDefaultModelState({ status: 'unset' })
  }
})

/**
 * The CLI route, proved through the process this Architect actually launches.
 *
 * The debt carried from 6.2 is specifically this one: the Workflow Architect's
 * declared level was passed towards a CLI adapter and followed no further by
 * any test, so "the CLI carries it" rested on reading the code. The Claude
 * adapter turns the level into `--effort`, and that flag is on the argument
 * vector of a real child process.
 *
 * A local executable stands in for the paid CLI at the process boundary —
 * nothing inside the adapter or the model client is replaced, and no vendor
 * needs to be reachable. The configured value is what is asserted: every turn
 * carries some effort, so a case content with any value would have passed while
 * the declared one was being discarded.
 */
test("a declared level reaches the CLI process the Workflow Architect launches", async () => {
  initProviders()
  const repoRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-architect-cli-')),
  )
  const binDirectory = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'workflow-architect-cli-bin-')),
  )
  const argumentsPath = path.join(binDirectory, 'argv.json')
  fs.mkdirSync(path.join(repoRoot, 'teams', 'workflow-architect'), { recursive: true })
  fs.mkdirSync(path.join(repoRoot, 'agents', 'workflow-architect'), { recursive: true })
  fs.writeFileSync(
    path.join(repoRoot, 'teams', 'workflow-architect', 'team.yaml'),
    ['agents:', '  - agent_file: ../../agents/workflow-architect/workflow-architect.md', ''].join('\n'),
  )
  fs.writeFileSync(
    path.join(repoRoot, 'agents', 'workflow-architect', 'workflow-architect.md'),
    ['---', 'provider: claude', 'model: haiku', 'thinking: high', '---', '', 'Design workflows.', ''].join('\n'),
  )
  fs.writeFileSync(
    path.join(binDirectory, 'claude'),
    `#!/usr/bin/env node
const fs = require('node:fs')
// Recorded from inside the process, so what is asserted is what was launched.
fs.writeFileSync(${JSON.stringify(argumentsPath)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: ${JSON.stringify(VALID_TURN)},
}) + '\\n')
`,
    { mode: 0o755 },
  )

  const previousPath = process.env.PATH
  process.env.PATH = `${binDirectory}${path.delimiter}${previousPath ?? ''}`
  try {
    const result = await runGeneratorTurn({
      history: [{ role: 'user', text: 'Design something.' }],
      currentDraft: null,
      repoRoot,
      registry: REGISTRY,
    })

    // A parsed answer, not merely a process that ran: a turn that failed would
    // still have launched one.
    assert.equal(result.fallback, false, JSON.stringify(result))
    assert.equal(result.response.message, 'Here is the plan.', JSON.stringify(result))
    // And it ran on the Architect's own pair, so the settings under test are
    // the ones that belong to it.
    assert.equal(result.selection?.source, 'agent', JSON.stringify(result))

    const raw: unknown = JSON.parse(fs.readFileSync(argumentsPath, 'utf8'))
    assert.ok(Array.isArray(raw), 'the CLI recorded no arguments')
    const args = raw.map((value) => String(value))
    const modelIndex = args.indexOf('--model')
    assert.notEqual(modelIndex, -1, `no model was passed: ${JSON.stringify(args)}`)
    assert.equal(args[modelIndex + 1], 'haiku', JSON.stringify(args))
    const effortIndex = args.indexOf('--effort')
    assert.notEqual(effortIndex, -1, `no effort was passed: ${JSON.stringify(args)}`)
    assert.equal(
      args[effortIndex + 1],
      'high',
      `the CLI ran at a level the Architect did not declare: ${JSON.stringify(args)}`,
    )
  } finally {
    process.env.PATH = previousPath
    fs.rmSync(repoRoot, { recursive: true, force: true })
    fs.rmSync(binDirectory, { recursive: true, force: true })
  }
})

/**
 * The OpenAI helper route, and the model that can actually take an effort.
 *
 * The native adapter has always mapped the declared level — it speaks the
 * Responses API and writes `reasoning.effort` — while the helper speaks Chat
 * Completions and wrote nothing. The parameter is documented there too, so this
 * was missing behaviour rather than an impossibility.
 *
 * What it is *not* is a parameter for every OpenAI-compatible endpoint. The
 * helper's Chat Completions function is shared with DeepSeek, OpenRouter, xAI
 * and configured connections, and only some OpenAI models accept an effort at
 * all — so support is decided by the predicate the host bridge already uses
 * (`domains/provider/provider-preflight.ts:242`) rather than by a second list
 * written here.
 */
test('a declared level reaches an OpenAI request for a model that takes one', async () => {
  await withArchitect(
    [NOT_JSON, VALID_TURN],
    ['provider: openai', 'model: gpt-5.2', 'thinking: high'],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies.length, 2, 'the repair attempt ran')
      for (const [index, body] of bodies.entries()) {
        // A repair is the same turn asking again, so it runs on the same
        // settings as the first attempt.
        assert.equal(
          body.reasoning_effort,
          'high',
          `attempt ${index + 1} carried no declared effort: ${JSON.stringify(body)}`,
        )
      }
    },
  )
})

test('a model that takes no effort is sent none', async () => {
  await withArchitect(
    [VALID_TURN],
    ['provider: openai', 'model: gpt-4o-mini', 'thinking: high'],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies[0]?.reasoning_effort, undefined, JSON.stringify(bodies[0]))
    },
  )
})

test('an OpenAI-compatible vendor is not sent an OpenAI parameter', async () => {
  // The same Chat Completions function serves DeepSeek, OpenRouter and xAI.
  // Compatible in shape is not the same as accepting this parameter, and a
  // model name that happens to look like OpenAI's does not make it one.
  await withArchitect(
    [VALID_TURN],
    ['provider: deepseek', 'model: gpt-5.2', 'thinking: high'],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies[0]?.reasoning_effort, undefined, JSON.stringify(bodies[0]))
    },
    'deepseek-chat-completions',
  )
})

test('an Agent that turned reasoning off is sent no effort, and still runs', async () => {
  // The native adapter reads `reasoning: false` and omits the block. The same
  // agent file has to mean the same thing here, or it works on one path and
  // stops the turn on the other.
  await withArchitect(
    [VALID_TURN],
    [
      'provider: openai',
      'model: gpt-5.2',
      'thinking: high',
      `provider_options: '${JSON.stringify({ reasoning: false })}'`,
    ],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies[0]?.reasoning_effort, undefined, JSON.stringify(bodies[0]))
    },
  )
})

test('a sampling setting beside an effort stops the turn rather than one of them', async () => {
  // The vendor rejects `temperature` alongside a non-none effort. Both were
  // written by somebody, so neither is quietly removed to hide the conflict and
  // neither is sent to be rejected downstream.
  await withArchitect(
    [VALID_TURN],
    [
      'provider: openai',
      'model: gpt-5.2',
      'thinking: high',
      `provider_options: '${JSON.stringify({ temperature: 0.2 })}'`,
    ],
    async ({ repoRoot, requestCount }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, true, JSON.stringify(result))
      assert.match(String(result.reason), /temperature/)
      assert.match(String(result.reason), /gpt-5\.2/)
      assert.equal(requestCount(), 0, 'nothing was sent')
    },
  )
})

/**
 * A model-family prefix is a guess, and two documented models falsify it.
 *
 * `openAiHostSupportsReasoningEffort` answers a question about the Responses
 * host. Reusing it here as certification for Chat Completions is wrong in both
 * directions, and each direction fails differently:
 *
 *   - `gpt-5-pro` matches the prefix but is a Responses-API model. Leaving the
 *     parameter off would not save it: the request would still go to an
 *     endpoint that model does not serve. The turn has to stop, visibly, with
 *     nothing sent.
 *   - `gpt-6-astra` matches no prefix here but documents the parameter on this
 *     endpoint, so a declared level has to reach a real request.
 */
test('a Responses-only model is refused on this endpoint rather than quietly dispatched', async () => {
  for (const model of ['gpt-5-pro', 'gpt-5-pro-2025-10-06']) {
    await withArchitect(
      [VALID_TURN],
      ['provider: openai', `model: ${model}`, 'thinking: high'],
      async ({ repoRoot, requestCount }) => {
        const result = await runGeneratorTurn({
          history: [{ role: 'user', text: 'Design something.' }],
          currentDraft: null,
          repoRoot,
          registry: REGISTRY,
        })

        assert.equal(result.fallback, true, `${model}: ${JSON.stringify(result)}`)
        assert.match(String(result.reason), new RegExp(model.replace(/\./g, '\\.')))
        assert.equal(requestCount(), 0, `${model}: nothing was sent`)
      },
    )
  }
})

test('a model documented for this endpoint carries its declared level', async () => {
  await withArchitect(
    [VALID_TURN],
    ['provider: openai', 'model: gpt-6-astra', 'thinking: high'],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies[0]?.reasoning_effort, 'high', JSON.stringify(bodies[0]))
    },
  )
})

test('turning reasoning off is a setting a non-reasoning model may carry too', async () => {
  // `providers/openai.ts:86` applies `reasoning: false` with no model
  // restriction. Refusing it here on a model that takes no effort anyway would
  // stop a turn that the native route runs without complaint.
  await withArchitect(
    [VALID_TURN],
    [
      'provider: openai',
      'model: gpt-4o-mini',
      'thinking: high',
      `provider_options: '${JSON.stringify({ reasoning: false })}'`,
    ],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies[0]?.reasoning_effort, undefined, JSON.stringify(bodies[0]))
    },
  )
})

test('turning reasoning off does not rescue a sampling setting on a model that reasons anyway', async () => {
  // Omitting `reasoning_effort` is not the same as the model not reasoning.
  // The original `gpt-5` defaults to a middle level, and `gpt-6-astra` accepts
  // no "none" at all, so for these the sampling conflict is about the model
  // rather than about what this request was going to send — and the opt-out
  // must not be offered as a way out of it.
  for (const model of ['gpt-5', 'gpt-6-astra']) {
    await withArchitect(
      [VALID_TURN],
      [
        'provider: openai',
        `model: ${model}`,
        'thinking: high',
        `provider_options: '${JSON.stringify({ reasoning: false, temperature: 0.2 })}'`,
      ],
      async ({ repoRoot, requestCount }) => {
        const result = await runGeneratorTurn({
          history: [{ role: 'user', text: 'Design something.' }],
          currentDraft: null,
          repoRoot,
          registry: REGISTRY,
        })

        assert.equal(result.fallback, true, `${model}: ${JSON.stringify(result)}`)
        assert.match(String(result.reason), /temperature/)
        assert.equal(requestCount(), 0, `${model}: nothing was sent`)
      },
    )
  }
})

test('a model that defaults to no reasoning may still be given a sampling setting', async () => {
  // `gpt-5.2` documents a default of none, and sampling is supported there. So
  // turning the effort off and setting a temperature is a valid request, and
  // over-refusing it would take away a combination the vendor allows.
  await withArchitect(
    [VALID_TURN],
    [
      'provider: openai',
      'model: gpt-5.2',
      'thinking: high',
      `provider_options: '${JSON.stringify({ reasoning: false, temperature: 0.2 })}'`,
    ],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies[0]?.reasoning_effort, undefined, JSON.stringify(bodies[0]))
      assert.equal(bodies[0]?.temperature, 0.2, JSON.stringify(bodies[0]))
    },
  )
})

test('an Agent that asks for reasoning explicitly still gets its declared level', async () => {
  // `providers/openai.ts:86` reads this as `!== false`, so `true` keeps the
  // effort the level asks for, and the option table accepts both booleans.
  // Refusing `true` here would make a valid agent file stop the turn on one
  // route and run on the other.
  await withArchitect(
    [VALID_TURN],
    [
      'provider: openai',
      'model: gpt-5.2',
      'thinking: high',
      `provider_options: '${JSON.stringify({ reasoning: true })}'`,
    ],
    async ({ repoRoot, bodies }) => {
      const result = await runGeneratorTurn({
        history: [{ role: 'user', text: 'Design something.' }],
        currentDraft: null,
        repoRoot,
        registry: REGISTRY,
      })

      assert.equal(result.fallback, false, JSON.stringify(result))
      assert.equal(bodies[0]?.reasoning_effort, 'high', JSON.stringify(bodies[0]))
    },
  )
})

/**
 * Which models reason only when asked, and what counts as one of them.
 *
 * `gpt-5.1`, `gpt-5.2` and `gpt-5.4` are each documented as defaulting to no
 * reasoning, and as supporting sampling settings there — so turning the effort
 * off leaves a temperature valid. Treating every other `gpt-5` name as always
 * reasoning would refuse a combination the vendor allows.
 *
 * Matching is by exact model id or a dated snapshot of one, not by prefix:
 * `gpt-5.2-pro` and `gpt-5.20` are different models this codebase has no
 * evidence about, and quietly classifying them as `gpt-5.2` would apply one
 * model's documented defaults to another's.
 */
test('a model documented to reason only when asked keeps its sampling setting', async () => {
  for (const model of ['gpt-5.1', 'gpt-5.4', 'gpt-5.1-2025-11-13']) {
    await withArchitect(
      [VALID_TURN],
      [
        'provider: openai',
        `model: ${model}`,
        'thinking: high',
        `provider_options: '${JSON.stringify({ reasoning: false, temperature: 0.2 })}'`,
      ],
      async ({ repoRoot, bodies }) => {
        const result = await runGeneratorTurn({
          history: [{ role: 'user', text: 'Design something.' }],
          currentDraft: null,
          repoRoot,
          registry: REGISTRY,
        })

        assert.equal(result.fallback, false, `${model}: ${JSON.stringify(result)}`)
        assert.equal(bodies[0]?.reasoning_effort, undefined, `${model}: ${JSON.stringify(bodies[0])}`)
        assert.equal(bodies[0]?.temperature, 0.2, `${model}: ${JSON.stringify(bodies[0])}`)
      },
    )
  }
})

test('a name that merely starts like a documented one is not treated as it', async () => {
  // Nothing is known about these two, so the conservative reading applies:
  // a model in the reasoning family that has not been shown to default to none
  // is assumed to reason, and its sampling setting is refused rather than sent
  // on the strength of a different model's documentation.
  for (const model of ['gpt-5.2-pro', 'gpt-5.20']) {
    await withArchitect(
      [VALID_TURN],
      [
        'provider: openai',
        `model: ${model}`,
        'thinking: high',
        `provider_options: '${JSON.stringify({ reasoning: false, temperature: 0.2 })}'`,
      ],
      async ({ repoRoot, requestCount }) => {
        const result = await runGeneratorTurn({
          history: [{ role: 'user', text: 'Design something.' }],
          currentDraft: null,
          repoRoot,
          registry: REGISTRY,
        })

        assert.equal(result.fallback, true, `${model}: ${JSON.stringify(result)}`)
        assert.match(String(result.reason), /temperature/)
        assert.equal(requestCount(), 0, `${model}: nothing was sent`)
      },
    )
  }
})
