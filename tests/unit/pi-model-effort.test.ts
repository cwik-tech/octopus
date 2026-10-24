/**
 * Pi's per-model thinking range, read from the runtime this application runs.
 *
 * Pi's `--help` states the seven levels the binary parses and `--list-models`
 * says only whether a model thinks at all, so neither answers what a given
 * model accepts. The runtime itself does: `getSupportedThinkingLevels` in
 * `@earendil-works/pi-ai` derives it from each model's `thinkingLevelMap`, and
 * that data ships inside the package this application executes.
 *
 * Reading it matters because the same runtime's `clampThinkingLevel` rounds an
 * unsupported level **upward**, so a request this application cannot place
 * accurately does not fail — it quietly becomes a different request.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import {
  readPiModelEffortSupport,
  readPiRuntimeCapabilities,
  resolveExecutedPiPath,
} from '../../domains/provider/pi-model-effort.js'

function withPiPackage(
  models: Record<string, Record<string, unknown>>,
  run: (cliPath: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-effort-'))
  try {
    const dataDir = path.join(
      root,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'node_modules',
      '@earendil-works',
      'pi-ai',
      'dist',
      'providers',
      'data',
    )
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(
      path.join(dataDir, 'vendor.json'),
      JSON.stringify({ 'vendor-api': models }),
    )
    const cliDir = path.join(
      root,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
    )
    fs.mkdirSync(cliDir, { recursive: true })
    const cliPath = path.join(cliDir, 'cli.js')
    fs.writeFileSync(cliPath, '// fixture')
    run(cliPath)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

test('a model that maps thinking-off to nothing does not offer off', () => {
  withPiPackage(
    {
      'deep-model': {
        id: 'deep-model',
        provider: 'vendor',
        reasoning: true,
        thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
      },
    },
    (cliPath) => {
      const support = readPiModelEffortSupport(cliPath)
      assert.deepEqual(support.get('vendor/deep-model'), [
        'minimal',
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ])
    },
  )
})

test('the top two levels are offered only where the model names them', () => {
  withPiPackage(
    {
      'plain-model': { id: 'plain-model', provider: 'vendor', reasoning: true },
    },
    (cliPath) => {
      assert.deepEqual(readPiModelEffortSupport(cliPath).get('vendor/plain-model'), [
        'off',
        'minimal',
        'low',
        'medium',
        'high',
      ])
    },
  )
})

test('a model that does not reason offers only off', () => {
  withPiPackage(
    {
      'flat-model': { id: 'flat-model', provider: 'vendor', reasoning: false },
    },
    (cliPath) => {
      assert.deepEqual(readPiModelEffortSupport(cliPath).get('vendor/flat-model'), ['off'])
    },
  )
})

test('a runtime whose data cannot be found publishes nothing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-effort-empty-'))
  try {
    assert.equal(readPiModelEffortSupport(path.join(root, 'cli.js')).size, 0)
    assert.equal(readPiModelEffortSupport(undefined).size, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a runtime that answered is told apart from one that could not', () => {
  // The difference decides whether an unlisted model means "this runtime does
  // not have it" or "we learned nothing here", and only the first of those may
  // narrow a turn's options with any confidence.
  withPiPackage(
    { 'some-model': { id: 'some-model', provider: 'vendor', reasoning: true } },
    (cliPath) => {
      assert.equal(readPiRuntimeCapabilities(cliPath).known, true)
    },
  )
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-effort-unknown-'))
  try {
    assert.equal(readPiRuntimeCapabilities(path.join(root, 'cli.js')).known, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('the executable a turn will spawn is followed to where it really lives', () => {
  // `PATH` usually holds a symlink into a package tree somewhere else, and the
  // capability data sits beside the real file rather than beside the link.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-effort-path-'))
  try {
    const realDir = path.join(root, 'real', 'dist')
    fs.mkdirSync(realDir, { recursive: true })
    const realPath = path.join(realDir, 'cli.js')
    fs.writeFileSync(realPath, '// fixture', { mode: 0o755 })
    const binDir = path.join(root, 'bin')
    fs.mkdirSync(binDir, { recursive: true })
    const link = path.join(binDir, 'pi')
    fs.symlinkSync(realPath, link)

    assert.equal(
      resolveExecutedPiPath({ PATH: binDir }),
      fs.realpathSync(realPath),
    )
    assert.equal(resolveExecutedPiPath({ PATH: path.join(root, 'nowhere') }), undefined)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
