import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  buildBundledPiEnvironment,
  buildPiInvocation,
  PI_CLI_PATH_ENV,
  PI_NODE_PATH_ENV,
  resolveBundledFileParserEntry,
  resolveBundledPiCliPath,
  resolveRuntimeExtensionEntry,
} from '../../core/pi-runtime.js'
import { TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV } from '../../core/file-parser-launcher.js'

const repoRoot = process.cwd()

test('bundled Pi CLI starts without a globally installed pi command', () => {
  const env = {
    PATH: '/usr/bin:/bin',
    [PI_CLI_PATH_ENV]: resolveBundledPiCliPath(repoRoot),
    [PI_NODE_PATH_ENV]: process.execPath,
  }
  const invocation = buildPiInvocation(['--version'], env)
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: invocation.env,
  })

  assert.equal(result.status, 0, result.stderr)
  assert.match(`${result.stdout}${result.stderr}`, /\d+\.\d+\.\d+/)
  assert.equal(
    env[PI_CLI_PATH_ENV],
    path.join(
      repoRoot,
      'node_modules',
      '@earendil-works',
      'pi-coding-agent',
      'dist',
      'cli.js',
    ),
  )
  assert.equal(
    resolveRuntimeExtensionEntry(repoRoot),
    path.join(repoRoot, 'dist-electron', 'team-runtime', 'index.js'),
  )
})

test('bundled Pi environment validates and publishes the compiled file parser', () => {
  const appRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bundled-pi-env-'))
  try {
    for (const filePath of [
      resolveBundledPiCliPath(appRoot),
      resolveRuntimeExtensionEntry(appRoot),
      resolveBundledFileParserEntry(appRoot),
    ]) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true })
      fs.writeFileSync(filePath, '')
    }

    const env = buildBundledPiEnvironment(appRoot, {}, process.execPath)

    assert.equal(
      env[TEAM_RUNTIME_FILE_PARSER_ENTRY_ENV],
      resolveBundledFileParserEntry(appRoot),
    )
  } finally {
    fs.rmSync(appRoot, { recursive: true, force: true })
  }
})
