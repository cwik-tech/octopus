import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

const repoRoot = process.cwd()

test('reset-codebase restores seed experience pads and deletes only workspace state', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'reset-codebase-'))
  const scriptDir = path.join(fixtureRoot, 'scripts')
  const scratchPadPath = path.join(
    fixtureRoot,
    'agents',
    'alpha',
    'experience',
    'scratch-pad.md',
  )
  const durableSkillPath = path.join(fixtureRoot, 'skills', 'durable', 'SKILL.md')

  try {
    fs.mkdirSync(scriptDir, { recursive: true })
    fs.copyFileSync(
      path.join(repoRoot, 'scripts', 'reset-codebase.mjs'),
      path.join(scriptDir, 'reset-codebase.mjs'),
    )
    fs.mkdirSync(path.dirname(scratchPadPath), { recursive: true })
    fs.writeFileSync(scratchPadPath, 'session-specific notes\n')
    fs.mkdirSync(path.join(fixtureRoot, 'agents', 'without-pad'), {
      recursive: true,
    })
    fs.mkdirSync(path.join(fixtureRoot, 'workspace'), { recursive: true })
    fs.writeFileSync(path.join(fixtureRoot, 'workspace', 'state.json'), '{}')
    fs.mkdirSync(path.dirname(durableSkillPath), { recursive: true })
    fs.writeFileSync(durableSkillPath, '# Durable skill\n')

    const result = spawnSync(
      process.execPath,
      [path.join(scriptDir, 'reset-codebase.mjs')],
      { encoding: 'utf8' },
    )

    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /Reset 1 experience file\(s\)\./)
    assert.match(result.stdout, /Skipped 1 missing experience file\(s\)\./)
    assert.match(result.stdout, /Deleted workspace folder: workspace/)
    assert.match(
      fs.readFileSync(scratchPadPath, 'utf8'),
      /After each session, append an entry below using this format/,
    )
    assert.equal(fs.existsSync(path.join(fixtureRoot, 'workspace')), false)
    assert.equal(fs.readFileSync(durableSkillPath, 'utf8'), '# Durable skill\n')
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true })
  }
})
