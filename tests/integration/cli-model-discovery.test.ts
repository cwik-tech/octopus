import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { ProviderSettingsService } from '../../services/provider-settings-service.js'

// What Claude Code answers to the SDK `initialize` control request: the same
// list its interactive `/model` picker shows. The names are deliberately ones
// no hand-written list in this repository contains.
const REPORTED_MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-9',
    displayName: 'Default (recommended)',
    description: 'Opus 9 · Best for everyday, complex tasks',
  },
  {
    value: 'opus',
    resolvedModel: 'claude-opus-9',
    displayName: 'Opus 9',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'high', 'max'],
  },
  {
    value: 'claude-opus-9-1',
    resolvedModel: 'claude-opus-9-1',
    displayName: 'Opus 9.1',
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-9',
    displayName: 'Haiku 9',
  },
]

test('Claude Code lists the models the installed CLI reports', async () => {
  await withFakeCli(writeFakeClaude, async ({ service }) => {
    const agents = await service.listCliAgents(true)

    const claude = agents.find((agent) => agent.id === 'claude')
    assert.ok(claude, 'Claude Code is listed')
    assert.deepEqual(
      claude.models.map(({ id, name }) => ({ id, name })),
      [
        { id: 'default', name: 'Default (recommended)' },
        { id: 'opus', name: 'Opus 9' },
        { id: 'claude-opus-9-1', name: 'Opus 9.1' },
        { id: 'haiku', name: 'Haiku 9' },
      ],
    )
    assert.deepEqual(
      claude.models.find((model) => model.id === 'opus')?.supportedEfforts,
      ['low', 'high', 'max'],
    )
  })
})

test('asking Claude Code for its models runs no hooks and saves no session', async () => {
  await withFakeCli(writeFakeClaude, async ({ service, root }) => {
    await service.listCliAgents(true)

    const argv = readProbeArguments(claudeArgvLog(root))
    assert.ok(argv.includes('--no-session-persistence'), 'no session is saved')
    const settingSources = argv[argv.indexOf('--setting-sources') + 1]
    assert.equal(settingSources, '', 'user, project and local settings are not loaded')
    const settings = argv[argv.indexOf('--settings') + 1]
    assert.ok(settings, 'inline settings are passed')
    assert.equal(JSON.parse(settings).disableAllHooks, true, 'hooks are disabled')
  })
})

test('Kimi lists the model aliases its configuration defines', async () => {
  await withFakeCli(writeFakeKimi, async ({ service }) => {
    const agents = await service.listCliAgents(true)

    const kimi = agents.find((agent) => agent.id === 'kimi-cli')
    assert.ok(kimi, 'Kimi is listed')
    assert.deepEqual(
      kimi.models.map(({ id, name, contextLength }) => ({ id, name, contextLength })),
      [
        { id: 'default', name: 'Default model', contextLength: undefined },
        { id: 'kimi-code/k9', name: 'K9', contextLength: 1_048_576 },
        { id: 'kimi-code/k9-fast', name: 'K9 Fast', contextLength: 262_144 },
      ],
    )
  })
})

test('Qwen lists each model id it can run once, whichever plans serve it', async () => {
  await withFakeCli(writeFakeQwen, async ({ service }) => {
    const agents = await service.listCliAgents(true)

    const qwen = agents.find((agent) => agent.id === 'qwen')
    assert.ok(qwen, 'Qwen is listed')
    // `qwen --model` takes only the id, so Qwen chooses the plan for an id
    // that several plans serve. Such an id is named by itself, and gets the
    // smallest window any of its plans states.
    assert.deepEqual(
      qwen.models.map(({ id, name, contextLength }) => ({ id, name, contextLength })),
      [
        { id: 'default', name: 'Default model', contextLength: undefined },
        { id: 'qwen9-plus', name: 'qwen9-plus', contextLength: 262_144 },
        { id: 'glm-9', name: '[Plan A] glm-9', contextLength: 202_752 },
        { id: 'qwen9-coder', name: '[Plan B] qwen9-coder', contextLength: 1_000_000 },
      ],
    )
  })
})

interface FakeCliContext {
  service: ProviderSettingsService
  root: string
}

async function withFakeCli(
  writeFake: (binDirectory: string, root: string) => void,
  run: (context: FakeCliContext) => Promise<void>,
): Promise<void> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-model-discovery-')))
  const binDirectory = path.join(root, 'bin')
  fs.mkdirSync(binDirectory)
  writeFake(binDirectory, root)

  const originalPath = process.env.PATH
  const originalFallback = process.env.PIPELINE_CLI_PATH_FALLBACK
  // Only the fake directory, so no CLI installed on this machine is probed.
  process.env.PATH = binDirectory
  process.env.PIPELINE_CLI_PATH_FALLBACK = '0'
  try {
    const service = new ProviderSettingsService({
      storagePath: path.join(root, 'provider-settings.json'),
    })
    await run({ service, root })
  } finally {
    restoreEnvironment('PATH', originalPath)
    restoreEnvironment('PIPELINE_CLI_PATH_FALLBACK', originalFallback)
    fs.rmSync(root, { recursive: true, force: true })
  }
}

function claudeArgvLog(root: string): string {
  return path.join(root, 'claude-probe-argv.json')
}

function writeFakeClaude(binDirectory: string, root: string): void {
  const argvLog = claudeArgvLog(root)
  const executable = path.join(binDirectory, 'claude')
  fs.writeFileSync(
    executable,
    [
      `#!${process.execPath}`,
      "const fs = require('node:fs')",
      "const readline = require('node:readline')",
      'const args = process.argv.slice(2)',
      "if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0) }",
      "if (!args.includes('--input-format')) { console.log('Usage: claude [options]'); process.exit(0) }",
      `fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args))`,
      'const input = readline.createInterface({ input: process.stdin })',
      "input.on('line', (line) => {",
      '  const message = JSON.parse(line)',
      "  if (message.type !== 'control_request' || message.request.subtype !== 'initialize') return",
      '  process.stdout.write(JSON.stringify({',
      "    type: 'control_response',",
      "    response: { subtype: 'success', request_id: message.request_id, response: {",
      "      commands: [], output_style: 'default',",
      `      models: ${JSON.stringify(REPORTED_MODELS)},`,
      '    } },',
      "  }) + '\\n')",
      '})',
      "input.on('close', () => process.exit(0))",
      '',
    ].join('\n'),
  )
  fs.chmodSync(executable, 0o755)
}

// What `kimi provider list --json` prints: the raw configuration, with the
// provider credentials next to the model aliases `kimi --model` accepts.
const KIMI_CONFIGURATION = {
  providers: {
    'managed:kimi-code': {
      baseUrl: 'https://kimi.example.test/v1',
      type: 'kimi',
      apiKey: 'sk-fake-kimi-key',
    },
  },
  models: {
    'kimi-code/k9': {
      provider: 'managed:kimi-code',
      model: 'k9',
      maxContextSize: 1_048_576,
      displayName: 'K9',
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'high',
    },
    'kimi-code/k9-fast': {
      provider: 'managed:kimi-code',
      model: 'k9-fast',
      maxContextSize: 262_144,
      displayName: 'K9 Fast',
    },
  },
}

function writeFakeKimi(binDirectory: string): void {
  const executable = path.join(binDirectory, 'kimi')
  fs.writeFileSync(
    executable,
    [
      `#!${process.execPath}`,
      'const args = process.argv.slice(2)',
      "if (args[0] === '--version') { console.log('9.9.9'); process.exit(0) }",
      "if (args.join(' ') === 'provider list --json') {",
      `  console.log(${JSON.stringify(JSON.stringify(KIMI_CONFIGURATION))})`,
      '  process.exit(0)',
      '}',
      "console.log('Usage: kimi [options] [command]')",
      '',
    ].join('\n'),
  )
  fs.chmodSync(executable, 0o755)
}

// What Qwen answers to the SDK `get_available_models` control request: one
// entry per configured plan, so an id served by two plans appears twice.
const QWEN_AVAILABLE_MODELS = [
  { id: 'qwen9-plus', label: '[Plan A] qwen9-plus', contextWindowSize: 1_000_000 },
  { id: 'glm-9', label: '[Plan A] glm-9', contextWindowSize: 202_752 },
  { id: 'qwen9-plus', label: '[Plan B] qwen9-plus', contextWindowSize: 262_144 },
  { id: 'qwen9-coder', label: '[Plan B] qwen9-coder', contextWindowSize: 1_000_000 },
]

function writeFakeQwen(binDirectory: string): void {
  const executable = path.join(binDirectory, 'qwen')
  fs.writeFileSync(
    executable,
    [
      `#!${process.execPath}`,
      "const readline = require('node:readline')",
      'const args = process.argv.slice(2)',
      "if (args[0] === '--version') { console.log('9.9.9'); process.exit(0) }",
      "if (!args.includes('--input-format')) { console.log('Usage: qwen [options]'); process.exit(0) }",
      'let initialized = false',
      'const reply = (request_id, response) => process.stdout.write(JSON.stringify({',
      "  type: 'control_response', response: { subtype: 'success', request_id, response },",
      "}) + '\\n')",
      'const input = readline.createInterface({ input: process.stdin })',
      "input.on('line', (line) => {",
      '  const message = JSON.parse(line)',
      "  if (message.type !== 'control_request') return",
      '  const subtype = message.request.subtype',
      "  if (subtype === 'initialize') {",
      '    initialized = true',
      "    reply(message.request_id, { subtype: 'initialize', session_id: 'fake' })",
      "  } else if (subtype === 'get_available_models' && initialized) {",
      `    reply(message.request_id, { subtype: 'get_available_models', models: ${JSON.stringify(QWEN_AVAILABLE_MODELS)} })`,
      '  }',
      '})',
      "input.on('close', () => process.exit(0))",
      '',
    ].join('\n'),
  )
  fs.chmodSync(executable, 0o755)
}

function readProbeArguments(argvLog: string): string[] {
  assert.ok(fs.existsSync(argvLog), 'Claude Code was asked for its models')
  const parsed: unknown = JSON.parse(fs.readFileSync(argvLog, 'utf8'))
  assert.ok(Array.isArray(parsed), 'the probe recorded its arguments')
  return parsed.map(String)
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name]
  else process.env[name] = value
}
