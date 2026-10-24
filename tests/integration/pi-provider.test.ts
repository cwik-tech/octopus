import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { createPiProvider } from '../../providers/pi.js'
import { getAssignmentLogPath } from '../../domains/runtime/logger.js'

function withFakePi<T>(handlerSource: string, fn: (binDir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-pi-provider-bin-'))
  const scriptPath = path.join(dir, 'pi')
  fs.writeFileSync(scriptPath, `#!/usr/bin/env node\n${handlerSource}\n`, { mode: 0o755 })
  return fn(dir).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })
}

test('Pi provider passes model, thinking, system prompt file, and @message file args', async () => {
  const handlerSource = `
const payload = {
  type: 'message_end',
  message: {
    role: 'assistant',
    model: 'fake-pi-model',
    usage: { input: 1, output: 1, totalTokens: 2, cost: { total: 0 } },
    content: [{ type: 'text', text: JSON.stringify(process.argv.slice(2)) }]
  }
}
process.stdout.write(JSON.stringify(payload) + '\\n')
// A real run ends on agent_settled: message_end says what a message held,
// agent_settled says Pi will not auto-retry or run a queued follow-up.
process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
`

  await withFakePi(handlerSource, async (binDir) => {
    const originalPath = process.env.PATH
    process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
    try {
      const provider = createPiProvider()
      const result = await provider.execute({
        systemPrompt: 'sys prompt',
        userMessage: 'user prompt',
        model: 'pi-model',
        thinking: 'low',
      })

      const args: string[] = JSON.parse(result.text)
      assert.ok(args.includes('--mode'))
      assert.ok(args.includes('json'))
      assert.ok(args.includes('--no-session'))
      assert.ok(args.includes('--model'))
      assert.ok(args.includes('pi-model'))
      assert.ok(args.includes('--thinking'))
      assert.ok(args.includes('low'))
      assert.ok(args.includes('--append-system-prompt'))
      assert.ok(args.some((arg) => arg.startsWith('@')), 'Should pass user message via @file')
    } finally {
      process.env.PATH = originalPath
    }
  })
})

test('Pi provider starts Pi with its built-in tools off and keeps only the non-built-in tools it was granted', async () => {
  const recordDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-argv-'))
  const argvPath = path.join(recordDir, 'argv.json')
  const handlerSource = `
require('node:fs').writeFileSync(${JSON.stringify(argvPath)}, JSON.stringify(process.argv.slice(2)))
process.stdout.write(JSON.stringify({
  type: 'message_end',
  message: { role: 'assistant', model: 'pi-model', content: [{ type: 'text', text: 'ok' }] },
}) + '\\n')
process.stdout.write(JSON.stringify({ type: 'agent_settled' }) + '\\n')
`
  // Unset, so the fake `pi` on PATH is what runs rather than a bundled CLI.
  const bundledCliPath = process.env.TEAM_RUNTIME_PI_CLI_PATH
  delete process.env.TEAM_RUNTIME_PI_CLI_PATH
  try {
    await withFakePi(handlerSource, async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        await createPiProvider().execute({
          systemPrompt: 'sys prompt',
          userMessage: 'user prompt',
          model: 'pi-model',
          thinking: 'low',
          tools: ['read', 'bash', 'handoff'],
        })
      } finally {
        process.env.PATH = originalPath
      }
    })

    const recorded: unknown = JSON.parse(fs.readFileSync(argvPath, 'utf8'))
    assert.ok(Array.isArray(recorded), 'the fake pi must have recorded its argv')
    const argv = recorded.filter((value): value is string => typeof value === 'string')
    assert.equal(argv[0], '--no-builtin-tools', 'the lockdown flag must lead the argv')
    assert.equal(argv.filter((argument) => argument === '--no-builtin-tools').length, 1)
    const toolsIndex = argv.indexOf('--tools')
    assert.notEqual(toolsIndex, -1, 'the granted tools must still be passed')
    assert.equal(
      argv[toolsIndex + 1],
      'handoff',
      'built-in tool names must be dropped from the allowlist, and the rest kept',
    )
  } finally {
    if (bundledCliPath === undefined) delete process.env.TEAM_RUNTIME_PI_CLI_PATH
    else process.env.TEAM_RUNTIME_PI_CLI_PATH = bundledCliPath
    fs.rmSync(recordDir, { recursive: true, force: true })
  }
})

test('Pi provider logs provider lifecycle events and rejects non-zero exits', async () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-provider-logs-'))
  await withFakePi(
    `
process.stderr.write('cli failed')
process.exit(6)
`,
    async (binDir) => {
      const originalPath = process.env.PATH
      process.env.PATH = `${binDir}${path.delimiter}${originalPath ?? ''}`
      try {
        const provider = createPiProvider()
        await assert.rejects(
          () =>
            provider.execute({
              systemPrompt: 'sys',
              userMessage: 'user',
              model: 'pi-model',
              thinking: 'low',
              outputPath: outputDir,
              sessionId: 'pi-session',
              rootSessionId: 'pi-root',
              agentName: 'assistant',
            }),
          /exited with code 6/,
        )

        const entries = readJsonl(getAssignmentLogPath(outputDir, 'provider-events.jsonl'))
        assert.equal(entries[0]?.event, 'request.start')
        assert.equal(entries.at(-1)?.event, 'request.fail')
        assert.match(String(entries.at(-1)?.detail), /code 6/)
      } finally {
        process.env.PATH = originalPath
      }
    },
  )
  fs.rmSync(outputDir, { recursive: true, force: true })
})

function readJsonl(filePath: string): Array<Record<string, unknown>> {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}
