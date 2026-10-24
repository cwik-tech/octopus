import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

const repoRoot = process.cwd()

test('editor prompt requires exact section or phrase references in revise feedback', () => {
  const prompt = fs.readFileSync(path.join(repoRoot, 'agents', 'editor', 'editor.md'), 'utf8')

  assert.match(prompt, /every issue must cite an exact section heading or quote an exact phrase from the draft/i)
  assert.match(prompt, /Do not give generic advice like "improve flow" without pointing to the exact location/i)
  assert.match(prompt, /rewrite or remove unsupported metric-specific claims instead of demanding fabricated or freshly researched numbers/i)
  assert.match(prompt, /avoid escalating fresh softer concerns into new blockers unless the draft still clearly fails the brief/i)
  assert.match(prompt, /The runtime owns the review loop, canonical final artifact, and approved-draft promotion/i)
  assert.match(prompt, /Return only the review decision tag plus review feedback\./i)
  assert.match(prompt, /Put that tag first in the response body\./i)
  assert.match(prompt, /Do not include progress narration such as "I’m checking files"/i)
  assert.match(prompt, /final-artifact instructions such as "promote this draft"/i)
  assert.match(prompt, /loop-control instructions such as "run another review cycle"/i)
})

test('review engine revision prompt includes current draft and strict reviewer feedback structure', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'engines', 'review.ts'), 'utf8')

  assert.match(source, /## Current Draft/)
  assert.match(source, /## Previous Blocking Guidance/)
  assert.match(source, /If you remove or rewrite away a metric-dependent claim, also remove any matching placeholder-log entry tied to that claim\./)
  assert.match(source, /Reference exact section headings or quote exact phrases from the draft\./)
  assert.match(source, /Do not give generic advice like "improve flow" without pointing to the exact place\./)
  assert.match(source, /prefer feedback that tells the writer to rewrite or remove the metric-specific claim rather than demanding a precise number\./)
  assert.match(source, /First judge whether the prior blocking issues were resolved before introducing any new blocker\./)
  assert.match(source, /approve once the brief is covered and no concrete blocker remains; do not keep the loop open for polish-only wording preferences\./i)
})
