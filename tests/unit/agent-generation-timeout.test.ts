import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { runCreateAgent } from '../../domains/agent-generator/create-agent.js'
import { ProviderError } from '../../domains/provider/provider-error.js'
import { getProvider, initProviders, registerProvider } from '../../providers/index.js'
import { createProviderStallWatchdog } from '../../providers/provider-stall-watchdog.js'

const authoredDraft = JSON.stringify({
  message: 'Created the software design specialist.',
  suggestedName: 'architect-software-design',
  personaMarkdown: '---\nname: architect-software-design\nthinking: medium\ntools: none\n---\n# Software Design Architect\nReviews software architecture.',
  generatedSkills: [{
    name: 'software-design-review',
    body: '---\nname: software-design-review\ndescription: Review software designs when an architecture needs assessment.\n---\nAssess boundaries, tradeoffs, and evidence.',
  }],
})

for (const scenario of [
  { name: 'accepts a valid Agent draft after more than two minutes of silent reasoning', silenceMs: 145_000, repair: false, fallback: false },
  { name: 'allows the JSON repair turn the same authoring window', silenceMs: 145_000, repair: true, fallback: false },
  { name: 'still rejects an Agent provider silent beyond the authoring deadline', silenceMs: 601_000, repair: false, fallback: true },
]) {
  test(scenario.name, async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-authoring-timeout-'))
    const teamDir = path.join(repoRoot, 'teams', 'workflow-architect')
    const agentDir = path.join(repoRoot, 'agents', 'workflow-architect')
    fs.mkdirSync(teamDir, { recursive: true })
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(teamDir, 'team.yaml'), 'agents:\n  - agent_file: ../../agents/workflow-architect/workflow-architect.md\n')
    fs.writeFileSync(path.join(agentDir, 'workflow-architect.md'), '---\nprovider: codex\nmodel: default\n---\nAuthor an Agent.')
    initProviders()
    const original = getProvider('codex')
    // The paid, nondeterministic CLI provider is replaced at its public
    // boundary. Its real watchdog receives an injected clock, so reproducing
    // a 145-second silent reasoning span does not require a timed sleep.
    registerProvider({
      name: 'codex',
      async execute(options) {
        let aborted = false
        const watchdog = createProviderStallWatchdog({
          idleMs: options.stallWatchdog?.idleMs ?? 60_000,
          abortIdleMs: options.stallWatchdog?.abortIdleMs ?? 120_000,
          onStall: () => {},
          onResume: () => {},
          onAbort: () => { aborted = true },
        })
        watchdog.observe(0)
        watchdog.check(scenario.silenceMs)
        if (aborted) {
          throw new ProviderError({ provider: 'codex', message: 'Silent turn aborted.', kind: 'timeout', code: 'provider_stalled', retryable: true })
        }
        assert.ok(options.signal, 'CLI authoring must have a bounded request signal')
        const text = scenario.repair && !options.userMessage.includes('Assistant:')
          ? 'Please repair this malformed output.'
          : authoredDraft
        return { text, model: options.model, cost: 0, durationMs: scenario.silenceMs, inputTokens: 0, outputTokens: 0, contextTokens: 0 }
      },
    }, { source: 'tests/unit/agent-generation-timeout.test.ts', trustClass: 'test' }, { replaceExisting: true })

    try {
      const result = await runCreateAgent({ repoRoot, provider: 'codex', model: 'test-model', skillPaths: [], chatHistory: [{ role: 'user', text: 'Create architect-software-design.' }] })

      assert.ok(!('duplicate' in result) && !('needsInput' in result))
      assert.equal(result.meta.fallback, scenario.fallback, result.meta.reason)
    } finally {
      registerProvider(original, { source: 'providers/codex.ts', trustClass: 'builtin' }, { replaceExisting: true })
      fs.rmSync(repoRoot, { recursive: true, force: true })
    }
  })
}
