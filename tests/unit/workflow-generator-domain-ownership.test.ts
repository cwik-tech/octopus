import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const EXPECTED_IMPLEMENTATION_FILES = [
  'delete-workflow.ts',
  'generator-llm.ts',
  'generator-prompt.ts',
  'index.ts',
  'mermaid-builder.ts',
  'registry.ts',
  'save-workflow.ts',
  'validators.ts',
  'workflow-draft.ts',
  'yaml-builder.ts',
  'yaml-parser.ts',
]

test('Workflow Generator has one direct owner and no legacy shared path', () => {
  const repoRoot = findRepoRoot()
  const canonicalPath = path.join(repoRoot, 'domains', 'workflow-generator')
  const legacyPath = path.join(repoRoot, 'shared', 'workflow-generator')

  assert.deepEqual(
    fs.readdirSync(canonicalPath).sort(),
    EXPECTED_IMPLEMENTATION_FILES,
  )
  assert.equal(fs.existsSync(legacyPath), false)
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
