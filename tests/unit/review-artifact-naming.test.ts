import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

const repoRoot = process.cwd()

test('review engine persists separate draft and review-feedback iteration artifacts', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'engines', 'review.ts'), 'utf8')

  assert.match(source, /draft-v\$\{iteration\}\.md/)
  assert.match(source, /review-feedback-v\$\{iteration\}\.md/)
  assert.doesNotMatch(source, /review-draft-v\$\{reviewState\.iteration\}\.md/)
})
