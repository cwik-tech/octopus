import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

import { buildPiInvocation } from '../../core/pi-runtime.js'

const PI_BUILTIN_TOOL_NAMES = [
  'read',
  'bash',
  'edit',
  'write',
  'grep',
  'find',
  'ls',
] as const

test('Pi invocation disables every unmanaged built-in while preserving extension tools', () => {
  const invocation = buildPiInvocation([
    '--mode',
    'json',
    '--tools',
    [...PI_BUILTIN_TOOL_NAMES, 'handoff'].join(','),
  ], {})

  assert.equal(
    invocation.args.filter((argument) => argument === '--no-builtin-tools').length,
    1,
  )
  const toolsIndex = invocation.args.indexOf('--tools')
  assert.notEqual(toolsIndex, -1)
  assert.equal(invocation.args[toolsIndex + 1], 'handoff')
})

test('an all-built-in Pi allowlist remains empty instead of enabling discovered extension tools', () => {
  const invocation = buildPiInvocation([
    '--tools',
    PI_BUILTIN_TOOL_NAMES.join(','),
  ], {})

  const toolsIndex = invocation.args.indexOf('--tools')
  assert.notEqual(toolsIndex, -1)
  assert.equal(invocation.args[toolsIndex + 1], '')
})

test('Pi invocation filters unmanaged built-ins from equals-form tool allowlists', () => {
  for (const argument of [
    '--tools=read,bash,handoff',
    '-t=read,bash,handoff',
  ]) {
    const invocation = buildPiInvocation([argument], {})
    const prefix = argument.slice(0, argument.indexOf('=') + 1)

    assert.equal(
      invocation.args.find((candidate) => candidate.startsWith(prefix)),
      `${prefix}handoff`,
    )
  }
})

test('every production Pi launcher uses the shared invocation boundary', () => {
  const launcherFiles = [
    'domains/agent-execution/agent-runner.ts',
    'domains/run/run-launcher.ts',
    // The desktop launcher, which `electron/main.ts` now only composes.
    'domains/run/desktop-run-launcher.ts',
    'providers/pi.ts',
  ]

  for (const relativePath of launcherFiles) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
    // Either directly, or by delegating to the shared Team-host launch, which
    // is itself in this list and is checked for the direct call. Delegating is
    // not a way around the boundary; it is the boundary being reused.
    assert.match(
      source,
      /buildPiInvocation\s*\(|launchTeamHostRun\s*\(/u,
      `${relativePath} must use the shared Pi invocation boundary`,
    )
  }
})

// The Team host is the process that switches models, and every switch is
// written to `<agentDir>/settings.json` by the installed Pi. A launcher that
// starts one without its own agent directory rewrites the user's Pi default.
test('every Team host launcher isolates its Pi agent directory', () => {
  const teamHostLaunchers = [
    'domains/agent-execution/agent-runner.ts',
    'domains/run/run-launcher.ts',
    'domains/run/desktop-run-launcher.ts',
  ]

  for (const relativePath of teamHostLaunchers) {
    const source = fs.readFileSync(path.join(process.cwd(), relativePath), 'utf8')
    assert.match(
      source,
      /isolatePiAgentDirectory\s*\(|launchTeamHostRun\s*\(/u,
      `${relativePath} must not start a Team host on the shared Pi agent directory`,
    )
  }
})
