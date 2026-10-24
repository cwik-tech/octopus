/**
 * What a run writes down about its display channel, and what it never does.
 *
 * The channel id is not a secret: reading the channel still requires the
 * session that owns it, so recording the id is what lets the UI find the
 * stream from the run it is already watching. The token is a different thing
 * entirely. A run's records outlive the run, so a credential written into one
 * would outlive its own revocation.
 */
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import test from 'node:test'

import { logAgentRun } from '../../domains/runtime/logger.js'
import { AGENT_TEXT_STREAM_TOKEN_ENV } from '../../domains/runtime/agent-text-delta-tokens.js'
import type { AgentRunEvent } from '../../core/types.js'

const CHANNEL_ID = '11111111-2222-4333-8444-555555555555'
const TOKEN = 'a-working-credential-that-must-not-persist'

function makeAgentRunEvent(
  overrides: Partial<AgentRunEvent> = {},
): AgentRunEvent {
  return {
    timestamp: new Date().toISOString(),
    event: 'start',
    session_id: 'run-1',
    assignment_path: 'assignments/run-1',
    team: 'line-team',
    agent_name: 'line-one',
    agent_type: 'agent',
    ...overrides,
  }
}

/** Every file the run wrote, so nothing is checked by naming it in advance. */
function readEverything(root: string): string {
  const parts: string[] = []
  const walk = (directory: string): void => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(entryPath)
      else if (entry.isFile()) parts.push(fs.readFileSync(entryPath, 'utf8'))
    }
  }
  walk(root)
  return parts.join('\n')
}

test('a run records its display channel so the UI can find the stream', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-channel-'))
  try {
    logAgentRun(
      outputDir,
      makeAgentRunEvent({ text_channel_id: CHANNEL_ID }),
    )

    const written = readEverything(outputDir)
    assert.equal(
      written.includes(CHANNEL_ID),
      true,
      'the channel id never reached the run record',
    )
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('a run never records the credential its child was given', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-run-token-'))
  const previous = process.env[AGENT_TEXT_STREAM_TOKEN_ENV]
  process.env[AGENT_TEXT_STREAM_TOKEN_ENV] = TOKEN
  try {
    logAgentRun(
      outputDir,
      makeAgentRunEvent({ text_channel_id: CHANNEL_ID }),
    )

    const written = readEverything(outputDir)
    assert.equal(written.includes(CHANNEL_ID), true)
    assert.equal(
      written.includes(TOKEN),
      false,
      'a run record carried the posting credential',
    )
  } finally {
    if (previous === undefined) delete process.env[AGENT_TEXT_STREAM_TOKEN_ENV]
    else process.env[AGENT_TEXT_STREAM_TOKEN_ENV] = previous
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})
