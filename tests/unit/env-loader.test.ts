import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

test('loadDotEnv loads keys from cwd .env without overriding existing env vars', async () => {
  const { loadDotEnv } = await import('../../core/env-loader.js?test=' + Date.now())
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-loader-'))
  const envPath = path.join(dir, '.env')
  const originalNew = process.env.OPENROUTER_API_KEY
  const originalExisting = process.env.OPENROUTER_SITE_NAME

  fs.writeFileSync(envPath, [
    'OPENROUTER_API_KEY=sk-test',
    'OPENROUTER_SITE_NAME="Pipeline Template"',
  ].join('\n'))

  process.env.OPENROUTER_SITE_NAME = 'already-set'
  delete process.env.OPENROUTER_API_KEY

  try {
    loadDotEnv(dir)
    assert.equal(process.env.OPENROUTER_API_KEY, 'sk-test')
    assert.equal(process.env.OPENROUTER_SITE_NAME, 'already-set')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    if (originalNew === undefined) delete process.env.OPENROUTER_API_KEY
    else process.env.OPENROUTER_API_KEY = originalNew
    if (originalExisting === undefined) delete process.env.OPENROUTER_SITE_NAME
    else process.env.OPENROUTER_SITE_NAME = originalExisting
  }
})

test('loadDotEnv aliases CLAUDE_API_KEY into ANTHROPIC_API_KEY when needed', async () => {
  const { loadDotEnv } = await import('../../core/env-loader.js?test=' + Date.now())
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-loader-anthropic-'))
  const envPath = path.join(dir, '.env')
  const originalAnthropic = process.env.ANTHROPIC_API_KEY
  const originalClaude = process.env.CLAUDE_API_KEY

  fs.writeFileSync(envPath, 'CLAUDE_API_KEY=sk-ant-test')

  delete process.env.ANTHROPIC_API_KEY
  delete process.env.CLAUDE_API_KEY

  try {
    loadDotEnv(dir)
    assert.equal(process.env.CLAUDE_API_KEY, 'sk-ant-test')
    assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-test')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
    if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
    else process.env.ANTHROPIC_API_KEY = originalAnthropic
    if (originalClaude === undefined) delete process.env.CLAUDE_API_KEY
    else process.env.CLAUDE_API_KEY = originalClaude
  }
})
