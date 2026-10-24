import assert from 'node:assert/strict'
import test from 'node:test'

import {
  VOICE_CONTROL_CONTRACT,
  voiceControlDescriptorSchema,
  voiceNotifyInputSchema,
  voiceSetStatusInputSchema,
  voiceSayInputSchema,
} from '../../contracts/voice-control.js'

// Shapes taken from docs/feature-voice-control-mcp.md, "Discovery descriptor"
// and "Voice-layer tools".
function makeDescriptor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contract: 'voice-control/1',
    appId: 'octopus',
    name: 'Octopus',
    role: 'app',
    pid: 41237,
    mcp: {
      type: 'http',
      url: 'http://127.0.0.1:53211/_pipeline-mcp',
      headers: { Authorization: 'Bearer per-launch-token' },
    },
    updatedAt: '2026-10-09T10:00:00.000Z',
    ...overrides,
  }
}

function makeNotify(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    source: { appId: 'octopus', name: 'Octopus' },
    kind: 'needs_review',
    title: 'Research complete',
    speech: 'Your market research is done. Want me to read the summary?',
    priority: 'normal',
    subject: { type: 'task', id: 't_91', label: 'Market research' },
    actions: [
      {
        id: 'read',
        label: 'Read the summary',
        tool: { appId: 'octopus', name: 'read_result', arguments: { taskId: 't_91' } },
      },
    ],
    dedupeKey: 'octopus:task:t_91:done',
    ...overrides,
  }
}

test('the contract version is voice-control/1', () => {
  assert.equal(VOICE_CONTROL_CONTRACT, 'voice-control/1')
})

test('ordinary speech may carry an utterance ID without a dialogue identity', () => {
  assert.equal(voiceSayInputSchema.safeParse({
    source: { appId: 'octopus', name: 'Octopus' }, text: 'Your report is ready.', utteranceId: 'ordinary-1',
  }).success, true)
})

test('a descriptor from the plan parses', () => {
  const parsed = voiceControlDescriptorSchema.safeParse(makeDescriptor())
  assert.equal(parsed.success, true)
})

test('a descriptor for the voice layer may carry no headers', () => {
  const parsed = voiceControlDescriptorSchema.safeParse(makeDescriptor({
    appId: 'hexa-puffs',
    role: 'voice',
    mcp: { type: 'http', url: 'http://[::1]:4100/mcp' },
  }))
  assert.equal(parsed.success, true)
})

test('a descriptor whose server is not on loopback is refused', () => {
  for (const url of [
    'http://example.com/_pipeline-mcp',
    'http://10.0.0.4:53211/_pipeline-mcp',
    'http://127.0.0.1.example.com/_pipeline-mcp',
    'https://127.0.0.1:53211/_pipeline-mcp',
    'http://user:pass@127.0.0.1:53211/_pipeline-mcp',
    'file:///tmp/socket',
  ]) {
    const parsed = voiceControlDescriptorSchema.safeParse(makeDescriptor({
      mcp: { type: 'http', url },
    }))
    assert.equal(parsed.success, false, `${url} must be refused`)
  }
})

test('a descriptor for another contract version is refused', () => {
  const parsed = voiceControlDescriptorSchema.safeParse(makeDescriptor({
    contract: 'voice-control/2',
  }))
  assert.equal(parsed.success, false)
})

test('an appId that could escape the discovery folder is refused', () => {
  for (const appId of ['../octopus', 'Octopus', 'octo/pus', '']) {
    const parsed = voiceControlDescriptorSchema.safeParse(makeDescriptor({ appId }))
    assert.equal(parsed.success, false, `${JSON.stringify(appId)} must be refused`)
  }
})

test('the notify example from the plan parses', () => {
  const parsed = voiceNotifyInputSchema.safeParse(makeNotify())
  assert.equal(parsed.success, true)
})

test('a notify without a dedupeKey is refused', () => {
  const notify = makeNotify()
  delete notify.dedupeKey
  assert.equal(voiceNotifyInputSchema.safeParse(notify).success, false)
})

test('a notify with a priority outside low, normal and urgent is refused', () => {
  const parsed = voiceNotifyInputSchema.safeParse(makeNotify({ priority: 'high' }))
  assert.equal(parsed.success, false)
})

test('set_status accepts only the fixed state vocabulary', () => {
  const base = {
    source: { appId: 'octopus', name: 'Octopus' },
    subject: { type: 'task', id: 't_91', label: 'Team ABC' },
    label: 'dispatching agents',
  }
  for (const state of ['idle', 'working', 'needs_input', 'needs_approval', 'needs_review', 'failed']) {
    assert.equal(voiceSetStatusInputSchema.safeParse({ ...base, state }).success, true, state)
  }
  assert.equal(voiceSetStatusInputSchema.safeParse({ ...base, state: 'done' }).success, false)
})
