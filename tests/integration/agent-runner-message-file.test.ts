/**
 * Integration tests for T2 fix: runAgent() writes userMessage to a temp file
 * and passes @<filepath> instead of a raw CLI argument.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { runAgent } from '../../domains/agent-execution/agent-runner.js'
import { initProviders } from '../../providers/index.js'

// Register all providers before tests run
initProviders()

function withFakePi<T>(handlerSource: string, fn: (binDir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pi-bin-'))
  const scriptPath = path.join(dir, 'pi')
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${handlerSource}\n`, { mode: 0o755 })
  return fn(dir).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

test('runAgent passes userMessage via @file syntax, not raw CLI arg', async () => {
  // This fake pi script reads the @file argument and echoes its contents back
  await withFakePi(`
const fs = require('node:fs')
// Find the @file argument
const atArg = process.argv.find(a => a.startsWith('@'))
let content = '[no @file arg found]'
if (atArg) {
  const filePath = atArg.slice(1)
  try {
    content = fs.readFileSync(filePath, 'utf8')
  } catch (e) {
    content = '[read error: ' + e.message + ']'
  }
}
const payload = {
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'fake',
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    content: [{ type: 'text', text: 'ECHOED: ' + content }]
  }
}
process.stdout.write(JSON.stringify(payload) + '\\n')
process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
`, async (binDir) => {
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      const bigMessage = 'Hello from the message file! '.repeat(100)
      const result = await runAgent({
        systemPrompt: 'sys prompt',
        userMessage: bigMessage,
        model: 'fake-model',
        thinking: 'low',
        provider: 'pi',
      })

      assert.match(result.text, /^ECHOED: /)
      assert.match(result.text, /Hello from the message file!/)
    } finally {
      process.env.PATH = originalPath
    }
  })
})

test('runAgent preserves UTF-8 JSON when a subprocess splits a character across chunks', async () => {
  await withFakePi(`
const payload = Buffer.from(JSON.stringify({
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'fake',
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0.125 } },
    content: [{ type: 'text', text: 'Price: €' }]
  }
}) + '\\n')
const splitAt = payload.indexOf(Buffer.from('€')) + 1
process.stdout.write(payload.subarray(0, splitAt))
setTimeout(() => {
  process.stdout.write(payload.subarray(splitAt))
  // Inside the timeout, so the run settles *after* the split message
  // finishes arriving rather than before it.
  process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
}, 5)
`, async (binDir) => {
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      const result = await runAgent({
        systemPrompt: 'sys prompt',
        userMessage: 'hello',
        model: 'fake-model',
        thinking: 'low',
        provider: 'pi',
      })

      assert.equal(result.text, 'Price: €')
      assert.equal(result.cost, 0.125)
      assert.equal(result.costTracked, true)
    } finally {
      process.env.PATH = originalPath
    }
  })
})

test('runAgent throws a helpful error when pi binary is missing', async () => {
  // Use an empty PATH so 'pi' cannot be found — provider should throw a clear message
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'empty-bin-'))
  const originalPath = process.env.PATH
  const originalFallback = process.env.PIPELINE_CLI_PATH_FALLBACK
  process.env.PATH = emptyDir
  process.env.PIPELINE_CLI_PATH_FALLBACK = '0'
  try {
    await assert.rejects(
      () => runAgent({
        systemPrompt: 'sys',
        userMessage: 'hello',
        model: 'fake',
        thinking: 'low',
        provider: 'pi',
      }),
      (err: Error) => {
        assert.ok(
          err.message.includes("Provider 'pi' requires 'pi' CLI"),
          `Expected helpful install message, got: ${err.message}`,
        )
        return true
      },
    )
  } finally {
    process.env.PATH = originalPath
    if (originalFallback === undefined) delete process.env.PIPELINE_CLI_PATH_FALLBACK
    else process.env.PIPELINE_CLI_PATH_FALLBACK = originalFallback
    fs.rmSync(emptyDir, { recursive: true, force: true })
  }
})
