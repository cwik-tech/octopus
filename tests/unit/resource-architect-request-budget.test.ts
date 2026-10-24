import assert from 'node:assert/strict'
import test from 'node:test'

import { ProviderRequestBudgetError } from '../../domains/provider/provider-request-budget.js'
import {
  admitResourceArchitectRequest,
  admitSelectedAgentPackage,
  resolveResourceArchitectRequestBudget,
  SelectedAgentPackageBudgetError,
} from '../../domains/resource-architect/resource-architect-request-budget.js'

// Two million bytes is far past every window in the table, at any byte ratio.
const OVERSIZED = 'x'.repeat(2_000_000)

test('an assumed context window measures an oversized Agent Architect request but never refuses it', () => {
  // No table row names this provider, so its window is only a guess.
  const assumed = resolveResourceArchitectRequestBudget({ provider: 'unlisted-provider', model: 'some-model' })
  // OpenAI has a table row, so its window may refuse.
  const known = resolveResourceArchitectRequestBudget({ provider: 'openai', model: 'some-model' })

  const accounting = admitResourceArchitectRequest({
    stage: 'Agent Architect draft', budget: assumed, systemPrompt: OVERSIZED, messages: [],
  })
  const selectedPackage = admitSelectedAgentPackage({ agentName: 'researcher', text: OVERSIZED, budget: assumed })

  assert.ok(accounting.estimatedInputTokens > accounting.admissibleInputTokens, 'the request is measured as too large')
  assert.ok(selectedPackage.tokens > assumed.draftAdmissibleInputTokens, 'the package is measured as too large')
  assert.equal(selectedPackage.bytes, 2_000_000)
  // The same inputs on a known window are refused, so the difference is the window's source.
  assert.throws(
    () => admitResourceArchitectRequest({ stage: 'Agent Architect draft', budget: known, systemPrompt: OVERSIZED, messages: [] }),
    ProviderRequestBudgetError,
  )
  assert.throws(
    () => admitSelectedAgentPackage({ agentName: 'researcher', text: OVERSIZED, budget: known }),
    SelectedAgentPackageBudgetError,
  )
})

test('a selected package larger than the reference share but inside the draft window is admitted whole', () => {
  // OpenAI's table row is a 128k-token window, which admits 108,800 input
  // tokens once the answer reserve is held back.
  const known = resolveResourceArchitectRequestBudget({ provider: 'openai', model: 'some-model' })
  // 180,000 bytes is about 51,000 estimated tokens: well past a 19,584-token
  // reference share, well inside the draft window.
  const text = 'Evidence line.\n'.repeat(12_000)

  const admitted = admitSelectedAgentPackage({ agentName: 'researcher', text, budget: known })

  assert.equal(admitted.bytes, 180_000)
})
