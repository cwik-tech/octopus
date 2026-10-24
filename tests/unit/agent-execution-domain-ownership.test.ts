import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const EXPECTED_IMPLEMENTATION_FILES = [
  'agent-runner.ts',
  'agent-turn-journal.ts',
  'context-compressor.ts',
  'delegated-settlement.ts',
  'failure-policy.ts',
  'minutes.ts',
  'sub-team-failure.ts',
]

test('Agent Execution has one direct owner and no legacy root facades', () => {
  const repoRoot = findRepoRoot()
  const canonicalPath = path.join(repoRoot, 'domains', 'agent-execution')

  assert.deepEqual(
    fs.readdirSync(canonicalPath).sort(),
    EXPECTED_IMPLEMENTATION_FILES,
  )
  for (const filename of EXPECTED_IMPLEMENTATION_FILES) {
    assert.equal(
      fs.existsSync(path.join(repoRoot, 'shared', filename)),
      false,
      `shared/${filename} must not remain as a compatibility facade`,
    )
  }
})

function findRepoRoot(): string {
  const currentFileDirectory = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    process.cwd(),
    path.resolve(currentFileDirectory, '..', '..'),
    path.resolve(currentFileDirectory, '..', '..', '..'),
  ]
  const repoRoot = candidates.find((candidate) =>
    fs.existsSync(path.join(candidate, 'package.json')),
  )
  assert.ok(repoRoot, 'repository root must contain package.json')
  return repoRoot
}
