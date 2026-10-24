import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

test('Generate Word CLI converts Markdown without an agent runtime', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'generate-word-cli-'))
  try {
    const inputPath = path.join(workspace, 'report.md')
    const outputPath = path.join(workspace, 'report.docx')
    fs.writeFileSync(
      inputPath,
      '# CLI Report\n\n## Result\n\nThe deterministic conversion completed.\n',
    )
    const result = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/generate-word.ts',
        inputPath,
        outputPath,
        '--profile',
        'proposal',
        '--no-mermaid',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
      },
    )
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /profile 'proposal'/)
    assert.equal(
      fs.readFileSync(outputPath).subarray(0, 2).toString('ascii'),
      'PK',
    )
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true })
  }
})
