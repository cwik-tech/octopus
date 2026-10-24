import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  appendProviderLifecycleTranscriptEvent,
  appendProviderProtocolTranscriptEvent,
  getCanonicalTranscriptLogPath,
  getRawTranscriptLogPath,
  rebuildCanonicalTranscript,
} from '../../domains/runtime/transcript.js'

test('provider protocol transcript logging writes raw and canonical events', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-test-'))
  try {
    appendProviderProtocolTranscriptEvent(outputDir, {
      kind: 'text',
      provider: 'codex',
      text: 'Hello',
      rawType: 'item.completed',
      raw: { type: 'item.completed', item: { text: 'Hello' } },
    }, {
      sessionId: 'session-1',
      rootSessionId: 'root-1',
      agentName: 'writer',
      model: 'gpt-5.4-mini',
      sequence: 1,
    })

    const raw = fs.readFileSync(getRawTranscriptLogPath(outputDir), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
    const canonical = fs.readFileSync(getCanonicalTranscriptLogPath(outputDir), 'utf8').trim().split('\n').map((line) => JSON.parse(line))

    assert.equal(raw.length, 1)
    assert.equal(raw[0].raw_type, 'item.completed')
    assert.equal(raw[0].sequence, 1)
    assert.equal(canonical.length, 1)
    assert.equal(canonical[0].kind, 'text')
    assert.equal(canonical[0].text, 'Hello')
    assert.equal(canonical[0].parser_version, 1)
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

test('canonical transcript can be rebuilt from raw events', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-rebuild-'))
  try {
    appendProviderLifecycleTranscriptEvent(outputDir, {
      timestamp: new Date().toISOString(),
      provider: 'openai',
      event: 'request.end',
      model: 'gpt-5.4',
      session_id: 'session-2',
      assignment_path: outputDir,
      status: 'completed',
      raw: {
        input_tokens: 10,
        output_tokens: 4,
        context_tokens: 14,
        cost: 0,
        text_preview: 'Done',
      },
    })

    fs.writeFileSync(getCanonicalTranscriptLogPath(outputDir), 'corrupted\n')
    const rebuilt = rebuildCanonicalTranscript(outputDir)

    assert.equal(rebuilt.length, 2)
    assert.deepEqual(rebuilt.map((event) => event.kind), ['complete', 'usage'])
    const persisted = fs.readFileSync(getCanonicalTranscriptLogPath(outputDir), 'utf8')
    assert.doesNotMatch(persisted, /corrupted/)
  } finally {
    fs.rmSync(outputDir, { recursive: true, force: true })
  }
})

